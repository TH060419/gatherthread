import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { cloudRequestInput, composerAgentAction, mountAgentRequestControl, resumeAgentRequestInput, retryAgentRequestPermission } from "../src/agent-request-control.js";
import { MockCollaborationApi } from "../src/api.js";

const request = (id = "r1", userId = "me", harness = "codex") => ({ id, type: "agent_request", actor: { id: userId }, replyTo: "quote-1",
  payload: { content: "@Peer explain this", mentions: [{ user_id: "peer", start: 0, end: 5 }], execution_profile: {
    harness, provider: harness === "codex" ? "openai" : "deepseek-official", model: "original-model", reasoning_effort: "low", runtime_id: "original-runtime",
  } } });
const progress = (id, status = "running") => ({ type: "agent_progress", replyTo: id, payload: { status } });
const response = (id) => ({ type: "agent_response", replyTo: id, payload: { status: "completed" } });

test("completed seed example does not leave the composer waiting for an Agent", () => {
  const api = new MockCollaborationApi({ latency: 0 });
  assert.equal(composerAgentAction(api.events.get("session-orbit"), api.currentUser.id).action, "request");
});

test("an accepted cloud request can be paused without a local runtime or a work marker", () => {
  const cloud = request("cloud", "me", "opencode");
  delete cloud.payload.execution_profile.runtime_id;
  cloud.payload.profile_id = "cloud-free";
  assert.equal(composerAgentAction([cloud], "me").action, "pause");
  assert.equal(composerAgentAction([cloud, progress(cloud.id, "paused")], "me").action, "resume");
  assert.equal(composerAgentAction([cloud, response(cloud.id)], "me").action, "request");
});

test("cloud retry uses writer permission rather than local runtime presence, and preserves its exact model", () => {
  const cloud = request("cloud", "me", "opencode");
  cloud.payload.profile_id = "cloud-free";
  const context = { session: { mode: "multi", members: [{ userId: "me", role: "owner", runtime: null }] },
    currentUser: { id: "me" }, connectionPhase: "live" };
  assert.equal(retryAgentRequestPermission(cloud, context).allowed, true);
  context.session.members[0].role = "viewer";
  assert.equal(retryAgentRequestPermission(cloud, context).allowed, false);
  assert.throws(() => cloudRequestInput(cloud, "k", [{ id: "cloud-free", provider: "other", model: "original-model" }]), /original cloud model/);
  assert.equal(cloudRequestInput(cloud, "k", [{ id: "cloud-free", provider: "deepseek-official", model: "original-model" }]).profileId, "cloud-free");
});

test("personal cloud retry requires the immutable private revision and cannot adopt an edited connection", () => {
  const cloud = request("cloud", "me", "opencode");
  cloud.payload.profile_id = "api-10000000-0000-4000-8000-000000000001";
  const profile = { id: cloud.payload.profile_id, provider: "deepseek-official", model: "original-model", api_config_revision: "old-revision" };
  const selection = { profile_id: profile.id, api_config_revision: "old-revision" };
  assert.throws(() => cloudRequestInput(cloud, "k", [profile]), /API connection changed/);
  assert.equal(cloudRequestInput(cloud, "k", [profile], selection).apiConfigRevision, "old-revision");
  assert.throws(() => cloudRequestInput(cloud, "k", [{ ...profile, api_config_revision: "new-revision" }], selection), /API connection changed/);
  assert.throws(() => cloudRequestInput(cloud, "k", [profile], { ...selection, profile_id: "api-other" }), /API connection changed/);
});

test("personal cloud Continue preserves private API and captured history revisions", async () => {
  const { continueCloudRequestInput } = await import("../src/agent-request-control.js");
  const cloud = request("cloud", "me", "opencode");
  cloud.payload.profile_id = "api-10000000-0000-4000-8000-000000000001";
  const profile = { id: cloud.payload.profile_id, provider: "deepseek-official", model: "original-model", api_config_revision: "old-revision" };
  const selection = { profile_id: profile.id, api_config_revision: "old-revision" };
  const input = continueCloudRequestInput(cloud, "key", [profile], selection, 3);
  assert.equal(input.apiConfigRevision, "old-revision");
  assert.equal(input.contentRevision, 3);
  assert.equal(input.continueFromEventId, cloud.id);
  assert.throws(() => continueCloudRequestInput(cloud, "key", [{ ...profile, api_config_revision: "new-revision" }], selection, 3), /API connection changed/);
});

