import type {
  CaptureFidelity,
  HarnessName,
  TranscriptEvent,
} from "@gatherthread/adapters";

export type CanonicalEventType =
  | "human_chat"
  | "agent_request"
  | "agent_response"
  | "tool_call"
  | "tool_result"
  | "attachment"
  | "context_snapshot"
  | "membership_change"
  | "session_state_change";

export interface RuntimeProvenance {
  userId: string;
  deviceId: string;
  runtimeId: string;
  harness: HarnessName;
  provider: string;
  model: string;
  reasoningEffort?: string;
  localSessionId: string;
  captureFidelity: CaptureFidelity;
}

export interface CanonicalEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: CanonicalEventType;
  actorId: string;
  actorDisplayName?: string;
  timestamp: string;
  payload: unknown;
  runtime?: RuntimeProvenance;
}

export interface CommitLocalTurnInput {
  localTurnId: string;
  runtimeId: string;
  basedOnSequence: number;
  occurredAt: string;
  observedModel?: string;
  observedReasoningEffort?: string;
  requestPayload: unknown;
  responsePayload: unknown;
  toolEvents?: readonly unknown[];
}

export interface CommitLocalTurnResult {
  localTurnId: string;
  runtimeId: string;
  headBeforeCommit: number;
  reconciliationRequired: boolean;
  requestEvent: CanonicalEvent;
  responseEvent: CanonicalEvent;
  toolEvents: CanonicalEvent[];
}

export type SnapshotRequestStatus = "pending" | "claimed" | "completed" | "failed";

export interface SnapshotRequestSummary {
  id: string;
  sessionId: string;
  throughSequence: number;
  status: SnapshotRequestStatus;
  createdAt?: string;
  failure?: { code: string; message: string };
  /** @deprecated Compatibility alias for pre-final snapshot wire drafts. */
  requestedAt?: string;
  result?: unknown;
  /** @deprecated Compatibility alias for pre-final snapshot wire drafts. */
  error?: { code: string; message: string };
}

export interface SessionSummary {
  id: string;
  projectId?: string;
  ownerUserId?: string;
  name?: string;
  mode: "solo" | "multi";
  state?: "active" | "archived";
  role?: "owner" | "participant" | "viewer";
  latestSequence?: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  role: "owner" | "participant" | "viewer";
  state: "active" | "archived";
  sessionCount: number;
}

export interface ReadEventsResult {
  events: CanonicalEvent[];
  nextSequence: number;
  hasMore: boolean;
}

export interface AppendEventInput {
  type: CanonicalEventType;
  idempotencyKey: string;
  payload: unknown;
  replyTo?: string;
  visibility?: string;
  runtimeId?: string;
  runtime?: RuntimeProvenance;
  observedModel?: string;
  observedReasoningEffort?: string;
}

export interface RuntimeRegistration {
  runtimeId?: string;
  sessionId: string;
  deviceId: string;
  harness: HarnessName;
  provider: string;
  model: string;
  localSessionId: string;
  captureFidelity: CaptureFidelity;
  capabilities?: readonly string[];
  purpose?: "execution" | "snapshot_connector";
}

export interface RegisteredRuntime extends RuntimeRegistration {
  id: string;
  userId: string;
  registeredAt?: string;
  purpose?: "execution" | "snapshot_connector";
}

export interface CurrentActor {
  id: string;
  displayName: string;
  deviceId: string;
}

export interface AgentRequestClaim {
  claimed: boolean;
  status: "claimed" | "completed";
  requestId: string;
  runtimeId: string;
}

export interface CompleteAgentRequestInput {
  runtimeId: string;
  idempotencyKey: string;
  payload: unknown;
  observedModel?: string;
  observedReasoningEffort?: string;
}

export interface CollaborationApi {
  listSessions(): Promise<SessionSummary[]>;
  listProjects?(): Promise<ProjectSummary[]>;
  listProjectSessions?(projectId: string): Promise<SessionSummary[]>;
  createSession?(projectId: string, input: {
    title: string;
    mode: "solo" | "multi";
    idempotencyKey: string;
  }): Promise<SessionSummary>;
  updateSession?(sessionId: string, input: { title: string; idempotencyKey: string }): Promise<SessionSummary>;
  readEvents(sessionId: string, afterSequence: number, limit?: number): Promise<ReadEventsResult>;
  appendEvent(sessionId: string, event: AppendEventInput): Promise<CanonicalEvent>;
  registerRuntime(runtime: RuntimeRegistration): Promise<RegisteredRuntime>;
  heartbeatRuntime?(runtimeId: string): Promise<RegisteredRuntime>;
  claimAgentRequest(sessionId: string, requestId: string, runtimeId: string): Promise<AgentRequestClaim>;
  completeAgentRequest(sessionId: string, requestId: string, input: CompleteAgentRequestInput): Promise<CanonicalEvent>;
  commitLocalTurn?(sessionId: string, input: CommitLocalTurnInput): Promise<CommitLocalTurnResult>;
  createSnapshotRequest?(sessionId: string): Promise<SnapshotRequestSummary>;
  getSnapshotRequest?(requestId: string): Promise<SnapshotRequestSummary>;
  listSnapshotRequests?(status: SnapshotRequestStatus, limit?: number): Promise<SnapshotRequestSummary[]>;
  claimSnapshotRequest?(requestId: string, runtimeId: string): Promise<SnapshotRequestSummary>;
  completeSnapshotRequest?(requestId: string, runtimeId: string, result: unknown): Promise<SnapshotRequestSummary>;
  failSnapshotRequest?(
    requestId: string,
    runtimeId: string,
    error: { code: string; message: string },
  ): Promise<SnapshotRequestSummary>;
}

export interface HarnessExecutionInput {
  request: CanonicalEvent;
  canonicalHistory: CanonicalEvent[];
  runtime: RegisteredRuntime;
}

export interface HarnessExecutionResult {
  events: TranscriptEvent[];
  localSessionId?: string;
  observedModel?: string;
  observedReasoningEffort?: string;
}

export interface HarnessExecutor {
  execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult>;
  shouldExecute?(request: CanonicalEvent, runtime: RegisteredRuntime): Promise<boolean> | boolean;
  /**
   * Ensure the harness-native conversation exists and report the canonical
   * sequence it actually covers. The bridge uses this native cursor to recover
   * safely when its transport cursor survived but native projection state did
   * not, or when a harness requires a one-time native-thread migration.
   */
  prepareCanonicalProjection?(runtime: RegisteredRuntime): Promise<number>;
  projectCanonicalEvents?(events: readonly CanonicalEvent[], runtime: RegisteredRuntime): Promise<void>;
}

export type ContextSnapshot =
  | {
    captureFidelity: "canonical_history";
    content: unknown;
    coversThroughSequence: number;
  }
  | {
    captureFidelity: "harness_transcript";
    content: unknown;
    localSessionId: string;
  }
  | {
    captureFidelity: "provider_request";
    content: unknown;
    exactProviderRequest: true;
    observedBy: "harness_hook" | "authorized_proxy";
  };
