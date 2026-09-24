import {
  ensureProjectWorkspace,
  HttpCollaborationClient,
  ProjectCodeSync,
  type ProjectSummary,
  type LocalConversationSyncStatus,
  type LocalConversationUploadResult,
} from "@gatherthread/bridge";
import { createHash } from "node:crypto";
import path from "node:path";
import { DshCodeSyncController, type DshCodeSyncView } from "./code-sync-controller.js";
import { createHttpDshCollaborationApi } from "./collaboration-api.js";
import { managedDshSessionTitle } from "./session-title.js";
import {
  assertSafeDshStateRoot,
  deriveDshSessionId,
  deriveNativeDshSessionId,
  type EnabledDshProjectHostConfig,
} from "./config.js";
import { DshHostConnector } from "./connector.js";
import {
  createDshHostFacade,
  DSH_NPM_COMPATIBILITY,
  registerDshNativeWorkspace,
  registerDshPluginDisposer,
} from "./dsh-compat.js";
import {
  activeNativeProjects,
  beginDshNativePairing,
  createNativeCollaborationClient,
  createNativeProjectConfig,
  DSH_NATIVE_PAIRING_CHANNEL,
  DshNativeCredentialStore,
  normalizeDshServerUrl,
  pollDshNativePairing,
  publicPairingView,
  type DshNativeBinding,
  type DshNativeGrant,
  type DshNativePairingIntent,
  type DshNativePairingView,
  type DshNativeRoute,
} from "./native-connection.js";
import {
  DshProjectManager,
  type DshManagedConnector,
  type DshProjectConnectorFactoryInput,
  type DshProjectManagerStatusUpdate,
} from "./project-manager.js";
import { FileConnectorStateStore } from "./state-store.js";
import {
  bindOptionalDshStatusRoute,
  DshStatusController,
  type DshPublicStatusSnapshot,
} from "./status.js";
import type { DshRuntimeExecutionProfile } from "./types.js";

export const name = "gatherthread-dsh-native";
/** DSH's built-in editable Web preset; recorded in new native Session headers. */
export const DSH_NATIVE_AGENT_PRESET = "standard";
export const inject = [
  "agents",
  "sessions",
  "sessionPersistence",
  "sessionQuery",
  "sessionTitle",
  "workspaceRegistry",
  "llm",
  "credentials",
  "connection",
] as const;

const RPC_ENDPOINTS = new Set([
  "status/get",
  "pairing/start",
  "pairing/cancel",
  "catalog/get",
  "connection/configure",
  "connection/disconnect",
  "sync/set-auto-upload",
  "sync/upload",
  "code/authorize",
  "code/action",
]);
const MAX_CATALOG_PROVIDERS = 64;
const MAX_CATALOG_MODELS = 256;
const MAX_EXECUTION_PROFILES = 32;
const MAX_REASONING_EFFORTS = 16;

export interface DshNativePluginConfig {
  readonly enabled: boolean;
  readonly workspacePath: string;
  readonly dshHome?: string;
  readonly officialServerUrl?: string;
}

export interface DshNativePublicState {
  readonly schemaVersion: 2;
  readonly integration: "gatherthread";
  readonly authorization: "unpaired" | "pairing" | "paired";
  readonly compatibility: {
    readonly package: "@deepseek-ai/dsh";
    readonly version: "0.1.2-rc.1";
    readonly profile: "web";
  };
  readonly runtime: DshPublicStatusSnapshot;
  readonly officialServerUrl?: string;
  readonly serverUrl?: string;
  readonly deviceName?: string;
  readonly route?: DshNativeRoute;
  readonly projectCount?: number;
  readonly bindings?: readonly DshNativeBinding[];
  readonly pairing?: DshNativePairingView;
  readonly recoverableError?: "pairing_failed" | "connection_failed";
  readonly localSync?: readonly DshNativeLocalSyncStatus[];
  readonly codeSync?: readonly (DshCodeSyncView & { projectId: string; projectName: string })[];
}

export interface DshNativeLocalSyncStatus extends LocalConversationSyncStatus {
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
}

export interface DshNativeCatalog {
  readonly schemaVersion: 1;
  readonly projects: readonly ProjectSummary[];
  readonly providers: readonly {
    readonly id: string;
    readonly name: string;
    readonly models: readonly { readonly id: string; readonly name: string }[];
  }[];
}

interface NativeOwner {
  stop(): Promise<void>;
  localSyncStatuses?(): LocalConversationSyncStatus[];
  setLocalAutoUpload?(sessionId: string, enabled: boolean): Promise<LocalConversationSyncStatus>;
  uploadLocalTurns?(sessionId: string): Promise<LocalConversationUploadResult>;
  codeSyncView?(): DshCodeSyncView;
  authorizeCodeSync?(enabled: boolean): Promise<DshCodeSyncView>;
  executeCodeSync?(action: string): Promise<DshCodeSyncView>;
}

interface NativeLlmLike {
  listProviders(): readonly unknown[];
  listModels(provider: string): Promise<readonly unknown[]>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>;
}

interface NativeRpcConnectionLike {
  readonly rpc: {
    handle(
      channel: string,
      handler: (
        endpoint: string,
        payload: unknown,
        signal: AbortSignal,
      ) => Promise<NativeRpcResult>,
    ): () => Promise<void>;
  };
}

type NativeRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | {
    readonly ok: false;
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, never>;
    };
  };

