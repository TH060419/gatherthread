import { readdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import type { ZcodeCliProbe, ZcodeCommandSpec } from "./zcode-compat.js";
import {
  pendingZcodeLocalSessionId,
  ZcodeSessionExecutor,
  loadZcodeState,
} from "./zcode-executor.js";
import type {
  ProjectHarnessAdapter,
  ProjectHarnessDescriptor,
  ProjectHarnessPreflight,
  ProjectHarnessSessionBinding,
} from "./project-harness.js";
import type { SessionSummary } from "./types.js";

export interface ZcodeProjectHarnessOptions {
  probe: ZcodeCliProbe;
  spec: ZcodeCommandSpec;
  workspacePath: string;
  provider: string;
  model: string;
  /** Share redacted tool events; default false (final-answer-only). */
  shareToolEvents?: boolean;
  /** Exact tool names eligible for sharing when shareToolEvents is on. */
  toolAllowlist?: readonly string[];
  /** Connector state root; scanned during preflight to recover native ids. */
  stateRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

interface KnownSessionIdentity {
  localSessionId?: string;
  observedModel?: string;
}

/**
 * Project-scoped ZCode harness. GatherThread owns project authorization and
 * canonical ordering; this adapter owns exactly one headless ZCode binding per
 * writable session. Local-turn capture is deliberately absent in this first
 * slice: it belongs to the reviewed-hooks path planned as a later phase, so
 * the adapter publishes nothing on its own initiative.
 */
export class ZcodeProjectHarness implements ProjectHarnessAdapter {
  readonly descriptor: ProjectHarnessDescriptor;
  readonly #options: ZcodeProjectHarnessOptions;
  readonly #known = new Map<string, KnownSessionIdentity>();
  readonly #executors = new Set<ZcodeSessionExecutor>();
  #deactivated = false;

  constructor(options: ZcodeProjectHarnessOptions) {
    this.#options = options;
    this.descriptor = {
      harness: "zcode",
      provider: options.provider,
      model: options.model,
      captureFidelity: "harness_transcript",
      capabilities: ["execute"],
    };
  }

  async preflight(): Promise<ProjectHarnessPreflight> {
    const workspacePath = await validateZcodeWorkspace(this.#options.workspacePath);
    if (this.#options.stateRoot !== undefined) {
      await this.#recoverKnownIdentities(this.#options.stateRoot);
    }
    return {
      version: this.#options.probe.version,
      authentication: "gatherthread-device-token",
      workspacePath,
    };
  }

  createSessionBinding(input: {
    session: SessionSummary;
    sessionKey: string;
    statePath: string;
  }): ProjectHarnessSessionBinding {
    const known = this.#known.get(input.session.id);
    const executor = new ZcodeSessionExecutor({
      probe: this.#options.probe,
      spec: this.#options.spec,
      sessionId: input.session.id,
      workspacePath: this.#options.workspacePath,
      statePath: input.statePath,
      ...(this.#options.shareToolEvents === undefined ? {} : { shareToolEvents: this.#options.shareToolEvents }),
      ...(this.#options.toolAllowlist === undefined ? {} : { toolAllowlist: this.#options.toolAllowlist }),
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
      ...(this.#options.maxOutputBytes === undefined ? {} : { maxOutputBytes: this.#options.maxOutputBytes }),
      ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
    });
    if (this.#deactivated) executor.deactivate();
    this.#executors.add(executor);
    return {
      executor,
      localSessionId: known?.localSessionId
        ?? pendingZcodeLocalSessionId(input.sessionKey),
    };
  }

  /**
   * Revocation, removal, role downgrade, and shutdown abort every in-flight
   * headless child and refuse later publication of its result. In-flight
   * turns surface as bounded failures instead of committing after the
   * binding lost its authorization.
   */
  async deactivateExecutionBindings(): Promise<void> {
    this.#deactivated = true;
    for (const executor of this.#executors) {
      executor.deactivate();
    }
  }

  async close(): Promise<void> {
    await this.deactivateExecutionBindings();
    this.#executors.clear();
  }

  /**
   * Restart recovery: rebuild session-id → native-id knowledge from the
   * per-session state files. A malformed file stops the connector instead of
   * being silently skipped, so bindings never diverge from durable state.
   */
  async #recoverKnownIdentities(stateRoot: string): Promise<void> {
    this.#known.clear();
    let entries: string[];
    try {
      entries = await readdir(stateRoot);
    } catch {
      return;
    }
    for (const entry of entries.filter((name) => name.endsWith("-session.json"))) {
      const state = await loadZcodeState(path.join(stateRoot, entry));
      for (const [sessionId, sessionState] of Object.entries(state.sessions)) {
        const identity: KnownSessionIdentity = {
          ...(sessionState.localSessionId === undefined ? {} : { localSessionId: sessionState.localSessionId }),
          ...(sessionState.observedModel === undefined ? {} : { observedModel: sessionState.observedModel }),
        };
        this.#known.set(sessionId, identity);
      }
    }
  }
}

export async function validateZcodeWorkspace(workspacePath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(workspacePath);
  } catch (error) {
    throw new Error("ZCode workspace does not exist or cannot be resolved", { cause: error });
  }
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error("ZCode workspace must be a directory");
  return resolved;
}
