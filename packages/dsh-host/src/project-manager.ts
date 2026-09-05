import path from "node:path";
import {
  refreshProjectSessionPermissions,
  type CurrentActor,
  type ProjectHarnessDeactivationReason,
  type SessionSummary,
} from "@gatherthread/bridge";
import {
  deriveDshSessionId,
  type EnabledDshHostConfig,
  type EnabledDshProjectHostConfig,
} from "./config.js";
import { BoundedDshExecutionGate } from "./execution-gate.js";
import type {
  DshExecutionGate,
  DshProjectCollaborationApi,
} from "./types.js";

export interface DshManagedConnector {
  readonly stopped: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DshProjectConnectorFactoryInput {
  readonly config: EnabledDshHostConfig;
  readonly session: SessionSummary;
  readonly actorUserId: string;
  readonly executionGate: DshExecutionGate;
  readonly onBackgroundError: (error: Error) => void;
}

export type DshProjectConnectorFactory = (
  input: DshProjectConnectorFactoryInput,
) => DshManagedConnector;

export interface DshProjectManagerOptions {
  readonly config: EnabledDshProjectHostConfig;
  readonly api: DshProjectCollaborationApi;
  readonly createConnector: DshProjectConnectorFactory;
  readonly onBackgroundError?: (error: Error) => void;
  readonly now?: () => number;
  readonly onStatus?: (update: DshProjectManagerStatusUpdate) => void;
}

export type DshProjectManagerStatusUpdate =
  | {
    readonly state: "connected";
    readonly eligibleSessions: readonly SessionSummary[];
    readonly activeSessionIds: readonly string[];
  }
  | { readonly state: "offline" }
  | { readonly state: "error" }
  | { readonly state: "stopped" };

export type DshProjectRefreshResult =
  | {
    status: "updated";
    eligibleSessionIds: string[];
    activeSessionIds: string[];
    errors: Error[];
  }
  | { status: "transient_failure"; error: unknown }
  | { status: "project_inaccessible"; error: Error };

interface ManagedBinding {
  readonly connector: DshManagedConnector;
  phase: "starting" | "active";
  deactivateLocalPublishing(reason: ProjectHarnessDeactivationReason): Promise<void>;
}

interface RetryState {
  attempts: number;
  nextAttemptAt: number;
}

/**
 * Explicitly enabled project binding. Discovery is authoritative, while each
 * Session retains a distinct connector, DSH Session, cursor, outbox and abort
 * scope. No server or canonical schema extension is required.
 */
export class DshProjectManager {
  readonly #config: EnabledDshProjectHostConfig;
  readonly #api: DshProjectCollaborationApi;
  readonly #createConnector: DshProjectConnectorFactory;
  readonly #onBackgroundError: ((error: Error) => void) | undefined;
  readonly #now: () => number;
  readonly #executionGate: BoundedDshExecutionGate;
  readonly #onStatus: ((update: DshProjectManagerStatusUpdate) => void) | undefined;
  readonly #managed = new Map<string, ManagedBinding>();
  readonly #retries = new Map<string, RetryState>();
  #actor: CurrentActor | undefined;
  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refreshPromise: Promise<DshProjectRefreshResult> | undefined;
  #stopPromise: Promise<void> | undefined;
  #discoveryFailures = 0;

