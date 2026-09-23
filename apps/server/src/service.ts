import type {
  AppendEventInput,
  CanonicalEvent,
  CommitLocalTurnInput,
  CommitLocalTurnResult,
  CreateHistorySummaryInput,
  HistoryContext,
  JsonValue,
  MembershipRole,
  ReplayResponse,
  SnapshotFailure,
  SnapshotRequestKind,
  SnapshotRequestStatus,
} from "@gatherthread/protocol";
import { CollaborationDatabase, type Actor, type RuntimeRecord, type SessionRecord } from "./database.js";
import { agentRequestFailed, conflict, forbidden, notFound } from "./errors.js";
import { redactJson } from "./redaction.js";

type EventListener = (event: CanonicalEvent) => void;

const RUNTIME_EVENT_TYPES = new Set(["agent_response", "tool_call", "tool_result"]);
const DIRECT_EVENT_TYPES = new Set([
  "human_chat",
  "agent_request",
  "agent_response",
  "tool_call",
  "tool_result",
  "attachment",
  "context_snapshot",
]);

export class CollaborationService {
  private readonly eventListeners = new Set<EventListener>();

  constructor(readonly database: CollaborationDatabase) {}

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  createSession(actor: Actor, input: Parameters<CollaborationDatabase["createSession"]>[1]) {
    this.database.assertActiveDevice(actor);
    const result = this.database.createSession(actor, input);
    this.publish(result.event);
    return result;
  }

  createProject(actor: Actor, input: Parameters<CollaborationDatabase["createProject"]>[1]) {
    this.database.assertActiveDevice(actor);
    return this.database.createProject(actor, input);
  }

  deleteProject(actor: Actor, projectId: string) {
    this.database.assertActiveDevice(actor);
    return this.database.deleteProject(actor, projectId);
  }

  updateProject(actor: Actor, projectId: string, input: Parameters<CollaborationDatabase["updateProject"]>[2]) {
    this.database.assertActiveDevice(actor);
    return this.database.updateProject(actor, projectId, input);
  }

  getProject(actor: Actor, projectId: string) {
    const role = this.requireProjectMembership(actor, projectId);
    return { project: this.database.requireProject(projectId), role };
  }

  getProjectContextPolicy(actor: Actor, projectId: string) {
    return this.database.getProjectContextPolicy(actor, projectId);
  }

  setProjectContextPolicy(actor: Actor, projectId: string, mode: "summary" | "original") {
    return this.database.setProjectContextPolicy(actor, projectId, mode);
  }

  listProjects(actor: Actor) {
    this.database.assertActiveDevice(actor);
    return this.database.listProjects(actor.user_id);
  }

  listProjectSessions(actor: Actor, projectId: string) {
    this.requireProjectMembership(actor, projectId);
    return this.database.listProjectSessions(projectId, actor.user_id);
  }

  listProjectMembers(actor: Actor, projectId: string) {
    this.requireProjectMembership(actor, projectId);
    return this.database.listProjectMembers(projectId);
  }

  createProjectInvitation(
    actor: Actor,
    projectId: string,
    input: Parameters<CollaborationDatabase["createProjectInvitation"]>[2],
  ) {
    this.requireProjectOwner(actor, projectId);
    return this.database.createProjectInvitation(actor, projectId, input);
  }

  revokeProjectInvitation(actor: Actor, projectId: string, invitationId: string) {
    this.requireProjectOwner(actor, projectId);
    return this.database.revokeProjectInvitation(actor, projectId, invitationId);
  }

  listProjectInvitations(actor: Actor, projectId: string) {
    this.requireProjectOwner(actor, projectId);
    return this.database.listProjectInvitations(actor, projectId);
  }

  listProjectInvitationAudit(actor: Actor, projectId: string) {
    this.requireProjectOwner(actor, projectId);
    return this.database.listProjectInvitationAudit(actor, projectId);
  }

  setProjectMembership(
    actor: Actor,
    projectId: string,
    userId: string,
    role: "participant" | "viewer",
  ) {
    this.requireProjectOwner(actor, projectId);
    return this.database.setProjectMembership(actor, projectId, userId, role);
  }

  removeProjectMembership(actor: Actor, projectId: string, userId: string): void {
    this.requireProjectOwner(actor, projectId);
    this.database.removeProjectMembership(actor, projectId, userId);
  }

  getSession(actor: Actor, sessionId: string): { session: SessionRecord; role: MembershipRole } {
    const role = this.requireMembership(actor, sessionId);
    return { session: this.database.requireSession(sessionId), role };
  }

  deleteSession(actor: Actor, sessionId: string) {
    this.database.assertActiveDevice(actor);
    return this.database.deleteSession(actor, sessionId);
  }

  listSessions(actor: Actor) {
    this.database.assertActiveDevice(actor);
    return this.database.listSessions(actor.user_id);
  }

