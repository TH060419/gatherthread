import assert from "node:assert/strict";
import test from "node:test";
import { mountAccountDevices } from "../src/account-devices.js";

function fixture(api = {}, confirm = () => true, translate = value => value) {
  class Node {
    children = []; listeners = {}; _disabled = false; textContent = ""; dataset = {};
    get disabled() { return this._disabled; }
    set disabled(value) { this._disabled = value; if (value) this.focused = false; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {}
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() { this.focused = true; }
    click() { return this.listeners.click?.(); }
  }
  const nodes = new Map(["settings-devices-list", "settings-devices-status", "settings-devices-refresh"].map(id => [id, new Node()]));
  const document = { getElementById: id => nodes.get(id), createElement: () => new Node() };
  let scope = "account:1", open = true;
  const current = () => open ? { scope, userId: "me", deviceId: "browser" } : null;
  const devices = [{ id: "browser", user_id: "me", name: "Browser" }, { id: "phone", user_id: "me", name: "<Phone>" },
    { id: "gone", user_id: "me", name: "Gone", revoked_at: "2026-01-01" }, { id: "foreign", user_id: "other", name: "Not mine" }];
  const control = mountAccountDevices({ document, api: { listDevices: async () => devices, ...api },
    localizer: { t: translate }, getContext: current, confirm });
  return { control, nodes, devices, setScope: value => { scope = value; }, close: () => { open = false; control.clear(); },
    rows: () => nodes.get("settings-devices-list").children,
    buttons: () => nodes.get("settings-devices-list").children.flatMap(row => row.children.filter(node => node.dataset.deviceId)) };
}

test("device controls are account-scoped, escape names and never revoke the current browser", async () => {
  const calls = [], f = fixture({ revokeDevice: async id => { calls.push(id); } });
  await f.control.load();
  assert.equal(f.rows().length, 3);
  assert.equal(f.rows()[1].children[0].children[0].textContent, "<Phone>");
  assert.deepEqual(f.buttons().map(button => button.dataset.deviceId), ["phone"]);
  await f.buttons()[0].click();
  assert.deepEqual(calls, ["phone"]);
  assert.equal(f.nodes.get("settings-devices-refresh").focused, true, "focus returns only after the refreshed control is enabled");
});

test("revocation requires confirmation and is single-flight even when refresh is clicked", async () => {
  let approved = false, resolve, calls = 0, loads = 0;
  const f = fixture({ listDevices: async () => { loads++; return f.devices; },
    revokeDevice: async () => { calls++; await new Promise(done => { resolve = done; }); } }, () => approved);
  await f.control.load();
  await f.buttons()[0].click(); assert.equal(calls, 0);
  approved = true;
  const pending = f.buttons()[0].click(); f.buttons()[0].click();
  await f.control.load(); assert.equal(calls, 1); assert.equal(loads, 1);
  resolve(); await pending;
  assert.equal(loads, 2);
});

test("stale device loads and errors cannot enter another account or a closed dialog", async () => {
  let resolve, reject;
  const f = fixture({ listDevices: () => new Promise(done => { resolve = done; }) });
  const pending = f.control.load(); f.setScope("account:2"); resolve(f.devices); await pending;
  assert.equal(f.rows().length, 0);
  const broken = fixture({ listDevices: () => new Promise((_done, fail) => { reject = fail; }) });
  const failed = broken.control.load(); broken.close(); reject(Error("private response")); await failed;
  assert.equal(broken.nodes.get("settings-devices-status").textContent, "");
});

test("revocation failure stays visible without exposing upstream data or claiming success", async () => {
  const f = fixture({ revokeDevice: async () => { throw Error("private response"); } });
  await f.control.load(); await f.buttons()[0].click();
  assert.equal(f.nodes.get("settings-devices-status").textContent, "Could not revoke device access. Refresh and try again.");
  assert.equal(f.buttons()[0].disabled, false);
});

test("loaded device labels switch languages both ways without refetching or translating names", async () => {
  let locale = "en", loads = 0;
  const f = fixture({ listDevices: async () => { loads++; return f.devices; } }, () => true,
    value => value && locale === "zh" ? `zh:${value}` : value);
  await f.control.load();
  locale = "zh"; f.control.refreshLanguage();
  assert.equal(f.rows()[0].children[0].children[1].textContent, "zh:This browser");
  assert.equal(f.buttons()[0].textContent, "zh:Revoke access");
  assert.equal(f.rows()[1].children[0].children[0].textContent, "<Phone>");
  locale = "en"; f.control.refreshLanguage();
  assert.equal(f.rows()[0].children[0].children[1].textContent, "This browser");
  assert.equal(f.buttons()[0].textContent, "Revoke access");
  assert.equal(loads, 1);
});
