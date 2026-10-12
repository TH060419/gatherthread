import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { CloudApiConfigurationSchema, CloudApiStatusSchema, HostedAgentSelectionSchema } from "@gatherthread/protocol";
import { browserSessionFixture, identityFixture } from "./auth-fixtures.js";
import { startCollaborationServer } from "../src/server.js";
import { CloudApiStore } from "../src/cloud-api.js";

async function fixture() {
  const origin = "http://127.0.0.1:18787", key = randomBytes(32).toString("base64");
  const server = await startCollaborationServer({ databasePath: ":memory:", allowedOrigins: [origin],
    authTokenPepper: "cloud-api-http-fixture-pepper-32chars", hostedAgent: {
      personalApiEncryptionKey: key, image: `sha256:${"b".repeat(64)}`, endpoints: [{ id: "free", profileId: "free", provider: "deepseek",
        label: "Free fixture", model: "deepseek-chat", apiToken: "operator-fixture-secret", baseUrl: "https://api.deepseek.com/v1",
        quotaGroup: "operator", dailyRuns: 4, maxConcurrent: 1 }], userDailyRuns: 1, globalDailyRuns: 4,
      maxConcurrent: 1, runContainer: async () => JSON.stringify({ answer: "Fixture", files: [] }),
    } }, 0);
  const owner = identityFixture(server, {}), other = identityFixture(server, {});
  const cookie = (token: string) => browserSessionFixture(server, { token }).headers.get("set-cookie")!.split(";")[0]!;
  const headers = { cookie: cookie(owner.body.data.token), origin, "content-type": "application/json" };
  const otherHeaders = { ...headers, cookie: cookie(other.body.data.token) };
  const base = server.origin, id = randomUUID(), apiKey = ["private", "provider", "fixture", "key"].join("-");
  const input = { expected_revision: null, provider_id: "anthropic", model: "claude-fixture", label: "Personal fixture", enabled: true, api_key: apiKey };
  const store = new CloudApiStore(server.database, key);
  return { ...server, origin, owner: owner.body.data, other: other.body.data, headers, otherHeaders, base, id, apiKey, input, store };
}

test("personal API HTTP is browser-only, origin-fenced, strict and never returns credentials", async () => {
  const f = await fixture();
  try {
    const anonymous = await fetch(`${f.base}/v1/cloud-api`); assert.equal(anonymous.status, 401);
    const bearer = await fetch(`${f.base}/v1/cloud-api`, { headers: { authorization: `Bearer ${f.owner.token}` } }); assert.equal(bearer.status, 403);
    const noOrigin = await fetch(`${f.base}/v1/cloud-api/${f.id}`, { method: "PUT", headers: { cookie: f.headers.cookie,
      "content-type": "application/json" }, body: JSON.stringify(f.input) }); assert.equal(noOrigin.status, 403);
    const put = await fetch(`${f.base}/v1/cloud-api/${f.id}`, { method: "PUT", headers: f.headers, body: JSON.stringify(f.input) });
    assert.equal(put.status, 200); const savedBody = await put.json() as { data: { configuration: unknown } };
    const saved = CloudApiConfigurationSchema.parse(savedBody.data.configuration);
    assert.doesNotMatch(JSON.stringify(savedBody), /private-provider-fixture-key|ciphertext|api_key/);
    const status = await fetch(`${f.base}/v1/cloud-api`, { headers: f.headers }); assert.equal(status.status, 200);
    const listed = CloudApiStatusSchema.parse((await status.json() as { data: unknown }).data); assert.equal(listed.configurations[0]?.revision, saved.revision);
    const foreign = await fetch(`${f.base}/v1/cloud-api`, { headers: f.otherHeaders }); assert.deepEqual((await foreign.json() as { data: { configurations: unknown[] } }).data.configurations, []);
    const foreignPut = await fetch(`${f.base}/v1/cloud-api/${f.id}`, { method: "PUT", headers: f.otherHeaders, body: JSON.stringify(f.input) });
    assert.equal(foreignPut.status, 400);
    for (const invalid of [{ ...f.input, base_url: "http://127.0.0.1:1" }, { ...f.input, api_key: "bad secret\nvalue" },
      { ...f.input, headers: { Authorization: f.apiKey } }]) {
      const response = await fetch(`${f.base}/v1/cloud-api/${randomUUID()}`, { method: "PUT", headers: f.headers, body: JSON.stringify(invalid) });
      assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /bad secret|private-provider-fixture-key/);
    }
    const huge = await fetch(`${f.base}/v1/cloud-api/${randomUUID()}`, { method: "PUT", headers: f.headers,
      body: JSON.stringify({ ...f.input, api_key: "x".repeat(10_000) }) }); assert.equal(huge.status, 413);
    const stale = await fetch(`${f.base}/v1/cloud-api/${f.id}`, { method: "DELETE", headers: f.headers,
      body: JSON.stringify({ expected_revision: randomUUID() }) }); assert.equal(stale.status, 409);
    const removed = await fetch(`${f.base}/v1/cloud-api/${f.id}`, { method: "DELETE", headers: f.headers,
      body: JSON.stringify({ expected_revision: saved.revision }) }); assert.equal(removed.status, 204);
  } finally { await f.close(); }
});