test("composer control is author-scoped, claim-aware, and resets after terminal completion", () => {
  const own = request();
  assert.equal(composerAgentAction([], "me").action, "request");
  assert.equal(composerAgentAction([request("peer", "other"), progress("peer")], "me").action, "request");
  assert.equal(composerAgentAction([own], "me").action, "wait");
  assert.equal(composerAgentAction([own, progress(own.id)], "me").action, "pause");
  assert.equal(composerAgentAction([own, progress(own.id), progress(own.id, "paused")], "me").action, "resume");
  assert.equal(composerAgentAction([own, progress(own.id, "paused"), response(own.id)], "me").action, "request");
  assert.equal(composerAgentAction([own, progress(own.id, "paused"), request("new"), response("new")], "me").action, "request");
  const summary = request("summary"); summary.payload.history_summary = { version: 1 };
  assert.equal(composerAgentAction([summary], "me").action, "request");
  assert.equal(composerAgentAction([own, progress(own.id, "paused"), summary], "me").action, "resume");
});

test("resume retains Codex/DSH exact original routing, quote and mentions", () => {
  for (const harness of ["codex", "deepseek-harness"]) {
    const own = request("r1", "me", harness);
    const input = resumeAgentRequestInput(own, "resume-key");
    assert.deepEqual(input.executionProfile, { harness, provider: own.payload.execution_profile.provider,
      model: "original-model", reasoningEffort: "low", runtimeId: "original-runtime" });
    assert.equal(input.content, own.payload.content); assert.equal(input.replyTo, "quote-1");
    assert.deepEqual(input.mentions, own.payload.mentions); assert.notEqual(input.mentions, own.payload.mentions);
    assert.equal(input.idempotencyKey, "resume-key");
  }
  const legacy = request(); delete legacy.payload.execution_profile;
  assert.equal(composerAgentAction([legacy, progress(legacy.id, "paused")], "me").action, "request");
  assert.throws(() => resumeAgentRequestInput(legacy, "no-fallback"), /Original Agent settings/);
  const unbound = request(); delete unbound.payload.execution_profile.runtime_id;
  assert.equal(composerAgentAction([unbound, progress(unbound.id, "paused")], "me").action, "request");
  assert.throws(() => resumeAgentRequestInput(unbound, "no-device-fallback"), /Original Agent settings/);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
function composerCleanerSource(source) {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const start = normalized.indexOf("function clearStaleTeamComposerProblem() {");
  const end = normalized.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "the actual composer invalidation function must be present");
  return normalized.slice(start, end + 2);
}
function fixture(api = {}, options = {}) {
  const own = request();
  let context = { scope: "scope1", contentRevision: 0, userId: "me", sessionId: "s1", writable: true, sending: false, events: [own, progress(own.id)] };
  const button = { disabled: false, dataset: {}, attributes: {}, textContent: "",
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...nodes) { this.textContent = nodes.map((node) => typeof node === "string" ? node : node.textContent).join(""); },
    ownerDocument: { createElement: () => ({ setAttribute() {}, textContent: "" }) } };
  const targetLabel = {}, errorNode = {};
  let keys = 0, changes = 0;
  const control = mountAgentRequestControl({ button, targetLabel, errorNode, api, getContext: () => context,
    makeKey: () => `key-${++keys}`, onChange: () => { changes++; control.update(); }, ...options });
  control.update();
  return { control, button, targetLabel, errorNode, setContext: (value) => { context = { ...context, ...value }; control.update(); },
    context: () => context, changes: () => changes };
}

test("Team Stop uses its safe error formatter and drops a late failure after navigation", async () => {
  const f = fixture(); let reject;
  const safe = "Team Stop is unconfirmed. Check the previous action.";
  f.setContext({ teamRun: { id: "team-a", status: "running" }, stopTeam: async () => { throw Error("SYNTHETIC_PRIVATE_ERROR"); },
    teamError: () => safe });
  assert.equal(f.control.handleClick(), true); await flush(); assert.equal(f.errorNode.textContent, safe);
  f.setContext({ stopTeam: () => new Promise((_resolve, no) => { reject = no; }) });
  f.control.handleClick(); f.setContext({ scope: "scope2", teamRun: null, events: [] });
  reject(Error("LATE_SYNTHETIC_PRIVATE_ERROR")); await flush(); assert.equal(f.errorNode.textContent, "");
});

