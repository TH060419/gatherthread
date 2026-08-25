import type { CaptureFidelity, HarnessName } from "@gatherthread/adapters";
import type {
  CollaborationApi,
  HarnessExecutor,
  RegisteredRuntime,
  SessionSummary,
} from "./types.js";

export interface ProjectHarnessDescriptor {
  harness: HarnessName;
  provider: string;
  model: string;
  captureFidelity: CaptureFidelity;
  capabilities: readonly string[];
}

export interface ProjectHarnessPreflight {
  version: string;
  authentication: string;
  workspacePath: string;
}

export interface ProjectHarnessSessionBinding {
  executor: HarnessExecutor;
  localSessionId: string;
  synchronize?: (input: { api: CollaborationApi; runtime: RegisteredRuntime }) => Promise<void>;
  rename?: (session: SessionSummary) => Promise<void>;
  readNativeName?: () => Promise<string | null | undefined>;
  activateLocalPublishing?: () => Promise<void>;
  deactivateLocalPublishing?: (reason: ProjectHarnessDeactivationReason) => Promise<void>;
  relayLocalHarnessEvent?: (input: {
    api: CollaborationApi;
    runtime: RegisteredRuntime;
    event: unknown;
    replay: boolean;
  }) => Promise<{ handled: boolean; additionalContext?: string }>;
}

export type ProjectHarnessDeactivationReason =
  | "initializing"
  | "read_only"
  | "archived"
  | "removed"
  | "project_inaccessible";

/**
 * Project-scoped harness boundary.
 *
 * GatherThread owns project/session discovery and canonical history. Each local
 * harness integration owns only its process protocol and one executor binding
 * per shared session. Claude Code, DeepSeek Harness, and other runtimes can be
 * added without changing the collaboration loop or the server protocol.
 */
export interface ProjectHarnessAdapter {
  readonly descriptor: ProjectHarnessDescriptor;
  preflight(): Promise<ProjectHarnessPreflight>;
  createSessionBinding(input: {
    session: SessionSummary;
    sessionKey: string;
    statePath: string;
  }): ProjectHarnessSessionBinding;
  processSnapshotJobs?(input: {
    api: CollaborationApi;
    actorDeviceId: string;
    sessions: readonly SessionSummary[];
  }): Promise<void>;
  deactivateExecutionBindings?(input?: {
    retainSessionIds?: readonly string[];
    preserveSessionIds?: readonly string[];
  }): Promise<void>;
  close(): Promise<void>;
}
