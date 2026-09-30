import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationDatabase } from "../src/database.js";
import { parseHostedEndpoints, HOSTED_MODEL } from "../src/hosted-agent-pool.js";
import { HostedAgent } from "../src/hosted-agent.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgentStatusSchema } from "@gatherthread/protocol";

const config = { id: "a", profile_id: "coding", label: "Coding", provider: "deepseek", model: "deepseek-chat",
  token_env: "PROVIDER_A", quota_group: "account-a", daily_runs: 4, max_concurrent: 1 };
const env = { PROVIDER_A: "private-credential-a", PROVIDER_B: "private-credential-b" };
const parse = (items: unknown[]) => parseHostedEndpoints(JSON.stringify(items), env);

test("operator pool validates exact model profiles, credentials, shared account quotas and HTTPS", () => {
  const pool = parse([config, { ...config, id: "b", token_env: "PROVIDER_B", quota_group: "account-b" }]);
  assert.equal(pool.length, 2);
  assert.equal(pool[1]!.baseUrl, "https://api.deepseek.com/v1");
  assert.throws(() => parse([config, { ...config, id: "b", model: "other" }]));
  assert.throws(() => parse([config, { ...config, id: "b", daily_runs: 9 }]));
  assert.throws(() => parse([config, { ...config, id: "b", quota_group: "inflated" }]));
  assert.throws(() => parse([{ ...config, token_env: "MISSING" }]));
  assert.throws(() => parse([{ ...config, token: "inline-secret" }]));
  for (const base_url of ["http://api.example.com/v1", "https://user:pass@api.example.com", "https://api.example.com?key=x"]) {
    assert.throws(() => parse([{ ...config, provider: "openai-compatible", base_url }]));
  }
  const cf = { ...config, provider: "cloudflare-workers-ai", model: HOSTED_MODEL, quota_group: undefined,
    account_id: "a".repeat(32), free_plan_confirmed: true };
  const shared = parse([cf, { ...cf, id: "b", token_env: "PROVIDER_B" }]);
  assert.equal(shared[0]!.quotaGroup, shared[1]!.quotaGroup);
  assert.throws(() => parse([{ ...cf, daily_runs: 5 }]));
  assert.throws(() => parse([{ ...cf, free_plan_confirmed: false }]));
});