for (const obsolete of [false, true]) {
  test(`a ${obsolete ? "fenced" : "delayed"} Team Stop failure preserves newer composer validation`, async () => {
    let reject;
    const f = fixture();
    f.setContext({ teamRun: { id: "team-a", status: "running" },
      stopTeam: () => new Promise((_resolve, no) => { reject = no; }),
      teamError: () => obsolete ? "" : "Team Stop is unconfirmed." });
    f.control.handleClick();
    const newer = { kind: "new-validation" };
    f.errorNode.teamProblemIntent = newer;
    f.errorNode.textContent = "Write a message first.";
    reject(Error("OLD_STOP_FAILURE")); await flush();
    assert.equal(f.errorNode.textContent, "Write a message first.");
    assert.equal(f.errorNode.teamProblemIntent, newer);
  });
}

for (const lineEnding of ["\n", "\r\n"]) for (const newer of [false, true]) {
  test(`an already displayed Stop failure is cleared by the real composer invalidation without clearing newer text (${newer}, ${JSON.stringify(lineEnding)})`, async () => {
    const problem = Object.assign(Error("safe failure"), { code: "agent_team_model_unavailable" });
    const f = fixture(); let obsolete = false;
    f.setContext({ teamRun: { id: "team-a", status: "running" }, stopTeam: async () => { throw problem; },
      teamError: () => "OLD_PRIVATE_MODULE unavailable" });
    f.control.handleClick(); await flush();
    assert.equal(f.errorNode.teamProblemIntent.problem, problem);
    assert.equal(f.errorNode.teamProblemIntent.text, f.errorNode.textContent);
    const context = vm.createContext({ sendError: f.errorNode, teamsUi: { isObsoleteError: value => obsolete && value === problem } });
    vm.runInContext(composerCleanerSource(mainSource.replace(/\r?\n/gu, lineEnding)), context);
    if (newer) f.errorNode.textContent = "Keep the new input validation";
    obsolete = true; context.clearStaleTeamComposerProblem();
    assert.equal(f.errorNode.textContent, newer ? "Keep the new input validation" : "");
    assert.equal(f.errorNode.teamProblemIntent, undefined);
  });
}

test("personal cloud resume waits for its private selection and cannot write after navigation", async () => {
  let resolve, reads = 0; const writes = [];
  const cloud = request("cloud", "me", "opencode"); cloud.payload.profile_id = "api-fixture";
  const profile = { id: "api-fixture", provider: "deepseek-official", model: "original-model", api_config_revision: "revision-fixture" };
  const f = fixture({ getHostedAgentSelection: (sessionId, requestId) => {
    reads++; assert.equal(sessionId, "s1"); assert.equal(requestId, "cloud"); return new Promise(done => { resolve = done; });
  }, appendHostedAgentRequest: async (...args) => { writes.push(args); } });
  f.setContext({ events: [cloud, progress("cloud", "paused")], cloudProfiles: [profile] });
  f.control.handleClick(); f.control.handleClick(); assert.equal(reads, 1);
  f.setContext({ scope: "other", sessionId: "s2", events: [] });
  resolve({ profile_id: profile.id, api_config_revision: profile.api_config_revision }); await flush();
  assert.equal(writes.length, 0); assert.equal(f.errorNode.textContent, "");
});

test("personal cloud resume rechecks authoritative history after its delayed private selection", async () => {
  let resolve; const writes = [];
  const cloud = request("cloud", "me", "opencode"); cloud.payload.profile_id = "api-fixture";
  const profile = { id: "api-fixture", provider: "deepseek-official", model: "original-model", api_config_revision: "revision-fixture" };
  const f = fixture({ getHostedAgentSelection: () => new Promise(done => { resolve = done; }),
    appendHostedAgentRequest: async (...args) => { writes.push(args); } });
  f.setContext({ events: [cloud, progress("cloud", "paused")], cloudProfiles: [profile] });
  f.control.handleClick();
  f.setContext({ contentRevision: 1, events: [{ ...cloud, deleted: { reason: "author" }, payload: {} }] });
  resolve({ profile_id: profile.id, api_config_revision: profile.api_config_revision }); await flush();
  assert.deepEqual(writes, []); assert.equal(f.errorNode.textContent, "");
});

test("a valid cloud resume sends the captured history revision without changing its model", async () => {
  const writes = [], cloud = request("cloud", "me", "opencode"); cloud.payload.profile_id = "cloud-free";
  const f = fixture({ appendHostedAgentRequest: async (...args) => { writes.push(args); } });
  f.setContext({ contentRevision: 7, events: [cloud, progress("cloud", "paused")], cloudProfiles: [
    { id: "cloud-free", provider: "deepseek-official", model: "original-model" },
  ] });
  f.control.handleClick(); await flush();
  assert.equal(writes.length, 1); assert.equal(writes[0][1].contentRevision, 7);
  assert.equal(writes[0][1].profileId, "cloud-free");
});

