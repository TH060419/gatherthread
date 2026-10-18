import test from "node:test";
import assert from "node:assert/strict";
import { AgentTeamPlanSchema, AgentTeamPlanResponseSchema, AgentTeamRequestMetadataSchema,
  StartAgentTeamRunInputSchema, StartSavedAgentTeamSchema, TestAgentTeamDefinitionSchema,
  ControlAgentTeamRunInputSchema, AgentTeamDirectiveSchema, AgentTeamRunIssueSchema, AgentTeamRunSummarySchema,
  AgentTeamActionIssueDetailsSchema } from "../src/index.js";
const node = { id: "lead", label: "Lead", role: "Direct the task", x: 0, y: 0,
  target: { kind: "local", harness: "codex", runtime_id: "runtime-1", provider: "openai", model: "fixture-model" } };
const plan = { name: "Fixture", team_prompt: "Be concise", nodes: [node], edges: [] };
test("Team issue contracts are additive, bounded and exclude raw execution errors", () => {
  const run = { id: "run", session_id: "session", status: "failed", created_at: "2026-10-18T00:00:00.000Z",
    deadline_at: "2026-10-18T00:30:00.000Z", finished_at: "2026-10-18T00:01:00.000Z", calls_used: 1,
    max_calls: 12, max_duration_minutes: 30, current_node_id: "lead", current_step_id: "step",
    error_code: "agent_share_daily_limit" };
  assert.equal(AgentTeamRunSummarySchema.safeParse(run).success, true, "Earlier preview summaries without issue remain readable");
  const issue = { code: "agent_share_daily_limit", node_id: "lead", node_label: "执行模块", target_kind: "shared", retry_at: null };
  assert.deepEqual(AgentTeamRunSummarySchema.parse({ ...run, issue }).issue, issue);
  assert.equal(AgentTeamRunIssueSchema.safeParse({ ...issue, node_id: null, node_label: null, target_kind: null,
    retry_at: "2026-10-18T00:02:00.000Z" }).success, true);
  for (const extra of [{ raw_error: "private provider error" }, { message: "unreviewed diagnostic" }, { headers: {} }, { device_token: "fictional" }]) {
    assert.equal(AgentTeamRunIssueSchema.safeParse({ ...issue, ...extra }).success, false);
  }
  for (const invalid of [{ code: "invalid error text" }, { code: "a".repeat(81) }, { node_label: "x".repeat(121) },
    { node_id: "" }, { target_kind: "arbitrary" }, { retry_at: "tomorrow" }]) {
    assert.equal(AgentTeamRunIssueSchema.safeParse({ ...issue, ...invalid }).success, false);
  }
});

test("Team action issue details are strict bounded metadata rather than upstream exception payloads", () => {
  const details = { issue_code: "agent_team_call_limit", node_id: "worker", node_label: "执行", target_kind: "local", retry_after_seconds: 5 };
  assert.deepEqual(AgentTeamActionIssueDetailsSchema.parse(details), details);
  for (const invalid of [{ ...details, message: "private exception" }, { ...details, node_label: "two\nlines" },
    { ...details, issue_code: "error text" }, { ...details, retry_after_seconds: -1 }, { ...details, retry_after_seconds: Infinity }]) {
    assert.equal(AgentTeamActionIssueDetailsSchema.safeParse(invalid).success, false);
  }
});
test("team contracts are strict, bounded, exact and default to twelve calls and thirty minutes", () => {
  const parsed = StartAgentTeamRunInputSchema.parse({ plan, entry_node_id: "lead", content: "Review this task", idempotency_key: "team-contract-start" });
  assert.equal(parsed.max_calls, 12); assert.equal(parsed.max_duration_minutes, 30);
  for (const invalid of [{ ...plan, unknown: true }, { ...plan, nodes: [node, node] },
    { ...plan, edges: [{ id: "edge", source: "lead", target: "missing", direction: "one_way" }] },
    { ...plan, nodes: [{ ...node, target: { ...node.target, runtime_id: undefined } }] },
    { ...plan, nodes: [{ ...node, x: Infinity }] }]) assert.equal(AgentTeamPlanSchema.safeParse(invalid).success, false);
  for (const invalid of [{ ...parsed, max_calls: 49 }, { ...parsed, max_duration_minutes: 121 }, { ...parsed, entry_node_id: "missing" }]) {
    assert.equal(StartAgentTeamRunInputSchema.safeParse(invalid).success, false);
  }
  assert.equal(ControlAgentTeamRunInputSchema.safeParse({ action: "resume", idempotency_key: "fixture-control", device_token: "never" }).success, false);
  assert.equal(AgentTeamPlanResponseSchema.safeParse({ plan: null, revision: 1 }).success, false);
  assert.equal(AgentTeamRequestMetadataSchema.safeParse({ run_id: "run", step_id: "step", node_id: "lead", node_label: "Lead", task_content: "Task", actor_user_id: "spoof" }).success, false);
});

