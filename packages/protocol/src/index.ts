import { z } from "zod";

export const sessionModes = ["solo", "multi"] as const;
export const membershipRoles = ["owner", "participant", "viewer"] as const;
export const eventTypes = [
  "human_chat",
  "agent_request",
  "agent_response",
  "tool_call",
  "tool_result",
  "attachment",
  "context_snapshot",
  "membership_change",
  "session_state_change",
] as const;
export const eventVisibilities = ["session", "owner_only"] as const;
export const captureFidelities = [
  "canonical_history",
  "harness_transcript",
  "provider_request",
] as const;
export const invitationTtls = ["1h", "24h", "7d"] as const;

export const SessionModeSchema = z.enum(sessionModes);
export const MembershipRoleSchema = z.enum(membershipRoles);
export const EventTypeSchema = z.enum(eventTypes);
export const EventVisibilitySchema = z.enum(eventVisibilities);
export const CaptureFidelitySchema = z.enum(captureFidelities);
export const InvitationTtlSchema = z.enum(invitationTtls);
export const InvitationRoleSchema = z.enum(["participant", "viewer"]);

export type SessionMode = z.infer<typeof SessionModeSchema>;
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventVisibility = z.infer<typeof EventVisibilitySchema>;
export type CaptureFidelity = z.infer<typeof CaptureFidelitySchema>;
export type InvitationTtl = z.infer<typeof InvitationTtlSchema>;
export type InvitationRole = z.infer<typeof InvitationRoleSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const IdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const IdempotencyKeySchema = z.string().trim().min(8).max(200);

export const RuntimeProvenanceSchema = z.object({
  user_id: IdSchema,
  device_id: IdSchema,
  runtime_id: IdSchema.optional(),
  harness: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(160),
  local_session_id: z.string().trim().min(1).max(512),
  capture_fidelity: CaptureFidelitySchema,
});

export type RuntimeProvenance = z.infer<typeof RuntimeProvenanceSchema>;

export const CanonicalEventSchema = z.object({
  id: IdSchema,
  session_id: IdSchema,
  sequence: z.number().int().positive(),
  idempotency_key: IdempotencyKeySchema,
  type: EventTypeSchema,
  actor_user_id: IdSchema,
  created_at: z.string().datetime(),
  visibility: EventVisibilitySchema,
  reply_to_event_id: IdSchema.nullable(),
  payload: JsonValueSchema,
  runtime_provenance: RuntimeProvenanceSchema.nullable(),
});

export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;

export const AppendEventInputSchema = z.object({
  event_id: IdSchema.optional(),
  idempotency_key: IdempotencyKeySchema,
  type: EventTypeSchema,
  visibility: EventVisibilitySchema.default("session"),
  reply_to_event_id: IdSchema.nullable().optional(),
  payload: JsonValueSchema,
  runtime_id: IdSchema.optional(),
});

export type AppendEventInput = z.infer<typeof AppendEventInputSchema>;

export const CreateSessionInputSchema = z.object({
  session_id: IdSchema.optional(),
  idempotency_key: IdempotencyKeySchema,
  mode: SessionModeSchema,
  title: z.string().trim().min(1).max(200),
});

export const SetMembershipInputSchema = z.object({
  role: z.enum(["participant", "viewer"]),
  idempotency_key: IdempotencyKeySchema,
});

export const CreateIdentityInputSchema = z.object({
  user_id: IdSchema.optional(),
  display_name: z.string().trim().min(1).max(120),
  device_id: IdSchema.optional(),
  device_name: z.string().trim().min(1).max(120),
});

export const ActorSchema = z.object({
  user_id: IdSchema,
  display_name: z.string().trim().min(1).max(120),
  device_id: IdSchema,
});

export type ActorIdentity = z.infer<typeof ActorSchema>;

export const CreateInvitationInputSchema = z.object({
  role: InvitationRoleSchema,
  ttl: InvitationTtlSchema.default("24h"),
});

export type CreateInvitationInput = z.infer<typeof CreateInvitationInputSchema>;

