import test from "node:test";
import assert from "node:assert/strict";
import { AgentTeamPlanSchema, AgentTeamPlanResponseSchema, AgentTeamRequestMetadataSchema,
  StartAgentTeamRunInputSchema, ControlAgentTeamRunInputSchema } from "../src/index.js";
const node = { id: "lead", label: "Lead", role: "Direct the task", x: 0, y: 0,
  target: { kind: "local", harness: "codex", runtime_id: "runtime-1", provider: "openai", model: "fixture-model" } };
const plan = { name: "Fixture", team_prompt: "Be concise", nodes: [node], edges: [] };
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
