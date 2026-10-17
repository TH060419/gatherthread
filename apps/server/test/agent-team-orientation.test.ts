import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTeamPlan } from "@gatherthread/protocol";
import { teamOrientation } from "../src/agent-team-orientation.js";

const target = { kind: "local" as const, runtime_id: "private-runtime-fixture", harness: "codex" as const, provider: "fixture", model: "fixture-model" };
const plan: AgentTeamPlan = { name: "Team fixture", team_prompt: "Shared rules", nodes: [
  { id: "a", label: "Planner", role: "Plan and coordinate", prompt: "Planner instructions", x: 0, y: 0, target },
  { id: "b", label: "Builder", role: "Implement within the approved project", prompt: "Other module instructions", x: 100, y: 0, target },
  { id: "c", label: "Checker", role: "Test the result", x: 200, y: 0, target },
], edges: [{ id: "a-b", source: "a", target: "b", direction: "one_way" }, { id: "b-c", source: "b", target: "c", direction: "bidirectional" }] };
const input = { entryNodeId: "a", nodeId: "b", callerNodeId: "a", returnedFromNodeId: null, firstContact: true,
  phase: "delegated_assignment" as const, callsUsed: 1, maxCalls: 12, deadlineAt: "2026-10-16T12:30:00.000Z", remainingSeconds: 1500 };

test("the public full-Team manifest gives all roles and edges without other prompts or runtime bindings", () => {
  const manifest = teamOrientation(plan, input), serialized = JSON.stringify(manifest);
  assert.deepEqual(manifest.team.modules, plan.nodes.map(node => ({ id: node.id, name: node.label, role: node.role })));
  assert.deepEqual(manifest.team.connections, plan.edges.map(({ source, target, direction }) => ({ source, target, direction })));
  assert.equal(manifest.team.entry_node_id, "a");
  assert.equal(manifest.first_contact, true);
  assert.equal(manifest.overview_delivery, "first_module_call");
  for (const excluded of [target.runtime_id, "Planner instructions", "Other module instructions", "reasoning_effort", "include_code"]) {
    assert.ok(!serialized.includes(excluded), `public overview must not include ${excluded}`);
  }
});

test("actual caller and return destination follow the active stack, independently of incoming graph edges", () => {
  const manifest = teamOrientation(plan, input);
  assert.deepEqual(manifest.assigned_by, { kind: "module", id: "a", name: "Planner" });
  assert.deepEqual(manifest.return_result_to, manifest.assigned_by);
  assert.deepEqual(manifest.allowed_call_targets, [{ kind: "module", id: "c", name: "Checker" }],
    "the one-way parent return does not grant a new call to A");
  const otherCaller = teamOrientation(plan, { ...input, callerNodeId: "c" });
  assert.deepEqual(otherCaller.assigned_by, { kind: "module", id: "c", name: "Checker" });
  assert.deepEqual(otherCaller.allowed_call_targets, manifest.allowed_call_targets);
  const root = teamOrientation(plan, { ...input, nodeId: "a", callerNodeId: null, phase: "reviewing_return", returnedFromNodeId: "b", firstContact: false });
  assert.deepEqual(root.return_result_to, { kind: "human_requester" });
  assert.deepEqual(root.returned_result_from, { kind: "module", id: "b", name: "Builder" });
  assert.equal(root.overview_delivery, "refreshed_for_this_independent_call");
  assert.deepEqual(root.team, manifest.team, "refresh uses the same frozen complete organization facts");
});

test("orientation preserves literal untrusted labels and reports bounded remaining resources", () => {
  const custom = structuredClone(plan); custom.nodes[1]!.label = '<script>fixture</script>'; custom.nodes[1]!.role = "";
  const manifest = teamOrientation(custom, { ...input, callsUsed: 12, remainingSeconds: -1, phase: "clarification_resume" });
  assert.equal(manifest.team.modules[1]!.name, '<script>fixture</script>');
  assert.equal(manifest.team.modules[1]!.role, "Complete the assigned task.");
  assert.equal(manifest.limits.calls_remaining_including_this_call, 0);
  assert.equal(manifest.limits.seconds_remaining, 0);
  assert.equal(manifest.limits.deadline_at, input.deadlineAt);
});
