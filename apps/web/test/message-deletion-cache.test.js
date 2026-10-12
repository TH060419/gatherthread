import test from "node:test";
import assert from "node:assert/strict";
import { mountMessageActions, messageText, agentWorkStatus } from "../src/message-actions.js";

class Node {
  constructor() { this.children = []; this.listeners = new Map(); this.dataset = {}; this.attributes = {}; this.value = ""; this.isConnected = true; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(k, v) { this.attributes[k] = v; } removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(k, fn) { this.listeners.set(k, fn); } click() { this.listeners.get("click")?.(); }
  focus() {} close() { this.open = false; } showModal() { this.open = true; }
}
const own = { id: "source", type: "human_chat", actor: { id: "me", username: "Me" }, sessionId: "s1", sequence: 1,
  visibility: "session", payload: { content: "private source" } };
const deleted = { ...own, deleted: { reason: "author", deleted_at: "2026-10-12T00:00:00.000Z" } };
function fixture() {
  const nodes = new Map(), el = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const document = { getElementById: el, createElement: () => new Node(), createElementNS: () => new Node(), body: new Node() };
  let context = { userId: "me", projectId: "p1", sessionId: "s1", writable: true, events: [own] };
  const control = mountMessageActions({ document, api: { listProjectMentions: async () => ({ mentions: [], next_before_id: null }) },
    localizer: { t: value => value }, getContext: () => context, announce() {}, selectSession() {}, revealEvent() {} });
  return { control, el, setContext: patch => { context = { ...context, ...patch }; } };
}
test("deleted sources cannot be copied or quoted, including retained old action closures", () => {
  const f = fixture(), old = f.control.actions(own);
  f.setContext({ events: [deleted] });
  old.children[1].click();
  assert.equal(f.control.metadata().replyTo, null);
  assert.equal(f.control.actions(deleted).children.length, 0);
  assert.equal(messageText(deleted), "");
  const quote = f.control.quoted({ type: "human_chat", replyTo: "source" }, [deleted]);
  assert.equal(quote.disabled, true); assert.equal(quote.textContent, "Original message deleted");
});
test("content invalidation removes only a deleted draft quote while preserving unrelated quote and text", () => {
  const f = fixture(); f.el("message-input").value = "my unsent draft";
  f.control.actions(own).children[1].click();
  f.control.invalidateContent();
  assert.equal(f.el("composer-quote-text").textContent.includes("private source"), false);
  f.setContext({ events: [own] }); f.control.reconcileContent();
  assert.equal(f.control.metadata().replyTo, "source");
  assert.equal(f.el("message-input").value, "my unsent draft");
  f.setContext({ events: [deleted] }); f.control.reconcileContent();
  assert.equal(f.control.metadata().replyTo, null);
});
test("deleted request work cannot leave a member busy", () => {
  assert.equal(agentWorkStatus([{ ...deleted, type: "agent_request" }, { type: "agent_progress", replyTo: "source",
    payload: { status: "thinking" }, provenance: { runtimeId: "runtime" } }], "runtime"), null);
});
