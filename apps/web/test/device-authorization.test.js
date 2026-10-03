import test from "node:test";
import assert from "node:assert/strict";
import { mountDeviceAuthorization } from "../src/device-authorization.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const result = (id) => ({ authorization: { id, expires_at: new Date(Date.now() + 600_000).toISOString() }, authorization_token: "isolated-fixture-authorization" });
function fixture(createDeviceAuthorization) {
  const nodes = new Map(), revoked = [];
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", hidden: false, disabled: false,
      listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return nodes.get(id);
  };
  let currentScope = "email-actor:project-a";
  const ui = mountDeviceAuthorization({ document: { getElementById: get },
    api: { createDeviceAuthorization, revokeDeviceAuthorization: async (id) => { revoked.push(id); } },
    localizer: { t: (x) => x }, scope: () => currentScope });
  return { get, ui, revoked, create: () => get("authorize-codex-device").listeners.click(), changeScope: () => { currentScope = "another-actor:project-b"; } };
}
test("closing a device authorization clears its value and revokes the unclaimed grant", async () => {
  const f = fixture(async () => result("grant-a"));
  await f.create();
  assert.equal(f.get("codex-authorization-result").hidden, false);
  assert.equal(f.get("copy-codex-authorization").disabled, false);
  f.ui.clear();
  assert.equal(f.get("codex-device-authorization").value, "");
  assert.equal(f.get("codex-authorization-result").hidden, true);
  assert.equal(f.get("copy-codex-authorization").disabled, true);
  assert.deepEqual(f.revoked, ["grant-a"]);
});
for (const change of ["close", "account/project change"]) {
  test(`a late authorization after ${change} is revoked without revealing it`, async () => {
    const pending = deferred(); const f = fixture(() => pending.promise);
    const work = f.create();
    if (change === "close") f.ui.clear(); else f.changeScope();
    pending.resolve(result("stale-grant")); await work;
    assert.equal(f.get("codex-device-authorization").value, "");
    assert.equal(f.get("codex-authorization-result").hidden, true);
    assert.deepEqual(f.revoked, ["stale-grant"]);
  });
}
test("a stale authorization failure cannot overwrite a newer dialog request", async () => {
  const old = deferred(), newer = deferred(); let calls = 0;
  const f = fixture(() => (++calls === 1 ? old.promise : newer.promise));
  const first = f.create(); f.ui.clear(); const second = f.create();
  old.reject(new Error("isolated failure")); await first;
  assert.equal(f.get("codex-authorization-status").textContent, "");
  assert.equal(f.get("authorize-codex-device").disabled, true);
  newer.resolve(result("new-grant")); await second;
  assert.equal(f.get("codex-authorization-result").hidden, false);
  f.ui.clear();
});
