import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CloudApiPutInputSchema, HostedAgentRequestInputSchema, HostedHistorySummaryInputSchema, HostedGithubTaskInputSchema, HostedAgentSelectionSchema } from "../src/index.js";

test("requester-private selection contract is strict and cannot carry credentials or silently drop revisions", () => {
  const id = randomUUID(), revision = randomUUID();
  assert.deepEqual(HostedAgentSelectionSchema.parse({ profile_id: `api-${id}`, api_config_revision: revision }),
    { profile_id: `api-${id}`, api_config_revision: revision });
  for (const invalid of [{ profile_id: `api-${id}` }, { profile_id: "free", api_config_revision: revision },
    { profile_id: "free", api_key: "secret" }, { profile_id: `api-${id}`, api_config_revision: "stale" }]) {
    assert.equal(HostedAgentSelectionSchema.safeParse(invalid).success, false);
  }
});

test("personal API wire contract rejects URLs, headers, key whitespace and unpinned profile selection", () => {
  const input = { profile_id: `api-${randomUUID()}`, content: "hello", idempotency_key: "fixture-request" };
  assert.equal(HostedAgentRequestInputSchema.safeParse(input).success, false);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, api_config_revision: randomUUID() }).success, true);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, profile_id: "default", api_config_revision: randomUUID() }).success, false);
  assert.equal(HostedHistorySummaryInputSchema.safeParse({ profile_id: input.profile_id, source_event_ids: ["message"], idempotency_key: "fixture-summary" }).success, false);
  assert.equal(HostedGithubTaskInputSchema.safeParse(input).success, false);
  const config = { expected_revision: null, provider_id: "openai", label: "My API", model: "fixture-chat", enabled: true, api_key: ["synthetic", "provider", "key"].join("-") };
  for (const field of [{ base_url: "https://127.0.0.1" }, { headers: { Authorization: "synthetic" } }, { api_key: ["key", "\n", "with-newline"].join("") }]) {
    assert.equal(CloudApiPutInputSchema.safeParse({ ...config, ...field }).success, false);
  }
});

test("automatic hosted retries pin an optional exact content revision independently of the personal API revision", () => {
  const base = { profile_id: "default", content: "Explicit request", idempotency_key: "history-retry-contract" };
  for (const schema of [HostedAgentRequestInputSchema, HostedGithubTaskInputSchema]) {
    assert.equal(schema.safeParse(base).success, true, "ordinary older clients remain compatible");
    for (const content_revision of [0, 1, Number.MAX_SAFE_INTEGER]) {
      assert.equal((schema.parse({ ...base, content_revision }) as { content_revision?: number }).content_revision, content_revision);
      assert.equal(schema.safeParse({ ...base, profile_id: `api-${randomUUID()}`, api_config_revision: randomUUID(), content_revision }).success, true);
    }
    for (const content_revision of [-1, 0.5, "0", null, Infinity]) {
      assert.equal(schema.safeParse({ ...base, content_revision }).success, false);
    }
    assert.equal(schema.safeParse({ ...base, profile_id: `api-${randomUUID()}`, content_revision: 0 }).success, false);
  }
});
