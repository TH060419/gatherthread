import {
  HttpCollaborationClient,
  type CollaborationApi,
  type RuntimeRegistration,
} from "@gatherthread/bridge";
import type {
  DshCollaborationApi,
  DshProjectCollaborationApi,
  DshRegisteredRuntime,
  DshRuntimeRegistration,
} from "./types.js";

export interface DshHttpApiOptions {
  baseUrl: string;
  credential: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/**
 * Typed compatibility wrapper around GatherThread's existing HTTP client.
 * The unsafe cast is deliberately confined here because the current bridge's
 * TypeScript-only HarnessName union predates the server's open string field.
 */
export function createHttpDshCollaborationApi(options: DshHttpApiOptions): DshProjectCollaborationApi {
  const client = new HttpCollaborationClient({
    baseUrl: options.baseUrl,
    bearerToken: options.credential,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    ...adaptCollaborationApi(client),
    getCurrentActor: () => client.getCurrentActor(),
    createSession: (projectId, input) => client.createSession(projectId, input),
  };
}

export function adaptCollaborationApi(client: CollaborationApi): DshCollaborationApi {
  const listProjectSessions = client.listProjectSessions;
  const heartbeatRuntime = client.heartbeatRuntime;
  const appendAgentProgress = client.appendAgentProgress;
  const commitLocalTurn = client.commitLocalTurn;
  if (listProjectSessions === undefined
    || heartbeatRuntime === undefined
    || appendAgentProgress === undefined
    || commitLocalTurn === undefined) {
    throw new Error("GatherThread Collaboration API lacks required session, heartbeat, progress, or local-turn support");
  }
  return {
    listProjectSessions: (projectId) => listProjectSessions.call(client, projectId),
    readEvents: (sessionId, afterSequence, limit) => client.readEvents(sessionId, afterSequence, limit),
    registerRuntime: async (input: DshRuntimeRegistration) => client.registerRuntime(
      input as unknown as RuntimeRegistration,
    ) as unknown as DshRegisteredRuntime,
    heartbeatRuntime: async (runtimeId) => heartbeatRuntime.call(
      client,
      runtimeId,
    ) as unknown as DshRegisteredRuntime,
    claimAgentRequest: (sessionId, requestId, runtimeId) => client.claimAgentRequest(
      sessionId,
      requestId,
      runtimeId,
    ),
    appendAgentProgress: (sessionId, requestId, input) => appendAgentProgress.call(
      client,
      sessionId,
      requestId,
      input,
    ),
    appendEvent: (sessionId, input) => client.appendEvent(sessionId, input),
    completeAgentRequest: (sessionId, requestId, input) => client.completeAgentRequest(
      sessionId,
      requestId,
      input,
    ),
    commitLocalTurn: (sessionId, input) => commitLocalTurn.call(client, sessionId, input),
  };
}

export function isTerminalClaimConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409
    && (candidate.code === "agent_request_already_claimed"
      || candidate.code === "agent_request_already_completed");
}