  constructor(options: DshProjectManagerOptions) {
    this.#config = options.config;
    this.#api = options.api;
    this.#createConnector = options.createConnector;
    this.#onBackgroundError = options.onBackgroundError;
    this.#now = options.now ?? Date.now;
    this.#executionGate = new BoundedDshExecutionGate(
      options.config.maxConcurrentSessions,
    );
    this.#onStatus = options.onStatus;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  activeSessionIds(): string[] {
    return [...this.#managed]
      .filter(([, binding]) => binding.phase === "active" && !binding.connector.stopped)
      .map(([sessionId]) => sessionId)
      .sort();
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("DSH project manager is already started");
    if (this.#stopped) throw new Error("DSH project manager cannot restart after disposal");
    this.#started = true;
    try {
      const actor = await this.#api.getCurrentActor();
      if (actor.deviceId !== this.#config.deviceId) {
        throw new Error("Configured DSH device identity does not match the authenticated actor");
      }
      this.#actor = actor;
      const initial = await this.#refresh();
      if (initial.status === "project_inaccessible") throw initial.error;
      if (initial.status === "transient_failure") {
        throw publicError(initial.error, "Initial GatherThread Project discovery failed");
      }
      this.#scheduleNextRefresh();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  refreshOnce(): Promise<DshProjectRefreshResult> {
    if (!this.#started || this.#stopped) {
      return Promise.reject(new Error("DSH project manager is not running"));
    }
    return this.#refresh();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= (async () => {
      this.#stopped = true;
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#executionGate.close(new Error("DSH project manager stopped"));
      await this.#deactivateAll();
      const refresh = this.#refreshPromise;
      if (refresh !== undefined) {
        try {
          await refresh;
        } catch {
          // An in-flight attach or discovery may observe connector disposal.
        }
      }
      await this.#deactivateAll();
      this.#retries.clear();
      this.#notifyStatus({ state: "stopped" });
    })();
    return this.#stopPromise;
  }

  #refresh(): Promise<DshProjectRefreshResult> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    this.#refreshPromise = this.#performRefresh().finally(() => {
      this.#refreshPromise = undefined;
    });
    return this.#refreshPromise;
  }

  async #performRefresh(): Promise<DshProjectRefreshResult> {
    const actor = this.#requireActor();
    if (this.#stopped) throw new Error("DSH project manager stopped during discovery");

    for (const [sessionId, binding] of [...this.#managed]) {
      if (!binding.connector.stopped) continue;
      this.#managed.delete(sessionId);
      try {
        await binding.connector.stop();
      } catch (error) {
        this.#reportError(publicError(error, "Stopped DSH Session connector cleanup failed"));
      }
      this.#recordFailure(sessionId);
    }

    const permissions = await refreshProjectSessionPermissions({
      loadSessions: () => this.#api.listProjectSessions(this.#config.projectId),
      actorUserId: actor.id,
      managed: this.#managed,
      harness: {},
    });
    if (permissions.status === "project_inaccessible") {
      this.#stopped = true;
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#executionGate.close(new Error("GatherThread Project became inaccessible"));
      await this.#deactivateAll();
      this.#reportError(permissions.error);
      this.#notifyStatus({ state: "error" });
      return { status: "project_inaccessible", error: permissions.error };
    }
    if (permissions.status === "transient_failure") {
      this.#discoveryFailures += 1;
      this.#reportError(publicError(
        permissions.error,
        "GatherThread Project discovery failed transiently",
      ));
      this.#notifyStatus({ state: "offline" });
      return permissions;
    }

    this.#discoveryFailures = 0;
    for (const error of permissions.errors) this.#reportError(error);
    const eligibleIds = new Set(permissions.eligibleSessions.map((session) => session.id));
    for (const sessionId of [...this.#retries.keys()]) {
      if (!eligibleIds.has(sessionId)) this.#retries.delete(sessionId);
    }
    const now = this.#now();
    const candidates = permissions.eligibleSessions.filter((session) => {
      if (this.#managed.has(session.id)) return false;
      return (this.#retries.get(session.id)?.nextAttemptAt ?? 0) <= now;
    });
    const attachErrors = await runBounded(
      candidates,
      this.#config.maxConcurrentSessions,
      (session) => this.#attach(session, actor.id),
    );
    for (const error of attachErrors) this.#reportError(error);
    const result: DshProjectRefreshResult = {
      status: "updated",
      eligibleSessionIds: [...eligibleIds].sort(),
      activeSessionIds: this.activeSessionIds(),
      errors: [...permissions.errors, ...attachErrors],
    };
    this.#notifyStatus({
      state: "connected",
      eligibleSessions: permissions.eligibleSessions,
      activeSessionIds: result.activeSessionIds,
    });
    return result;
  }

  async #attach(session: SessionSummary, actorUserId: string): Promise<void> {
    if (this.#stopped || this.#managed.has(session.id)) return;
    let binding: ManagedBinding | undefined;
    try {
      const connector = this.#createConnector({
        config: projectSessionConfig(this.#config, session.id),
        session,
        actorUserId,
        executionGate: this.#executionGate,
        onBackgroundError: (error) => this.#reportError(error),
      });
      binding = {
        connector,
        phase: "starting",
        deactivateLocalPublishing: async () => connector.stop(),
      };
      this.#managed.set(session.id, binding);
      await connector.start();
      if (this.#stopped || connector.stopped || this.#managed.get(session.id) !== binding) {
        await connector.stop();
        this.#managed.delete(session.id);
        return;
      }
      binding.phase = "active";
      this.#retries.delete(session.id);
    } catch (error) {
      if (binding !== undefined && this.#managed.get(session.id) === binding) {
        this.#managed.delete(session.id);
      }
      try {
        await binding?.connector.stop();
      } catch (stopError) {
        this.#reportError(publicError(stopError, "DSH Session connector cleanup failed"));
      }
      if (this.#stopped) return;
      this.#recordFailure(session.id);
      throw publicError(error, `DSH Session ${session.id} failed to attach`);
    }
  }

  #recordFailure(sessionId: string): void {
    const attempts = (this.#retries.get(sessionId)?.attempts ?? 0) + 1;
    this.#retries.set(sessionId, {
      attempts,
      nextAttemptAt: this.#now() + retryDelay(this.#config, attempts),
    });
  }

  #scheduleNextRefresh(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    const now = this.#now();
    let delay = this.#discoveryFailures > 0
      ? retryDelay(this.#config, this.#discoveryFailures)
      : this.#config.refreshIntervalMs;
    for (const retry of this.#retries.values()) {
      delay = Math.min(delay, Math.max(1, retry.nextAttemptAt - now));
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refreshOnce()
        .catch((error: unknown) => this.#reportError(publicError(
          error,
          "DSH Project refresh failed",
        )))
        .finally(() => this.#scheduleNextRefresh());
    }, delay);
    this.#timer.unref?.();
  }

  async #deactivateAll(): Promise<void> {
    const bindings = [...this.#managed.values()];
    this.#managed.clear();
    const results = await Promise.allSettled(bindings.map((binding) => binding.connector.stop()));
    for (const result of results) {
      if (result.status === "rejected") {
        this.#reportError(publicError(result.reason, "DSH Session connector cleanup failed"));
      }
    }
  }

  #requireActor(): CurrentActor {
    if (this.#actor === undefined) throw new Error("Authenticated GatherThread actor is unavailable");
    return this.#actor;
  }

  #reportError(error: Error): void {
    this.#onBackgroundError?.(error);
  }

  #notifyStatus(update: DshProjectManagerStatusUpdate): void {
    try {
      this.#onStatus?.(update);
    } catch {
      // Public status is observational and must never affect Session discovery.
    }
  }
}