test("request selection is requester-only and immutable across updates, disable, deletion and service profiles", async () => {
  const f = await fixture();
  try {
    const session = f.service.createSession(f.owner.actor, { mode: "multi", title: "Fixture", idempotency_key: "http-selection-session" }).session;
    f.service.setMembership(f.owner.actor, session.id, f.other.actor.user_id, "participant", "http-selection-other");
    const saved = f.store.put(f.owner.actor, f.id, f.input as never), endpoint = f.store.resolve(f.owner.actor, saved.profile_id, saved.revision);
    const limits = { userDailyRuns: 100, globalDailyRuns: 1000, maxConcurrent: 1, billingSource: "personal" as const };
    const request = f.database.reserveHostedAgentRequest(f.owner.actor, session.id,
      { profile_id: saved.profile_id, api_config_revision: saved.revision, content: "Fixture", include_code: false, idempotency_key: "http-personal-request" }, [endpoint], limits);
    const route = `${f.base}/v1/sessions/${session.id}/hosted-agent-requests/${request.event.id}/selection`;
    const response = await fetch(route, { headers: f.headers }); assert.equal(response.status, 200);
    assert.deepEqual(HostedAgentSelectionSchema.parse((await response.json() as { data: unknown }).data), { profile_id: saved.profile_id, api_config_revision: saved.revision });
    assert.doesNotMatch(JSON.stringify(f.service.replay(f.owner.actor, session.id, 0, 100)), new RegExp(saved.revision));
    assert.equal((await fetch(route, { headers: f.otherHeaders })).status, 404);
    const otherSession = f.service.createSession(f.owner.actor, { mode: "multi", title: "Other", idempotency_key: "http-other-session" }).session;
    assert.equal((await fetch(route.replace(session.id, otherSession.id), { headers: f.headers })).status, 404);
    const updated = f.store.put(f.owner.actor, f.id, { ...f.input, expected_revision: saved.revision, label: "Changed" } as never);
    assert.equal((await fetch(route, { headers: f.headers })).status, 409);
    f.store.remove(f.owner.actor, f.id, updated.revision);
    assert.equal((await fetch(route, { headers: f.headers })).status, 409);
    f.database.sqlite.prepare("DELETE FROM hosted_agent_active_runs").run();
    f.database.sqlite.prepare("DELETE FROM hosted_agent_user_activity").run();
    const funded = f.database.reserveHostedAgentRequest(f.owner.actor, session.id, { profile_id: "free", content: "Fixture", include_code: false,
      idempotency_key: "http-free-request" }, [{ id: "free", profileId: "free", provider: "deepseek", model: "deepseek-chat", quotaGroup: "operator",
        dailyRuns: 4, maxConcurrent: 1 }], { userDailyRuns: 1, globalDailyRuns: 4, maxConcurrent: 1 });
    const free = await fetch(route.replace(request.event.id, funded.event.id), { headers: f.headers }); assert.equal(free.status, 200);
    assert.deepEqual((await free.json() as { data: unknown }).data, { profile_id: "free" });
    f.database.revokeDevice(f.owner.actor, f.owner.actor.device_id);
    assert.equal((await fetch(route, { headers: f.headers })).status, 401);
  } finally { await f.close(); }
});
