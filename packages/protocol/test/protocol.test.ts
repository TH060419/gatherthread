import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentExecutionProfileSchema,
  AgentProgressInputSchema,
  AgentRequestClaimSchema,
  AppendEventInputSchema,
  CanonicalEventSchema,
  ClaimInvitationInputSchema,
  CreateBrowserSessionInputSchema,
  ActivateRememberedAccountInputSchema,
  CreateSnapshotRequestInputSchema,
  CommitLocalTurnInputSchema,
  CompleteAgentRequestInputSchema,
  CompleteSnapshotRequestInputSchema,
  CreateInvitationInputSchema,
  CreateProjectInputSchema,
  InvitationRecordSchema,
  ProjectInvitationRecordSchema,
  ProjectListItemSchema,
  RegisterRuntimeInputSchema,
  RemoveProjectMembershipInputSchema,
  RemoveSessionMembershipInputSchema,
  DetachedCodeClearResultSchema,
  RuntimeExecutionProfilesSchema,
  RuntimeProvenanceSchema,
  SessionTitleSchema,
  SnapshotRequestRecordSchema,
  SubscribeMessageSchema,
  UpdateSessionInputSchema,
  UpdateProjectInputSchema,
} from "../src/index.js";

test("member-removal and detached-clear wire contracts reject unknown fields", () => {
  const head = "a".repeat(40);
  const decision = { branch_resolution: "delete", expected_branch_head_commit: head };
  assert.equal(RemoveProjectMembershipInputSchema.safeParse({}).success, true);
  assert.equal(RemoveProjectMembershipInputSchema.safeParse(decision).success, true);
  assert.equal(RemoveProjectMembershipInputSchema.safeParse({ ...decision, unexpected: true }).success, false);
  assert.equal(RemoveProjectMembershipInputSchema.safeParse({ branch_resolution: "delete" }).success, false);
  assert.equal(RemoveSessionMembershipInputSchema.safeParse({ idempotency_key: "remove-one" }).success, true);
  assert.equal(RemoveSessionMembershipInputSchema.safeParse({ ...decision, idempotency_key: "remove-two" }).success, true);
  assert.equal(RemoveSessionMembershipInputSchema.safeParse({ ...decision, idempotency_key: "remove-three", unexpected: true }).success, false);
  assert.equal(DetachedCodeClearResultSchema.safeParse({ released_bytes: 0 }).success, true);
  assert.equal(DetachedCodeClearResultSchema.safeParse({ released_bytes: 0, private_detail: "ignored" }).success, false);
});

test("Agent execution profiles are bounded single-line data", () => {
  assert.deepEqual(AgentExecutionProfileSchema.parse({
    harness: "codex",
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoning_effort: "high",
    runtime_id: "runtime-codex-1",
  }), {
    harness: "codex",
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoning_effort: "high",
    runtime_id: "runtime-codex-1",
  });
  assert.equal(AgentExecutionProfileSchema.safeParse({ harness: "codex", model: "bad\nmodel" }).success, false);
  assert.equal(AgentExecutionProfileSchema.safeParse({ harness: "codex", model: "x".repeat(161) }).success, false);
  assert.equal(AgentExecutionProfileSchema.safeParse({ harness: "codex", model: "gpt-5.6-sol", reasoning_effort: "bad\u0085value" }).success, false);
  assert.equal(AgentExecutionProfileSchema.safeParse({ harness: "codex", provider: "bad\nprovider", model: "gpt-5.6-sol" }).success, false);
  assert.equal(AgentExecutionProfileSchema.safeParse({ harness: "codex", model: "gpt-5.6-sol", runtime_id: "bad runtime" }).success, false);
});

test("Agent progress and completion accept a positive claim attempt fence", () => {
  const input = {
    runtime_id: "runtime-1",
    claim_attempt: 2,
    idempotency_key: "agent-complete-0001",
    payload: { text: "done" },
  };
  assert.equal(CompleteAgentRequestInputSchema.parse(input).claim_attempt, 2);
  assert.equal(AgentProgressInputSchema.parse(input).claim_attempt, 2);
  assert.equal(CompleteAgentRequestInputSchema.safeParse({ ...input, claim_attempt: 0 }).success, false);
});

