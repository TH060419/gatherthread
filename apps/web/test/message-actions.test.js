import assert from "node:assert/strict";
import test from "node:test";
import { mentionQuery, insertMention, reconcileMentions, messageExcerpt, agentWorkStatus, mountMessageActions } from "../src/message-actions.js";

test("background mention refresh preserves older pages, cursor, reading position and focus", async () => {
  class Element {
    constructor() { this.listeners = new Map(); this.children = []; this.dataset = {}; this.value = ""; this.scrollTop = 0; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    setAttribute() {} removeAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { document.activeElement = this; }
    click() { this.listeners.get("click")?.(); }
  }
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = { getElementById: el, createElement: () => new Element(), body: new Element() };
  const entry = (id) => ({ id, session_id: "s", session_title: "Session", actor_display_name: "Member", excerpt: id });
  const calls = [];
  let pendingPage;
  const api = { listProjectMentions: async (_project, cursor) => {
    calls.push(cursor);
    if (cursor === "a") return { mentions: [entry("b")], next_before_id: "b" };
    if (cursor === "b") return new Promise((resolve) => { pendingPage = resolve; });
    return { mentions: [entry("a")], next_before_id: "a" };
  } };
  const actions = mountMessageActions({ document, api, localizer: { t: (text) => text },
    getContext: () => ({ projectId: "p", userId: "u", sessionId: "s" }), selectSession() {}, revealEvent() {}, announce() {} });
  el("mentions-button").click(); await new Promise(setImmediate);
  el("mentions-more").click(); await new Promise(setImmediate);
  assert.equal(el("mentions-list").children.length, 2);
  el("mentions-list").scrollTop = 80;
  el("mentions-list").children[1].children[0].focus();
  await actions.refresh();
  assert.equal(el("mentions-list").children.length, 2);
  assert.equal(el("mentions-list").scrollTop, 80);
  assert.equal(document.activeElement.dataset.mentionEventId, "b");
  el("mentions-more").click(); await new Promise(setImmediate);
  assert.equal(calls.at(-1), "b", "background refresh must not reset the older-page cursor");
  const count = calls.length;
  await actions.refresh(); assert.equal(calls.length, count, "polling must not supersede an in-flight older page");
  pendingPage({ mentions: [entry("c")], next_before_id: null }); await new Promise(setImmediate);
  assert.equal(el("mentions-list").children.length, 3);
  assert.equal(el("mentions-more").hidden, true);
});

test("busy and thinking belong only to a started, unfinished exact runtime request", () => {
  const request = { id: "r", type: "agent_request" };
  const started = { type: "agent_progress", replyTo: "r", provenance: { runtimeId: "native" }, payload: { status: "started" } };
  assert.equal(agentWorkStatus([request], "native"), null);
  assert.equal(agentWorkStatus([request, started], "native"), "Agent busy");
  assert.equal(agentWorkStatus([request, { ...started, payload: { status: "thinking" } }], "native"), "Agent thinking");
  assert.equal(agentWorkStatus([request, started], "other"), null);
  assert.equal(agentWorkStatus([request, started, { type: "agent_response", replyTo: "r" }], "native"), null);
  const paused = { type: "agent_progress", replyTo: "r", payload: { status: "paused" } };
  assert.equal(agentWorkStatus([request, started, paused], "native"), null);
  assert.equal(agentWorkStatus([request, { ...started, payload: { status: "thinking" } }, paused], "native"), null);
  assert.equal(agentWorkStatus([request, started, paused, { ...started, replyTo: "resumed" }], "native"), "Agent busy");
});

test("mention picking supports names with spaces and preserves offsets through edits", () => {
  assert.deepEqual(mentionQuery("Hi @Ma", 6), { start: 3, end: 6, query: "Ma" });
  assert.equal(mentionQuery("mail@example.org", 8), null);
  const result = insertMention("Hi @Ma", { start: 3, end: 6 }, { userId: "maya", username: "Maya Chen" });
  assert.equal(result.text, "Hi @Maya Chen ");
  assert.deepEqual(result.mention, { user_id: "maya", start: 3, end: 13 });
  assert.deepEqual(reconcileMentions(result.text, `Oh ${result.text}`, [result.mention]), [{ user_id: "maya", start: 6, end: 16 }]);
  assert.deepEqual(reconcileMentions(result.text, "Hi @Maya Ch", [result.mention]), []);
});

test("copy and quote previews contain only message text, never identity or time", () => {
  assert.equal(messageExcerpt({ payload: { content: "message" }, actor: { username: "sender" }, createdAt: "date" }), "message");
  assert.equal(messageExcerpt({ payload: { text: "a".repeat(300) } }).length, 181);
});
