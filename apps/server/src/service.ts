import type {
  AppendEventInput,
  CanonicalEvent,
  JsonValue,
  MembershipRole,
  ReplayResponse,
} from "@gatherthread/protocol";
import { CollaborationDatabase, type Actor, type RuntimeRecord, type SessionRecord } from "./database.js";
import { conflict, forbidden, notFound } from "./errors.js";
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

  getSession(actor: Actor, sessionId: string): { session: SessionRecord; role: MembershipRole } {
    const role = this.requireMembership(actor, sessionId);
    return { session: this.database.requireSession(sessionId), role };
  }

  listSessions(actor: Actor) {
    this.database.assertActiveDevice(actor);
    return this.database.listSessions(actor.user_id);
  }

  listMembers(actor: Actor, sessionId: string) {
    this.requireMembership(actor, sessionId);
    return this.database.listSessionMembers(sessionId);
  }

  createInvitation(
    actor: Actor,
    sessionId: string,
    input: Parameters<CollaborationDatabase["createInvitation"]>[2],
  ) {
    this.requireOwner(actor, sessionId);
    const session = this.database.requireSession(sessionId);
    if (session.mode === "solo" && input.role !== "viewer") {
      throw forbidden("Solo sessions can invite read-only viewers only");
    }
    return this.database.createInvitation(actor, sessionId, input);
  }

  claimInvitation(input: Parameters<CollaborationDatabase["claimInvitation"]>[0]) {
    const result = this.database.claimInvitation(input);
    this.publish(result.event);
    return result;
  }

  claimInvitationWithBrowserSession(input: Parameters<CollaborationDatabase["claimInvitation"]>[0]) {
    const result = this.database.claimInvitation(input, { browserSession: true });
    this.publish(result.event);
    return result;
  }

  claimInvitationForActor(actor: Actor, inviteToken: string) {
    const result = this.database.claimInvitationForActor(actor, inviteToken);
    this.publish(result.event);
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

  rotateDeviceToken(actor: Actor, deviceId: string, expiresAt?: string | null) {
    this.database.assertActiveDevice(actor);
    return this.database.rotateDeviceToken(actor, deviceId, expiresAt);
  }

  revokeDevice(actor: Actor, deviceId: string): void {
    this.database.assertActiveDevice(actor);
    this.database.revokeDevice(actor, deviceId);
  }

  updateSession(actor: Actor, sessionId: string, input: Parameters<CollaborationDatabase["updateSession"]>[2]) {
    this.requireOwner(actor, sessionId);
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
    if (!DIRECT_EVENT_TYPES.has(input.type)) throw forbidden("Membership and session-state events require their dedicated owner endpoints");
    if (input.visibility === "owner_only" && role !== "owner") throw forbidden("Only the owner may append owner-only events");

    let provenance = null;
    if (RUNTIME_EVENT_TYPES.has(input.type) && !input.runtime_id) {
      throw conflict(`${input.type} requires runtime_id provenance`);
    }
    if (input.runtime_id) {
      const runtime = this.requireOwnedRuntime(actor, sessionId, input.runtime_id);
      provenance = this.database.runtimeProvenance(runtime);
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
    return this.database.replay(sessionId, afterSequence, limit, role === "owner", maxBytes);
  }

  registerRuntime(actor: Actor, input: Parameters<CollaborationDatabase["registerRuntime"]>[1]): RuntimeRecord {
    this.requireWrite(actor, input.session_id);
    return this.database.registerRuntime(actor, input);
  }

  heartbeatRuntime(actor: Actor, runtimeId: string): RuntimeRecord {
    return this.database.heartbeatRuntime(actor, runtimeId);
  }

  claimAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string) {
    this.requireWrite(actor, sessionId);
    return this.database.claimAgentRequest(actor, sessionId, requestEventId, runtimeId);
  }

  completeAgentRequest(actor: Actor, sessionId: string, requestEventId: string, runtimeId: string, idempotencyKey: string, payload: JsonValue): CanonicalEvent {
    const { session } = this.requireWrite(actor, sessionId);
    if (session.state !== "active") throw conflict("Archived sessions do not accept agent responses");
    const event = this.database.completeAgentRequest(
      actor,
      sessionId,
      requestEventId,
      runtimeId,
      idempotencyKey,
      redactJson(payload),
    );
    this.publish(event);
    return event;
  }

  canReadEvent(actor: Actor, event: CanonicalEvent): boolean {
    const role = this.database.membershipRole(event.session_id, actor.user_id);
    if (!role) return false;
    return event.visibility === "session" || role === "owner";
  }

  requireMembership(actor: Actor, sessionId: string): MembershipRole {
    this.database.assertActiveDevice(actor);
    this.database.requireSession(sessionId);
    const role = this.database.membershipRole(sessionId, actor.user_id);
    if (!role) throw notFound("Session");
    return role;
  }

  private requireWrite(actor: Actor, sessionId: string): { role: MembershipRole; session: SessionRecord } {
    const session = this.database.requireSession(sessionId);
    const role = this.database.membershipRole(sessionId, actor.user_id);
    if (!role) throw notFound("Session");
    if (role === "viewer") throw forbidden("Viewers cannot append events");
    if (session.mode === "solo" && role !== "owner") throw forbidden("Only the owner can write to a solo session");
    return { role, session };
  }

  private requireOwner(actor: Actor, sessionId: string): void {
    if (this.requireMembership(actor, sessionId) !== "owner") throw forbidden("Only the session owner may perform this action");
  }

  private requireOwnedRuntime(actor: Actor, sessionId: string, runtimeId: string): RuntimeRecord {
    const runtime = this.database.getRuntime(runtimeId);
    if (runtime.user_id !== actor.user_id || runtime.device_id !== actor.device_id
      || runtime.session_id !== sessionId || runtime.status === "revoked") {
      throw forbidden("Runtime does not belong to the actor and session");
    }
    return runtime;
  }

  private publish(event: CanonicalEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}
