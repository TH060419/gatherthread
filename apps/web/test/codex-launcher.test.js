import test from "node:test";
import assert from "node:assert/strict";
import { createAccountEmailHint, mountCodexLauncher } from "../src/codex-launcher.js";

const id = "12345678-1234-4234-8234-123456789abc";
const storage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
test("email hints survive refresh, are account-bound, expire and contain no credentials", () => {
  const sessionStorage = storage(), localStorage = storage(); let now = 1000;
  const options = { sessionStorage, localStorage, now: () => now };
  let hint = createAccountEmailHint(options);
  hint.remember("user-a", "User@example.invalid", false);
  hint = createAccountEmailHint(options);
  assert.equal(hint.read("user-a"), "user@example.invalid");
  assert.equal(hint.read("user-b"), "");
  assert.equal(localStorage.getItem("gt-account-email-hint"), null);
  hint.remember("user-a", "user@example.invalid", true);
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem("gt-account-email-hint"))).sort(), ["email", "expiresAt", "userId"]);
  now += 31 * 86400_000;
  assert.equal(hint.read("user-a"), "");
  hint.clear("user-a");
  assert.equal(sessionStorage.getItem("gt-account-email-hint"), null);
  assert.equal(localStorage.getItem("gt-account-email-hint"), null);
});
test("blocked browser storage never prevents connection or saves a password", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const hint = createAccountEmailHint({ sessionStorage: blocked, localStorage: blocked });
  hint.remember("user-a", "user@example.invalid", false);
  assert.equal(hint.read("user-a"), "user@example.invalid");
  hint.clear("user-a");
  assert.equal(hint.read("user-a"), "");
});
test("remembered email uses a one-day tab hint and removes expired stored hints on read", () => {
  const sessionStorage = storage(), localStorage = storage(); let now = 1000;
  const options = { sessionStorage, localStorage, now: () => now };
  const hint = createAccountEmailHint(options); hint.remember("user-a", "user@example.invalid", true);
  assert.equal(JSON.parse(sessionStorage.getItem("gt-account-email-hint")).expiresAt, now + 86400_000);
  now += 2 * 86400_000;
  assert.equal(createAccountEmailHint(options).read("user-a"), "user@example.invalid", "Remember retains a valid local hint");
  assert.equal(sessionStorage.getItem("gt-account-email-hint"), null, "expired tab hint removed");
  now += 31 * 86400_000;
  assert.equal(createAccountEmailHint(options).read("user-a"), "");
  assert.equal(localStorage.getItem("gt-account-email-hint"), null, "expired local hint removed");
});