test("parallel reservations allocate separate accounts; replay and failures never multiply budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-pool-"));
  const db = new CollaborationDatabase(join(directory, "db.sqlite"), { authTokenPepper: "pool-test-auth-token-pepper" });
  try {
    const owner = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
    const second = db.createIdentity({ display_name: "Second", device_name: "Laptop", can_create_projects: true }).actor;
    const service = new CollaborationService(db);
    const create = (actor: typeof owner, id: string) => service.createSession(actor, {
      session_id: id, mode: "solo", title: id, idempotency_key: `create-${id}` }).session;
    const one = create(owner, "pool-session-one"), two = create(second, "pool-session-two");
    const endpoints = parse([config, { ...config, id: "b", token_env: "PROVIDER_B", quota_group: "account-b" }]);
    const limits = { userDailyRuns: 5, globalDailyRuns: 8, maxConcurrent: 2 };
    const input = { profile_id: "coding", include_code: false, content: "write a test", idempotency_key: "request-one" };
    const a = db.reserveHostedAgentRequest(owner, one.id, input, endpoints, limits);
    const b = db.reserveHostedAgentRequest(second, two.id, { ...input, idempotency_key: "request-two" }, endpoints, limits);
    assert.equal(a.endpointId, "a"); assert.equal(b.endpointId, "b");
    assert.equal(db.reserveHostedAgentRequest(owner, one.id, input, endpoints, limits).created, false);
    assert.throws(() => db.reserveHostedAgentRequest(owner, one.id, { ...input, content: "changed" }, endpoints, limits));
    assert.throws(() => db.reserveHostedAgentRequest(owner, one.id, { ...input, idempotency_key: "request-three" }, endpoints, limits), /busy/);
    const agent = new HostedAgent(service, new CodeRepository(db, join(directory, "code")), {
      endpoints, ...limits, image: `example/hosted@sha256:${"a".repeat(64)}`, runContainer: async () => "unused" });
    const status = HostedAgentStatusSchema.parse(agent.status(owner));
    assert.equal(status.enabled && status.profiles[0]!.available, false);
    assert.doesNotMatch(JSON.stringify(status), /private-credential|account-a|apiToken|quotaGroup|baseUrl/);
    db.finishHostedAgentRequest(a.event.id, {});
    assert.equal(db.hostedEndpointUsage(endpoints[0]!).active, 0);
    assert.equal(db.hostedEndpointUsage(endpoints[0]!).daily, 1);
    assert.equal(db.hostedAgentUsage(owner, 5, 8).user_used_runs, 1);
    assert.equal(db.reserveHostedAgentRequest(owner, one.id, { ...input, idempotency_key: "request-three" }, endpoints, limits).endpointId, "a");
    assert.throws(() => db.reserveHostedAgentRequest(owner, one.id, { ...input, profile_id: "other" }, endpoints, limits), /available/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("keys of one account share limits and never borrow another model's account", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-pool-shared-"));
  const db = new CollaborationDatabase(join(directory, "db.sqlite"), { authTokenPepper: "pool-test-auth-token-pepper" });
  try {
    const owner = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
    const service = new CollaborationService(db);
    const session = service.createSession(owner, { session_id: "pool-shared", mode: "solo", title: "Pool", idempotency_key: "create-pool-shared" }).session;
    const endpoints = parse([{ ...config, daily_runs: 1 }, { ...config, id: "b", token_env: "PROVIDER_B", daily_runs: 1 }]);
    const limits = { userDailyRuns: 5, globalDailyRuns: 8, maxConcurrent: 8 };
    const input = { profile_id: "coding", include_code: false, content: "test", idempotency_key: "shared-one" };
    const first = db.reserveHostedAgentRequest(owner, session.id, input, endpoints, limits);
    assert.throws(() => db.reserveHostedAgentRequest(owner, session.id, { ...input, idempotency_key: "shared-two" }, endpoints, limits), /capacity/);
    db.finishHostedAgentRequest(first.event.id, { content: "done" });
    assert.throws(() => db.reserveHostedAgentRequest(owner, session.id, { ...input, idempotency_key: "shared-two" }, endpoints, limits), /capacity/);
    assert.equal(db.hostedAgentUsage(owner, 5, 8).user_used_runs, 1);
    db.setHostedAgentUserLimit(owner.user_id, 0);
    assert.throws(() => db.reserveHostedAgentRequest(owner, session.id, { ...input, idempotency_key: "shared-two" }, endpoints, limits), /allowance/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});


test("legacy preview migration retains reservations and user limits across repeated opens", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-pool-migration-"));
  const path = join(directory, "db.sqlite");
  const options = { authTokenPepper: "pool-test-auth-token-pepper" };
  let db = new CollaborationDatabase(path, options);
  try {
    const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
    const service = new CollaborationService(db);
    const session = service.createSession(actor, { session_id: "legacy-session", title: "Old", mode: "solo", idempotency_key: "create-legacy-session" }).session;
    const endpoints = parse([config]);
    const run = db.reserveHostedAgentRequest(actor, session.id, { profile_id: "coding", content: "old request", include_code: false,
      idempotency_key: "legacy-request" }, endpoints, { userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1 });
    db.close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO hosted_agent_limits SELECT id, 4000 FROM users;
      INSERT INTO hosted_agent_jobs(request_event_id,session_id,user_id,device_id,utc_day,reserved_neurons,status,created_at)
        SELECT request_event_id,session_id,user_id,device_id,utc_day,2000,status,created_at FROM hosted_agent_runs;
      DROP TABLE hosted_agent_runs; DROP TABLE hosted_agent_run_limits;`);
    raw.close();
    db = new CollaborationDatabase(path, options);
    assert.equal(db.hostedAgentUsage(actor, 1, 4).user_limit_runs, 2);
    assert.equal(db.hostedAgentUsage(actor, 1, 4).user_used_runs, 1);
    assert.equal(db.hostedEndpointUsage(endpoints[0]!).daily, 1);
    assert.equal(db.failInterruptedHostedAgentJobs().length, 1);
    assert.equal(db.finishHostedAgentRequest(run.event.id, {}), undefined);
    db.close(); db = new CollaborationDatabase(path, options);
    assert.equal(db.hostedAgentUsage(actor, 1, 4).user_used_runs, 1);
    assert.equal(db.hostedActiveRuns(), 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
