import test from "node:test";
import assert from "node:assert/strict";
import { composerAgentAction, mountAgentRequestControl, resumeAgentRequestInput } from "../src/agent-request-control.js";
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
function fixture(api = {}, options = {}) {
  const own = request();
  let context = { scope: "scope1", userId: "me", sessionId: "s1", writable: true, sending: false, events: [own, progress(own.id)] };
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