  listMembers(actor: Actor, sessionId: string) {
    const role = this.requireMembership(actor, sessionId);
    return this.database.listSessionMembers(sessionId).map((member) => {
      if (member.runtime === null || role === "owner" || member.user_id === actor.user_id) return member;
      return {
        ...member,
        runtime: {
          ...member.runtime,
          id: "private",
          device_id: "private",
          local_session_id: "private",
        },
      };
    });
  }

  listOwnExecutionRuntimes(actor: Actor, sessionId: string) {
    this.requireMembership(actor, sessionId);
    return this.database.listSessionRuntimesForUser(sessionId, actor.user_id)
      .filter((runtime) => runtime.purpose === "execution")
      .map((runtime) => ({
        id: runtime.id,
        device_id: runtime.device_id,
        harness: runtime.harness,
        provider: runtime.provider,
        model: runtime.model,
        ...(runtime.execution_profiles === undefined ? {} : { execution_profiles: runtime.execution_profiles }),
        status: runtime.status,
        last_seen_at: runtime.last_seen_at,
      }));
  }

  createInvitation(
    actor: Actor,
    sessionId: string,
    input: Parameters<CollaborationDatabase["createInvitation"]>[2],
  ) {
    this.requireOwner(actor, sessionId);
    return this.database.createInvitation(actor, sessionId, input);
  }

  claimInvitation(input: Parameters<CollaborationDatabase["claimInvitation"]>[0]) {
    const result = this.database.claimInvitation(input);
    if (result.event) this.publish(result.event);
    return result;
  }

  claimInvitationWithBrowserSession(input: Parameters<CollaborationDatabase["claimInvitation"]>[0]) {
    const result = this.database.claimInvitation(input, { browserSession: true });
    if (result.event) this.publish(result.event);
    return result;
  }

  claimTestAccess(input: Parameters<CollaborationDatabase["claimTestAccess"]>[0]) {
    return this.database.claimTestAccess(input);
  }

  claimTestAccessWithBrowserSession(input: Parameters<CollaborationDatabase["claimTestAccess"]>[0]) {
    return this.database.claimTestAccess(input, { browserSession: true });
  }

  claimInvitationForActor(actor: Actor, inviteToken: string) {
    const result = this.database.claimInvitationForActor(actor, inviteToken);
    if (result.event) this.publish(result.event);
    return result;
  }

  revokeInvitation(actor: Actor, sessionId: string, invitationId: string) {
    this.requireOwner(actor, sessionId);
    return this.database.revokeInvitation(actor, sessionId, invitationId);
  }

  listInvitations(actor: Actor, sessionId: string) {
    this.requireOwner(actor, sessionId);
    return this.database.listInvitations(actor, sessionId);
  }

  listInvitationAudit(actor: Actor, sessionId: string) {
    this.requireOwner(actor, sessionId);
    return this.database.listInvitationAudit(actor, sessionId);
  }

  createDeviceAuthorization(actor: Actor) {
    return this.database.createDeviceAuthorization(actor);
  }

  claimDeviceAuthorization(input: Parameters<CollaborationDatabase["claimDeviceAuthorization"]>[0]) {
    return this.database.claimDeviceAuthorization(input);
  }

  revokeDeviceAuthorization(actor: Actor, authorizationId: string) {
    this.database.assertActiveDevice(actor);
    return this.database.revokeDeviceAuthorization(actor, authorizationId);
  }

  listDeviceAuthorizations(actor: Actor) {
    this.database.assertActiveDevice(actor);
    return this.database.listDeviceAuthorizations(actor);
  }

  listDevices(actor: Actor) {
    this.database.assertActiveDevice(actor);
    return this.database.listDevices(actor);
  }

  updateDeviceName(actor: Actor, deviceId: string, name: string) {
    return this.database.updateDeviceName(actor, deviceId, name);
  }

  rotateDeviceToken(actor: Actor, deviceId: string, expiresAt?: string | null) {
    this.database.assertActiveDevice(actor);
    return this.database.rotateDeviceToken(actor, deviceId, expiresAt);
  }

  revokeDevice(actor: Actor, deviceId: string): void {
    this.database.assertActiveDevice(actor);
    this.database.revokeDevice(actor, deviceId);
  }

  updateSession(actor: Actor, sessionId: string, input: Parameters<CollaborationDatabase["updateSession"]>[2]) {
    this.requireManage(actor, sessionId);
    const result = this.database.updateSession(actor, sessionId, input);
    this.publish(result.event);
    return result;
  }

  setMembership(actor: Actor, sessionId: string, userId: string, role: "participant" | "viewer", idempotencyKey: string): CanonicalEvent {
    this.requireOwner(actor, sessionId);
    const event = this.database.setMembership(actor, sessionId, userId, role, idempotencyKey);
    this.publish(event);
    return event;
  }

