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
  localSessionId: string;
  captureFidelity: CaptureFidelity;
}

export interface CanonicalEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: CanonicalEventType;
  actorId: string;
  timestamp: string;
  payload: unknown;
  runtime?: RuntimeProvenance;
}

export interface SessionSummary {
  id: string;
  name?: string;
  mode: "solo" | "multi";
  role?: "owner" | "participant" | "viewer";
  latestSequence?: number;
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
}

export interface RegisteredRuntime extends RuntimeRegistration {
  id: string;
  userId: string;
  registeredAt?: string;
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
}

export interface CollaborationApi {
  listSessions(): Promise<SessionSummary[]>;
  readEvents(sessionId: string, afterSequence: number, limit?: number): Promise<ReadEventsResult>;
  appendEvent(sessionId: string, event: AppendEventInput): Promise<CanonicalEvent>;
  registerRuntime(runtime: RuntimeRegistration): Promise<RegisteredRuntime>;
  claimAgentRequest(sessionId: string, requestId: string, runtimeId: string): Promise<AgentRequestClaim>;
  completeAgentRequest(sessionId: string, requestId: string, input: CompleteAgentRequestInput): Promise<CanonicalEvent>;
}

export interface HarnessExecutionInput {
  request: CanonicalEvent;
  canonicalHistory: CanonicalEvent[];
  runtime: RegisteredRuntime;
}

export interface HarnessExecutionResult {
  events: TranscriptEvent[];
  localSessionId?: string;
}

export interface HarnessExecutor {
  execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult>;
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