test("a valid local resume sends its exact history revision", async () => {
  const writes = [], f = fixture({ appendAgentRequest: async (...args) => { writes.push(args); } });
  f.setContext({ contentRevision: 3, events: [request(), progress("r1", "paused")] });
  f.control.handleClick(); await flush();
  assert.equal(writes.length, 1); assert.equal(writes[0][1].contentRevision, 3);
});

test("control writes are single-flight; stale failures cannot overwrite another session", async () => {
  let reject, calls = 0;
  const f = fixture({ pauseAgentRequest: () => { calls++; return new Promise((_resolve, no) => { reject = no; }); } });
  assert.match(f.button.textContent, /Pause Agent/);
  assert.equal(f.control.handleClick(), true); f.control.handleClick();
  assert.equal(calls, 1); assert.equal(f.button.attributes["aria-busy"], "true");
  f.setContext({ scope: "scope2", sessionId: "s2", events: [] });
  const changes = f.changes();
  reject(Error("old private failure")); await flush();
  assert.equal(f.errorNode.textContent, ""); assert.equal(f.changes(), changes);
  assert.match(f.button.textContent, /Request my agent/);
});

test("resume honors confirmation without adding a request, key or busy state when cancelled", async () => {
  let confirmed = false, confirmations = 0, appends = 0;
  const f = fixture({ appendAgentRequest: async () => { appends++; } }, {
    confirmResume: () => { confirmations++; return confirmed; },
  });
  f.setContext({ events: [request(), progress("r1", "paused")] });
  f.control.handleClick(); await flush();
  assert.equal(confirmations, 1); assert.equal(appends, 0);
  assert.equal(f.button.attributes["aria-busy"], "false");
  assert.match(f.button.textContent, /Resume Agent/);
  confirmed = true; f.control.handleClick(); await flush();
  assert.equal(confirmations, 2); assert.equal(appends, 1);
});

test("resume retries reuse a key without changing the target or drafts; viewer/sync gates remain closed", async () => {
  const calls = [];
  const f = fixture({ appendAgentRequest: async (...args) => { calls.push(args); throw Error("Uncertain acknowledgement"); } });
  f.setContext({ events: [request(), progress("r1", "paused")] });
  assert.match(f.button.textContent, /Resume Agent/);
  f.control.handleClick(); await flush(); f.control.handleClick(); await flush();
  assert.equal(calls.length, 2); assert.equal(calls[0][1].idempotencyKey, calls[1][1].idempotencyKey);
  assert.equal(calls[0][1].executionProfile.runtimeId, "original-runtime");
  f.setContext({ writable: false }); f.control.handleClick(); await flush();
  assert.equal(calls.length, 2); assert.equal(f.button.disabled, true);
  f.setContext({ writable: true, sending: true }); f.control.handleClick();
  assert.equal(calls.length, 2);
});

test("timeout continuation is a fresh request with exact cloud target and original linkage", async () => {
  const { continueCloudRequestInput } = await import("../src/agent-request-control.js");
  const cloud = request("timeout-request", "me", "opencode");
  cloud.payload.profile_id = "cloud-free"; cloud.payload.include_code = true;
  const result = continueCloudRequestInput(cloud, "stable-continue-key", [{ id: "cloud-free", provider: "deepseek-official", model: "original-model" }]);
  assert.deepEqual(result, { content: cloud.payload.content, profileId: "cloud-free", includeCode: true,
    idempotencyKey: "stable-continue-key", replyTo: "quote-1", continueFromEventId: "timeout-request" });
  assert.throws(() => continueCloudRequestInput(cloud, "key", [{ id: "cloud-free", provider: "deepseek-official", model: "changed" }]), /original cloud model/);
});

test("the composer Team Stop remains independently usable while realtime replay gates new writes", async () => {
  let stops = 0;
  const f = fixture(); f.setContext({ writable: false, controlWritable: true, sending: true,
    teamRun: { id: "accepted-team", status: "running" }, stopTeam: async () => { stops++; } });
  assert.equal(f.control.action(), "stop_team"); assert.equal(f.button.disabled, false);
  f.control.handleClick(); await flush(); assert.equal(stops, 1);
  f.setContext({ controlWritable: false }); assert.equal(f.button.disabled, true);
  f.control.handleClick(); await flush(); assert.equal(stops, 1, "current role loss still blocks an emergency HTTP action");
});
