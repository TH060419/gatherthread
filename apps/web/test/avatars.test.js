import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AVATAR_CATALOG, avatarImage, eventAuthorLabel, renderAvatar } from "../src/avatars.js";
import { mountAvatarSettings } from "../src/avatar-settings.js";
import { HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";
import { translateUiText } from "../src/i18n.js";

class Node {
  constructor() {
    this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {};
    this.classes = new Set(); this.disabled = false;
    this.classList = { add: value => this.classes.add(value), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) };
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
}

function fixture() {
  const nodes = new Map();
  const el = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const document = { getElementById: el, createElement: () => new Node() };
  let user = { id: "u1", username: "Same name", avatar_id: "cat" };
  let revision = 0;
  const saved = [], writes = [];
  let loader = async () => ({ user_id: "u1", avatar_id: "cat" });
  let writer = async avatarId => ({ user_id: "u1", avatar_id: avatarId });
  const ui = mountAvatarSettings({ document, localizer: { t: text => text }, getUser: () => user, getRevision: () => revision,
    onSaved: profile => saved.push(profile), api: { getAccountAvatar: () => loader(), setAccountAvatar: id => { writes.push(id); return writer(id); } } });
  el("settings-dialog").open = true;
  const pick = id => {
    const choices = el("settings-avatar-grid").children;
    for (const choice of choices) choice.children[0].checked = choice.children[0].value === (id ?? "");
    const input = choices.find(choice => choice.children[0].checked).children[0];
    input.dispatch("change");
    return input;
  };
  return { ui, el, saved, writes, pick, document, setUser: value => { user = value; },
    updateAvatar: value => { user.avatar_id = value; revision += 1; },
    setLoader: value => { loader = value; }, setWriter: value => { writer = value; } };
}

test("official catalog matches the server allowlist and contains self-contained reviewed images", async () => {
  const source = await readFile(new URL("../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
  const ids = JSON.parse(`[${source.match(/AvatarIdSchema = z.enum\(\[([^\]]+)\]/u)[1]}]`);
  assert.deepEqual(AVATAR_CATALOG.map(item => item.id), ids);
  for (const item of AVATAR_CATALOG) assert.match(item.image, /^data:image\/svg\+xml,/u);
  assert.equal(avatarImage("https://external.example/avatar.svg"), null);
});

test("only Agent replies use owner attribution and a badge; requests use a human avatar; failed images and deleted users fall back", () => {
  const app = fixture();
  const reply = { type: "agent_response", actor: { id: "owner", username: "Owner $&" } };
  assert.equal(eventAuthorLabel(reply), "Owner $&'s Agent");
  assert.equal(eventAuthorLabel(reply, text => translateUiText(text, "zh-CN")), "Owner $&的 Agent");
  assert.equal(eventAuthorLabel({ ...reply, type: "agent_request" }), "Owner $&");
  const node = new Node();
  renderAvatar(app.document, node, { userId: "owner", username: "Owner", avatarId: "cat", agent: true, harness: "codex" });
  assert.equal(node.children[1].src, avatarImage("cat"));
  assert.equal(node.children[2].dataset.harness, "codex");
  node.children[1].dispatch("load");
  assert.equal(node.children[0].hidden, true);
  node.children[1].dispatch("error");
  assert.equal(node.children[0].hidden, false);
  assert.equal(node.children[0].textContent, "O");
  assert.equal(node.children.length, 2);
  renderAvatar(app.document, node, { userId: "deleted-account", username: "Deleted member", avatarId: "cat" });
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].textContent, "·");
});

test("picker previews without writing; cancel restores the saved image; radio selection preserves focusable nodes", async () => {
  const app = fixture(); await app.ui.load(); app.saved.length = 0;
  const originalGrid = app.el("settings-avatar-grid").children;
  app.pick("fox");
  assert.equal(app.el("settings-avatar-grid").children, originalGrid);
  assert.equal(app.el("settings-avatar-preview").children[1].src, avatarImage("fox"));
  assert.equal(app.writes.length, 0);
  app.el("settings-avatar-cancel").dispatch("click");
  assert.equal(app.el("settings-avatar-preview").children[1].src, avatarImage("cat"));
  app.pick(null); await app.el("settings-avatar-save").dispatch("click");
  assert.deepEqual(app.writes, [null]);
  assert.deepEqual(app.saved, [{ user_id: "u1", avatar_id: null }]);
});

test("save failures keep the draft retryable; closing or changing accounts fences delayed loads and writes", async () => {
  const app = fixture(); await app.ui.load(); app.saved.length = 0;
  app.pick("rabbit"); app.setWriter(async () => { throw new Error("offline"); });
  await app.el("settings-avatar-save").dispatch("click");
  assert.equal(app.el("settings-avatar-status").textContent, "Could not save avatar. Try again.");
  assert.equal(app.el("settings-avatar-save").disabled, false);
  let resolve; app.setWriter(() => new Promise(yes => { resolve = yes; }));
  const work = app.el("settings-avatar-save").dispatch("click");
  app.el("settings-dialog").open = false; app.el("settings-dialog").dispatch("close");
  resolve({ user_id: "u1", avatar_id: "rabbit" }); await work;
  assert.equal(app.saved.length, 0);
  app.el("settings-dialog").open = true;
  app.setLoader(() => new Promise(yes => { resolve = yes; }));
  const load = app.ui.load(); app.setUser({ id: "u2", username: "Same name" });
  resolve({ user_id: "u1", avatar_id: "cat" }); await load;
  assert.equal(app.saved.length, 0);
});

test("a pending Settings load keeps a newer account avatar instead of applying its stale response", async () => {
  const app = fixture();
  let resolve;
  app.setLoader(() => new Promise(yes => { resolve = yes; }));
  const load = app.ui.load();
  app.updateAvatar("fox");
  resolve({ user_id: "u1", avatar_id: "cat" });
  await load;
  assert.equal(app.saved.length, 0);
  assert.equal(app.el("settings-avatar-preview").children[1].src, avatarImage("fox"));
});

test("HTTP avatar APIs use strict self assignment and scoped profile reads; mock changes affect both sessions without changing events", async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ url, options }); return Response.json({ data: url.endsWith("avatar-profiles") ? { profiles: [] } : { id: "u1", avatar_id: "cat" } }); };
  try {
    const api = new HttpCollaborationApi();
    assert.equal((await api.getAccountAvatar()).avatar_id, "cat");
    await api.setAccountAvatar("fox"); await api.listAvatarProfiles("session / 1");
    assert.equal(calls[1].url, "/v1/me/avatar"); assert.equal(calls[1].options.method, "PUT");
    assert.equal(calls[1].options.credentials, "include");
    assert.deepEqual(JSON.parse(calls[1].options.body), { avatar_id: "fox" });
    assert.equal(calls[2].url, "/v1/sessions/session%20%2F%201/avatar-profiles");
  } finally { globalThis.fetch = originalFetch; }
  const mock = new MockCollaborationApi({ latency: 0 });
  const before = structuredClone([...mock.events]); await mock.setAccountAvatar("owl");
  for (const session of mock.sessions) assert.equal((await mock.listAvatarProfiles(session.id)).find(profile => profile.user_id === mock.currentUser.id)?.avatar_id, "owl");
  assert.deepEqual([...mock.events], before);
});

test("HTTP avatar reads have a finite default deadline without cancelling unrelated requests", async () => {
  const originalFetch = globalThis.fetch;
  const keepAlive = setTimeout(() => {}, 6_000);
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    const api = new HttpCollaborationApi();
    await Promise.all([
      assert.rejects(api.getAccountAvatar(), { name: "TimeoutError" }),
      assert.rejects(api.listAvatarProfiles("s1"), { name: "TimeoutError" }),
    ]);
  } finally { clearTimeout(keepAlive); globalThis.fetch = originalFetch; }
});

test("avatar reads work on supported browsers without AbortSignal.timeout", async () => {
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
  const calls = [];
  AbortSignal.timeout = undefined;
  globalThis.fetch = async (url, options) => {
    calls.push(options.signal);
    return Response.json({ data: url.endsWith("avatar-profiles")
      ? { profiles: [] } : { id: "u1", avatar_id: "fox" } });
  };
  try {
    const api = new HttpCollaborationApi();
    assert.equal((await api.getAccountAvatar()).avatar_id, "fox");
    assert.deepEqual(await api.listAvatarProfiles("s1"), []);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(signal => signal instanceof AbortSignal));
  } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; }
});