  removeMembership(actor: Actor, sessionId: string, userId: string, idempotencyKey: string): CanonicalEvent {
    this.requireOwner(actor, sessionId);
    const event = this.database.removeMembership(actor, sessionId, userId, idempotencyKey);
    this.publish(event);
    return event;
  }

  appendEvent(actor: Actor, sessionId: string, input: AppendEventInput): CanonicalEvent {
    const { role, session } = this.requireWrite(actor, sessionId);
    if (!DIRECT_EVENT_TYPES.has(input.type)) throw forbidden("This event type requires its dedicated endpoint");
    if (input.visibility === "owner_only" && role !== "owner") throw forbidden("Only the owner may append owner-only events");

    let provenance = null;
    if (RUNTIME_EVENT_TYPES.has(input.type) && !input.runtime_id) {
      throw conflict(`${input.type} requires runtime_id provenance`);
    }
    if (input.runtime_id) {
      const runtime = this.requireOwnedRuntime(actor, sessionId, input.runtime_id);
      provenance = {
        ...this.database.runtimeProvenance(runtime),
        ...(input.observed_model === undefined ? {} : { model: input.observed_model }),
        ...(input.observed_reasoning_effort === undefined ? {} : { reasoning_effort: input.observed_reasoning_effort }),
      };
    }
    if (session.state !== "active") throw conflict("Archived sessions do not accept new events");

    const event = this.database.appendEvent(actor, sessionId, {
      ...input,
      payload: redactJson(input.payload),
    }, provenance);
    this.publish(event);
    return event;
  }

  replay(actor: Actor, sessionId: string, afterSequence: number, limit: number, maxBytes?: number): ReplayResponse {
    const role = this.requireMembership(actor, sessionId);
    const replay = this.database.replay(sessionId, afterSequence, limit, role === "owner", maxBytes);
    return {
      ...replay,
      events: replay.events.map((event) => this.minimizeEventForActor(actor, role, event)),
    };
  }

  createHistorySummary(actor: Actor, sessionId: string, input: CreateHistorySummaryInput): CanonicalEvent {
    const event = this.database.createHistorySummary(actor, sessionId, input);
    this.publish(event);
    return event;
  }

  readHistoryContext(actor: Actor, sessionId: string, view?: "summary" | "original", throughSequence?: number): HistoryContext {
    return this.database.readHistoryContext(actor, sessionId, view, throughSequence);
  }

  registerRuntime(actor: Actor, input: Parameters<CollaborationDatabase["registerRuntime"]>[1]): RuntimeRecord {
    if ((input.purpose ?? "execution") === "snapshot_connector") this.requireMembership(actor, input.session_id);
    else this.requireWrite(actor, input.session_id);
    return this.database.registerRuntime(actor, input);
  }

  heartbeatRuntime(actor: Actor, runtimeId: string): RuntimeRecord {
    return this.database.heartbeatRuntime(actor, runtimeId);
  }

  claimAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string) {
    this.requireWrite(actor, sessionId);
    const outcome = this.database.claimAgentRequest(actor, sessionId, requestEventId, runtimeId);
    if ("failed" in outcome) {
      if (outcome.event !== undefined) this.publish(outcome.event);
      throw agentRequestFailed();
    }
    return outcome.claim;
  }

  appendAgentProgress(
    actor: Actor,
    sessionId: string,
    requestEventId: string,
    runtimeId: string,
    idempotencyKey: string,
    payload: JsonValue,
    observedModel?: string,
    observedReasoningEffort?: string,
    claimAttempt?: number,
  ): CanonicalEvent {
    const { session } = this.requireWrite(actor, sessionId);
    if (session.state !== "active") throw conflict("Archived sessions do not accept agent progress");
    const event = this.database.appendAgentProgress(
      actor,
      sessionId,
      requestEventId,
      runtimeId,
      idempotencyKey,
      redactJson(payload),
      observedModel,
      observedReasoningEffort,
      claimAttempt,
    );
    this.publish(event);
    return event;
  }

  completeAgentRequest(
    actor: Actor,
    sessionId: string,
    requestEventId: string,
    runtimeId: string,
    idempotencyKey: string,
    payload: JsonValue,
    observedModel?: string,
    observedReasoningEffort?: string,
    claimAttempt?: number,
  ): CanonicalEvent {
    const { session } = this.requireWrite(actor, sessionId);
    if (session.state !== "active") throw conflict("Archived sessions do not accept agent responses");
    const event = this.database.completeAgentRequest(
      actor,
      sessionId,
      requestEventId,
      runtimeId,
      idempotencyKey,
      redactJson(payload),
      observedModel,
      observedReasoningEffort,
      claimAttempt,
    );
    this.publish(event);
    return event;
  }

  commitLocalTurn(actor: Actor, sessionId: string, input: CommitLocalTurnInput): CommitLocalTurnResult {
    const result = this.database.commitLocalTurn(actor, sessionId, {
      ...input,
      request_payload: redactJson(input.request_payload),
      response_payload: redactJson(input.response_payload),
      tool_events: input.tool_events?.map((event) => ({ ...event, payload: redactJson(event.payload) })),
    });
    this.publish(result.request_event);
    for (const event of result.tool_events) this.publish(event);
    this.publish(result.response_event);
    return result;
  }

  createSnapshotRequest(actor: Actor, sessionId: string, kind?: SnapshotRequestKind, targetRuntimeId?: string) {
    return this.database.createSnapshotRequest(actor, sessionId, kind, targetRuntimeId);
  }

  getSnapshotRequest(actor: Actor, requestId: string) {
    return this.database.getSnapshotRequest(actor, requestId);
  }

  listSnapshotRequests(actor: Actor, status: SnapshotRequestStatus | undefined, sessionId: string | undefined, limit: number) {
    return this.database.listSnapshotRequests(actor, status, sessionId, limit);
  }

  claimSnapshotRequest(actor: Actor, requestId: string, runtimeId: string) {
    return this.database.claimSnapshotRequest(actor, requestId, runtimeId);
  }

  completeSnapshotRequest(actor: Actor, requestId: string, runtimeId: string, result: JsonValue) {
    return this.database.completeSnapshotRequest(actor, requestId, runtimeId, redactJson(result));
  }

  failSnapshotRequest(actor: Actor, requestId: string, runtimeId: string, failure: SnapshotFailure) {
    return this.database.failSnapshotRequest(
      actor, requestId, runtimeId, redactJson(failure as unknown as JsonValue) as SnapshotFailure,
    );
  }

  canReadEvent(actor: Actor, event: CanonicalEvent): boolean {
    const role = this.database.membershipRole(event.session_id, actor.user_id);
    if (!role) return false;
    return event.visibility === "session" || role === "owner";
  }

  presentEvent(actor: Actor, event: CanonicalEvent): CanonicalEvent {
    const role = this.requireMembership(actor, event.session_id);
    return this.minimizeEventForActor(actor, role, event);
  }

  requireMembership(actor: Actor, sessionId: string): MembershipRole {
    this.database.assertActiveDevice(actor);
    this.database.requireSession(sessionId);
    const role = this.database.membershipRole(sessionId, actor.user_id);
    if (!role) throw notFound("Session");
    return role;
  }

  requireProjectMembership(actor: Actor, projectId: string): MembershipRole {
    this.database.assertActiveDevice(actor);
    this.database.requireProject(projectId);
    const role = this.database.projectMembershipRole(projectId, actor.user_id);
    if (!role) throw notFound("Project");
    return role;
  }

  private requireWrite(actor: Actor, sessionId: string): { role: MembershipRole; session: SessionRecord } {
    this.database.assertActiveDevice(actor);
    const session = this.database.requireSession(sessionId);
    const role = this.database.membershipRole(sessionId, actor.user_id);
    if (!role) throw notFound("Session");
    if (role === "viewer") throw forbidden("Viewers cannot append events");
    if (session.mode === "solo" && session.owner_user_id !== actor.user_id) {
      throw forbidden("Only the solo creator can write to this session");
    }
    return { role, session };
  }

  private requireManage(actor: Actor, sessionId: string): void {
    const { role, session } = this.requireWrite(actor, sessionId);
    if (session.mode === "solo") return;
    if (role !== "owner") throw forbidden("Only the project owner can manage a multi session");
  }

  private requireOwner(actor: Actor, sessionId: string): void {
    if (this.requireMembership(actor, sessionId) !== "owner") throw forbidden("Only the project owner may perform this action");
  }

  private requireProjectOwner(actor: Actor, projectId: string): void {
    if (this.requireProjectMembership(actor, projectId) !== "owner") {
      throw forbidden("Only the project owner may perform this action");
    }
  }

  private requireOwnedRuntime(actor: Actor, sessionId: string, runtimeId: string): RuntimeRecord {
    const runtime = this.database.getRuntime(runtimeId);
    if (runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
      || runtime.session_id !== sessionId || runtime.status === "revoked" || runtime.purpose !== "execution") {
      throw forbidden("Runtime does not belong to the actor and session");
    }
    return runtime;
  }

  private minimizeEventForActor(actor: Actor, role: MembershipRole, event: CanonicalEvent): CanonicalEvent {
    const provenance = event.runtime_provenance;
    if (provenance === null || role === "owner" || provenance.user_id === actor.user_id) return event;
    return {
      ...event,
      runtime_provenance: {
        ...provenance,
        device_id: "private",
        runtime_id: "private",
        local_session_id: "private",
      },
    };
  }

  private publish(event: CanonicalEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}