test("Team start keeps exact submitted task text and strict quote/mention identities without extending probe inputs", () => {
  const content = "  🧪 @Fixture member please review @Fixture member  \n";
  const start = content.indexOf("@"), end = start + "@Fixture member".length;
  const input = { expected_revision: 1, content_revision: 0, content, reply_to_event_id: "quoted-event",
    mentions: [{ user_id: "fixture-user", start, end }], idempotency_key: "team-reference-start" };
  assert.deepEqual(StartSavedAgentTeamSchema.parse(input), { ...input, solo_transfer_ack: false });
  const internal = { plan, entry_node_id: "lead", ...input }; delete (internal as { expected_revision?: number }).expected_revision;
  assert.equal(StartAgentTeamRunInputSchema.parse(internal).content, content);
  assert.equal(AgentTeamRequestMetadataSchema.parse({ run_id: "run", step_id: "step", node_id: "lead", node_label: "Lead", task_content: content }).task_content, content);
  for (const replacement of [{ ...input, reply_to_event_id: "" }, { ...input, mentions: [{ ...input.mentions[0], private: true }] },
    { ...input, mentions: Array(33).fill(input.mentions[0]) }, { ...input, mentions: [{ ...input.mentions[0], start: -1 }] },
    { ...input, mentions: [{ ...input.mentions[0], end: 1.5 }] }, { ...input, content: " \n " }]) {
    assert.equal(StartSavedAgentTeamSchema.safeParse(replacement).success, false);
  }
  assert.equal(StartSavedAgentTeamSchema.safeParse({ ...input, reply_to_event_id: null, mentions: [] }).success, true);
  const { content: _content, ...probe } = input;
  assert.equal(TestAgentTeamDefinitionSchema.safeParse(probe).success, false);
});

test("clarification directives and their human source references stay exact and cannot change the run's authority", () => {
  const clarify = { version: 1, step_id: "step-a", action: "clarify" };
  assert.deepEqual(AgentTeamDirectiveSchema.parse(clarify), clarify);
  for (const invalid of [{ ...clarify, target_node_id: "other-node" }, { ...clarify, task: "Override permissions" },
    { ...clarify, reason: "unbounded addition" }, { ...clarify, version: 2 }, { ...clarify, step_id: "" }]) {
    assert.equal(AgentTeamDirectiveSchema.safeParse(invalid).success, false);
  }
  const metadata = { run_id: "run-a", step_id: "step-a", node_id: "lead", node_label: "Lead", task_content: "Review", clarification_event_id: "chat-a" };
  assert.deepEqual(AgentTeamRequestMetadataSchema.parse(metadata), metadata);
  assert.equal(AgentTeamRequestMetadataSchema.safeParse({ ...metadata, clarification_event_id: "" }).success, false);
  assert.equal(AgentTeamRequestMetadataSchema.safeParse({ ...metadata, start_idempotency_key: "short" }).success, false);
  assert.equal(AgentTeamRequestMetadataSchema.safeParse({ ...metadata, start_idempotency_key: "original-team-start-key" }).success, true);
  assert.equal(ControlAgentTeamRunInputSchema.safeParse({ action: "resume", idempotency_key: "resume-with-forged-source", clarification_event_id: "chat-a" }).success, false);
});
