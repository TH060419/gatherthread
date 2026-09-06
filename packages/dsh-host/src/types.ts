import type {
  AgentRequestClaim,
  AppendEventInput,
  CanonicalEvent,
  CommitLocalTurnInput,
  CommitLocalTurnResult,
  CompleteAgentRequestInput,
  CurrentActor,
  ReadEventsResult,
  SessionSummary,
} from "@gatherthread/bridge";

export type DshHarnessName = "deepseek-harness";

export interface DshRuntimeRegistration {
  sessionId: string;
  deviceId: string;
  harness: DshHarnessName;
  provider: string;
  model: string;
  localSessionId: string;
  captureFidelity: "harness_transcript";
  capabilities: readonly string[];
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
  listProjectSessions(projectId: string): Promise<SessionSummary[]>;
  readEvents(sessionId: string, afterSequence: number, limit?: number): Promise<ReadEventsResult>;
  registerRuntime(input: DshRuntimeRegistration): Promise<DshRegisteredRuntime>;
  heartbeatRuntime(runtimeId: string): Promise<DshRegisteredRuntime>;
  claimAgentRequest(
    sessionId: string,
    requestId: string,
    runtimeId: string,
  ): Promise<AgentRequestClaim>;
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
}

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

export interface DshHostFacade {
  readonly sessionId: string;
  open(): Promise<"created" | "resumed">;
  currentSequence(): number;
  snapshotFrom(sequence: number): readonly DshSessionEventRecord[];
  projectCanonicalEvents(events: readonly DshCanonicalProjection[]): Promise<void>;
  flush(): Promise<void>;
  prompt(text: string): Promise<DshPromptResult>;
  onSessionEvent(listener: (event: DshSessionEventRecord) => void): () => void;
  onStatus(listener: (status: DshAgentStatus) => void): () => void;
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
  requestId: string;
  requestSequence: number;
  dshFromSequence: number;
  dshToSequence?: number;
  promptDigest: string;
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
  version: 2;
  binding: {
    projectId: string;
    sessionId: string;
    dshSessionId: string;
  };
  serverCursor: number;
  /** Canonical sequence durably materialized in the native DSH Session. */
  projectionCursor: number;
  publishedDshSequence: number;
  activeRequest?: ConnectorActiveRequest;
  outbox: ConnectorOutboxOperation[];
}

export interface ConnectorStateStore {
  load(): Promise<ConnectorState | undefined>;
  save(state: ConnectorState): Promise<void>;
}
