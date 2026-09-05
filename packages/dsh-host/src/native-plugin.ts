import type { ProjectSummary } from "@gatherthread/bridge";
import { createHttpDshCollaborationApi } from "./collaboration-api.js";
import {
  assertSafeDshStateRoot,
  type EnabledDshProjectHostConfig,
} from "./config.js";
import { DshHostConnector } from "./connector.js";
import {
  createDshHostFacade,
  DSH_NPM_COMPATIBILITY,
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

export const name = "gatherthread-dsh-native";
export const inject = [
  "agents",
  "sessions",
  "sessionPersistence",
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
]);
const MAX_CATALOG_PROVIDERS = 64;
const MAX_CATALOG_MODELS = 256;

export interface DshNativePluginConfig {
  readonly enabled: boolean;
  readonly workspacePath: string;
  readonly dshHome?: string;
  readonly officialServerUrl?: string;
}

export interface DshNativePublicState {
  readonly schemaVersion: 1;
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
  readonly binding?: DshNativeBinding;
  readonly pairing?: DshNativePairingView;
  readonly recoverableError?: "pairing_failed" | "connection_failed";
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
  readonly officialServerUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly createOwner?: (
    grant: DshNativeGrant,
    binding: DshNativeBinding,
    signal: AbortSignal,
    status: DshStatusController,
  ) => Promise<NativeOwner>;
  readonly listProjects?: (
    grant: DshNativeGrant,
    signal: AbortSignal,
  ) => Promise<ProjectSummary[]>;
  readonly listCatalog?: (signal: AbortSignal) => Promise<DshNativeCatalog["providers"]>;
  readonly validateModel?: (
    provider: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<void>;
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
  #grant: DshNativeGrant | undefined;
  #owner: NativeOwner | undefined;
  #pairing: DshNativePairingIntent | undefined;
  #pairingAbort: AbortController | undefined;
  #pairingTask: Promise<void> | undefined;
  #recoverableError: DshNativePublicState["recoverableError"];
  #started = false;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: DshNativeHostControllerOptions) {
    this.#options = options;
    this.#credentials = new DshNativeCredentialStore(options.context);
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("GatherThread native DSH controller is already started");
    if (this.#disposed) throw new Error("GatherThread native DSH controller is disposed");
    this.#started = true;
    this.#grant = await this.#credentials.load();
    if (this.#grant?.binding === undefined) {
      this.#options.status.setConnection("stopped");
      return;
    }
    try {
      await this.#activate(this.#grant, this.#grant.binding);
    } catch {
      this.#recoverableError = "connection_failed";
      this.#options.status.setConnection("error");
    }
  }

  publicState(): DshNativePublicState {
    const authorization = this.#pairing !== undefined
      ? "pairing"
      : this.#grant === undefined ? "unpaired" : "paired";
    return {
      schemaVersion: 1,
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
        ...(this.#grant.binding === undefined ? {} : { binding: { ...this.#grant.binding } }),
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
    if (this.#pairingTask !== undefined) {
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
      intent = await beginDshNativePairing({
        serverUrl: requiredInputText(input.serverUrl, "serverUrl", 2_048),
        deviceName: requiredInputText(input.deviceName, "deviceName", 120),
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        signal: beginSignal,
      });
    } catch (error) {
      this.#abort.signal.removeEventListener("abort", abortFromRoot);
      this.#pairingAbort = undefined;
      operationAbort.abort();
      throw error;
    }
    if (requestSignal?.aborted === true || this.#disposed) {
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
    const task = this.#pairingTask;
    this.#pairingAbort?.abort(new Error("GatherThread DSH pairing canceled"));
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
    const grant = this.#requireGrant();
    const input = exactInput(inputValue, new Set(["projectId", "provider", "model"]));
    const projectId = safeInputIdentifier(input.projectId, "projectId");
    const provider = requiredInputText(input.provider, "provider", 80);
    const model = requiredInputText(input.model, "model", 160);
    const operationSignal = combineSignal(this.#abort.signal, signal);
    const projects = activeNativeProjects(await this.#listProjects(grant, operationSignal));
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      throw new Error("The selected GatherThread Project is unavailable or archived");
    }
    await this.#validateModel(provider, model, operationSignal);
    const binding: DshNativeBinding = {
      projectId: project.id,
      projectName: boundedPublicText(project.name, "project name", 160),
      provider,
      model,
    };
    await this.#stopOwner();
    const nextGrant: DshNativeGrant = { ...grant, binding };
    try {
      await this.#activate(nextGrant, binding);
      throwIfAborted(operationSignal);
      this.#grant = await this.#credentials.save(nextGrant);
      this.#recoverableError = undefined;
      return this.publicState();
    } catch (error) {
      await this.#stopOwner();
      this.#recoverableError = "connection_failed";
      this.#options.status.setConnection("error");
      throw error;
    }
  }

  async disconnect(): Promise<DshNativePublicState> {
    this.#assertAvailable();
    await this.cancelPairing();
    await this.#stopOwner();
    await this.#credentials.clear();
    this.#grant = undefined;
    this.#recoverableError = undefined;
    this.#options.status.setProjectName("GatherThread / 共序");
    this.#options.status.setConnection("stopped");
    return this.publicState();
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= (async () => {
      this.#disposed = true;
      this.#abort.abort(new Error("GatherThread native DSH plugin unloaded"));
      this.#pairingAbort?.abort(this.#abort.signal.reason);
      await Promise.allSettled([
        this.#pairingTask,
        this.#stopOwner(),
      ]);
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
          schemaVersion: 1,
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

  async #activate(grant: DshNativeGrant, binding: DshNativeBinding): Promise<void> {
    this.#options.status.setProjectName(binding.projectName);
    this.#options.status.setConnection("connecting");
    const createOwner = this.#options.createOwner ?? ((grantValue, bindingValue, signal, status) => (
      createProductionOwner({
        context: this.#options.context,
        grant: grantValue,
        binding: bindingValue,
        workspacePath: this.#options.workspacePath,
        ...(this.#options.dshHome === undefined ? {} : { dshHome: this.#options.dshHome }),
        signal,
        status,
      })
    ));
    const owner = await createOwner(grant, binding, this.#abort.signal, this.#options.status);
    if (this.#disposed || this.#abort.signal.aborted) {
      await owner.stop();
      throw new Error("GatherThread native DSH plugin unloaded during activation");
    }
    this.#owner = owner;
  }

  async #stopOwner(): Promise<void> {
    const owner = this.#owner;
    this.#owner = undefined;
    await owner?.stop();
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
    if (!this.#started || this.#disposed) {
      throw new Error("GatherThread native DSH controller is unavailable");
    }
  }
}

/** Installed bundle entry. The explicit bundle row supplies enabled: true. */
export async function apply(context: unknown, rawConfig?: unknown): Promise<void> {
  const config = parseNativePluginConfig(rawConfig);
  if (!config.enabled) return;
  const status = new DshStatusController({
    bindingMode: "project",
    projectName: "GatherThread / 共序",
  });
  const controller = new DshNativeHostController({
    context,
    status,
    workspacePath: config.workspacePath,
    ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
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
}): Promise<NativeOwner> {
  const config = createNativeProjectConfig({
    grant: options.grant,
    binding: options.binding,
    workspacePath: options.workspacePath,
    ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
  });
  await assertSafeDshStateRoot(config);
  const ownerAbort = new AbortController();
  const abortFromRoot = () => ownerAbort.abort(options.signal.reason);
  if (options.signal.aborted) abortFromRoot();
  else options.signal.addEventListener("abort", abortFromRoot, { once: true });
  const api = createHttpDshCollaborationApi({
    baseUrl: options.grant.apiUrl,
    credential: options.grant.token,
    signal: ownerAbort.signal,
  });
  const manager = new DshProjectManager({
    config,
    api,
    createConnector: (input) => createNativeManagedConnector({
      input,
      context: options.context,
      credential: options.grant.token,
      rootSignal: ownerAbort.signal,
      status: options.status,
    }),
    onStatus: (update) => updateNativeManagerStatus(options.status, update),
  });
  try {
    await manager.start();
  } catch (error) {
    ownerAbort.abort(new Error("GatherThread native DSH manager failed to start"));
    options.signal.removeEventListener("abort", abortFromRoot);
    await manager.stop();
    throw error;
  }
  let stopPromise: Promise<void> | undefined;
  return {
    stop() {
      stopPromise ??= (async () => {
        options.signal.removeEventListener("abort", abortFromRoot);
        ownerAbort.abort(new Error("GatherThread native DSH manager stopped"));
        await manager.stop();
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
}): DshManagedConnector {
  const sessionAbort = new AbortController();
  const abortFromRoot = () => sessionAbort.abort(options.rootSignal.reason);
  if (options.rootSignal.aborted) abortFromRoot();
  else options.rootSignal.addEventListener("abort", abortFromRoot, { once: true });
  const host = createDshHostFacade({
    context: options.context,
    sessionId: options.input.config.dshSessionId,
    workspacePath: options.input.config.workspacePath,
    provider: options.input.config.provider,
    model: options.input.config.model,
    agentPreset: "read-only",
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
    async start() { await connector.start(); },
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

function updateNativeManagerStatus(
  status: DshStatusController,
  update: DshProjectManagerStatusUpdate,
): void {
  if (update.state === "connected") {
    status.reconcileProjectSessions(update.eligibleSessions, update.activeSessionIds);
    status.setConnection("connected");
  } else if (update.state === "offline") {
    status.markSessionsOffline();
    status.setConnection("offline");
  } else {
    status.setConnection(update.state);
  }
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