export function projectSessionConfig(
  config: EnabledDshProjectHostConfig,
  sessionId: string,
): EnabledDshHostConfig {
  const dshSessionId = deriveDshSessionId(config.projectId, sessionId, config.workspacePath);
  return {
    enabled: true,
    bindingMode: "single",
    apiUrl: config.apiUrl,
    credentialReference: config.credentialReference,
    projectId: config.projectId,
    ...(config.projectName === undefined ? {} : { projectName: config.projectName }),
    sessionId,
    deviceId: config.deviceId,
    workspacePath: config.workspacePath,
    statePath: path.join(config.stateRoot, `${dshSessionId}.json`),
    provider: config.provider,
    model: config.model,
    pollIntervalMs: config.pollIntervalMs,
    pollLimit: config.pollLimit,
    shareToolEvents: config.shareToolEvents,
    dshSessionId,
  };
}

function retryDelay(config: EnabledDshProjectHostConfig, attempts: number): number {
  return Math.min(
    config.retryMaxMs,
    config.retryBaseMs * 2 ** Math.min(attempts - 1, 30),
  );
}

async function runBounded<T>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<void>,
): Promise<Error[]> {
  const errors: Error[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index];
      index += 1;
      if (current === undefined) continue;
      try {
        await operation(current);
      } catch (error) {
        errors.push(publicError(error, "DSH Session attach failed"));
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

function publicError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
