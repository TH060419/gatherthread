import assert from "node:assert/strict";
import test from "node:test";
import {
  AppendEventInputSchema,
  CanonicalEventSchema,
  ClaimInvitationInputSchema,
  CreateInvitationInputSchema,
  InvitationRecordSchema,
  RuntimeProvenanceSchema,
  SubscribeMessageSchema,
} from "../src/index.js";

test("append input rejects unknown event types and short idempotency keys", () => {
  assert.equal(
    AppendEventInputSchema.safeParse({
      idempotency_key: "short",
      type: "thought",
      payload: {},
    }).success,
    false,
  );
});

test("invitation inputs allow only fixed TTLs and participant/viewer roles", () => {
  assert.deepEqual(CreateInvitationInputSchema.parse({ role: "viewer" }), {
    role: "viewer",
    ttl: "24h",
  });
  assert.equal(CreateInvitationInputSchema.safeParse({ role: "owner", ttl: "1h" }).success, false);
  assert.equal(CreateInvitationInputSchema.safeParse({ role: "participant", ttl: "2h" }).success, false);
  assert.equal(ClaimInvitationInputSchema.safeParse({
    invite_token: "too-short",
    display_name: "Invitee",
    device_name: "Laptop",
  }).success, false);
});

test("public invitation records never contain a token digest", () => {
  const record = {
    id: "invite-1",
    session_id: "session-1",
    inviter_user_id: "owner",
    role: "participant",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
    expired_at: null,
    claimed_at: null,
    claimed_by_user_id: null,
    claimed_by_device_id: null,
  };
  assert.deepEqual(InvitationRecordSchema.parse(record), record);
  assert.equal("token_digest" in InvitationRecordSchema.parse({ ...record, token_digest: "secret" }), false);
});

test("runtime provenance requires an explicit fidelity claim", () => {
  const base = {
    user_id: "user-1",
    device_id: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    local_session_id: "local-1",
  };
  assert.equal(RuntimeProvenanceSchema.safeParse(base).success, false);
  assert.equal(
    RuntimeProvenanceSchema.safeParse({ ...base, capture_fidelity: "harness_transcript" }).success,
    true,
  );
});

test("canonical events and reconnect subscriptions round-trip", () => {
  const event = {
    id: "event-1",
    session_id: "session-1",
    sequence: 1,
    idempotency_key: "request-0001",
    type: "human_chat",
    actor_user_id: "user-1",
    created_at: new Date().toISOString(),
    visibility: "session",
    reply_to_event_id: null,
    payload: { text: "hello" },
    runtime_provenance: null,
  };
  assert.deepEqual(CanonicalEventSchema.parse(event), event);
  assert.deepEqual(
    SubscribeMessageSchema.parse({ type: "subscribe", session_id: "session-1" }),
    { type: "subscribe", session_id: "session-1", after_sequence: 0 },
  );
});
