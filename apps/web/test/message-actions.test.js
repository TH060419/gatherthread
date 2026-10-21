import assert from "node:assert/strict";
import test from "node:test";
import { mentionQuery, insertMention, reconcileMentions, messageExcerpt, agentWorkStatus, mountMessageActions } from "../src/message-actions.js";

const flush = () => new Promise(setImmediate);
function mentionFixture({ entries = [], page, selectSession, revealEvent, storage } = {}) {
  class Element {
    constructor(id = "") {
      this.id = id; this.listeners = new Map(); this.children = []; this.dataset = {}; this.attributes = {};
      this.value = ""; this.hidden = false; this.rect = { top: 50, left: 20, bottom: 150, right: 320, height: 100, width: 300 };
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    setAttribute(name, value) { this.attributes[name] = value; } removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    getBoundingClientRect() { return this.rect; }
    getClientRects() { return this.hidden || this.noRects ? [] : [this.rect]; }
    closest() { return this.hidden || this.inert ? this : this.parent?.closest() ?? null; }
    showModal() { this.open = true; } close() { this.open = false; }
    focus() { document.activeElement = this; }
    click() { this.listeners.get("click")?.(); }
  }
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  let context = { userId: "u", projectId: "p", sessionId: "s", identityScope: "auth-1", writable: true, events: [] };
  const document = { getElementById: id => elements.get(id) ?? null, createElement: () => new Element(),
    createElementNS: () => new Element(), body: new Element(), visibilityState: "visible",
    defaultView: { innerWidth: 800, innerHeight: 600, sessionStorage: storage }, querySelector: () => document.modal ? {} : null };
  for (const id of ["message-input", "mention-picker", "mentions-dialog", "mentions-button", "mentions-count", "mentions-label",
    "mentions-list", "mentions-empty", "mentions-more", "mentions-close", "mentions-error", "cancel-message-quote",
    "composer-quote", "composer-quote-text", "timeline-region"]) el(id);
  el("timeline-region").rect = { top: 0, left: 0, bottom: 500, right: 500, height: 500, width: 500 };
  const calls = [], announcements = [], reveals = [], selections = [];
  const api = { async listProjectMentions(project, cursor) {
    calls.push([project, cursor]); return page ? page(project, cursor) : { mentions: entries, next_before_id: null };
  } };
  let f;
  const actions = mountMessageActions({ document, api, localizer: { t: value => value }, getContext: () => context,
    selectSession: async id => { selections.push(id); return selectSession?.(id, f); },
    revealEvent: async (id, sequence) => { reveals.push([id, sequence]); return revealEvent?.(id, sequence, f); },
    announce: value => announcements.push(value) });
  f = { actions, el, context: () => context, document, calls, announcements, reveals, selections,
    setContext: patch => { context = { ...context, ...patch }; },
    card(id, patch = {}) {
      const card = el(`message-${id}`); Object.assign(card, patch); el("timeline-region").append(card); return card;
    } };
  return f;
}
function mentionEntry(id, sequence = 1, sessionId = "s") {
  return { id, session_id: sessionId, session_title: "Session", actor_display_name: "Member", sequence, excerpt: id };
}
function mentionedEvent(entry, userId = "u") {
  return { id: entry.id, sessionId: entry.session_id, sequence: entry.sequence, type: "human_chat",
    payload: { content: "@Member hello", mentions: [{ user_id: userId, start: 0, end: 7 }] } };
}

test("mention fetch never marks read; a genuinely visible card removes the temporary jump", async () => {
  const entry = mentionEntry("visible"), f = mentionFixture({ entries: [entry] });
  f.setContext({ events: [mentionedEvent(entry)] }); f.card(entry.id);
  assert.equal(f.el("mentions-button").hidden, true);
  await f.actions.refresh();
  assert.equal(f.el("mentions-button").hidden, false);
  assert.equal(f.el("mentions-count").textContent, "1");
  assert.match(f.el("mentions-button").attributes["aria-label"], /Jump to unread mention/u);
  assert.equal(f.el("mentions-button").attributes["aria-haspopup"], undefined);
  f.actions.readVisible();
  assert.equal(f.el("mentions-button").hidden, true);
  await f.actions.refresh();
  assert.equal(f.el("mentions-button").hidden, true, "polling must not resurrect an already viewed mention");
});

test("background, modal, folded, offscreen, deleted and unavailable mentions remain unread", async () => {
  const entry = mentionEntry("not-read"), f = mentionFixture({ entries: [entry] });
  f.setContext({ events: [mentionedEvent(entry)] });
  const card = f.card(entry.id);
  await f.actions.refresh();
  const assertUnread = () => { f.actions.readVisible(); assert.equal(f.el("mentions-count").textContent, "1"); };
  f.document.visibilityState = "hidden"; assertUnread(); f.document.visibilityState = "visible";
  f.document.modal = true; assertUnread(); f.document.modal = false;
  card.hidden = true; assertUnread(); card.hidden = false;
  card.noRects = true; assertUnread(); card.noRects = false;
  card.rect = { top: 600, left: 20, bottom: 700, right: 320, height: 100, width: 300 }; assertUnread();
  card.rect = { top: 50, left: 20, bottom: 150, right: 320, height: 100, width: 300 };
  f.setContext({ events: [{ ...mentionedEvent(entry), deleted: { reason: "author" } }] });
  f.actions.readVisible(); assert.equal(f.el("mentions-button").hidden, true);
  f.setContext({ events: [{ ...mentionedEvent(entry), contentUnavailable: true }] });
  f.actions.readVisible(); assert.equal(f.el("mentions-button").hidden, true);
  f.el("timeline-region").replaceChildren();
  f.setContext({ events: [mentionedEvent(entry)] }); assertUnread();
  f.el("timeline-region").append(card); f.actions.readVisible();
  assert.equal(f.el("mentions-button").hidden, true);
});

test("read markers are account/project scoped and survive same-account session switches", async () => {
  const entry = mentionEntry("shared-id"), f = mentionFixture({ entries: [entry] });
  f.setContext({ events: [mentionedEvent(entry)] }); f.card(entry.id);
  await f.actions.refresh(); f.actions.readVisible();
  f.setContext({ sessionId: "other", events: [] }); f.actions.reset(); await f.actions.refresh();
  assert.equal(f.el("mentions-button").hidden, true);
  f.setContext({ userId: "second-user", identityScope: "auth-2" }); f.actions.reset(); await f.actions.refresh();
  assert.equal(f.el("mentions-count").textContent, "1", "another account has not read this event");
  f.setContext({ userId: "u", identityScope: "auth-3", projectId: "other-project" }); f.actions.reset(); await f.actions.refresh();
  assert.equal(f.el("mentions-count").textContent, "1", "another project must not inherit read state");
  f.setContext({ projectId: "p" }); f.actions.reset(); await f.actions.refresh();
  assert.equal(f.el("mentions-button").hidden, true);
});

test("corner button jumps oldest unread across sessions and marks only after reveal", async () => {
  const newest = mentionEntry("newest", 5), oldest = mentionEntry("oldest", 2, "other");
  const f = mentionFixture({ entries: [newest, oldest],
    selectSession: async (id, fixture) => {
      assert.equal(fixture.el("mentions-count").textContent, "2", "selection must not prematurely acknowledge");
      fixture.actions.reset(); fixture.setContext({ sessionId: id, events: [mentionedEvent(oldest)] });
    },
    revealEvent: async (id, sequence, fixture) => {
      assert.equal(id, oldest.id); assert.equal(sequence, 2);
      fixture.card(id); await fixture.actions.refresh(); return true;
    } });
  await f.actions.refresh();
  f.el("mentions-button").click(); await flush();
  assert.deepEqual(f.selections, ["other"]); assert.deepEqual(f.reveals, [["oldest", 2]]);
  assert.equal(f.el("mentions-count").textContent, "1");
  assert.equal(f.el("mentions-dialog").open, undefined, "direct jump must not open a second inbox step");
  assert.equal(f.el("mentions-button").disabled, false);
});

test("failed reveal remains unread, announces failure and restores a usable button", async () => {
  const entry = mentionEntry("missing"), f = mentionFixture({ entries: [entry], revealEvent: async () => false });
  await f.actions.refresh(); await f.actions.jumpUnread();
  assert.equal(f.el("mentions-count").textContent, "1");
  assert.equal(f.el("mentions-button").disabled, false);
  assert.equal(f.el("mentions-button").attributes["aria-busy"], undefined);
  assert.equal(f.announcements.at(-1), "Unable to locate this message.");
  await f.actions.jumpUnread(); assert.equal(f.reveals.length, 2, "a failed jump remains retryable");
});

test("cancelled cross-session selection announces failure without marking read", async () => {
  const f = mentionFixture({ entries: [mentionEntry("other-session", 1, "other")] });
  await f.actions.refresh(); await f.actions.jumpUnread();
  assert.equal(f.el("mentions-count").textContent, "1"); assert.deepEqual(f.reveals, []);
  assert.equal(f.announcements.at(-1), "Unable to locate this message.");
});

test("an account round-trip during async navigation cannot reveal or acknowledge old work", async () => {
  let finish;
  const f = mentionFixture({ entries: [mentionEntry("cross-account", 1, "other")],
    selectSession: () => new Promise(resolve => { finish = resolve; }) });
  await f.actions.refresh(); const jump = f.actions.jumpUnread();
  f.setContext({ userId: "second", identityScope: "auth-2" }); f.actions.reset();
  f.setContext({ userId: "u", identityScope: "auth-3", sessionId: "other" }); f.actions.reset();
  finish(); await jump;
  assert.deepEqual(f.reveals, []);
  await f.actions.refresh(); assert.equal(f.el("mentions-count").textContent, "1");
});

test("stale mention fetch cannot populate a newer authentication scope", async () => {
  let finish;
  const f = mentionFixture({ page: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.actions.refresh();
  f.setContext({ identityScope: "auth-2" }); f.actions.reset();
  finish({ mentions: [mentionEntry("stale")], next_before_id: null }); await pending;
  assert.equal(f.el("mentions-button").hidden, true); assert.equal(f.el("mentions-count").textContent, "");
});

test("reading a full first page surfaces older unread mentions without losing pagination", async () => {
  const first = mentionEntry("first"), older = mentionEntry("older", 1, "other");
  const f = mentionFixture({ page: async (_project, cursor) => cursor === "first"
    ? { mentions: [older], next_before_id: null } : { mentions: [first], next_before_id: "first" } });
  f.setContext({ events: [mentionedEvent(first)] }); f.card(first.id);
  await f.actions.refresh(); f.actions.readVisible(); await flush();
  assert.deepEqual(f.calls, [["p", undefined], ["p", "first"]]);
  assert.equal(f.el("mentions-count").textContent, "1");
  await f.actions.refresh(); assert.equal(f.el("mentions-count").textContent, "1");
  assert.equal(f.calls.length, 3, "background head refresh must retain the consumed older-page cursor");
});

test("an older-page failure does not create an automatic retry loop", async () => {
  const first = mentionEntry("first"), f = mentionFixture({ page: async (_project, cursor) => {
    if (cursor) throw new Error("offline"); return { mentions: [first], next_before_id: "first" };
  } });
  f.setContext({ events: [mentionedEvent(first)] }); f.card(first.id);
  await f.actions.refresh(); f.actions.readVisible(); await flush(); await flush();
  assert.equal(f.calls.length, 2);
});

test("same-tab reload retains bounded read IDs without storing excerpts or crossing accounts", async () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const entry = mentionEntry("persisted"), first = mentionFixture({ entries: [entry], storage });
  first.setContext({ events: [mentionedEvent(entry)] }); first.card(entry.id);
  await first.actions.refresh(); first.actions.readVisible();
  const raw = values.get("gatherthread.mentions-read.v1");
  assert.match(raw, /persisted/u); assert.doesNotMatch(raw, /@Member|hello|excerpt|content/u);
  const reloaded = mentionFixture({ entries: [entry], storage });
  await reloaded.actions.refresh(); assert.equal(reloaded.el("mentions-button").hidden, true);
  reloaded.setContext({ userId: "other", identityScope: "auth-2" }); reloaded.actions.reset();
  await reloaded.actions.refresh(); assert.equal(reloaded.el("mentions-count").textContent, "1");
  for (let index = 0; index < 14; index++) {
    first.setContext({ projectId: `p-${index}` }); first.actions.reset();
    await first.actions.refresh(); first.actions.readVisible();
  }
  const saved = JSON.parse(values.get("gatherthread.mentions-read.v1"));
  assert.equal(saved.length, 12); assert.ok(saved.every(([, ids]) => ids.length <= 2048));
});

test("corrupt and denied session storage cannot break jumps or in-memory read state", async () => {
  for (const storage of [
    { getItem: () => "not json", setItem() {} },
    { getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Denied"); } },
    { getItem: () => JSON.stringify([[JSON.stringify(["u", "p"]), ["<invalid id>"]]]), setItem() {} },
  ]) {
    const entry = mentionEntry("readable"), f = mentionFixture({ entries: [entry], storage });
    f.setContext({ events: [mentionedEvent(entry)] }); f.card(entry.id);
    await f.actions.refresh(); assert.equal(f.el("mentions-count").textContent, "1");
    f.actions.readVisible(); assert.equal(f.el("mentions-button").hidden, true);
    await f.actions.refresh(); assert.equal(f.el("mentions-button").hidden, true);
  }
});

test("a nonmodal file overlay does not acknowledge geometrically intersecting messages", async () => {
  const entry = mentionEntry("covered"), f = mentionFixture({ entries: [entry] });
  f.setContext({ events: [mentionedEvent(entry)] }); const card = f.card(entry.id);
  await f.actions.refresh();
  f.document.elementFromPoint = () => f.el("file-overlay"); f.actions.readVisible();
  assert.equal(f.el("mentions-count").textContent, "1");
  f.document.elementFromPoint = () => card; f.actions.readVisible();
  assert.equal(f.el("mentions-button").hidden, true);
});

test("canonical head omissions prune stale targets instead of trapping the oldest-unread jump", async () => {
  const stale = { ...mentionEntry("stale-head"), created_at: "2026-10-20T12:00:00Z" };
  const valid = { ...mentionEntry("valid-head"), created_at: "2026-10-20T11:00:00Z" };
  let head = [stale, valid];
  const f = mentionFixture({ page: async () => ({ mentions: head, next_before_id: "older-cursor" }) });
  await f.actions.refresh(); assert.equal(f.el("mentions-count").textContent, "2");
  head = [valid]; await f.actions.refresh();
  assert.equal(f.el("mentions-count").textContent, "1"); await f.actions.jumpUnread();
  assert.deepEqual(f.reveals, [[valid.id, valid.sequence]]);
});

test("a full new head retains legitimate entries shifted into the older window", async () => {
  const old = Array.from({ length: 50 }, (_, index) => ({ ...mentionEntry(`old-${index}`, index + 1),
    created_at: new Date(Date.UTC(2026, 9, 20, 10, index)).toISOString() })).reverse();
  const added = { ...mentionEntry("newest-50", 51), created_at: "2026-10-20T11:00:00Z" };
  let head = old;
  const f = mentionFixture({ page: async () => ({ mentions: head, next_before_id: head.at(-1).id }) });
  await f.actions.refresh(); head = [added, ...old.slice(0, 49)]; await f.actions.refresh();
  assert.equal(f.el("mentions-count").textContent, "51"); await f.actions.jumpUnread();
  assert.deepEqual(f.reveals, [["old-0", 1]], "the legitimately shifted oldest event must remain reachable");
});

test("complete canonical head prunes cached deleted entries and paginated tails", async () => {
  const a = mentionEntry("head"), b = mentionEntry("old-tail"); let complete = false;
  const f = mentionFixture({ page: async (_project, cursor) => complete ? { mentions: [a], next_before_id: null }
    : cursor ? { mentions: [b], next_before_id: null } : { mentions: [a], next_before_id: a.id } });
  await f.actions.refresh(); await f.actions.refresh({ append: true });
  assert.equal(f.el("mentions-count").textContent, "2"); complete = true;
  await f.actions.refresh(); assert.equal(f.el("mentions-count").textContent, "1");
});

test("a target erased during reveal is not acknowledged and cannot block healthy unread work", async () => {
  const stale = mentionEntry("erased"), healthy = mentionEntry("healthy", 2);
  const f = mentionFixture({ entries: [healthy, stale], revealEvent: async (id, _sequence, fixture) => {
    fixture.setContext({ events: [{ ...mentionedEvent(stale), deleted: { reason: "author" } }, mentionedEvent(healthy)] });
    fixture.card(id); return true;
  } });
  await f.actions.refresh(); await f.actions.jumpUnread();
  assert.equal(f.el("mentions-count").textContent, "1");
  assert.equal(f.announcements.at(-1), "Unable to locate this message.");
  await f.actions.jumpUnread(); assert.equal(f.reveals.at(-1)[0], healthy.id);
});

test("definitive missing-target errors discard stale jumps while transient failures remain retryable", async () => {
  for (const status of [404, 403, 503]) {
    const entry = mentionEntry(`status-${status}`);
    const f = mentionFixture({ entries: [entry], revealEvent: async () => { throw Object.assign(new Error("Fixture failure"), { status }); } });
    await f.actions.refresh(); await f.actions.jumpUnread();
    assert.equal(f.el("mentions-button").hidden, status !== 503);
    assert.equal(f.announcements.at(-1), "Unable to locate this message.");
    assert.equal(f.el("mentions-button").disabled, false);
  }
});

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
  actions.openInbox(); await new Promise(setImmediate);
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
