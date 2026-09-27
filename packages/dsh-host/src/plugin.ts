import {
  assertSafeDshPaths,
  assertSafeDshStateRoot,
  assertSafeDshEnvironment,
  parseDshHostConfig,
  resolveCredentialReference,
} from "./config.js";
import { createHttpDshCollaborationApi } from "./collaboration-api.js";
import { DshHostConnector } from "./connector.js";
import {
  createDshHostFacade,
  registerDshPluginDisposer,
} from "./dsh-compat.js";
import { FileConnectorStateStore } from "./state-store.js";
import {
  DshProjectManager,
  type DshManagedConnector,
  type DshProjectConnectorFactoryInput,
} from "./project-manager.js";
import {
  bindOptionalDshStatusRoute,
  DshStatusController,
} from "./status.js";
import type { DshConnectorLifecycleUpdate } from "./types.js";

export const name = "gatherthread-dsh-host";
export const inject = ["agents", "sessions", "sessionPersistence", "llm"] as const;

/**
 * Cordis Host entry. Loading the module is inert: an explicit `enabled: true`
 * profile row is required before it reads environment state or opens either a
 * GatherThread connection or a DSH Session.
 */
export async function apply(context: unknown, rawConfig?: unknown): Promise<void> {
  const config = parseDshHostConfig(rawConfig);
  if (!config.enabled) return;
  assertSafeDshEnvironment();
  if (config.bindingMode === "single") await assertSafeDshPaths(config);
  else await assertSafeDshStateRoot(config);
  const status = new DshStatusController({
    bindingMode: config.bindingMode,
    projectName: config.projectName ?? config.projectId,
  });
  let statusDispose: (() => Promise<void>) | undefined;
  const credential = resolveCredentialReference(config.credentialReference);
  const abort = new AbortController();
  let owner: { stop(): Promise<void> } | undefined;
  registerDshPluginDisposer(context, async () => {
    abort.abort(new Error("GatherThread DSH Host plugin unloaded"));
    await owner?.stop();
    status.setConnection("stopped");
    await statusDispose?.();
  });
  try {
    statusDispose = bindOptionalDshStatusRoute(context, status);
    const api = createHttpDshCollaborationApi({
      baseUrl: config.apiUrl,
      credential,
      signal: abort.signal,
    });
    if (config.bindingMode === "single") {
      let sessionTitle = config.sessionId;
      status.upsertSession({
        sessionId: config.sessionId,
        title: sessionTitle,
        state: "connecting",
      });
      const actor = await api.getCurrentActor();
      assertActorDevice(actor.deviceId, config.deviceId);
      const host = createDshHostFacade({
        context,
        sessionId: config.dshSessionId,
        workspacePath: config.workspacePath,
        contextBinding: { apiUrl: config.apiUrl, projectId: config.projectId, sessionId: config.sessionId },
        provider: config.provider,
        model: config.model,
      });
      const connector = new DshHostConnector({
        config,
        api,
        host,
        stateStore: new FileConnectorStateStore(config.statePath),
        actorUserId: actor.id,
        onLifecycle: (update) => {
          sessionTitle = update.session?.name ?? sessionTitle;
          updateSingleStatus(status, config.sessionId, sessionTitle, update);
        },
      });
      owner = connector;
      await connector.start();
      return;
    }

    const manager = new DshProjectManager({
      config,
      api,
      createConnector: (input) => createManagedConnector({
        input,
        context,
        credential,
        rootSignal: abort.signal,
        status,
      }),
      onStatus: (update) => {
        if (update.state === "connected") {
          status.reconcileProjectSessions(update.eligibleSessions, update.activeSessionIds);
          status.setConnection("connected");
        } else if (update.state === "offline") {
          status.markSessionsOffline();
          status.setConnection("offline");
        } else {
          status.setConnection(update.state);
        }
      },
    });
    owner = manager;
    await manager.start();
  } catch (error) {
    abort.abort(new Error("GatherThread DSH Host plugin initialization failed"));
    await Promise.allSettled([
      owner?.stop(),
      statusDispose?.(),
    ]);
    throw error;
  }
}

function createManagedConnector(options: {
  input: DshProjectConnectorFactoryInput;
  context: unknown;
  credential: string;
  rootSignal: AbortSignal;
  status: DshStatusController;
}): DshManagedConnector {
  const sessionAbort = new AbortController();
  const abortFromRoot = () => sessionAbort.abort(options.rootSignal.reason);
  if (options.rootSignal.aborted) abortFromRoot();
  else options.rootSignal.addEventListener("abort", abortFromRoot, { once: true });
  const api = createHttpDshCollaborationApi({
    baseUrl: options.input.config.apiUrl,
    credential: options.credential,
    signal: sessionAbort.signal,
  });
  const host = createDshHostFacade({
    context: options.context,
    sessionId: options.input.config.dshSessionId,
    workspacePath: options.input.config.workspacePath,
    contextBinding: { apiUrl: options.input.config.apiUrl, projectId: options.input.config.projectId, sessionId: options.input.config.sessionId },
    provider: options.input.config.provider,
    model: options.input.config.model,
  });
  const connector = new DshHostConnector({
    config: options.input.config,
    api,
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
    async start() {
      try {
        await connector.start();
      } catch (error) {
        options.status.upsertSession({
          sessionId: options.input.session.id,
          title: options.input.session.name ?? options.input.session.id,
          state: "error",
        });
        throw error;
      }
    },
    stop() {
      stopPromise ??= (async () => {
        options.rootSignal.removeEventListener("abort", abortFromRoot);
        sessionAbort.abort(new Error("GatherThread DSH Session binding stopped"));
        await connector.stop();
      })();
      return stopPromise;
    },
  };
}

function updateSingleStatus(
  status: DshStatusController,
  sessionId: string,
  sessionTitle: string,
  update: DshConnectorLifecycleUpdate,
): void {
  if (update.state === "stopped") {
    status.setConnection("stopped");
    return;
  }
  status.upsertSession({
    sessionId,
    title: sessionTitle,
    state: update.state,
    ...(update.synced === true ? { synced: true } : {}),
  });
  status.setConnection(
    update.state === "idle" || update.state === "running"
      ? "connected"
      : update.state,
  );
}

function assertActorDevice(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("Configured DSH device identity does not match the authenticated actor");
  }
}
