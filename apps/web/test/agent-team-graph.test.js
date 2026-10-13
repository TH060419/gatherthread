import test from "node:test";
import assert from "node:assert/strict";
import { canLinkTeamNodes, clampTeamPosition, removeTeamNode, teamEdgePath, teamRunControls, teamRunLabel,
  teamTargetChoices, teamTargetKey, TEAM_GRAPH_WIDTH, TEAM_NODE_WIDTH } from "../src/agent-team-graph.js";

test("team choices use exact advertised profiles and retain separate devices and efforts", () => {
  const runtimes = [{ id: "a", deviceId: "d1", harness: "codex", status: "online", provider: "openai", model: "old",
    executionProfiles: [{ provider: "openai", model: "offered", reasoningEfforts: ["low", "high"] }] },
  { id: "b", deviceId: "d2", harness: "codex", status: "offline", provider: "openai", model: "fixed" },
  { id: "c", deviceId: "d1", harness: "deepseek-harness", status: "online", provider: "deepseek", model: "dsh" }];
  const choices = teamTargetChoices({ runtimes, devices: [{ id: "d1", name: "My computer" }], userId: "me" });
  assert.equal(choices.length, 4); assert.equal(new Set(choices.map(choice => choice.key)).size, 4);
  assert.deepEqual(choices[0].target, { kind: "local", runtime_id: "a", harness: "codex", provider: "openai", model: "offered", reasoning_effort: "low" });
  assert.equal(choices[2].available, false); assert.ok(choices[0].label.includes("My computer"));
  assert.ok(!choices.some(choice => choice.target.model === "old"));
});

test("foreign, revoked and snapshot runtimes cannot become team choices", () => {
  const runtime = { id: "a", deviceId: "d", harness: "codex", status: "online", provider: "p", model: "m" };
  assert.deepEqual(teamTargetChoices({ userId: "me", runtimes: [{ ...runtime, userId: "peer" },
    { ...runtime, purpose: "snapshot_connector" }, { ...runtime, status: "revoked" }, { ...runtime, harness: "unknown" }] }), []);
});

test("cloud code opt-in does not change a model identity or invent provider access", () => {
  assert.equal(teamTargetChoices({ cloudStatus: { enabled: false, profiles: [{ id: "p" }] } }).length, 0);
  const [choice] = teamTargetChoices({ cloudStatus: { enabled: true, profiles: [{ id: "p", provider: "provider", model: "m", available: false }] } });
  assert.equal(choice.available, false); assert.equal(choice.target.include_code, false);
  assert.equal(teamTargetKey(choice.target), teamTargetKey({ ...choice.target, include_code: true }));
});

test("node removal cleans only adjacent edges; direction constrains new connections", () => {
  const plan = { nodes: [{ id: "a" }, { id: "b" }, { id: "c" }], edges: [{ id: "ab", source: "a", target: "b", direction: "one_way" },
    { id: "bc", source: "b", target: "c", direction: "bidirectional" }] };
  assert.equal(canLinkTeamNodes(plan, "b", "a"), true);
  assert.equal(canLinkTeamNodes(plan, "b", "a", "bidirectional"), false);
  assert.equal(canLinkTeamNodes(plan, "c", "b"), false);
  assert.equal(canLinkTeamNodes(plan, "a", "a"), false);
  assert.equal(canLinkTeamNodes(plan, "a", "missing"), false);
  const next = removeTeamNode(plan, "a"); assert.deepEqual(next.edges.map(edge => edge.id), ["bc"]); assert.equal(plan.nodes.length, 3);
});

test("drag and keyboard positions stay in the canvas without NaN or lost edge endpoints", () => {
  assert.deepEqual(clampTeamPosition(-10, NaN), { x: 0, y: 0 });
  assert.equal(clampTeamPosition(100000, 0).x, TEAM_GRAPH_WIDTH - TEAM_NODE_WIDTH);
  assert.equal(teamEdgePath({ x: 10, y: 20 }, { x: 400, y: 30 }).startsWith("M 246 91 C"), true);
});

test("timeout, pause and terminal bounds expose different team controls", () => {
  assert.deepEqual(teamRunControls({ status: "paused", error_code: "agent_timeout" }), { pause: false, stop: true, resume: false, continue: true });
  assert.equal(teamRunControls({ status: "paused", error_code: "server_restarted" }).resume, true);
  for (const status of ["completed", "failed", "stopped", "timed_out", "call_limit"]) assert.ok(Object.values(teamRunControls({ status })).every(value => !value));
  assert.equal(teamRunLabel({ status: "paused", error_code: "agent_timeout" }), "Agent timed out · continue available");
});

test("removing the saved first Agent chooses a remaining node without retaining a dangling target", () => {
  const saved = { name: "Fixture", entry_node_id: "lead", nodes: [{ id: "lead" }, { id: "worker" }], edges: [] };
  const remaining = removeTeamNode(saved, "lead"); assert.equal(remaining.entry_node_id, "worker");
  assert.equal(Object.hasOwn(removeTeamNode(remaining, "worker"), "entry_node_id"), false);
});