export interface DshNativeHostControllerOptions {
  readonly context: unknown;
  readonly status: DshStatusController;
  readonly workspacePath: string;
  readonly dshHome?: string;
  /** Logical user home used for managed GatherThread Project workspaces. */
  readonly projectWorkspaceHomeDirectory?: string;
  readonly officialServerUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly createOwner?: (
    grant: DshNativeGrant,
    binding: DshNativeBinding,
    signal: AbortSignal,
    status: DshStatusController,
    workspacePath: string,
    executionProfiles?: readonly DshRuntimeExecutionProfile[],
  ) => Promise<NativeOwner>;
  readonly resolveWorkspace?: (
    grant: DshNativeGrant,
    binding: DshNativeBinding,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly listProjects?: (
    grant: DshNativeGrant,
    signal: AbortSignal,
  ) => Promise<ProjectSummary[]>;
  readonly listCatalog?: (signal: AbortSignal) => Promise<DshNativeCatalog["providers"]>;
  readonly listExecutionProfiles?: (
    provider: string,
    signal: AbortSignal,
  ) => Promise<readonly DshRuntimeExecutionProfile[]>;
  readonly validateModel?: (
    provider: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly projectRefreshIntervalMs?: number;
}

/**
 * Plugin-owned state machine. It can boot without a GatherThread credential,
 * because installation and pairing are intentionally separate operations.
 */
export class DshNativeHostController {
  readonly #options: DshNativeHostControllerOptions;
  readonly #credentials: DshNativeCredentialStore;
  readonly #abort = new AbortController();
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #owners = new Map<string, NativeOwner>();
  readonly #projects = new Map<string, ProjectSummary>();
  readonly #projectStatuses = new Map<string, DshProjectManagerStatusUpdate>();
  #grant: DshNativeGrant | undefined;
  #pairing: DshNativePairingIntent | undefined;
  #pairingAbort: AbortController | undefined;
  #pairingBegin: Promise<DshNativePairingIntent> | undefined;
  #pairingTask: Promise<void> | undefined;
  #configureTask: Promise<DshNativePublicState> | undefined;
  #configureAbort: AbortController | undefined;
  #disconnecting = false;
  #recoverableError: DshNativePublicState["recoverableError"];
  #starting = false;
  #started = false;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #projectRefreshPromise: Promise<void> | undefined;
  #projectRefreshAbort: AbortController | undefined;
  #projectRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #executionProfileRouteKey: string | undefined;
  #executionProfiles: readonly DshRuntimeExecutionProfile[] | undefined;

  constructor(options: DshNativeHostControllerOptions) {
    this.#options = options;
    this.#credentials = new DshNativeCredentialStore(options.context);
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async start(): Promise<void> {
    if (this.#started || this.#starting) throw new Error("GatherThread native DSH controller is already started");
    if (this.#disposed) throw new Error("GatherThread native DSH controller is disposed");
    this.#starting = true;
    try {
      const grant = await this.#credentials.load();
      throwIfAborted(this.#abort.signal);
      this.#grant = grant;
    } finally { this.#starting = false; }
    this.#started = true;
    if (this.#grant?.route === undefined) {
      this.#options.status.setConnection("stopped");
      return;
    }
    try {
      await this.refreshProjects();
    } catch {
      this.#recoverableError = "connection_failed";
      this.#options.status.setConnection("error");
    } finally {
      this.#scheduleProjectRefresh();
    }
  }

  publicState(): DshNativePublicState {
    const authorization = this.#pairing !== undefined
      ? "pairing"
      : this.#grant === undefined ? "unpaired" : "paired";
    return {
      schemaVersion: 2,
      integration: "gatherthread",
      authorization,
      compatibility: {
        package: DSH_NPM_COMPATIBILITY.package,
        version: DSH_NPM_COMPATIBILITY.version,
        profile: DSH_NPM_COMPATIBILITY.profile,
      },
      runtime: this.#options.status.snapshot(),
      ...(this.#options.officialServerUrl === undefined ? {} : {
        officialServerUrl: this.#options.officialServerUrl,
      }),
      ...(this.#grant === undefined ? {} : {
        serverUrl: this.#grant.serverUrl,
        deviceName: this.#grant.deviceName,
        ...(this.#grant.route === undefined ? {} : {
          route: { ...this.#grant.route },
          projectCount: this.#projects.size,
          bindings: this.#currentBindings(this.#grant.route).slice(0, 100),
          localSync: this.#currentLocalSync().slice(0, 100),
          codeSync: [...this.#owners].flatMap(([projectId, owner]) => {
            if (this.#projects.get(projectId)?.role === "viewer") return [];
            const view = owner.codeSyncView?.();
            return view === undefined ? [] : [{
              projectId,
              projectName: this.#projects.get(projectId)?.name ?? projectId,
              ...view,
            }];
          }).slice(0, 100),
        }),
      }),
      ...(this.#pairing === undefined ? {} : {
        serverUrl: this.#pairing.serverUrl,
        deviceName: this.#pairing.deviceName,
        pairing: publicPairingView(this.#pairing),
      }),
      ...(this.#recoverableError === undefined ? {} : {
        recoverableError: this.#recoverableError,
      }),
    };
  }

  async startPairing(
    inputValue: unknown,
    requestSignal?: AbortSignal,
  ): Promise<DshNativePairingView> {
    this.#assertAvailable();
    if (this.#grant !== undefined) {
      throw new Error("Disconnect the current GatherThread pairing before starting another");
    }
    if (this.#pairingAbort !== undefined || this.#pairingTask !== undefined) {
      throw new Error("A GatherThread DSH pairing is already active");
    }
    const input = exactInput(inputValue, new Set(["serverUrl", "deviceName"]));
    const operationAbort = new AbortController();
    this.#pairingAbort = operationAbort;
    const abortFromRoot = () => operationAbort.abort(this.#abort.signal.reason);
    if (this.#abort.signal.aborted) abortFromRoot();
    else this.#abort.signal.addEventListener("abort", abortFromRoot, { once: true });
    const beginSignal = requestSignal === undefined
      ? operationAbort.signal
      : AbortSignal.any([operationAbort.signal, requestSignal]);
    let intent: DshNativePairingIntent;
    try {
      this.#pairingBegin = beginDshNativePairing({
        serverUrl: requiredInputText(input.serverUrl, "serverUrl", 2_048),
        deviceName: requiredInputText(input.deviceName, "deviceName", 120),
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        signal: beginSignal,
      });
      intent = await this.#pairingBegin;
    } catch (error) {
      this.#abort.signal.removeEventListener("abort", abortFromRoot);
      this.#pairingAbort = undefined;
      operationAbort.abort();
      throw error;
    } finally {
      this.#pairingBegin = undefined;
    }
    if (beginSignal.aborted || this.#disposed || this.#disconnecting) {
      operationAbort.abort();
      this.#abort.signal.removeEventListener("abort", abortFromRoot);
      this.#pairingAbort = undefined;
      throw new Error("GatherThread DSH pairing was canceled before activation");
    }
    this.#pairing = intent;
    this.#recoverableError = undefined;
    this.#options.status.setConnection("connecting");
    this.#pairingTask = this.#pollPairing(intent, operationAbort.signal)
      .catch((error: unknown) => {
        if (!operationAbort.signal.aborted && !this.#disposed) {
          this.#recoverableError = "pairing_failed";
          this.#options.status.setConnection("error");
        }
        if (!isAbortError(error) && !operationAbort.signal.aborted) {
          // The RPC response is already complete; publicState carries only a
          // fixed recovery code and never forwards this potentially sensitive error.
        }
      })
      .finally(() => {
        this.#abort.signal.removeEventListener("abort", abortFromRoot);
        if (this.#pairingAbort === operationAbort) this.#pairingAbort = undefined;
        this.#pairingTask = undefined;
        this.#pairing = undefined;
      });
    return publicPairingView(intent);
  }

  async cancelPairing(): Promise<void> {
    const beginning = this.#pairingBegin;
    const task = this.#pairingTask;
    this.#pairingAbort?.abort(new Error("GatherThread DSH pairing canceled"));
    if (beginning !== undefined) await beginning.catch(() => undefined);
    if (task !== undefined) await task;
    if (!this.#disposed && this.#grant === undefined) {
      this.#recoverableError = undefined;
      this.#options.status.setConnection("stopped");
    }
  }

  whenPairingSettled(): Promise<void> {
    return this.#pairingTask ?? Promise.resolve();
  }

  async catalog(signal?: AbortSignal): Promise<DshNativeCatalog> {
    this.#assertAvailable();
    const grant = this.#requireGrant();
    const operationSignal = combineSignal(this.#abort.signal, signal);
    const [projects, providers] = await Promise.all([
      this.#listProjects(grant, operationSignal),
      this.#listCatalog(operationSignal),
    ]);
    return {
      schemaVersion: 1,
      projects: activeNativeProjects(projects).slice(0, 100),
      providers,
    };
  }

  async configure(inputValue: unknown, signal?: AbortSignal): Promise<DshNativePublicState> {
    this.#assertAvailable();
    if (this.#configureTask !== undefined) throw new Error("GatherThread DSH configuration is already active");
    const configureAbort = new AbortController();
    this.#configureAbort = configureAbort;
    const operationSignal = combineSignal(configureAbort.signal, signal);
    const task = this.#configure(inputValue, operationSignal);
    this.#configureTask = task;
    try { return await task; }
    finally {
      if (this.#configureTask === task) {
        this.#configureTask = undefined;
        this.#configureAbort = undefined;
      }
    }
  }

  async #configure(inputValue: unknown, signal: AbortSignal): Promise<DshNativePublicState> {
    const grant = this.#requireGrant();
    const input = exactInput(inputValue, new Set(["projectId", "provider", "model"]));
    const projectId = input.projectId === undefined
      ? undefined
      : safeInputIdentifier(input.projectId, "projectId");
    const provider = requiredInputText(input.provider, "provider", 80);
    const model = requiredInputText(input.model, "model", 160);
    const operationSignal = combineSignal(this.#abort.signal, signal);
    const projects = activeNativeProjects(await this.#listProjects(grant, operationSignal));
    if (projectId !== undefined) {
      throw new Error("The single-Project DSH client is obsolete; refresh DSH and explicitly confirm all accessible Projects");
    }
    await this.#validateModel(provider, model, operationSignal);
    this.#executionProfileRouteKey = undefined;
    this.#executionProfiles = undefined;
    const route: DshNativeRoute = { provider, model };
    const nextGrant: DshNativeGrant = { ...grant, route };
    try {
      throwIfAborted(operationSignal);
      await this.#cancelProjectRefresh("GatherThread DSH model route changed");
      throwIfAborted(operationSignal);
      this.#grant = await this.#credentials.save(nextGrant);
      throwIfAborted(operationSignal);
      await this.#stopOwners();
      await this.#reconcileProjects(this.#grant, projects, operationSignal);
      this.#scheduleProjectRefresh();
      return this.publicState();
    } catch (error) {
      this.#recoverableError = "connection_failed";
      this.#options.status.setConnection("error");
      throw error;
    }
  }

  async refreshProjects(signal?: AbortSignal): Promise<void> {
    this.#assertAvailable();
    if (this.#projectRefreshPromise !== undefined) return this.#projectRefreshPromise;
    const grant = this.#requireGrant();
    if (grant.route === undefined) return;
    const refreshAbort = new AbortController();
    this.#projectRefreshAbort = refreshAbort;
    const operationSignal = combineSignal(
      combineSignal(this.#abort.signal, refreshAbort.signal),
      signal,
    );
    const task = (async () => {
      try {
        const projects = activeNativeProjects(await this.#listProjects(grant, operationSignal));
        throwIfAborted(operationSignal);
        await this.#reconcileProjects(grant, projects, operationSignal);
      } catch (error) {
        if (!operationSignal.aborted) {
          this.#recoverableError = "connection_failed";
          this.#options.status.setConnection(this.#owners.size > 0 ? "offline" : "error");
        }
        throw error;
      }
    })();
    const completion = task.finally(() => {
      if (this.#projectRefreshPromise === completion) {
        this.#projectRefreshPromise = undefined;
        this.#projectRefreshAbort = undefined;
      }
    });
    this.#projectRefreshPromise = completion;
    return completion;
  }

  async disconnect(): Promise<DshNativePublicState> {
    this.#assertAvailable();
    this.#disconnecting = true;
    this.#configureAbort?.abort(new Error("GatherThread DSH configuration canceled by disconnect"));
    try {
      // A delayed configuration/credential write must settle before clearing the
      // grant; otherwise it could resurrect pairing after the user disconnects.
      await this.#configureTask?.catch(() => undefined);
      await this.cancelPairing();
      await this.#cancelProjectRefresh("GatherThread DSH pairing disconnected");
      await this.#stopOwners();
      await this.#credentials.clear();
      this.#grant = undefined;
      this.#executionProfileRouteKey = undefined;
      this.#executionProfiles = undefined;
      this.#recoverableError = undefined;
      this.#options.status.setProjectName("GatherThread / 共序");
      this.#options.status.setConnection("stopped");
      return this.publicState();
    } finally { this.#disconnecting = false; }
  }

  async setLocalAutoUpload(inputValue: unknown): Promise<DshNativePublicState> {
    this.#assertAvailable();
    const input = exactInput(inputValue, new Set(["projectId", "sessionId", "enabled"]));
    const projectId = safeInputIdentifier(input.projectId, "projectId");
    const sessionId = safeInputIdentifier(input.sessionId, "sessionId");
    if (typeof input.enabled !== "boolean") throw new Error("enabled must be true or false");
    const owner = this.#owners.get(projectId);
    if (!owner) throw new Error("The selected GatherThread Project is not active");
    if (!owner.setLocalAutoUpload) throw new Error("This DSH Project does not expose upload controls");
    await owner.setLocalAutoUpload(sessionId, input.enabled);
    return this.publicState();
  }

  async uploadLocalTurns(inputValue: unknown): Promise<DshNativePublicState> {
    this.#assertAvailable();
    const input = exactInput(inputValue, new Set(["projectId", "sessionId"]));
    const projectId = safeInputIdentifier(input.projectId, "projectId");
    const sessionId = safeInputIdentifier(input.sessionId, "sessionId");
    const owner = this.#owners.get(projectId);
    if (!owner) throw new Error("The selected GatherThread Project is not active");
    if (!owner.uploadLocalTurns) throw new Error("This DSH Project does not expose manual upload");
    await owner.uploadLocalTurns(sessionId);
    return this.publicState();
  }

  async codeSyncAction(inputValue: unknown, authorize = false): Promise<DshNativePublicState> {
    this.#assertAvailable();
    const input = exactInput(inputValue, new Set(authorize ? ["projectId", "enabled"] : ["projectId", "action"]));
    const projectId = safeInputIdentifier(input.projectId, "projectId");
    const owner = this.#owners.get(projectId);
    if (!owner || this.#projects.get(projectId)?.role === "viewer") {
      throw new Error("This Project is not writable on this DSH device");
    }
    if (authorize) {
      if (typeof input.enabled !== "boolean" || !owner.authorizeCodeSync) throw new Error("Invalid code sync authorization");
      await owner.authorizeCodeSync(input.enabled);
    } else {
      if (typeof input.action !== "string" || ![
        "code_sync_status", "code_upload", "code_download", "code_recover",
        "code_auto_upload_enable", "code_auto_upload_disable",
      ].includes(input.action) || !owner.executeCodeSync) throw new Error("Invalid code sync action");
      await owner.executeCodeSync(input.action);
    }
    return this.publicState();
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= (async () => {
      this.#disposed = true;
      this.#abort.abort(new Error("GatherThread native DSH plugin unloaded"));
      this.#pairingAbort?.abort(this.#abort.signal.reason);
      await Promise.allSettled([this.#pairingBegin, this.#pairingTask, this.#configureTask, this.#projectRefreshPromise]);
      await this.#stopOwners();
      this.#pairing = undefined;
      this.#pairingTask = undefined;
      this.#options.status.setConnection("stopped");
    })();
    return this.#disposePromise;
  }

  async #pollPairing(intent: DshNativePairingIntent, signal: AbortSignal): Promise<void> {
    let intervalSeconds = intent.intervalSeconds;
    while (true) {
      throwIfAborted(signal);
      const result = await pollDshNativePairing(intent, {
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        signal,
      });
      throwIfAborted(signal);
      if (result.status === "paired") {
        const grant: DshNativeGrant = {
          schemaVersion: 2,
          serverUrl: intent.serverUrl,
          apiUrl: intent.apiUrl,
          deviceId: result.deviceId,
          deviceName: intent.deviceName,
          token: result.token,
        };
        this.#grant = await this.#credentials.save(grant);
        throwIfAborted(signal);
        this.#recoverableError = undefined;
        this.#options.status.setConnection("stopped");
        return;
      }
      intervalSeconds = result.intervalSeconds;
      if (Date.now() >= Date.parse(result.expiresAt)) {
        throw new Error("GatherThread DSH pairing expired");
      }
      await this.#sleep(intervalSeconds * 1_000, signal);
    }
  }

  async #activate(
    grant: DshNativeGrant,
    binding: DshNativeBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const workspacePath = await (this.#options.resolveWorkspace ?? resolveNativeProjectWorkspace)(
      grant,
      binding,
      signal,
      this.#options.projectWorkspaceHomeDirectory,
    );
    throwIfAborted(signal);
    const createOwner = this.#options.createOwner ?? ((grantValue, bindingValue, signal, status) => {
      const role = this.#projects.get(bindingValue.projectId)?.role;
      return createProductionOwner({
        context: this.#options.context,
        grant: grantValue,
        binding: bindingValue,
        workspacePath,
        ...(this.#options.dshHome === undefined ? {} : { dshHome: this.#options.dshHome }),
        signal,
        status,
        ...(this.#executionProfiles === undefined ? {} : {
          executionProfiles: this.#executionProfiles,
        }),
        canCreateLocalSessions: role === "owner" || role === "participant",
        onStatus: (update) => this.#updateProjectStatus(bindingValue.projectId, update),
      });
    });
    const owner = await createOwner(
      grant,
      binding,
      signal,
      this.#options.status,
      workspacePath,
      this.#executionProfiles,
    );
    if (this.#disposed || signal.aborted) {
      await owner.stop();
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("GatherThread native DSH Project activation was cancelled");
    }
    this.#owners.set(binding.projectId, owner);
    const existingStatus = this.#projectStatuses.get(binding.projectId);
    if (existingStatus === undefined || existingStatus.state === "error" || existingStatus.state === "stopped") {
      this.#projectStatuses.set(binding.projectId, {
        state: "connected",
        eligibleSessions: [],
        activeSessionIds: [],
      });
    }
  }

  async #stopOwners(): Promise<void> {
    if (this.#projectRefreshTimer !== undefined) clearTimeout(this.#projectRefreshTimer);
    this.#projectRefreshTimer = undefined;
    const owners = [...this.#owners.values()];
    this.#owners.clear();
    this.#projects.clear();
    this.#projectStatuses.clear();
    await Promise.allSettled(owners.map((owner) => owner.stop()));
  }

  async #cancelProjectRefresh(reason: string): Promise<void> {
    const task = this.#projectRefreshPromise;
    this.#projectRefreshAbort?.abort(new Error(reason));
    if (task !== undefined) await task.catch(() => undefined);
  }

  async #reconcileProjects(
    grant: DshNativeGrant,
    projects: readonly ProjectSummary[],
    signal: AbortSignal,
  ): Promise<void> {
    const route = grant.route;
    if (route === undefined) return;
    throwIfAborted(signal);
    await this.#refreshExecutionProfiles(route, signal);
    throwIfAborted(signal);
    const nextIds = new Set(projects.map((project) => project.id));
    const previousRoles = new Map([...this.#projects].map(([id, project]) => [id, project.role]));
    this.#projects.clear();
    for (const project of projects) this.#projects.set(project.id, { ...project });
    for (const [projectId, owner] of [...this.#owners]) {
      // Native managers capture write capabilities when they start. Refresh a
      // changed role in both directions without disturbing other Projects.
      if (nextIds.has(projectId) && previousRoles.get(projectId) === this.#projects.get(projectId)?.role) continue;
      this.#owners.delete(projectId);
      this.#projectStatuses.delete(projectId);
      await owner.stop();
      throwIfAborted(signal);
    }
    this.#options.status.setProjectName(projects.length === 1
      ? boundedPublicText(projects[0]?.name, "project name", 160)
      : `GatherThread / 共序 · ${String(projects.length)} Projects`);
    this.#options.status.setConnection(projects.length === 0 ? "stopped" : "connecting");
    let failures = 0;
    for (const binding of this.#currentBindings(route)) {
      throwIfAborted(signal);
      if (this.#owners.has(binding.projectId)) continue;
      try {
        await this.#activate(grant, binding, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        failures += 1;
        this.#projectStatuses.set(binding.projectId, { state: "error" });
      }
    }
    this.#refreshAggregateStatus();
    this.#recoverableError = failures > 0 ? "connection_failed" : undefined;
  }

  async #refreshExecutionProfiles(
    route: DshNativeRoute,
    signal: AbortSignal,
  ): Promise<void> {
    const routeKey = `${route.provider}\u0000${route.model}`;
    if (this.#executionProfileRouteKey === routeKey) return;
    if (route.provider !== "deepseek-official") {
      this.#executionProfiles = undefined;
      this.#executionProfileRouteKey = routeKey;
      return;
    }
    const discovered = this.#options.listExecutionProfiles === undefined
      ? await listNativeExecutionProfiles(this.#options.context, route.provider, signal)
      : await this.#options.listExecutionProfiles(route.provider, signal);
    throwIfAborted(signal);
    const profiles = normalizeExecutionProfiles(discovered, route.provider);
    if (!profiles.some((profile) => profile.model === route.model)) {
      throw new Error("DeepSeek Harness did not advertise the configured model as an execution profile");
    }
    this.#executionProfiles = profiles;
    this.#executionProfileRouteKey = routeKey;
  }

  #currentBindings(route: DshNativeRoute): DshNativeBinding[] {
    return [...this.#projects.values()]
      .map((project) => ({
        projectId: project.id,
        projectName: boundedPublicText(project.name, "project name", 160),
        provider: route.provider,
        model: route.model,
      }))
      .sort((left, right) => left.projectName.localeCompare(right.projectName)
        || left.projectId.localeCompare(right.projectId));
  }

  #currentLocalSync(): DshNativeLocalSyncStatus[] {
    const titles = new Map(this.#options.status.snapshot().sessions.map((session) => [session.sessionId, session.title]));
    return [...this.#owners.entries()].flatMap(([projectId, owner]) => {
      const project = this.#projects.get(projectId);
      if (!project) return [];
      return (owner.localSyncStatuses?.() ?? []).map((sync) => ({
        ...sync,
        projectId,
        projectName: boundedPublicText(project.name, "project name", 160),
        title: titles.get(sync.sessionId) ?? sync.sessionId,
      }));
    }).sort((left, right) => left.projectName.localeCompare(right.projectName)
      || left.title.localeCompare(right.title)
      || left.sessionId.localeCompare(right.sessionId));
  }

  #updateProjectStatus(projectId: string, update: DshProjectManagerStatusUpdate): void {
    if (!this.#projects.has(projectId) || this.#disposed) return;
    this.#projectStatuses.set(projectId, update);
    this.#refreshAggregateStatus();
  }

  #refreshAggregateStatus(): void {
    const connected = [...this.#projectStatuses.values()].filter((update) => update.state === "connected");
    this.#options.status.reconcileProjectSessions(
      connected.flatMap((update) => update.state === "connected" ? [...update.eligibleSessions] : []),
      connected.flatMap((update) => update.state === "connected" ? [...update.activeSessionIds] : []),
    );
    if (connected.length > 0) this.#options.status.setConnection("connected");
    else if ([...this.#projectStatuses.values()].some((update) => update.state === "offline")) {
      this.#options.status.setConnection("offline");
    } else if (this.#projects.size > 0) this.#options.status.setConnection("error");
    else this.#options.status.setConnection("stopped");
  }

  #scheduleProjectRefresh(): void {
    if (this.#disposed || this.#disconnecting || this.#grant?.route === undefined || this.#projectRefreshTimer !== undefined) return;
    const delay = this.#options.projectRefreshIntervalMs ?? 5_000;
    this.#projectRefreshTimer = setTimeout(() => {
      this.#projectRefreshTimer = undefined;
      void this.refreshProjects()
        .catch(() => undefined)
        .finally(() => this.#scheduleProjectRefresh());
    }, delay);
    this.#projectRefreshTimer.unref?.();
  }

  #listProjects(grant: DshNativeGrant, signal: AbortSignal): Promise<ProjectSummary[]> {
    if (this.#options.listProjects !== undefined) {
      return this.#options.listProjects(grant, signal);
    }
    return createNativeCollaborationClient(grant, signal).listProjects();
  }

  #listCatalog(signal: AbortSignal): Promise<DshNativeCatalog["providers"]> {
    if (this.#options.listCatalog !== undefined) return this.#options.listCatalog(signal);
    return listNativeLlmCatalog(this.#options.context, signal);
  }

  #validateModel(provider: string, model: string, signal: AbortSignal): Promise<void> {
    if (this.#options.validateModel !== undefined) {
      return this.#options.validateModel(provider, model, signal);
    }
    return validateNativeLlmModel(this.#options.context, provider, model, signal);
  }

  #requireGrant(): DshNativeGrant {
    if (this.#grant === undefined) throw new Error("GatherThread DSH is not paired");
    return this.#grant;
  }

  #assertAvailable(): void {
    if (!this.#started || this.#disposed || this.#disconnecting) {
      throw new Error("GatherThread native DSH controller is unavailable");
    }
  }
}

/** Installed bundle entry. The explicit bundle row supplies enabled: true. */
export async function apply(context: unknown, rawConfig?: unknown): Promise<void> {
  const config = parseNativePluginConfig(rawConfig);
  if (!config.enabled) return;
  const dshHome = config.dshHome ?? nativeDshHomeFromEnvironment();
  const status = new DshStatusController({
    bindingMode: "project",
    projectName: "GatherThread / 共序",
  });
  const controller = new DshNativeHostController({
    context,
    status,
    workspacePath: config.workspacePath,
    ...(dshHome === undefined ? {} : {
      dshHome,
      projectWorkspaceHomeDirectory: path.dirname(dshHome),
    }),
    ...(config.officialServerUrl === undefined ? {} : { officialServerUrl: config.officialServerUrl }),
  });
  let statusDispose: (() => Promise<void>) | undefined;
  let rpcDispose: (() => Promise<void>) | undefined;
  registerDshPluginDisposer(context, async () => {
    await controller.dispose();
    await Promise.allSettled([rpcDispose?.(), statusDispose?.()]);
  });
  try {
    statusDispose = bindOptionalDshStatusRoute(context, status);
    rpcDispose = registerNativeDshRpc(context, controller);
    await controller.start();
  } catch (error) {
    await Promise.allSettled([
      controller.dispose(),
      rpcDispose?.(),
      statusDispose?.(),
    ]);
    throw error;
  }
}

export function registerNativeDshRpc(
  contextValue: unknown,
  controller: DshNativeHostController,
): () => Promise<void> {
  const connection = requireConnection(contextValue);
  let active = true;
  const unregister = connection.rpc.handle(DSH_NATIVE_PAIRING_CHANNEL, async (
    endpoint,
    payload,
    signal,
  ) => {
    if (!active || !RPC_ENDPOINTS.has(endpoint)) {
      return rpcFailure("gatherthread/not-found", "GatherThread DSH action is unavailable");
    }
    try {
      switch (endpoint) {
        case "status/get":
          exactInput(payload, new Set());
          return rpcSuccess(controller.publicState());
        case "pairing/start":
          await controller.startPairing(payload, signal);
          return rpcSuccess(controller.publicState());
        case "pairing/cancel":
          exactInput(payload, new Set());
          await controller.cancelPairing();
          return rpcSuccess(controller.publicState());
        case "catalog/get":
          exactInput(payload, new Set());
          return rpcSuccess(await controller.catalog(signal));
        case "connection/configure":
          return rpcSuccess(await controller.configure(payload, signal));
        case "connection/disconnect":
          exactInput(payload, new Set());
          return rpcSuccess(await controller.disconnect());
        case "sync/set-auto-upload":
          return rpcSuccess(await controller.setLocalAutoUpload(payload));
        case "sync/upload":
          return rpcSuccess(await controller.uploadLocalTurns(payload));
        case "code/authorize":
          return rpcSuccess(await controller.codeSyncAction(payload, true));
        case "code/action":
          return rpcSuccess(await controller.codeSyncAction(payload));
        default:
          return rpcFailure("gatherthread/not-found", "GatherThread DSH action is unavailable");
      }
    } catch {
      return rpcFailure(
        "gatherthread/request-failed",
        "GatherThread could not complete this action. Check the address, authorization, and selected model.",
      );
    }
  });
  return async () => {
    if (!active) return;
    active = false;
    await unregister();
  };
}

export function parseNativePluginConfig(value: unknown): DshNativePluginConfig {
  if (value === undefined) return { enabled: false, workspacePath: process.cwd() };
  const input = exactInput(value, new Set(["enabled", "workspacePath", "dshHome", "officialServerUrl"]));
  if (input.enabled !== true) {
    if (input.enabled !== undefined && input.enabled !== false) {
      throw new Error("native DSH config.enabled must be true or false");
    }
    return { enabled: false, workspacePath: process.cwd() };
  }
  const workspacePath = input.workspacePath === undefined
    ? process.cwd()
    : absoluteInputPath(input.workspacePath, "workspacePath");
  const dshHome = input.dshHome === undefined
    ? undefined
    : absoluteInputPath(input.dshHome, "dshHome");
  const officialServerUrl = input.officialServerUrl === undefined
    ? undefined
    : normalizeDshServerUrl(requiredInputText(input.officialServerUrl, "officialServerUrl", 2_048)).serverUrl;
  return {
    enabled: true,
    workspacePath,
    ...(dshHome === undefined ? {} : { dshHome }),
    ...(officialServerUrl === undefined ? {} : { officialServerUrl }),
  };
}

async function createProductionOwner(options: {
  readonly context: unknown;
  readonly grant: DshNativeGrant;
  readonly binding: DshNativeBinding;
  readonly workspacePath: string;
  readonly dshHome?: string;
  readonly signal: AbortSignal;
  readonly status: DshStatusController;
  readonly onStatus: (update: DshProjectManagerStatusUpdate) => void;
  readonly canCreateLocalSessions: boolean;
  readonly executionProfiles?: readonly DshRuntimeExecutionProfile[];
}): Promise<NativeOwner> {
  const baseConfig = createNativeProjectConfig({
    grant: options.grant,
    binding: options.binding,
    workspacePath: options.workspacePath,
    ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
  });
  const config: EnabledDshProjectHostConfig = {
    ...baseConfig,
    ...(options.executionProfiles === undefined ? {} : {
      executionProfiles: cloneExecutionProfiles(options.executionProfiles),
    }),
  };
  await assertSafeDshStateRoot(config);
  const nativeWorkspace = await registerDshNativeWorkspace(
    options.context,
    config.workspacePath,
    options.binding.projectName,
  );
  const ownerAbort = new AbortController();
  const abortFromRoot = () => ownerAbort.abort(options.signal.reason);
  if (options.signal.aborted) abortFromRoot();
  else options.signal.addEventListener("abort", abortFromRoot, { once: true });
  const api = createHttpDshCollaborationApi({
    baseUrl: options.grant.apiUrl,
    credential: options.grant.token,
    signal: ownerAbort.signal,
  });
  const codeRuntimes = new Map<string, DshManagedConnector>();
  const manager = new DshProjectManager({
    config,
    api,
    createConnector: (input) => {
      const connector = createNativeManagedConnector({
        input,
        context: options.context,
        credential: options.grant.token,
        rootSignal: ownerAbort.signal,
        status: options.status,
        workspaceTitle: options.binding.projectName,
      });
      codeRuntimes.set(input.session.id, connector);
      return connector;
    },
    canCreateLocalSessions: options.canCreateLocalSessions,
    discoverLocalSessions: () => nativeWorkspace.listCompletedLocalSessions(),
    subscribeToLocalSessionChanges: (listener) => nativeWorkspace.onLocalSessionSettled(listener),
    mapCloudSessionId: (sessionId) => deriveNativeDshSessionId(
      config.projectId,
      sessionId,
      config.workspacePath,
    ),
    onStatus: options.onStatus,
  });
  let actor: Awaited<ReturnType<typeof api.getCurrentActor>>;
  try {
    actor = await api.getCurrentActor();
    await manager.start();
  } catch (error) {
    ownerAbort.abort(new Error("GatherThread native DSH manager failed to start"));
    options.signal.removeEventListener("abort", abortFromRoot);
    await manager.stop();
    nativeWorkspace.dispose();
    throw error;
  }
  const codeSync = new DshCodeSyncController({
    permissionPath: path.join(config.stateRoot, `code-consent-${createHash("sha256").update(actor.id).digest("hex")}.json`),
    binding: createHash("sha256").update(JSON.stringify([
      config.apiUrl, config.projectId, actor.id, config.workspacePath,
    ])).digest("hex"),
    createEngine: () => new ProjectCodeSync({
      apiUrl: config.apiUrl,
      token: options.grant.token,
      projectId: config.projectId,
      actorId: actor.id,
      workspacePath: config.workspacePath,
      // A custom DSH home is an isolated profile, including its code-sync state.
      // Default profiles keep the harness-neutral state shared with Codex.
      ...(options.dshHome === undefined ? {} : {
        stateRoot: path.join(options.dshHome, "gatherthread-code-sync", createHash("sha256").update(config.workspacePath).digest("hex")),
      }),
    }),
    api: new HttpCollaborationClient({
      baseUrl: options.grant.apiUrl,
      bearerToken: options.grant.token,
      signal: ownerAbort.signal,
    }),
    runtimes: () => new Map([...codeRuntimes].flatMap(([id, connector]) => (
      connector.stopped || !connector.executionRuntimeId ? [] : [[id, connector.executionRuntimeId]]
    ))),
    isBusy: () => nativeWorkspace.isBusy(),
  });
  // Invalid consent affects code sync only; existing conversation execution stays available.
  await codeSync.start().catch(() => undefined);
  const codeTimer = setInterval(() => { void codeSync.poll(); }, 5_000);
  codeTimer.unref();
  let stopPromise: Promise<void> | undefined;
  return {
    localSyncStatuses: () => manager.localSyncStatuses(),
    setLocalAutoUpload: (sessionId, enabled) => manager.setLocalAutoUpload(sessionId, enabled),
    uploadLocalTurns: (sessionId) => manager.uploadLocalTurns(sessionId),
    codeSyncView: () => codeSync.view(),
    authorizeCodeSync: (enabled) => codeSync.authorize(enabled),
    executeCodeSync: (action) => codeSync.execute(action),
    stop() {
      stopPromise ??= (async () => {
        options.signal.removeEventListener("abort", abortFromRoot);
        clearInterval(codeTimer);
        ownerAbort.abort(new Error("GatherThread native DSH manager stopped"));
        await codeSync.stop();
        await manager.stop();
        nativeWorkspace.dispose();
      })();
      return stopPromise;
    },
  };
}

function createNativeManagedConnector(options: {
  readonly input: DshProjectConnectorFactoryInput;
  readonly context: unknown;
  readonly credential: string;
  readonly rootSignal: AbortSignal;
  readonly status: DshStatusController;
  readonly workspaceTitle: string;
}): DshManagedConnector {
  const sessionAbort = new AbortController();
  const abortFromRoot = () => sessionAbort.abort(options.rootSignal.reason);
  if (options.rootSignal.aborted) abortFromRoot();
  else options.rootSignal.addEventListener("abort", abortFromRoot, { once: true });
  const adoptsNativeSession = options.input.config.sessionId === options.input.config.dshSessionId;
  const supersededSessionId = adoptsNativeSession
    ? undefined
    : deriveDshSessionId(
      options.input.config.projectId,
      options.input.config.sessionId,
      options.input.config.workspacePath,
    );
  const host = createDshHostFacade({
    context: options.context,
    sessionId: options.input.config.dshSessionId,
    workspacePath: options.input.config.workspacePath,
    contextBinding: { apiUrl: options.input.config.apiUrl, projectId: options.input.config.projectId, sessionId: options.input.config.sessionId },
    provider: options.input.config.provider,
    model: options.input.config.model,
    agentPreset: DSH_NATIVE_AGENT_PRESET,
    ...(supersededSessionId === undefined ? {} : { supersededSessionId }),
    // A newly created DSH Session receives the GatherThread marker once;
    // resumed or adopted Sessions keep their locally editable titles. The
    // published status snapshot below stays on the bare cloud name.
    sessionTitle: managedDshSessionTitle(options.input.session),
    workspaceTitle: options.workspaceTitle,
  });
  const connector = new DshHostConnector({
    config: options.input.config,
    api: createHttpDshCollaborationApi({
      baseUrl: options.input.config.apiUrl,
      credential: options.credential,
      signal: sessionAbort.signal,
    }),
    host,
    stateStore: new FileConnectorStateStore(options.input.config.statePath),
    actorUserId: options.input.actorUserId,
    executionGate: options.input.executionGate,
    adoptExistingLocalSession: adoptsNativeSession,
    onBackgroundError: options.input.onBackgroundError,
    onLifecycle: (update) => {
      if (update.state === "stopped") {
        options.status.removeSession(options.input.session.id);
        return;
      }
      options.status.upsertSession({
        sessionId: options.input.session.id,
        title: options.input.session.name ?? options.input.session.id,
        state: update.state,
        ...(update.synced === true ? { synced: true } : {}),
      });
    },
  });
  let stopPromise: Promise<void> | undefined;
  return {
    get stopped() { return connector.stopped; },
    get executionRuntimeId() { return connector.executionRuntimeId; },
    async start() { await connector.start(); },
    localSyncStatus: () => connector.localSyncStatus(),
    setLocalAutoUpload: (enabled) => connector.setLocalAutoUpload(enabled),
    uploadLocalTurns: () => connector.uploadLocalTurns(),
    stop() {
      stopPromise ??= (async () => {
        options.rootSignal.removeEventListener("abort", abortFromRoot);
        sessionAbort.abort(new Error("GatherThread native DSH Session stopped"));
        await connector.stop();
      })();
      return stopPromise;
    },
  };
}

async function resolveNativeProjectWorkspace(
  grant: DshNativeGrant,
  binding: DshNativeBinding,
  signal: AbortSignal,
  homeDirectory?: string,
): Promise<string> {
  throwIfAborted(signal);
  const workspacePath = await ensureProjectWorkspace({
    apiUrl: grant.apiUrl,
    projectId: binding.projectId,
    projectName: binding.projectName,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  });
  throwIfAborted(signal);
  return workspacePath;
}

function nativeDshHomeFromEnvironment(): string | undefined {
  const value = process.env.DSH_HOME?.trim();
  return value ? path.resolve(value) : undefined;
}

async function listNativeLlmCatalog(
  contextValue: unknown,
  signal: AbortSignal,
): Promise<DshNativeCatalog["providers"]> {
  const llm = requireLlm(contextValue);
  const providers = parseProviders(llm.listProviders()).slice(0, MAX_CATALOG_PROVIDERS);
  let remainingModels = MAX_CATALOG_MODELS;
  const result: Array<DshNativeCatalog["providers"][number]> = [];
  for (const provider of providers) {
    throwIfAborted(signal);
    const models = parseModels(await llm.listModels(provider.id), provider.id)
      .slice(0, remainingModels);
    remainingModels -= models.length;
    result.push({ ...provider, models });
    if (remainingModels === 0) break;
  }
  return result;
}

async function listNativeExecutionProfiles(
  contextValue: unknown,
  provider: string,
  signal: AbortSignal,
): Promise<readonly DshRuntimeExecutionProfile[]> {
  const llm = requireLlm(contextValue);
  const models = parseModels(await llm.listModels(provider), provider)
    .slice(0, MAX_EXECUTION_PROFILES);
  const profiles: DshRuntimeExecutionProfile[] = [];
  for (const model of models) {
    throwIfAborted(signal);
    const resolved = asObject(await llm.resolveModelInfo(provider, model.id, signal));
    if (resolved === undefined || resolved.provider !== provider || resolved.id !== model.id) {
      throw new Error("DeepSeek Harness did not resolve an advertised provider/model exactly");
    }
    const reasoning = parseNativeReasoningMetadata(resolved.reasoning, provider, model.id);
    profiles.push({
      provider,
      model: model.id,
      ...reasoning,
    });
  }
  return normalizeExecutionProfiles(profiles, provider);
}

async function validateNativeLlmModel(
  contextValue: unknown,
  provider: string,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  const resolved = asObject(await requireLlm(contextValue).resolveModelInfo(provider, model, signal));
  if (resolved === undefined || resolved.provider !== provider || resolved.id !== model) {
    throw new Error("DeepSeek Harness did not resolve the selected provider/model exactly");
  }
}

function parseProviders(values: readonly unknown[]): Array<{ id: string; name: string }> {
  if (!Array.isArray(values)) throw new Error("DeepSeek Harness returned an invalid provider catalog");
  const seen = new Set<string>();
  return values.map((value) => {
    const input = asObject(value);
    const id = boundedPublicText(input?.id, "provider id", 80);
    const nameValue = boundedPublicText(input?.name, "provider name", 160);
    if (seen.has(id)) throw new Error("DeepSeek Harness returned duplicate providers");
    seen.add(id);
    return { id, name: nameValue };
  });
}

function parseModels(
  values: readonly unknown[],
  provider: string,
): Array<{ id: string; name: string }> {
  if (!Array.isArray(values)) throw new Error("DeepSeek Harness returned an invalid model catalog");
  const seen = new Set<string>();
  return values.map((value) => {
    const input = asObject(value);
    if (input?.provider !== provider) {
      throw new Error("DeepSeek Harness returned a model for an unexpected provider");
    }
    const id = boundedPublicText(input.id, "model id", 160);
    const nameValue = boundedPublicText(input.name, "model name", 160);
    if (seen.has(id)) throw new Error("DeepSeek Harness returned duplicate models");
    seen.add(id);
    return { id, name: nameValue };
  });
}

function parseNativeReasoningMetadata(
  value: unknown,
  provider: string,
  model: string,
): Pick<DshRuntimeExecutionProfile, "reasoningEfforts" | "defaultReasoningEffort"> {
  if (value === undefined) return {};
  const reasoning = asObject(value);
  if (reasoning === undefined || !Array.isArray(reasoning.efforts)) {
    throw new Error(`DeepSeek Harness returned invalid reasoning metadata for ${provider}/${model}`);
  }
  const reasoningEfforts = reasoning.efforts.map((entry) => {
    const effort = asObject(entry);
    return boundedPublicText(effort?.id, "reasoning effort id", 80);
  });
  if (reasoningEfforts.length === 0
    || reasoningEfforts.length > MAX_REASONING_EFFORTS
    || new Set(reasoningEfforts).size !== reasoningEfforts.length) {
    throw new Error(`DeepSeek Harness returned invalid reasoning efforts for ${provider}/${model}`);
  }
  const defaultReasoningEffort = reasoning.defaultEffort === undefined
    ? undefined
    : boundedPublicText(reasoning.defaultEffort, "default reasoning effort", 80);
  if (defaultReasoningEffort !== undefined && !reasoningEfforts.includes(defaultReasoningEffort)) {
    throw new Error(`DeepSeek Harness returned an unknown default reasoning effort for ${provider}/${model}`);
  }
  return {
    reasoningEfforts,
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
  };
}

function normalizeExecutionProfiles(
  values: readonly unknown[],
  expectedProvider: string,
): readonly DshRuntimeExecutionProfile[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_EXECUTION_PROFILES) {
    throw new Error("DeepSeek Harness returned an invalid execution profile catalog");
  }
  const seen = new Set<string>();
  return values.map((value) => {
    const profile = asObject(value);
    const provider = boundedPublicText(profile?.provider, "execution profile provider", 80);
    const model = boundedPublicText(profile?.model, "execution profile model", 160);
    if (provider !== expectedProvider) {
      throw new Error("DeepSeek Harness returned an execution profile for an unexpected provider");
    }
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) throw new Error("DeepSeek Harness returned duplicate execution profiles");
    seen.add(key);
    const rawReasoningEfforts = profile?.reasoningEfforts;
    if (rawReasoningEfforts !== undefined && !Array.isArray(rawReasoningEfforts)) {
      throw new Error("DeepSeek Harness returned invalid execution profile reasoning efforts");
    }
    const reasoningEfforts = rawReasoningEfforts === undefined
      ? undefined
      : rawReasoningEfforts.map((effort: unknown) => boundedPublicText(
        effort,
        "execution profile reasoning effort",
        80,
      ));
    if (reasoningEfforts !== undefined
      && (reasoningEfforts.length === 0
        || reasoningEfforts.length > MAX_REASONING_EFFORTS
        || new Set(reasoningEfforts).size !== reasoningEfforts.length)) {
      throw new Error("DeepSeek Harness returned invalid execution profile reasoning efforts");
    }
    const defaultReasoningEffort = profile?.defaultReasoningEffort === undefined
      ? undefined
      : boundedPublicText(
        profile.defaultReasoningEffort,
        "execution profile default reasoning effort",
        80,
      );
    if (defaultReasoningEffort !== undefined
      && !reasoningEfforts?.includes(defaultReasoningEffort)) {
      throw new Error("DeepSeek Harness returned an invalid execution profile default reasoning effort");
    }
    return {
      provider,
      model,
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    };
  });
}

function cloneExecutionProfiles(
  values: readonly DshRuntimeExecutionProfile[],
): readonly DshRuntimeExecutionProfile[] {
  return values.map((value) => ({
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEfforts === undefined ? {} : {
      reasoningEfforts: [...value.reasoningEfforts],
    }),
    ...(value.defaultReasoningEffort === undefined ? {} : {
      defaultReasoningEffort: value.defaultReasoningEffort,
    }),
  }));
}

function requireConnection(contextValue: unknown): NativeRpcConnectionLike {
  const input = asObject(contextValue);
  const connection = input === undefined ? undefined : asObject(Reflect.get(input, "connection"));
  const rpc = connection === undefined ? undefined : asObject(connection.rpc);
  if (connection === undefined || rpc === undefined || typeof rpc.handle !== "function") {
    throw new Error("Pinned DSH Host service connection is unavailable or incompatible");
  }
  return connection as unknown as NativeRpcConnectionLike;
}

function requireLlm(contextValue: unknown): NativeLlmLike {
  const input = asObject(contextValue);
  const direct = input === undefined ? undefined : Reflect.get(input, "llm");
  const fallback = typeof input?.get === "function"
    ? (input.get as (name: string) => unknown)("llm")
    : undefined;
  const llm = asObject(direct ?? fallback);
  if (llm === undefined
    || typeof llm.listProviders !== "function"
    || typeof llm.listModels !== "function"
    || typeof llm.resolveModelInfo !== "function") {
    throw new Error("Pinned DSH Host service llm is unavailable or incompatible");
  }
  return llm as unknown as NativeLlmLike;
}

function rpcSuccess(value: unknown): NativeRpcResult {
  return { ok: true, value };
}

function rpcFailure(code: string, message: string): NativeRpcResult {
  return { ok: false, error: { code, message, details: {} } };
}

function combineSignal(root: AbortSignal, operation?: AbortSignal): AbortSignal {
  return operation === undefined ? root : AbortSignal.any([root, operation]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("GatherThread DSH operation aborted");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/iu.test(error.message));
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function exactInput(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  const input = asObject(value);
  if (input === undefined || Object.keys(input).some((key) => !keys.has(key))) {
    throw new Error("GatherThread DSH request has an invalid shape");
  }
  return input;
}

function requiredInputText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`GatherThread DSH ${label} is invalid`);
  }
  return value.trim();
}

function safeInputIdentifier(value: unknown, label: string): string {
  const text = requiredInputText(value, label, 128);
  if (!/^[A-Za-z0-9._:-]+$/u.test(text)) {
    throw new Error(`GatherThread DSH ${label} is invalid`);
  }
  return text;
}

function boundedPublicText(value: unknown, label: string, maximum: number): string {
  return requiredInputText(value, label, maximum);
}

function absoluteInputPath(value: unknown, label: string): string {
  const text = requiredInputText(value, label, 4_096);
  if (!pathIsAbsolute(text)) throw new Error(`native DSH config.${label} must be absolute`);
  return text;
}

function pathIsAbsolute(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/u.test(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
