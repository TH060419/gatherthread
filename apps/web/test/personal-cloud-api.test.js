import assert from "node:assert/strict";
import test from "node:test";
import { mountPersonalCloudApi } from "../src/personal-cloud-api.js";

const id = "10000000-0000-4000-8000-000000000001";
const revision = "20000000-0000-4000-8000-000000000001";
const provider = { id: "deepseek", label: "DeepSeek", transport: "openai-chat", base_url: "https://api.deepseek.com/v1", docs_url: "https://api-docs.deepseek.com/" };
const configuration = { id, revision, provider_id: provider.id, profile_id: `api-${id}`, label: "My project model", model: "deepseek-chat", enabled: true, has_key: true, updated_at: "2026-10-12T00:00:00.000Z" };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}, confirm = () => true) {
  class Node {
    children = []; value = ""; textContent = ""; dataset = {}; attrs = {}; handlers = {}; hidden = false; disabled = false; checked = false;
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(key, handler) { this.handlers[key] = handler; }
    click() { return this.disabled ? undefined : this.handlers.click?.(); }
    focus() { this.focused = true; }
  }
  const nodes = new Map(), document = { getElementById(key) { if (!nodes.has(key)) nodes.set(key, new Node()); return nodes.get(key); }, createElement() { return new Node(); } };
  let scope = "account-1", open = true, changes = 0;
  const calls = [], api = { getCloudApi: async () => ({ enabled: true, providers: [provider], configurations: [configuration] }),
    putCloudApi: async (key, input) => { calls.push(["save", key, input]); return { configuration }; },
    deleteCloudApi: async (key, input) => { calls.push(["delete", key, input]); }, ...overrides };
  const controller = mountPersonalCloudApi({ document, api, localizer: { t: value => value },
    getContext: () => open ? { scope } : null, makeId: () => id, confirm, onChanged: () => { changes++; } });
  return { controller, nodes, calls, changes: () => changes, node: key => document.getElementById(key),
    changeAccount: () => { scope = "account-2"; }, close: () => { open = false; controller.clear(); },
    edit: () => nodes.get("cloud-api-list").children[0].children.at(-1).click() };
}

test("personal API metadata is text-only and edits never retrieve or prefill the saved key", async () => {
  const f = fixture(); await f.controller.load(); f.edit();
  assert.equal(f.node("cloud-api-label").value, configuration.label);
  assert.equal(f.node("cloud-api-model").value, configuration.model);
  assert.equal(f.node("cloud-api-key").value, "");
  assert.equal(f.node("cloud-api-editor").hidden, false);
  assert.equal(f.node("cloud-api-provider").value, provider.id);
  assert.equal(f.node("cloud-api-endpoint").textContent, provider.base_url);
});

test("saving clears a key before the asynchronous write and uses an exact revision once", async () => {
  let finish, received;
  const f = fixture({ putCloudApi: async (_key, input) => { received = input; await new Promise(done => { finish = done; }); return { configuration }; } });
  await f.controller.load(); f.edit(); f.node("cloud-api-key").value = "fixture-k";
  f.node("cloud-api-save").click(); f.node("cloud-api-save").click();
  assert.equal(f.node("cloud-api-key").value, "");
  assert.deepEqual(received, { expected_revision: revision, provider_id: "deepseek", label: configuration.label, model: configuration.model, enabled: true, api_key: "fixture-k" });
  finish(); await nextTurn(); assert.equal(f.changes(), 1); assert.equal(f.node("cloud-api-editor").hidden, true);
});

test("key retention is explicit on edit; new configurations require a key", async () => {
  const f = fixture(); await f.controller.load(); f.edit(); f.node("cloud-api-save").click(); await nextTurn();
  assert.equal("api_key" in f.calls[0][2], false);
  f.node("cloud-api-new").click(); f.node("cloud-api-label").value = "New model"; f.node("cloud-api-model").value = "deepseek-chat";
  f.node("cloud-api-save").click(); await nextTurn(); assert.equal(f.calls.length, 1);
  assert.equal(f.node("cloud-api-status").textContent, "Choose a provider, model and label; a new connection also needs an API key.");
});

test("delete requires confirmation and the exact stored revision", async () => {
  let approved = false; const f = fixture({}, () => approved); await f.controller.load(); f.edit();
  f.node("cloud-api-delete").click(); await nextTurn(); assert.equal(f.calls.length, 0);
  approved = true; f.node("cloud-api-delete").click(); await nextTurn();
  assert.deepEqual(f.calls[0], ["delete", id, { expected_revision: revision }]); assert.equal(f.changes(), 1);
});

test("closing or changing accounts fences late metadata, errors and saved receipts", async () => {
  for (const action of ["close", "account"]) {
    let finish; const f = fixture({ getCloudApi: () => new Promise(done => { finish = done; }) });
    const pending = f.controller.load(); f.node("cloud-api-key").value = "fixture-k";
    if (action === "close") f.close(); else f.changeAccount();
    finish({ enabled: true, providers: [provider], configurations: [configuration] }); await pending;
    assert.equal(f.node("cloud-api-list").children.length, 0);
    if (action === "close") assert.equal(f.node("cloud-api-key").value, "");
  }
});

test("upstream errors never reveal private response data or a key", async () => {
  const f = fixture({ putCloudApi: async () => { throw Error("private provider response fixture-k"); } });
  await f.controller.load(); f.edit(); f.node("cloud-api-key").value = "fixture-k";
  f.node("cloud-api-save").click(); await nextTurn();
  assert.equal(f.node("cloud-api-key").value, "");
  assert.equal(f.node("cloud-api-status").textContent, "Could not save this API connection. Refresh and try again.");
  assert.equal(f.node("cloud-api-save").disabled, false);
});

test("an uncertain new save cannot create a second configuration on retry", async () => {
  const ids = []; const f = fixture({ getCloudApi: async () => ({ enabled: true, providers: [provider], configurations: [] }),
    putCloudApi: async (value) => { ids.push(value); throw Error("Uncertain acknowledgement"); } });
  await f.controller.load(); f.node("cloud-api-new").click();
  f.node("cloud-api-label").value = "Fixture"; f.node("cloud-api-model").value = "deepseek-chat";
  for (let i = 0; i < 2; i++) { f.node("cloud-api-key").value = "fixture-k"; f.node("cloud-api-save").click(); await nextTurn(); }
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

test("changing provider never reuses the saved key at another endpoint", async () => {
  const other = { ...provider, id: "openai", label: "OpenAI" };
  const f = fixture({ getCloudApi: async () => ({ enabled: true, providers: [provider, other], configurations: [configuration] }) });
  await f.controller.load(); f.edit(); f.node("cloud-api-provider").value = other.id;
  f.node("cloud-api-provider").handlers.change(); f.node("cloud-api-save").click(); await nextTurn();
  assert.equal(f.calls.length, 0);
  assert.equal(f.node("cloud-api-status").textContent, "Changing provider requires a new API key.");
});
