import test from "node:test";
import assert from "node:assert/strict";
import { canDeleteMessage, mountMessageDeletion } from "../src/message-deletion.js";
import { eventContent, pendingAgentRequests, isTimelineEventVisible, retryAgentRequestInput } from "../src/domain.js";
import { composerAgentAction } from "../src/agent-request-control.js";
import { eligibleHistorySources, historyWireEvents } from "../src/history-summaries.js";

const own = { id: "own", type: "human_chat", sessionId: "s1", sequence: 1, actor: { id: "me" },
  visibility: "session", payload: { content: "private fixture" } };
const tombstone = { ...own, deleted: { reason: "author", deleted_at: "2026-10-12T00:00:00.000Z" } };
test("deletion controls require authorship and current writer eligibility, never owner override", () => {
  const context = { userId: "me", sessionId: "s1", writable: true };
  for (const type of ["human_chat", "agent_request", "agent_response"]) assert.equal(canDeleteMessage({ ...own, type }, context), true);
  for (const value of [{ ...context, userId: "other" }, { ...context, writable: false }, { ...context, sessionId: "other" }]) {
    assert.equal(canDeleteMessage(own, value), false);
  }
  assert.equal(canDeleteMessage(tombstone, context), false);
  for (const type of ["agent_progress", "message_deleted", "membership_change"]) assert.equal(canDeleteMessage({ ...own, type }, context), false);
});

test("deleted messages are never copyable context, pending requests or summary sources", () => {
  const request = { ...tombstone, type: "agent_request", payload: { content: "private fixture", execution_profile: { harness: "opencode" } } };
  assert.equal(eventContent(tombstone), "");
  assert.deepEqual(pendingAgentRequests([request]), []);
  assert.equal(composerAgentAction([request], "me").action, "request");
  assert.deepEqual(eligibleHistorySources([tombstone]), []);
  assert.equal(historyWireEvents([tombstone])[0].deleted.reason, "author");
  assert.throws(() => retryAgentRequestInput(request, "retry"), /deleted/i);
  assert.equal(isTimelineEventVisible({ type: "message_deleted", payload: { content: "do not display" } }), false);
});

function fixture(api = {}, confirm = () => true) {
  class Element { constructor() { this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.isConnected = true; }
    setAttribute(k, v) { this.attributes[k] = v; } addEventListener(k, v) { this.listeners.set(k, v); }
    append() {} click() { this.listeners.get("click")?.(); } }
  const document = { body: {}, createElement: () => new Element(), createElementNS: () => new Element() };
  const placeholder = { focuses: 0, focus() { this.focuses++; document.activeElement = this; } };
  document.activeElement = document.body;
  document.getElementById = () => placeholder;
  let context = { scope: "one", userId: "me", sessionId: "s1", writable: true, events: [own] };
  const receipts = [], notices = [], confirmations = []; let keys = 0;
  const control = mountMessageDeletion({ document, api, getContext: () => context, localizer: { t: value => value },
    confirm: text => { confirmations.push(text); return confirm(text); }, makeKey: () => `key-${++keys}`,
    onDeleted: receipt => receipts.push(receipt), announce: text => notices.push(text) });
  return { control, receipts, notices, confirmations, document, placeholder,
    setContext: patch => { context = { ...context, ...patch }; } };
}
const flush = () => new Promise(setImmediate);
test("cancel and double click create no accidental deletion and uncertain retries reuse one key", async () => {
  let calls = []; const cancelled = fixture({ deleteMessage: () => calls.push("wrong") }, () => false);
  cancelled.control.action(own).click(); await flush(); assert.deepEqual(calls, []);
  let reject; const f = fixture({ deleteMessage: (_s, _id, input) => { calls.push(input.idempotencyKey); return new Promise((_ok, no) => { reject = no; }); } });
  const button = f.control.action(own); button.click(); button.click(); await flush();
  assert.deepEqual(calls, ["key-1"]); reject(new Error("network")); await flush();
  button.click(); await flush(); assert.deepEqual(calls, ["key-1", "key-1"]);
  reject(Object.assign(new Error("forbidden"), { status: 403 })); await flush();
  assert.match(f.notices.at(-1), /access|permission/i);
});
test("an old deletion receipt cannot mutate a new account/session and request warning names linked output", async () => {
  let resolve; const f = fixture({ deleteMessage: () => new Promise(ok => { resolve = ok; }) });
  const request = { ...own, type: "agent_request" }; f.setContext({ events: [request] });
  f.control.action(request).click(); await flush();
  assert.match(f.confirmations[0], /linked.*replies|replies.*work/i);
  f.setContext({ scope: "two", userId: "other", sessionId: "s2", events: [] });
  resolve({ contentRevision: 1 }); await flush();
  assert.equal(f.receipts.length, 0); assert.equal(f.notices.length, 0);
});

test("a deleted button restores focus to its placeholder but never steals focus moved into a draft", async () => {
  for (const moved of [false, true]) {
    let resolve; const f = fixture({ deleteMessage: () => new Promise(ok => { resolve = ok; }) });
    const button = f.control.action(own); f.document.activeElement = button; button.click(); await flush();
    const next = moved ? { value: "a newer draft" } : f.document.body;
    f.document.activeElement = next;
    resolve({ contentRevision: 1 }); await flush();
    assert.equal(f.placeholder.focuses, moved ? 0 : 1);
    if (moved) assert.equal(f.document.activeElement, next);
  }
});
