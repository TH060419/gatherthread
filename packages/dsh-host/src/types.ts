import type {
  SharedAgentExecutor, SharedAgentControlApi,
  AgentRequestClaim,
  AppendEventInput,
  CanonicalEvent,
  CommitLocalTurnInput,
  CommitLocalTurnResult,
  CompleteAgentRequestInput,
  CurrentActor,
  HistoryContext,
  ReadEventsResult,
  SessionSummary,
} from "@gatherthread/bridge";
import type { SharedExecutionCapability } from "@gatherthread/protocol";

export type DshHarnessName = "deepseek-harness";

/** One exact DSH route advertised to GatherThread by a dynamic native runtime. */
export interface DshRuntimeExecutionProfile {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEfforts?: readonly string[];
  readonly defaultReasoningEffort?: string;
}

/** Exact per-request route installed only while one GatherThread prompt runs. */
export interface DshExecutionSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface DshRuntimeRegistration {
  contextDeletionVersion?: 1;
  sharingCapability?: SharedExecutionCapability;
  sessionId: string;
  deviceId: string;
  harness: DshHarnessName;
  provider: string;
  model: string;
  localSessionId: string;
  captureFidelity: "harness_transcript";
  capabilities: readonly string[];
  executionProfiles?: readonly DshRuntimeExecutionProfile[];
  purpose: "execution";
}

export interface DshRegisteredRuntime extends DshRuntimeRegistration {
  id: string;
  userId: string;
  registeredAt?: string;
}

export type DshAppendEventInput = Omit<AppendEventInput, "runtime">;

/**
 * Minimum server surface used by the host connector. Keeping this interface
 * structural makes the full connector testable without a token or live server.
 */
export interface DshCollaborationApi {
  agentSharingApi?(): SharedAgentControlApi;
  listProjectSessions(projectId: string): Promise<SessionSummary[]>;
  readEvents(sessionId: string, afterSequence: number, limit?: number): Promise<ReadEventsResult>;
  readContext?(sessionId: string, view?: HistoryContext["view"], throughSequence?: number): Promise<HistoryContext>;
  registerRuntime(input: DshRuntimeRegistration): Promise<DshRegisteredRuntime>;
  heartbeatRuntime(runtimeId: string): Promise<DshRegisteredRuntime>;
  claimAgentRequest(
    sessionId: string,
    requestId: string,
    runtimeId: string,
  ): Promise<AgentRequestClaim>;
  readAgentExecution?(sessionId: string, requestId: string, runtimeId: string, claimAttempt: number): Promise<{ active: boolean }>;
  acknowledgeAgentExecutionStopped?(sessionId: string, requestId: string, runtimeId: string, claimAttempt: number): Promise<void>;
  appendAgentProgress(
    sessionId: string,
    requestId: string,
    input: CompleteAgentRequestInput,
  ): Promise<CanonicalEvent>;
  appendEvent(sessionId: string, input: DshAppendEventInput): Promise<CanonicalEvent>;
  completeAgentRequest(
    sessionId: string,
    requestId: string,
    input: CompleteAgentRequestInput,
  ): Promise<CanonicalEvent>;
  commitLocalTurn(
    sessionId: string,
    input: CommitLocalTurnInput,
  ): Promise<CommitLocalTurnResult>;
}

export interface DshProjectCollaborationApi extends DshCollaborationApi {
  getCurrentActor(): Promise<CurrentActor>;
  createSession(projectId: string, input: {
    sessionId: string;
    title: string;
    mode: "solo" | "multi";
    idempotencyKey: string;
  }): Promise<SessionSummary>;
}

export interface DshLocalSessionCandidate {
  readonly localSessionId: string;
  readonly title: string;
}