test("Agent request claim results distinguish legacy omission from malformed attempts", () => {
  const legacy = {
    request_event_id: "request-1",
    runtime_id: "runtime-1",
    status: "claimed",
  };
  assert.equal(AgentRequestClaimSchema.parse(legacy).attempt_count, undefined);
  assert.equal(AgentRequestClaimSchema.parse({ ...legacy, attempt_count: 2 }).attempt_count, 2);
  assert.equal(AgentRequestClaimSchema.safeParse({ ...legacy, attempt_count: 0 }).success, false);
  assert.equal(AgentRequestClaimSchema.safeParse({ ...legacy, attempt_count: "2" }).success, false);
  assert.equal(AgentRequestClaimSchema.safeParse({ ...legacy, status: "unknown" }).success, false);
});

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

test("project contracts keep invitations and session grouping project-scoped", () => {
  assert.equal(CreateProjectInputSchema.safeParse({
    title: "Shared implementation",
    idempotency_key: "project-create-0001",
  }).success, true);
  const timestamp = new Date().toISOString();
  assert.equal(ProjectListItemSchema.safeParse({
    id: "project-1",
    title: "Shared implementation",
    state: "active",
    role: "participant",
    session_count: 2,
    created_at: timestamp,
    updated_at: timestamp,
  }).success, true);
  assert.equal(ProjectInvitationRecordSchema.safeParse({
    id: "invite-1",
    project_id: "project-1",
    inviter_user_id: "owner",
    role: "participant",
    created_at: timestamp,
    expires_at: timestamp,
    revoked_at: null,
    expired_at: null,
    claimed_at: null,
    claimed_by_user_id: null,
    claimed_by_device_id: null,
  }).success, true);
});