function fixture(create) {
  const nodes = new Map(), revoked = [], opened = [];
  const get = key => {
    if (!nodes.has(key)) nodes.set(key, { value: "", textContent: "", hidden: false, disabled: false,
      listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return nodes.get(key);
  };
  let context = { scope: "a:project-a", userId: "user-a", projectId: "project-a", baseUrl: "https://test.gatherthread.cn",
    model: "gpt-5.6-sol", contextWindowTokens: 65536, visibleHistorySync: "never" };
  const hint = createAccountEmailHint({ sessionStorage: storage(), localStorage: storage() });
  hint.remember("user-a", "user@example.invalid", false);
  const ui = mountCodexLauncher({ document: { getElementById: get },
    api: { createCodexLauncherAuthorization: create ?? (async () => ({ email: "user@example.invalid",
      authorization: { id, expires_at: new Date(Date.now() + 600_000).toISOString() } })),
      revokeDeviceAuthorization: async key => revoked.push(key) },
    localizer: { t: value => value }, emailHint: hint, context: () => context, navigate: uri => opened.push(uri) });
  return { ui, get, hint, opened, revoked, change: () => { context = { ...context, scope: "b:project-b", projectId: "project-b" }; } };
}
test("Launcher prepares a password handoff then opens synchronously on the actual click", async () => {
  const f = fixture(); await f.ui.open();
  assert.equal(f.get("open-codex-launcher-button").disabled, false);
  f.get("open-codex-launcher-button").listeners.click();
  const link = new URL(f.opened[0]);
  assert.equal(link.searchParams.get("email"), "user@example.invalid");
  assert.equal(link.searchParams.get("v"), "2");
  assert.equal(link.searchParams.get("origin"), "https://test.gatherthread.cn");
  assert.doesNotMatch(link.href, /gtd_|gta_|password|cookie/i);
  f.ui.close();
  assert.deepEqual(f.revoked, [], "closing after launch must not interrupt password entry");
  f.ui.clear();
  assert.deepEqual(f.revoked, [id], "account/scope change revokes even handed-off requests");
});
test("same-project reopens preserve launched grants but scope clearing still revokes them", async () => {
  const issued = [id, "22345678-1234-4234-8234-123456789abc", "32345678-1234-4234-8234-123456789abc"];
  let count = 0;
  const f = fixture(async () => ({ email: "user@example.invalid", authorization: {
    id: issued[count++], expires_at: new Date(Date.now() + 600_000).toISOString(),
  } }));
  await f.ui.open(); f.get("open-codex-launcher-button").listeners.click(); f.ui.close();
  for (let index = 0; index < 2; index++) {
    await f.ui.open(); f.ui.close();
    assert.ok(!f.revoked.includes(id), "reopening must not interrupt native password entry");
    assert.ok(f.revoked.includes(issued[index + 1]), "unopened replacement must be revoked on close");
  }
  f.change(); f.ui.clear();
  assert.ok(f.revoked.includes(id), "a real project change still revokes the launched grant");
});
test("an unopened handoff is revoked on close and cannot launch after a project change", async () => {
  const f = fixture(); await f.ui.open(); f.change();
  f.get("open-codex-launcher-button").listeners.click();
  assert.deepEqual(f.opened, []);
  f.ui.close(); assert.deepEqual(f.revoked, [id]);
});
test("late authorization after close is revoked and cannot leak into another account", async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const f = fixture(() => pending); const work = f.ui.open(); f.ui.close();
  resolve({ email: "user@example.invalid", authorization: { id, expires_at: new Date(Date.now() + 600_000).toISOString() } });
  await work;
  assert.equal(f.get("open-codex-launcher-button").disabled, true);
  assert.deepEqual(f.revoked, [id]);
  assert.deepEqual(f.opened, []);
});
test("closing a pending confirmation does not disable confirmation when reopened", async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const f = fixture(() => pending); f.hint.clear("user-a"); await f.ui.open();
  f.get("codex-launcher-email").value = "user@example.invalid";
  f.get("prepare-codex-launcher-button").listeners.click();
  assert.equal(f.get("prepare-codex-launcher-button").disabled, true);
  f.ui.close(); await f.ui.open();
  assert.equal(f.get("prepare-codex-launcher-button").disabled, false);
  resolve({ email: "user@example.invalid", authorization: { id, expires_at: new Date(Date.now() + 600_000).toISOString() } });
  await new Promise(done => setImmediate(done));
  assert.equal(f.get("prepare-codex-launcher-button").disabled, false);
  assert.equal(f.get("open-codex-launcher-button").disabled, true);
  assert.deepEqual(f.revoked, [id]);
});
test("a rejected handoff is revoked even when URL construction rejects the connection", async () => {
  const f = fixture();
  f.change();
  // Invalid settings must fail closed after the server has issued a grant.
  const ui = mountCodexLauncher({ document: { getElementById: f.get },
    api: { createCodexLauncherAuthorization: async () => ({ email: "user@example.invalid",
      authorization: { id, expires_at: new Date(Date.now() + 600_000).toISOString() } }),
      revokeDeviceAuthorization: async key => f.revoked.push(key) }, localizer: { t: value => value },
    emailHint: f.hint, context: () => ({ scope: "bad", userId: "user-a", projectId: "project-a", baseUrl: "https://example.invalid" }) });
  await ui.open();
  assert.equal(f.get("open-codex-launcher-button").disabled, true);
  assert.equal(f.get("prepare-codex-launcher-button").disabled, false);
  assert.deepEqual(f.revoked, [id]);
});
test("correcting an outdated email hint updates later Launcher prefill", async () => {
  const f = fixture(); f.hint.remember("user-a", "outdated@example.invalid", false);
  await f.ui.open();
  assert.equal(f.get("codex-launcher-email-row").hidden, false);
  f.get("codex-launcher-email").value = "user@example.invalid";
  f.get("codex-launcher-email").listeners.input();
  f.get("prepare-codex-launcher-button").listeners.click();
  await new Promise(done => setImmediate(done));
  assert.equal(f.get("open-codex-launcher-button").disabled, false);
  assert.equal(f.hint.read("user-a"), "user@example.invalid");
  f.ui.clear();
});
