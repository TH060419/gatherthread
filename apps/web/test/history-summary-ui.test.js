import test from "node:test";
import assert from "node:assert/strict";
import { mountHistorySummaries } from "../src/history-summary-view.js";

class Node {
  constructor() { this.listeners = new Map(); this.children = []; this.dataset = {}; this.attributes = {}; this.isConnected = true; this.open = false; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  dispatch(type) { return this.listeners.get(type)?.({ target: this, preventDefault() {} }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
  focus() {}
}
const source = { id: "a", type: "human_chat", sequence: 1, visibility: "session", actor: { id: "u1", username: "Author" }, payload: { content: "original" } };
function setup() {
  const nodes = new Map(), created = [], calls = [];
  const el = (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const document = { getElementById: el, activeElement: new Node(),
    createElement: () => { const node = new Node(); created.push(node); return node; },
    querySelectorAll: () => created.filter((node) => node.className === "history-source-checkbox") };
  let current = { scope: "auth1:s1", sessionId: "s1", userId: "u1", events: [structuredClone(source)], writable: true,
    executionProfile: { harness: "codex", model: "m", reasoningEffort: "high", runtimeId: "exact1" }, instructions: "Fixture instruction" };
  let finish, reject;
  const api = { createHistorySummary: (...args) => { calls.push(structuredClone(args)); return new Promise((yes, no) => { finish = yes; reject = no; }); } };
  const ui = mountHistorySummaries({ document, api, localizer: { t: (text) => text }, getContext: () => current,
    onChange: () => ui.updateContext(), renderMarkdown: (text) => Object.assign(new Node(), { markdown: text }) });
  ui.updateContext();
  const choose = () => { el("history-summary-select-button").dispatch("click"); const box = ui.sourceControl(source); box.checked = true; box.dispatch("change"); };
  const confirm = () => { el("history-summary-generate-button").dispatch("click"); return el("history-summary-confirm-button").dispatch("click"); };
  return { ui, el, calls, choose, confirm, get context() { return current; }, update: (patch) => { current = { ...current, ...patch }; ui.updateContext(); },
    finish: (value) => finish(value), reject: (value) => reject(value) };
}
const receipt = { id: "summary", type: "agent_request", sequence: 2, visibility: "session", actor: { id: "u1", username: "Author" },
  payload: { content: "prompt", history_summary: { version: 1, source_event_ids: ["a"], source_digest: "a".repeat(64) } } };

test("generation requires explicit confirmation, freezes runtime and rejects repeat submit", async () => {
  const app = setup(); app.choose();
  app.el("history-summary-generate-button").dispatch("click");
  assert.equal(app.calls.length, 0);
  assert.match(app.el("history-summary-confirm-target").textContent, /codex.*m.*high.*exact1/);
  const pending = app.el("history-summary-confirm-button").dispatch("click");
  app.el("history-summary-confirm-button").dispatch("click");
  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.calls[0][1].sourceEventIds, ["a"]);
  assert.equal(app.el("history-summary-cancel-button").disabled, true);
  app.finish(receipt); await pending;
  assert.equal(app.el("history-summary-select-button").disabled, true);
  assert.equal(app.ui.timeline().before.get("summary")[0].status, "pending");
});

test("a runtime change after confirmation cannot silently reroute the request", () => {
  const app = setup(); app.choose();
  app.el("history-summary-generate-button").dispatch("click");
  app.update({ executionProfile: { ...app.context.executionProfile, runtimeId: "other" } });
  app.el("history-summary-confirm-button").dispatch("click");
  assert.equal(app.calls.length, 0);
  assert.equal(app.el("history-summary-confirm-button").disabled, true);
});

test("logout or session change drops late receipts and resets selection and display state", async () => {
  const app = setup(); app.choose(); const pending = app.confirm();
  app.update({ scope: "auth2:s2", sessionId: "s2", events: [] });
  app.finish(receipt); await pending;
  assert.equal(app.ui.timeline().versions.length, 0);
  assert.equal(app.el("history-summary-toolbar").hidden, true);
  assert.equal(app.el("history-summary-confirm-dialog").open, false);
});

test("uncertain transport retries retain the same idempotency key and frozen profile", async () => {
  const app = setup(); app.choose(); const pending = app.confirm();
  app.reject(new Error("network unavailable")); await pending;
  assert.equal(app.el("history-summary-select-button").disabled, true);
  assert.match(app.el("history-summary-status").textContent, /uncertain/);
  app.el("history-summary-resend-button").dispatch("click");
  const retry = app.el("history-summary-confirm-button").dispatch("click");
  assert.equal(app.calls[1][1].idempotencyKey, app.calls[0][1].idempotencyKey);
  assert.deepEqual(app.calls[1][1].executionProfile, app.calls[0][1].executionProfile);
  app.finish(receipt); await retry;
});

test("a definitive summary rejection keeps selection and explains how to retry without leaking raw errors", async () => {
  const app = setup(); app.choose(); const pending = app.confirm();
  app.reject(Object.assign(new Error("Untranslated server internals"), { status: 409 })); await pending;
  assert.match(app.el("history-summary-status").textContent, /Check your selected Agent and pending requests/u);
  assert.equal(app.el("history-summary-cancel-button").disabled, false);
  assert.equal(app.el("history-summary-generate-button").disabled, false);
  assert.equal(app.ui.sourceControl(source).checked, true);
  const retry = app.confirm();
  assert.notEqual(app.calls[1][1].idempotencyKey, app.calls[0][1].idempotencyKey);
  app.finish(receipt); await retry;
});

test("viewers can inspect summaries and originals but never generate or regenerate", () => {
  const app = setup();
  app.update({ writable: false, events: [source, receipt, { id: "answer", sequence: 3, type: "agent_response", visibility: "session", actor: { id: "u1" }, replyTo: "summary", payload: { content: "summary text" } }] });
  assert.equal(app.el("history-summary-select-button").hidden, true);
  app.el("history-summary-select-button").dispatch("click");
  assert.equal(app.ui.sourceControl(source), null);
  app.el("history-summary-view-button").dispatch("click");
  assert.equal(app.ui.timeline().hidden.has("a"), false);
  app.el("history-summary-versions-button").dispatch("click");
  assert.equal(app.el("history-summary-versions-dialog").open, true);
  const versionCard = app.el("history-summary-versions").children[0].children[0];
  assert.equal(versionCard.children[0].children[1].children.length, 0);
  const body = versionCard.children.find((child) => child.markdown);
  assert.equal(body.attributes["data-i18n-skip"], "");
  assert.equal(app.calls.length, 0);
});

test("rendering many summary cards reuses pending state instead of rescanning history per card", () => {
  const app = setup();
  const events = [structuredClone(source)];
  let payloadReads = 0;
  for (let index = 0; index < 500; index += 1) {
    events.push({ ...structuredClone(receipt), id: `summary-${index}`, sequence: events.length + 1 });
    events.push({ id: `answer-${index}`, sequence: events.length + 1, type: "agent_response", visibility: "session",
      actor: { id: "u1" }, replyTo: `summary-${index}`, payload: { content: "Summary fixture" } });
  }
  for (const item of events) {
    const payload = item.payload;
    Object.defineProperty(item, "payload", { get() { payloadReads += 1; return payload; } });
  }
  app.update({ events });
  const versions = app.ui.timeline().versions;
  assert.equal(versions.length, 500);
  payloadReads = 0;
  for (const version of versions) app.ui.card(version, { list: true });
  assert.ok(payloadReads <= 500 * 8, `Card rendering reread history payloads ${payloadReads} times.`);
});

test("any current writer can regenerate a terminal failed version with their own selected Agent", () => {
  const app = setup();
  app.update({ userId: "u2", events: [source, receipt, { id: "failure", sequence: 3, type: "agent_response", visibility: "session", actor: { id: "u1" }, replyTo: "summary", payload: { content: "failed", status: "failed" } }] });
  const version = app.ui.timeline().versions[0];
  const card = app.ui.card(version);
  const regenerate = card.children[0].children[1].children[0];
  assert.equal(regenerate.disabled, false);
  regenerate.dispatch("click");
  assert.equal(app.el("history-summary-count").textContent.startsWith("1 / 100"), true);
  assert.equal(app.el("history-summary-generate-button").disabled, false);
  assert.equal(app.calls.length, 0);
});