test("project and session renames use the same trimmed Unicode title contract as creation", () => {
  assert.equal(SessionTitleSchema.parse("  研究计划 🚀  "), "研究计划 🚀");
  assert.equal(CreateProjectInputSchema.parse({
    title: "  量子项目 🚀  ",
    idempotency_key: "unicode-project-0001",
  }).title, "量子项目 🚀");
  assert.deepEqual(UpdateSessionInputSchema.parse({
    title: "  Renamed session  ",
    idempotency_key: "rename-session-0001",
  }), {
    title: "Renamed session",
    idempotency_key: "rename-session-0001",
  });
  assert.deepEqual(UpdateProjectInputSchema.parse({
    title: "  Renamed project  ",
    idempotency_key: "rename-project-0001",
  }), {
    title: "Renamed project",
    idempotency_key: "rename-project-0001",
  });
  assert.equal(UpdateProjectInputSchema.safeParse({
    title: "   ",
    idempotency_key: "rename-project-0002",
  }).success, false);
  assert.equal(UpdateSessionInputSchema.safeParse({
    title: "   ",
    idempotency_key: "rename-session-0002",
  }).success, false);
  assert.equal(UpdateSessionInputSchema.safeParse({
    title: "x".repeat(201),
    idempotency_key: "rename-session-0003",
  }).success, false);
  for (const title of ["line\nbreak", "nul\u0000byte", "c1\u0085control"]) {
    assert.equal(SessionTitleSchema.safeParse(title).success, false);
    assert.equal(CreateProjectInputSchema.safeParse({
      title,
      idempotency_key: "control-project-0001",
    }).success, false);
    assert.equal(UpdateSessionInputSchema.safeParse({
      title,
      idempotency_key: "control-rename-0001",
    }).success, false);
    assert.equal(UpdateProjectInputSchema.safeParse({
      title,
      idempotency_key: "control-project-rename-0001",
    }).success, false);
  }
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
  assert.equal(ClaimInvitationInputSchema.parse({
    invite_token: "valid-invitation-secret-that-is-long-enough",
    display_name: "Invitee",
    device_name: "Safari · macOS",
  }).remember_device, false);
  assert.equal(CreateBrowserSessionInputSchema.parse({}).remember_device, false);
  assert.equal(CreateBrowserSessionInputSchema.parse({ remember_device: true }).remember_device, true);
  assert.equal(ActivateRememberedAccountInputSchema.safeParse({
    display_name: "Invitee", device_name: "Laptop", unexpected: true,
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
    actor_display_name: "User One",
    created_at: new Date().toISOString(),
    visibility: "session",
    reply_to_event_id: null,
    payload: { text: "hello" },
    runtime_provenance: null,
  };
  assert.deepEqual(CanonicalEventSchema.parse(event), event);
  const { actor_display_name: _omitted, ...legacyEvent } = event;
  assert.equal(CanonicalEventSchema.safeParse(legacyEvent).success, true);
  assert.deepEqual(
    SubscribeMessageSchema.parse({ type: "subscribe", session_id: "session-1" }),
    { type: "subscribe", session_id: "session-1", after_sequence: 0 },
  );
});

test("local turn, snapshot request, and runtime purpose contracts are bounded", () => {
  const runtime = {
    runtime_id: "runtime-1", session_id: "session-1", device_id: "device-1",
    harness: "codex", provider: "openai", model: "gpt-5", local_session_id: "local-1",
    capture_fidelity: "canonical_history",
  };
  assert.equal(RegisterRuntimeInputSchema.parse(runtime).purpose, "execution");
  assert.equal(RegisterRuntimeInputSchema.parse({ ...runtime, purpose: "snapshot_connector" }).purpose, "snapshot_connector");
  const executionProfiles = [{
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoning_efforts: ["low", "high"],
    default_reasoning_effort: "low",
  }, {
    provider: "deepseek-official",
    model: "deepseek-reasoner",
  }];
  assert.deepEqual(RuntimeExecutionProfilesSchema.parse(executionProfiles), executionProfiles);
  assert.deepEqual(
    RegisterRuntimeInputSchema.parse({ ...runtime, execution_profiles: executionProfiles }).execution_profiles,
    executionProfiles,
  );
  assert.equal(RuntimeExecutionProfilesSchema.safeParse([{
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoning_efforts: ["low"],
    default_reasoning_effort: "high",
  }]).success, false);
  assert.equal(RuntimeExecutionProfilesSchema.safeParse([{
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoning_efforts: ["low", "low"],
  }]).success, false);
  assert.equal(RuntimeExecutionProfilesSchema.safeParse([
    { provider: "deepseek-official", model: "deepseek-v4-flash" },
    { provider: "deepseek-official", model: "deepseek-v4-flash" },
  ]).success, false);
  assert.equal(RuntimeExecutionProfilesSchema.safeParse([{
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    unsupported: true,
  }]).success, false);
  assert.equal(RuntimeExecutionProfilesSchema.safeParse(Array.from({ length: 33 }, (_, index) => ({
    provider: "deepseek-official",
    model: `deepseek-model-${index}`,
  }))).success, false);
  const turn = {
    local_turn_id: "turn-1", runtime_id: "runtime-1", based_on_sequence: 0,
    occurred_at: "2026-08-25T12:00:00.000Z", observed_model: "gpt-5.6-terra", observed_reasoning_effort: "high",
    request_payload: {}, response_payload: {},
  };
  assert.equal(CommitLocalTurnInputSchema.safeParse(turn).success, true);
  assert.equal(CommitLocalTurnInputSchema.safeParse({ ...turn, observed_model: "x".repeat(161) }).success, false);
  assert.equal(CommitLocalTurnInputSchema.safeParse({ ...turn, observed_reasoning_effort: "x".repeat(81) }).success, false);
  assert.equal(CommitLocalTurnInputSchema.safeParse({
    ...turn,
    tool_events: Array.from({ length: 33 }, () => ({ type: "tool_result", payload: {} })),
  }).success, false);
  const record = {
    id: "snapshot-1", session_id: "session-1", requested_by_user_id: "user-1", kind: "immutable", through_sequence: 1,
    status: "pending", target_runtime_id: null, claimed_by_runtime_id: null, created_at: "2026-08-25T12:00:00.000Z",
    claimed_at: null, completed_at: null, failed_at: null, result: null, failure: null,
  };
  assert.deepEqual(SnapshotRequestRecordSchema.parse(record), record);
  assert.deepEqual(CreateSnapshotRequestInputSchema.parse({}), { kind: "immutable" });
  assert.deepEqual(CreateSnapshotRequestInputSchema.parse({ kind: "visible_history_replace" }), {
    kind: "visible_history_replace",
  });
  assert.deepEqual(CreateSnapshotRequestInputSchema.parse({
    kind: "local_auto_upload_disable", target_runtime_id: "runtime-1",
  }), { kind: "local_auto_upload_disable", target_runtime_id: "runtime-1" });
  assert.equal(CreateSnapshotRequestInputSchema.safeParse({ kind: "replace" }).success, false);
  assert.equal(CompleteSnapshotRequestInputSchema.safeParse({ runtime_id: "runtime-1", result: {} }).success, true);
  assert.equal(CompleteSnapshotRequestInputSchema.safeParse({
    runtime_id: "runtime-1", result: { content: "x".repeat(100_000) },
  }).success, false);
});
