import assert from "node:assert/strict";
import test from "node:test";
import {
  TEAM_NODE_HEIGHT,
  TEAM_NODE_WIDTH,
  moduleSnapshot,
  removeTeamNode,
  sameTeamSnapshot,
  teamConnectionChoices,
  teamConnectionKey,
  teamEdgeAllowed,
  teamEdgePath,
  teamModelKey,
  teamTargetForModel,
} from "../src/agent-team-graph.js";

const runtime = (overrides = {}) => ({
  id: "codex-a", userId: "alice", deviceId: "device-a", purpose: "execution", harness: "codex", status: "online",
  provider: "openai", model: "fixture-model-a",
  executionProfiles: [
    { provider: "openai", model: "fixture-model-a", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
    { provider: "openai", model: "fixture-model-b", reasoningEfforts: ["medium"] },
  ],
  ...overrides,
});
const context = (overrides = {}) => ({ userId: "alice", sessionId: "session-a", runtimes: [runtime()],
  devices: [{ id: "device-a", name: "Alice laptop" }], sharedAgents: [], cloudProfiles: [], ...overrides });

test("an Agent connection contains separate advertised model and reasoning choices", () => {
  const choices = teamConnectionChoices(context());
  assert.equal(choices.length, 1, "two models must not duplicate an Agent connection");
  assert.equal(choices[0].key, "local:codex-a");
  assert.equal(choices[0].available, true);
  assert.deepEqual(choices[0].models.map(model => [model.label, model.efforts]), [
    ["fixture-model-a", ["low", "high"]], ["fixture-model-b", ["medium"]],
  ]);
  assert.deepEqual(teamTargetForModel(choices[0].models[0], "low"), {
    kind: "local", runtime_id: "codex-a", harness: "codex", provider: "openai", model: "fixture-model-a", reasoning_effort: "low",
  });
  assert.equal(teamTargetForModel(choices[0].models[0]).reasoning_effort, "high");
  assert.equal(teamTargetForModel(choices[0].models[1]).reasoning_effort, "medium");
});

test("local choices accept only the caller's supported execution runtimes from the exact session", () => {
  const choices = teamConnectionChoices(context({ runtimes: [
    runtime(), // The browser's listSessionRuntimes already scopes normalized entries without a sessionId.
    runtime({ id: "same-session", sessionId: "session-a", harness: "deepseek-harness" }),
    runtime({ id: "foreign-user", userId: "bob" }),
    runtime({ id: "projection", purpose: "projection" }),
    runtime({ id: "unsupported-harness", harness: "unadvertised-harness" }),
    runtime({ id: "other-session", sessionId: "session-b" }),
    runtime({ id: "other-wire-session", session_id: "session-b" }),
  ] }));
  assert.deepEqual(choices.map(choice => choice.key), ["local:codex-a", "local:same-session"]);
  assert.ok(choices[1].label.startsWith("DSH"));
});

test("offline own connections remain identified as unavailable, without substituting an online device", () => {
  const choices = teamConnectionChoices(context({ runtimes: [runtime({ status: "offline" }), runtime({ id: "codex-b", deviceId: "device-b" })] }));
  assert.equal(choices[0].available, false);
  assert.equal(choices[1].available, true);
  assert.equal(teamConnectionKey(choices[0].models[0].target), "local:codex-a");
  assert.equal(teamConnectionKey(choices[1].models[0].target), "local:codex-b");
});

test("shared choices freeze the share identity and revision while preserving each model's advertised efforts", () => {
  const choices = teamConnectionChoices(context({ runtimes: [], sharedAgents: [{
    label: "Bob's DSH", available: true,
    share: { id: "bob-share", revision: 7, execution_profile: { harness: "deepseek-harness", provider: "fixture", model: "legacy" },
      execution_profiles: [{ provider: "fixture", model: "shared-model", reasoning_efforts: ["low", "high"], default_reasoning_effort: "high" }] },
  }] }));
  assert.equal(choices.length, 1);
  assert.equal(choices[0].key, "shared:bob-share:7");
  assert.deepEqual(teamTargetForModel(choices[0].models[0], "low"), {
    kind: "shared", share_id: "bob-share", share_revision: 7, harness: "deepseek-harness",
    provider: "fixture", model: "shared-model", reasoning_effort: "low",
  });
  assert.notEqual(teamConnectionKey({ kind: "shared", share_id: "bob-share", share_revision: 6 }), choices[0].key,
    "a stale stored revision must not match a newly authorized shared connection");
});

test("legacy shared advertisements offer only the exact published profile, without inventing stronger efforts", () => {
  const [choice] = teamConnectionChoices(context({ runtimes: [], sharedAgents: [{ label: "Bob's Codex", available: false,
    share: { id: "legacy-share", revision: 2, execution_profile: { harness: "codex", provider: "openai", model: "single-model", reasoning_effort: "high" } },
  }] }));
  assert.equal(choice.available, false);
  assert.deepEqual(choice.models[0].efforts, ["high"]);
  assert.equal(teamTargetForModel(choice.models[0], "high").reasoning_effort, "high");
  assert.equal(teamTargetForModel(choice.models[0], "max"), null);
});

test("personal cloud model choices keep configuration id, exact revision and code-transfer opt-out", () => {
  const [choice] = teamConnectionChoices(context({ runtimes: [], cloudProfiles: [
    { id: "personal-one", label: "Small", provider: "fixture", model: "cloud-model", api_config_revision: 4 },
    { id: "personal-two", provider: "fixture", model: "cloud-model", api_config_revision: 9, available: false },
  ] }), value => value === "Cloud Agent" ? "云端 Agent" : value);
  assert.equal(choice.label, "云端 Agent");
  assert.equal(choice.available, true);
  assert.equal(choice.models[1].available, false);
  assert.notEqual(choice.models[0].key, choice.models[1].key, "same provider/model under different personal credentials remains a distinct choice");
  assert.deepEqual(teamTargetForModel(choice.models[0]), {
    kind: "cloud", profile_id: "personal-one", provider: "fixture", model: "cloud-model", api_config_revision: 4, include_code: false,
  });
  assert.equal(teamTargetForModel(choice.models[1]).api_config_revision, 9);
  assert.equal(teamConnectionKey(choice.models[0].target), "cloud");
});

test("unavailable cloud catalogs remain unavailable and operator profiles never invent a personal revision", () => {
  const [choice] = teamConnectionChoices(context({ runtimes: [], cloudProfiles: [
    { id: "operator-profile", provider: "fixture", model: "operator-model", available: false },
  ] }));
  assert.equal(choice.available, false);
  assert.deepEqual(teamTargetForModel(choice.models[0]), {
    kind: "cloud", profile_id: "operator-profile", provider: "fixture", model: "operator-model", include_code: false,
  });
});

test("stale explicit model or reasoning selections cannot silently become a different executable choice", () => {
  const [choice] = teamConnectionChoices(context());
  const staleModelKey = teamModelKey({ provider: "openai", model: "deleted-model" });
  assert.equal(teamTargetForModel(choice.models.find(model => model.key === staleModelKey), "low"), null);
  assert.equal(teamTargetForModel(choice.models[0], "retired-effort"), null);
  assert.equal(teamTargetForModel(choice.models[0], ""), null, "an explicit blank is not a request for the advertised default");
  const noEffort = { target: { kind: "cloud", profile_id: "free", provider: "fixture", model: "plain" }, efforts: [] };
  assert.equal(teamTargetForModel(noEffort, "high"), null);
  assert.deepEqual(teamTargetForModel(noEffort), noEffort.target, "no effort is invented for a model that does not advertise it");
});

test("provider and personal profile remain part of a model's identity", () => {
  const base = { provider: "one", model: "model-a", profile_id: "profile-a" };
  assert.notEqual(teamModelKey(base), teamModelKey({ ...base, provider: "two" }));
  assert.notEqual(teamModelKey(base), teamModelKey({ ...base, model: "model-b" }));
  assert.notEqual(teamModelKey(base), teamModelKey({ ...base, profile_id: "profile-b" }));
  assert.equal(teamConnectionKey(null), "");
});

test("same-named native and shared models show their provider without changing exact selection keys", () => {
  const profiles = [{ provider: "provider-a", model: "same-model", reasoningEfforts: ["low"] },
    { provider: "provider-b", model: "same-model", reasoningEfforts: ["high"] }];
  const choices = teamConnectionChoices(context({ runtimes: [runtime({ executionProfiles: profiles })], sharedAgents: [{
    label: "Shared fixture", available: true, share: { id: "share-a", revision: 1,
      execution_profile: { harness: "codex", provider: "provider-a", model: "same-model" },
      execution_profiles: profiles.map(profile => ({ provider: profile.provider, model: profile.model, reasoning_efforts: profile.reasoningEfforts })) },
  }] }));
  for (const choice of choices) {
    assert.deepEqual(choice.models.map(model => model.label), ["provider-a · same-model", "provider-b · same-model"]);
    assert.notEqual(choice.models[0].key, choice.models[1].key);
    assert.equal(teamTargetForModel(choice.models[1]).provider, "provider-b");
    assert.equal(teamTargetForModel(choice.models[1]).reasoning_effort, "high");
  }
});

test("favorite snapshots are independent copies without canvas ids or positions", () => {
  const node = { id: "original", x: 12, y: 34, label: "Planner", role: "Coordinate work", prompt: "Ask for concise evidence",
    target: { kind: "shared", share_id: "bob-share", share_revision: 7, harness: "codex", provider: "fixture", model: "exact-model", reasoning_effort: "high" } };
  const favorite = moduleSnapshot(node), restored = { ...moduleSnapshot(favorite), id: "new-node", x: 90, y: 80 };
  assert.deepEqual(Object.keys(favorite).sort(), ["label", "prompt", "role", "target"]);
  assert.equal(sameTeamSnapshot(favorite, moduleSnapshot(restored)), true);
  assert.notEqual(favorite.target, node.target);
  assert.notEqual(restored.target, favorite.target);
  restored.target.model = "changed-copy";
  restored.label = "Edited planner";
  assert.equal(favorite.target.model, "exact-model");
  assert.equal(node.target.model, "exact-model");
  assert.equal(favorite.label, "Planner");
  assert.equal(sameTeamSnapshot(favorite, moduleSnapshot(restored)), false);
  assert.deepEqual(moduleSnapshot({ label: "Blank", role: "", target: null }), { label: "Blank", role: "", target: null });
});

test("directed routes may add the reverse direction but cannot duplicate any existing directed route", () => {
  const edges = [{ id: "ab", source: "a", target: "b", direction: "one_way" }];
  assert.equal(teamEdgeAllowed(edges, "a", "b", "one_way"), false);
  assert.equal(teamEdgeAllowed(edges, "b", "a", "one_way"), true);
  assert.equal(teamEdgeAllowed(edges, "a", "b", "bidirectional"), false);
  assert.equal(teamEdgeAllowed(edges, "b", "a", "bidirectional"), false);
  assert.equal(teamEdgeAllowed(edges, "a", "c", "bidirectional"), true);
  assert.equal(teamEdgeAllowed(edges, "a", "a", "one_way"), false);
  assert.equal(teamEdgeAllowed(edges, "", "b", "one_way"), false);
  assert.equal(teamEdgeAllowed(edges, "a", null, "one_way"), false);
});

test("bidirectional routes reserve both directions and editing excludes only the selected edge", () => {
  const edges = [{ id: "ab", source: "a", target: "b", direction: "bidirectional" },
    { id: "bc", source: "b", target: "c", direction: "one_way" }];
  assert.equal(teamEdgeAllowed(edges, "a", "b", "one_way"), false);
  assert.equal(teamEdgeAllowed(edges, "b", "a", "one_way"), false);
  assert.equal(teamEdgeAllowed(edges, "b", "a", "bidirectional", "ab"), true);
  assert.equal(teamEdgeAllowed(edges, "b", "c", "bidirectional", "ab"), false,
    "editing one route must not free another route's reserved direction");
});

test("deleting a node removes all incident flows and repairs the entry without mutating the original draft", () => {
  const draft = { name: "Team", entry_node_id: "b", nodes: [{ id: "a" }, { id: "b" }, { id: "c" }], edges: [
    { id: "ab", source: "a", target: "b", direction: "one_way" },
    { id: "bc", source: "b", target: "c", direction: "bidirectional" },
    { id: "ac", source: "a", target: "c", direction: "one_way" },
  ] };
  const next = removeTeamNode(draft, "b");
  assert.deepEqual(next.nodes.map(node => node.id), ["a", "c"]);
  assert.deepEqual(next.edges.map(edge => edge.id), ["ac"]);
  assert.equal(next.entry_node_id, "a");
  assert.equal(draft.entry_node_id, "b");
  assert.equal(draft.nodes.length, 3);
  assert.equal(draft.edges.length, 3);
  assert.equal(removeTeamNode({ ...draft, entry_node_id: "c" }, "b").entry_node_id, "c");
  const empty = removeTeamNode({ ...draft, nodes: [{ id: "b" }], edges: [] }, "b");
  assert.deepEqual(empty.nodes, []);
  assert.equal("entry_node_id" in empty, false);
});

test("Bezier flows connect the output and input ports and retain finite geometry in either direction", () => {
  const source = { x: 10, y: 20 }, target = { x: 600, y: 150 };
  const path = teamEdgePath(source, target);
  assert.match(path, new RegExp(`^M ${source.x + TEAM_NODE_WIDTH} ${source.y + TEAM_NODE_HEIGHT / 2} C `));
  assert.ok(path.endsWith(`${target.x} ${target.y + TEAM_NODE_HEIGHT / 2}`));
  assert.doesNotMatch(path, /NaN|Infinity/);
  const reverse = teamEdgePath(target, source);
  assert.match(reverse, /^M .* C /);
  assert.ok(reverse.endsWith(`${source.x} ${source.y + TEAM_NODE_HEIGHT / 2}`));
  assert.doesNotMatch(reverse, /NaN|Infinity/);
});


test("route identities remain distinct when valid module IDs contain colons", () => {
  const edges = [{ id: "route:one", source: "a:b", target: "c", direction: "one_way" }];
  assert.equal(teamEdgeAllowed(edges, "a", "b:c", "one_way"), true);
  assert.equal(teamEdgeAllowed(edges, "a", "b:c", "bidirectional"), true);
  assert.equal(teamEdgeAllowed(edges, "a:b", "c", "one_way"), false);
});

test("favorite matching ignores object key order and empty optional prompts while retaining exact targets", () => {
  const a = { label: "Planner", role: "Plan", target: { kind: "local", runtime_id: "runtime:a", harness: "codex", provider: "fixture", model: "model:a" } };
  const b = { target: { model: "model:a", provider: "fixture", harness: "codex", runtime_id: "runtime:a", kind: "local" }, prompt: "", role: "Plan", label: "Planner" };
  assert.equal(sameTeamSnapshot(a, b), true);
  assert.equal(sameTeamSnapshot(a, { ...b, target: { ...b.target, runtime_id: "runtime:b" } }), false);
});
