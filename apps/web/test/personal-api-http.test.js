import assert from "node:assert/strict";
import test from "node:test";
import { HttpCollaborationApi } from "../src/api.js";
const id = "10000000-0000-4000-8000-000000000001", revision = "20000000-0000-4000-8000-000000000001";
const configuration = { id, revision, profile_id: `api-${id}`, provider_id: "deepseek", label: "Fixture", model: "deepseek-chat", enabled: true, has_key: true, updated_at: "2026-10-12T00:00:00.000Z" };
test("private API CRUD uses strict metadata and an explicit revision body", async () => {
  const api = new HttpCollaborationApi(), calls = [];
  api.request = async (path, options) => { calls.push([path, options]); return options?.method === "PUT"
    ? { configuration } : options?.method === "DELETE" ? undefined : { enabled: true, providers: [], configurations: [configuration] }; };
  const status = await api.getCloudApi(); assert.deepEqual(status.configurations, [configuration]);
  const input = { expected_revision: revision, provider_id: "deepseek", label: "Fixture", model: "deepseek-chat", enabled: true };
  await api.putCloudApi(id, input); await api.deleteCloudApi(id, { expected_revision: revision });
  assert.deepEqual(calls.map(item => item[0]), ["/v1/cloud-api", `/v1/cloud-api/${id}`, `/v1/cloud-api/${id}`]);
  assert.equal(calls[1][1].method, "PUT"); assert.deepEqual(JSON.parse(calls[1][1].body), input);
  assert.equal(calls[2][1].method, "DELETE");
});
test("response validation cannot surface an accidentally returned key", async () => {
  const api = new HttpCollaborationApi();
  api.request = async () => ({ enabled: true, providers: [], configurations: [{ ...configuration, api_key: "fixture-k" }] });
  await assert.rejects(api.getCloudApi(), /^Error: Personal API response is invalid\. Refresh and try again\.$/);
});
test("requester-private selection is read from the exact session/request route", async () => {
  const api = new HttpCollaborationApi(); let target;
  api.request = async path => { target = path; return { profile_id: `api-${id}`, api_config_revision: revision }; };
  assert.deepEqual(await api.getHostedAgentSelection("session-fixture", "request-fixture"), { profile_id: `api-${id}`, api_config_revision: revision });
  assert.equal(target, "/v1/sessions/session-fixture/hosted-agent-requests/request-fixture/selection");
});

test("personal revision is transmitted with trial and summary writes, never inferred from the latest profile", async () => {
  const api = new HttpCollaborationApi(); const bodies = [];
  api.request = async (_path, options) => { bodies.push(JSON.parse(options.body)); return {}; };
  const input = { profileId: `api-${id}`, apiConfigRevision: revision, content: "fixture", idempotencyKey: "fixture-key" };
  await assert.rejects(api.appendHostedAgentRequest("s", input));
  await assert.rejects(api.createHistorySummary("s", { executionProfile: { harness: "opencode", cloudProfileId: input.profileId, apiConfigRevision: revision }, sourceEventIds: ["source"], idempotencyKey: "fixture-summary" }));
  assert.equal(bodies[0].api_config_revision, revision); assert.equal(bodies[1].api_config_revision, revision);
  assert.equal(Object.hasOwn(bodies[0], "api_key"), false);
});

test("a hosted retry sends the captured history revision, including zero, without changing ordinary writes", async () => {
  const api = new HttpCollaborationApi(), bodies = [];
  api.request = async (_path, options) => { bodies.push(JSON.parse(options.body)); return {}; };
  const input = { profileId: `api-${id}`, apiConfigRevision: revision, content: "fixture", idempotencyKey: "fixture-key" };
  for (const contentRevision of [0, 7]) await assert.rejects(api.appendHostedAgentRequest("s", { ...input, contentRevision }));
  await assert.rejects(api.appendHostedAgentRequest("s", input));
  assert.equal(bodies[0].content_revision, 0);
  assert.equal(bodies[1].content_revision, 7);
  assert.equal(Object.hasOwn(bodies[2], "content_revision"), false);
});

test("local retry pins history at the append envelope without exposing it as shared content", async () => {
  const api = new HttpCollaborationApi(), bodies = [];
  api.request = async (_path, options) => { bodies.push(JSON.parse(options.body)); throw Error("fixture capture finished"); };
  await assert.rejects(api.appendAgentRequest("s", { content: "fixture", idempotencyKey: "local-pin", contentRevision: 0 }));
  assert.equal(bodies[0].content_revision, 0);
  assert.equal(Object.hasOwn(bodies[0].payload, "content_revision"), false);
});
