import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_NATIVE_CREDENTIAL_KEY,
  DshNativeCredentialStore,
  beginDshNativePairing,
  createNativeProjectConfig,
  dshNpmLaunchCommand,
  normalizeDshServerUrl,
  pollDshNativePairing,
  publicPairingView,
  type DshNativeGrant,
} from "../src/native-connection.js";

const grant: DshNativeGrant = {
  schemaVersion: 1,
  serverUrl: "https://gatherthread.example",
  apiUrl: "https://gatherthread.example/v1",
  deviceId: "dsh_device-1",
  deviceName: "DeepSeek Harness · Mac",
  token: "gta_fixture-long-lived-secret",
};

function credentialFixture(initial?: unknown) {
  const records = new Map<string, unknown>();
  if (initial !== undefined) records.set(DSH_NATIVE_CREDENTIAL_KEY, initial);
  const calls = { read: 0, modify: 0, delete: 0 };
  const credentials = {
    async readRecord(key: string) {
      calls.read += 1;
      return records.get(key);
    },
    async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>) {
      calls.modify += 1;
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, structuredClone(next));
      return records.get(key);
    },
    async deleteRecord(key: string) {
      calls.delete += 1;
      records.delete(key);
    },
  };
  return { context: { credentials }, records, calls };
}

test("native DSH grant uses only the official opaque credential record", async () => {
  const fixture = credentialFixture();
  const store = new DshNativeCredentialStore(fixture.context);
  assert.equal(await store.load(), undefined);
  assert.deepEqual(await store.save(grant), grant);
  assert.deepEqual(await store.load(), grant);
  assert.equal(JSON.stringify(fixture.records.get(DSH_NATIVE_CREDENTIAL_KEY)).includes(grant.token), true);
  await store.clear();
  assert.equal(await store.load(), undefined);
  assert.deepEqual(fixture.calls, { read: 3, modify: 1, delete: 1 });

  const incompatible = new DshNativeCredentialStore(credentialFixture({ kind: "api-key", key: "private" }).context);
  await assert.rejects(incompatible.load(), /incompatible kind/);
});

test("native DSH grant parsing fails closed without echoing credential material", async () => {
  const secret = "gta_do-not-echo-this-secret";
  const malformed = credentialFixture({
    kind: "grant",
    payload: { ...grant, token: secret, unknown: "/private/path" },
  });
  const store = new DshNativeCredentialStore(malformed.context);
  await assert.rejects(store.load(), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message.includes(secret), false);
    assert.equal(message.includes("/private/path"), false);
    return /unsupported fields/.test(message);
  });
});

test("pairing uses a Host-only request and exposes only a short public view", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (String(input).endsWith("/dsh-pairings")) {
      return Response.json({ data: {
        pairing_id: "dshp_1",
        poll_token: "gtp_fixture-poll-secret",
        user_code: "ABCD-2345",
        verification_path: "/#dsh-pair=ABCD-2345",
        expires_at: "2026-09-06T01:05:00.000Z",
        interval_seconds: 2,
      } }, { status: 201 });
    }
    return Response.json({ data: {
      status: "paired",
      device_id: "dsh_device-1",
      token: "gta_fixture-long-lived-secret",
    } }, { status: 201 });
  }) as typeof fetch;

  const intent = await beginDshNativePairing({
    serverUrl: "https://gatherthread.example",
    deviceName: "DSH Mac",
    fetch: fakeFetch,
  });
  assert.deepEqual(publicPairingView(intent), {
    schemaVersion: 1,
    status: "pending",
    userCode: "ABCD-2345",
    verificationUrl: "https://gatherthread.example/#dsh-pair=ABCD-2345",
    expiresAt: "2026-09-06T01:05:00.000Z",
    intervalSeconds: 2,
  });
  assert.equal(JSON.stringify(publicPairingView(intent)).includes("gtp_"), false);
  assert.equal(new Headers(calls[0]?.init.headers).has("authorization"), false);
  assert.equal(new Headers(calls[0]?.init.headers).has("origin"), false);
  assert.equal(String(calls[0]?.init.body).includes("gta_"), false);

  const result = await pollDshNativePairing(intent, { fetch: fakeFetch });
  assert.deepEqual(result, {
    status: "paired",
    deviceId: "dsh_device-1",
    token: "gta_fixture-long-lived-secret",
  });
  assert.equal(
    new Headers(calls[1]?.init.headers).get("authorization"),
    "DSH-Pairing gtp_fixture-poll-secret",
  );
  assert.equal(new Headers(calls[1]?.init.headers).has("origin"), false);
});

test("server URL, native state, and mainstream launch command are bounded and deterministic", () => {
  assert.deepEqual(normalizeDshServerUrl("https://gatherthread.example/v1/"), {
    serverUrl: "https://gatherthread.example",
    apiUrl: "https://gatherthread.example/v1",
  });
  assert.deepEqual(normalizeDshServerUrl("http://127.0.0.2:4310"), {
    serverUrl: "http://127.0.0.2:4310",
    apiUrl: "http://127.0.0.2:4310/v1",
  });
  for (const value of [
    "http://192.168.1.20:4310",
    "https://user:pass@gatherthread.example",
    "https://gatherthread.example/private",
  ]) {
    assert.throws(() => normalizeDshServerUrl(value));
  }
  const configured = createNativeProjectConfig({
    grant,
    binding: {
      projectId: "project-1",
      projectName: "Project One",
      provider: "custom-provider",
      model: "CaseSensitiveModel",
    },
    workspacePath: "/readonly/workspace",
    dshHome: "/private/dsh-home",
  });
  assert.equal(configured.credentialReference.kind, "dsh-grant");
  assert.equal(configured.model, "CaseSensitiveModel");
  assert.match(configured.stateRoot, /^\/private\/dsh-home\/gatherthread\/state\/[a-f0-9]{32}$/u);
  assert.equal(configured.stateRoot.includes(grant.token), false);
  assert.equal(dshNpmLaunchCommand(), "npx @deepseek-ai/dsh web");
});