export const ClaimInvitationInputSchema = z.object({
  invite_token: z.string().min(32).max(512),
  user_id: IdSchema.optional(),
  display_name: z.string().trim().min(1).max(120),
  device_id: IdSchema.optional(),
  device_name: z.string().trim().min(1).max(120),
  device_expires_at: z.string().datetime().nullable().optional(),
});

export type ClaimInvitationInput = z.infer<typeof ClaimInvitationInputSchema>;

export const AcceptInvitationInputSchema = z.object({
  invite_token: z.string().min(32).max(512),
});

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationInputSchema>;

export const InvitationRecordSchema = z.object({
  id: IdSchema,
  session_id: IdSchema,
  inviter_user_id: IdSchema,
  role: InvitationRoleSchema,
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
  expired_at: z.string().datetime().nullable(),
  claimed_at: z.string().datetime().nullable(),
  claimed_by_user_id: IdSchema.nullable(),
  claimed_by_device_id: IdSchema.nullable(),
});

export type InvitationRecord = z.infer<typeof InvitationRecordSchema>;

export const DeviceRecordSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  name: z.string().trim().min(1).max(120),
  created_at: z.string().datetime(),
  token_created_at: z.string().datetime(),
  last_used_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  rotated_at: z.string().datetime().nullable(),
  token_version: z.number().int().positive(),
});

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export const ClaimDeviceAuthorizationInputSchema = z.object({
  authorization_token: z.string().min(32).max(512),
  device_id: IdSchema.optional(),
  device_name: z.string().trim().min(1).max(120),
  expires_at: z.string().datetime().nullable().optional(),
});

export type ClaimDeviceAuthorizationInput = z.infer<typeof ClaimDeviceAuthorizationInputSchema>;

export const DeviceAuthorizationRecordSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  authorizer_device_id: IdSchema,
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
  expired_at: z.string().datetime().nullable(),
  claimed_at: z.string().datetime().nullable(),
  claimed_by_device_id: IdSchema.nullable(),
});

export type DeviceAuthorizationRecord = z.infer<typeof DeviceAuthorizationRecordSchema>;

export const RotateDeviceTokenInputSchema = z.object({
  expires_at: z.string().datetime().nullable().optional(),
});

export const InvitationAuditRecordSchema = z.object({
  id: IdSchema,
  invitation_id: IdSchema,
  session_id: IdSchema,
  action: z.enum(["created", "claimed", "revoked", "expired"]),
  inviter_user_id: IdSchema,
  subject_user_id: IdSchema.nullable(),
  subject_device_id: IdSchema.nullable(),
  role: InvitationRoleSchema,
  created_at: z.string().datetime(),
});

export type InvitationAuditRecord = z.infer<typeof InvitationAuditRecordSchema>;

export const RegisterRuntimeInputSchema = z.object({
  runtime_id: IdSchema.optional(),
  session_id: IdSchema,
  device_id: IdSchema,
  harness: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(160),
  local_session_id: z.string().trim().min(1).max(512),
  capture_fidelity: CaptureFidelitySchema,
});

export const ClaimAgentRequestInputSchema = z.object({
  runtime_id: IdSchema,
});

export const CompleteAgentRequestInputSchema = z.object({
  runtime_id: IdSchema,
  idempotency_key: IdempotencyKeySchema,
  payload: JsonValueSchema,
});

export const SubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  session_id: IdSchema,
  after_sequence: z.number().int().nonnegative().default(0),
});

export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;

export const ReplayResponseSchema = z.object({
  events: z.array(CanonicalEventSchema),
  cursor: z.number().int().nonnegative(),
  has_more: z.boolean(),
});

export type ReplayResponse = z.infer<typeof ReplayResponseSchema>;

export const SessionListItemSchema = z.object({
  id: IdSchema,
  title: z.string(),
  mode: SessionModeSchema,
  state: z.enum(["active", "archived"]),
  role: MembershipRoleSchema,
  current_sequence: z.number().int().nonnegative(),
  member_count: z.number().int().nonnegative().optional(),
  updated_at: z.string().datetime(),
});

export type SessionListItem = z.infer<typeof SessionListItemSchema>;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: JsonValue;
  };
}
