import type { CaptureFidelity, HarnessName } from "@gatherthread/adapters";
import type {
  CollaborationApi,
  HarnessExecutor,
  RegisteredRuntime,
  RuntimeExecutionProfile,
  SessionSummary,
} from "./types.js";

export interface ProjectHarnessDescriptor {
  harness: HarnessName;
  provider: string;
  model: string;
  captureFidelity: CaptureFidelity;
  capabilities: readonly string[];
  /**
   * Models the connected harness reported online (for example via the Codex
   * App Server model/list RPC). When present, the collaboration server and the
   * Web workspace use this list instead of any hardcoded catalog.
   */
  executionProfiles?: readonly RuntimeExecutionProfile[];
}

export interface ProjectHarnessPreflight {
  version: string;
  authentication: string;
  workspacePath: string;
}

export interface LocalConversationSyncStatus {
  sessionId: string;
  localSessionId: string;
  automaticUpload: boolean;
  pendingLocalTurns: number;
  uploadableLocalTurns: number;
}

export interface LocalConversationUploadResult extends LocalConversationSyncStatus {
  discoveredLocalTurns: number;
  uploadedLocalTurns: number;
}

export interface VisibleHistorySnapshotResult {
  status: "imported" | "unchanged" | "disabled";
  threadId?: string;
  threadName?: string;
  previousThreadId?: string;
  previousTaskRetained?: boolean;
  throughSequence: number;
  compacted?: boolean;
}

export interface LocalConversationSyncControl {
  getLocalSyncStatus(sessionId: string): Promise<LocalConversationSyncStatus>;
  setLocalAutoUpload(sessionId: string, enabled: boolean): Promise<LocalConversationSyncStatus>;
  uploadLocalTurns(sessionId: string): Promise<LocalConversationUploadResult>;
  importVisibleHistorySnapshot(sessionId: string): Promise<VisibleHistorySnapshotResult>;
}

export interface ProjectHarnessSessionBinding {
  executor: HarnessExecutor;
  localSessionId: string;
  adoptLocalConversation?: (localConversationId: string) => Promise<void>;
  /** Capture/flush local turns before Web execution; the persisted upload preference remains authoritative. */
  synchronizeLocalTurns?: (input: { api: CollaborationApi; runtime: RegisteredRuntime }) => Promise<void>;
  getLocalSyncStatus?: () => Promise<LocalConversationSyncStatus>;
  /** Point-in-time guard for optional source-file synchronization; uncertainty is busy. */
  isLocalRunActive?: () => Promise<boolean>;
  setLocalAutoUpload?: (enabled: boolean) => Promise<LocalConversationSyncStatus>;
  uploadLocalTurns?: (input: {
    api: CollaborationApi;
    runtime: RegisteredRuntime;
  }) => Promise<LocalConversationUploadResult>;
  /** Import a verified native history snapshot as a new Desktop-visible task. */
  importVisibleHistorySnapshot?: (input: {
    api: CollaborationApi;
    throughSequence: number;
    automatic: boolean;
  }) => Promise<VisibleHistorySnapshotResult>;
  /** Best-effort visible native-history catch-up; runs after Web Agent execution. */
  synchronizeCanonicalHistory?: (input: { api: CollaborationApi; runtime: RegisteredRuntime }) => Promise<void>;
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