export interface DshExecutionGate {
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export type DshCanonicalEvent = CanonicalEvent;
export type DshSessionSummary = SessionSummary;

export interface DshSessionEventRecord {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  /** Internal live-event routing only; never inferred from message text. */
  readonly sourceSessionId?: string;
}

/** Public process-local DSH assistant frames, never provider request input.
 * Revisions increase for every frame across one Agent lifecycle; attemptId
 * groups a start, dense zero-based chunk indexes, and one terminal end.
 */
export type DshAssistantStreamFrame =
  | { readonly type: "start"; readonly attemptId: string; readonly revision: number; readonly turn: number; readonly step: number }
  | { readonly type: "chunk"; readonly attemptId: string; readonly revision: number; readonly index: number; readonly time: number; readonly chunk: unknown }
  | { readonly type: "end"; readonly attemptId: string; readonly revision: number; readonly index: number;
      readonly outcome: { readonly kind: "committed"; readonly eventType: "assistant/message" | "assistant/attempt"; readonly seq: number }
        | { readonly kind: "abandoned" } };

/** Admitted only while this facade's GatherThread prompt owns its first turn. */
export type DshLiveOutputEvent =
  | { readonly kind: "assistant-stream"; readonly sourceSessionId: string; readonly frame: DshAssistantStreamFrame }
  | { readonly kind: "session-event"; readonly sourceSessionId: string; readonly event: DshSessionEventRecord };

export type DshAgentStatus = "running" | "idle";

export type DshConnectorLifecycleState =
  | "connecting"
  | "idle"
  | "running"
  | "offline"
  | "error"
  | "stopped";

export interface DshConnectorLifecycleUpdate {
  readonly state: DshConnectorLifecycleState;
  readonly session?: DshSessionSummary;
  readonly synced?: boolean;
}

export interface DshPromptResult {
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly events: readonly DshSessionEventRecord[];
}

/** A public canonical message admitted to the DSH model-visible surface. */
export interface DshCanonicalProjection {
  readonly eventId: string;
  readonly canonicalSequence: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly occurredAt: string;
  readonly actorDisplayName?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface DshContextExecutionInput {
  readonly requestId: string;
  readonly requestSequence: number;
  readonly historyContext: HistoryContext;
  readonly selectedOnly: boolean;
  /** Recovery must find the already-durable execution Session and context marker. */
  readonly resume?: boolean;
}

export interface DshContextExecutionState {
  sessionId: string;
  historyContext: HistoryContext;
  selectedOnly: boolean;
}

export interface DshHostFacade {
  createSharedExecutor?(): SharedAgentExecutor;
  readonly contextDeletionVersion?: 1;
  readonly sessionId: string;
  open(): Promise<"created" | "resumed">;
  currentSequence(executionSessionId?: string): number;
  snapshotFrom(sequence: number, executionSessionId?: string): readonly DshSessionEventRecord[];
  prepareContextExecution?(input: DshContextExecutionInput): Promise<{ sessionId: string; fromSequence: number }>;
  /** Create/resume a clean owned projection and permanently retire its predecessor. */
  resetCanonicalContext?(contentRevision: number): Promise<{ sessionId: string }>;
  projectCanonicalEvents(events: readonly DshCanonicalProjection[]): Promise<void>;
  flush(): Promise<void>;
  /** After actual native idle, cancellation rejects with HarnessExecutionTerminatedError; preparation/unknown ownership is not exit evidence. */
  prompt(text: string, selection?: DshExecutionSelection, executionSessionId?: string, signal?: AbortSignal): Promise<DshPromptResult>;
  onSessionEvent(listener: (event: DshSessionEventRecord) => void): () => void;
  onLiveOutput?(listener: (event: DshLiveOutputEvent) => void): () => void;
  onStatus(listener: (status: DshAgentStatus, sourceSessionId?: string) => void): () => void;
  dispose(): Promise<void>;
}

export interface DshMappedAssistantEvent {
  readonly kind: "assistant";
  readonly localEventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly content: string;
}

export interface DshMappedToolCallEvent {
  readonly kind: "tool_call";
  readonly localEventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly arguments: unknown;
}

export interface DshMappedToolResultEvent {
  readonly kind: "tool_result";
  readonly localEventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly toolCallId: string;
  readonly result: unknown;
  readonly isError: boolean;
  readonly errorCode?: string;
}

export type DshMappedEvent =
  | DshMappedAssistantEvent
  | DshMappedToolCallEvent
  | DshMappedToolResultEvent;

export interface ConnectorActiveRequest {
  contentRevision?: number;
  requestId: string;
  requestSequence: number;
  dshFromSequence: number;
  dshToSequence?: number;
  promptDigest: string;
  claimAttempt?: number;
  /** Separate sequence domain; it must never advance the native upload cursor. */
  contextExecution?: DshContextExecutionState;
}

export type ConnectorOutboxOperation =
  | {
    id: string;
    kind: "progress";
    requestId: string;
    input: CompleteAgentRequestInput;
  }
  | {
    id: string;
    kind: "append";
    input: DshAppendEventInput;
  }
  | {
    id: string;
    kind: "complete";
    requestId: string;
    input: CompleteAgentRequestInput;
  }
  | {
    id: string;
    kind: "local_turn";
    dshToSequence: number;
    input: CommitLocalTurnInput;
  };

export interface ConnectorState {
  contentRevision?: number;
  projectionSessionId?: string;
  /** Old native bindings must not upload even if projection replacement fails. */
  localOnlySessionIds?: string[];
  version: 3;
  binding: {
    projectId: string;
    sessionId: string;
    dshSessionId: string;
  };
  serverCursor: number;
  /** Canonical sequence durably materialized in the native DSH Session. */
  projectionCursor: number;
  publishedDshSequence: number;
  automaticUpload: boolean;
  activeRequest?: ConnectorActiveRequest;
  /** Content-free native exit receipts; retry ACKs without re-driving a prompt. */
  stoppedExecutions?: { requestId: string; runtimeId: string; claimAttempt: number }[];
  outbox: ConnectorOutboxOperation[];
}

export interface ConnectorStateStore {
  load(): Promise<ConnectorState | undefined>;
  save(state: ConnectorState): Promise<void>;
}
