import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CloudApiStore } from "../src/cloud-api.js";
import { CollaborationDatabase } from "../src/database.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gt-cloud-api-test-"));
  const database = new CollaborationDatabase(join(root, "identity.db"), { authTokenPepper: "cloud-api-test-fixture-pepper" });
  const actor = database.bootstrapIdentity({ display_name: "Owner", device_name: "Browser" }).actor;
  const other = database.createIdentity({ display_name: "Other", device_name: "Browser" }).actor;
  const key = randomBytes(32).toString("base64");
  const store = new CloudApiStore(database, key);
  const input = { expected_revision: null, provider_id: "deepseek" as const, label: "My model", model: "deepseek-chat",
    enabled: true, api_key: ["synthetic", "private", "provider", "value"].join("-") };
  return { root, database, actor, other, store, input, close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("personal model configuration is encrypted, account-private and write-only", () => {
  const f = fixture();
  try {
    const id = randomUUID(), saved = f.store.put(f.actor, id, f.input);
    assert.equal(saved.id, id); assert.equal(saved.has_key, true);
    assert.equal(f.store.status(f.other).configurations.length, 0);
    assert.doesNotMatch(JSON.stringify(f.store.status(f.actor)), /synthetic-private|ciphertext|nonce|auth_tag/);
    const row = f.database.sqlite.prepare("SELECT * FROM cloud_api_configs WHERE id=?").get(id)!;
    assert.doesNotMatch(JSON.stringify(row), /synthetic-private/);
    assert.equal(f.store.resolve(f.actor, saved.profile_id, saved.revision).apiToken, f.input.api_key);
    assert.throws(() => f.store.resolve(f.other, saved.profile_id, saved.revision), /unavailable/);
    assert.throws(() => f.store.put(f.other, id, f.input), /unavailable/);
  } finally { f.close(); }
});

test("configuration updates are exact-revision CAS, retain omitted keys and fence previous revisions", () => {
  const f = fixture();
  try {
    const id = randomUUID(), first = f.store.put(f.actor, id, f.input);
    assert.equal(f.store.put(f.actor, id, f.input).revision, first.revision, "uncertain create retry is idempotent");
    const { api_key: _key, ...metadata } = f.input;
    const updated = f.store.put(f.actor, id, { ...metadata, expected_revision: first.revision, model: "deepseek-reasoner" });
    assert.notEqual(updated.revision, first.revision);
    assert.equal(f.store.resolve(f.actor, updated.profile_id, updated.revision).apiToken, f.input.api_key);
    assert.throws(() => f.store.resolve(f.actor, first.profile_id, first.revision), /changed/);
    assert.throws(() => f.store.put(f.actor, id, { ...f.input, expected_revision: first.revision }), /changed/);
    assert.throws(() => f.store.put(f.actor, id, { ...metadata, expected_revision: randomUUID(), model: "deepseek-reasoner" }), /changed/);
    assert.throws(() => f.store.remove(f.actor, id, first.revision), /changed/);
    f.store.remove(f.actor, id, updated.revision);
    assert.equal(f.store.status(f.actor).configurations.length, 0);
    assert.throws(() => f.store.resolve(f.actor, updated.profile_id, updated.revision), /unavailable/);
  } finally { f.close(); }
});

test("public configuration metadata refuses accidentally pasted keys, including retained keys", () => {
  const f = fixture();
  try {
    for (const metadata of [{ label: f.input.api_key }, { model: f.input.api_key }, { label: "sk-ant-fixture-key-value-123456789" },
      { model: "sk-or-v1-fixture-secret-value" }]) {
      assert.throws(() => f.store.put(f.actor, randomUUID(), { ...f.input, ...metadata }), /not credentials/);
    }
    const saved = f.store.put(f.actor, randomUUID(), f.input), { api_key: _key, ...metadata } = f.input;
    assert.throws(() => f.store.put(f.actor, saved.id, { ...metadata, expected_revision: saved.revision, label: f.input.api_key }), /not credentials/);
    assert.throws(() => f.store.put(f.actor, saved.id, { ...metadata, expected_revision: saved.revision, api_key: ["replacement", "fixture", "secret"].join("-"),
      label: f.input.api_key }), /not credentials/);
    assert.doesNotMatch(JSON.stringify(f.store.status(f.actor)), /synthetic-private/);
  } finally { f.close(); }
});

test("changing provider requires a newly submitted key rather than forwarding the previous vendor credential", () => {
  const f = fixture();
  try {
    const saved = f.store.put(f.actor, randomUUID(), f.input), { api_key: _key, ...metadata } = f.input;
    assert.throws(() => f.store.put(f.actor, saved.id, { ...metadata, expected_revision: saved.revision, provider_id: "anthropic" }), /new API key/);
    assert.equal(f.store.status(f.actor).configurations[0]?.provider_id, "deepseek");
    const next = f.store.put(f.actor, saved.id, { ...metadata, expected_revision: saved.revision, provider_id: "anthropic", api_key: ["new", "vendor", "fixture", "key"].join("-") });
    assert.equal(f.store.resolve(f.actor, next.profile_id, next.revision).apiToken, "new-vendor-fixture-key");
  } finally { f.close(); }
});

test("ciphertext cannot move between accounts, configuration IDs or revisions", () => {
  const f = fixture();
  try {
    const id = randomUUID(), saved = f.store.put(f.actor, id, f.input);
    const peer = f.store.put(f.actor, randomUUID(), { ...f.input, label: "Another config" });
    const foreign = f.store.put(f.other, randomUUID(), f.input);
    const ciphertext = String(f.database.sqlite.prepare("SELECT key_ciphertext FROM cloud_api_configs WHERE id=?").get(id)!.key_ciphertext);
    for (const [actor, config] of [[f.actor, peer], [f.other, foreign]] as const) {
      f.database.sqlite.prepare("UPDATE cloud_api_configs SET key_ciphertext=? WHERE id=?").run(ciphertext, config.id);
      assert.throws(() => f.store.resolve(actor, config.profile_id, config.revision), /unavailable/);
    }
    f.database.sqlite.prepare("UPDATE cloud_api_configs SET revision=? WHERE id=?").run(randomUUID(), id);
    assert.throws(() => f.store.resolve(f.actor, saved.profile_id, f.store.status(f.actor).configurations.find(config => config.id === id)!.revision), /unavailable/);
  } finally { f.close(); }
});

test("encrypted AAD binds every route-bearing metadata field, not just the revision", () => {
  const f = fixture();
  try {
    for (const [column, replacement] of [["provider_id", "openai"], ["model", "other-model"], ["label", "Changed label"],
      ["updated_at", "2026-10-01T00:00:00.000Z"]] as const) {
      const saved = f.store.put(f.actor, randomUUID(), f.input);
      f.database.sqlite.prepare(`UPDATE cloud_api_configs SET ${column}=? WHERE id=?`).run(replacement, saved.id);
      assert.throws(() => f.store.resolve(f.actor, saved.profile_id, saved.revision), /unavailable/);
    }
  } finally { f.close(); }
});

test("missing master key, disabled configuration, revoked device and unsafe configuration fail closed", () => {
  const f = fixture();
  try {
    assert.equal(new CloudApiStore(f.database).status(f.actor).enabled, false);
    assert.throws(() => new CloudApiStore(f.database, "not-a-32-byte-master-key"), /encryption/);
    assert.throws(() => f.store.put(f.actor, randomUUID(), { ...f.input, base_url: "http://127.0.0.1" } as typeof f.input), /configuration/);
    assert.throws(() => f.store.put(f.actor, randomUUID(), { ...f.input, api_key: ["header", "\r\n", "injection"].join("") }), /configuration/);
    const saved = f.store.put(f.actor, randomUUID(), { ...f.input, enabled: false });
    assert.throws(() => f.store.resolve(f.actor, saved.profile_id, saved.revision), /unavailable/);
    f.database.revokeDevice(f.actor, f.actor.device_id);
    assert.throws(() => f.store.status(f.actor));
  } finally { f.close(); }
});

test("configuration storage is bounded and keys cascade on account deletion", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 8; i++) f.store.put(f.actor, randomUUID(), { ...f.input, label: `Model ${i}` });
    assert.throws(() => f.store.put(f.actor, randomUUID(), f.input), /limit/);
    f.database.deleteAccount(f.actor);
    assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_api_configs").get()!.count, 0);
  } finally { f.close(); }
});
