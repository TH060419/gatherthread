import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedAgentStatusSchema } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent } from "../src/hosted-agent.js";
import { parseHostedEndpoints, siliconFlowFreePreset } from "../src/hosted-agent-pool.js";
import { ApiError } from "../src/errors.js";

const limits = { userDailyRuns: null, globalDailyRuns: null, maxConcurrent: 2 };
const endpoints = parseHostedEndpoints(siliconFlowFreePreset(2, true), { GATHERTHREAD_SILICONFLOW_API_KEY: "fixture-only-key" });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gt-user-rate-"));
  const path = join(directory, "db");
  let now = Date.parse("2026-10-03T00:00:00Z");
  const options = { authTokenPepper: "hosted-rate-test-pepper", clock: () => new Date(now) };
  const db = new CollaborationDatabase(path, options);
  const service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
  const create = (id: string, owner = actor) => service.createSession(owner,
    { session_id: id, mode: "solo", title: id, idempotency_key: `create-${id}` }).session;
  const agent = new HostedAgent(service, new CodeRepository(db, join(directory, "code")), {
    endpoints, ...limits, image: `sha256:${"a".repeat(64)}`, runContainer: async () => "unused",
  });
  return { directory, path, options, db, actor, create, agent, advance: (ms = 30_000) => { now += ms; } };
}

const input = (key: string, profile = endpoints[0]!.profileId) => ({ profile_id: profile, include_code: false,
  content: "Inspect code and test", idempotency_key: key });
const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test("free tasks share one user slot across models, devices and projects; other users can run concurrently", () => {
  const f = fixture();
  try {
    const first = f.create("first"), second = f.create("second");
    assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, first.id, input("rolled-back"), endpoints.slice(0, 1), limits,
      () => { throw new Error("fixture persistence failure"); }), /fixture persistence failure/);
    assert.equal(f.db.hostedAgentRateUsage(f.actor).retry_after_seconds, 0);
    assert.equal(f.db.hostedActiveRuns(), 0);
    const otherDevice = f.db.createDevice(f.actor.user_id, "Phone").device_id;
    const phone = { ...f.actor, device_id: otherDevice };
    const run = f.db.reserveHostedAgentRequest(f.actor, first.id, input("one"), endpoints.slice(0, 1), limits);
    assert.equal(f.db.reserveHostedAgentRequest(f.actor, first.id, input("one"), endpoints.slice(0, 1), limits).created, false);
    assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, first.id, { ...input("one"), content: "Changed" },
      endpoints.slice(0, 1), limits), errorCode("idempotency_conflict"));
    f.advance();
    assert.throws(() => f.db.reserveHostedAgentRequest(phone, second.id, input("two", endpoints[1]!.profileId),
      endpoints.slice(1), limits), errorCode("hosted_user_busy"));
    const other = f.db.createIdentity({ display_name: "Other", device_name: "Laptop", can_create_projects: true }).actor;
    const otherSession = f.create("other", other);
    const parallel = f.db.reserveHostedAgentRequest(other, otherSession.id, input("other", endpoints[1]!.profileId), endpoints.slice(1), limits);
    assert.equal(f.db.hostedActiveRuns(), 2);
    const status = HostedAgentStatusSchema.parse(f.agent.status(f.actor));
    assert.ok(status.enabled);
    assert.equal(status.user_limit_runs, null); assert.equal(status.global_limit_runs, null);
    assert.equal(status.rate_limits?.user_active_runs, 1);
    assert.ok(status.profiles.every((profile) => profile.status === "user_busy" && !profile.available));
    assert.doesNotMatch(JSON.stringify(status), /fixture-only-key|siliconflow-primary|baseUrl|apiToken/);
    f.db.finishHostedAgentRequest(parallel.event.id, {});
    f.db.finishHostedAgentRequest(run.event.id, { content: "done" });
    assert.equal(f.db.reserveHostedAgentRequest(phone, second.id, input("two", endpoints[1]!.profileId), endpoints.slice(1), limits).created, true);
  } finally { f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("cooldown survives failures and restart, rejected requests do not consume a slot, and free tasks have no daily quota", () => {
  const f = fixture();
  let db = f.db;
  try {
    const session = f.create("rate-window");
    const run = db.reserveHostedAgentRequest(f.actor, session.id, input("start"), endpoints.slice(0, 1), limits);
    db.finishHostedAgentRequest(run.event.id, {});
    const eventCount = () => db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=?").get(session.id)!.n;
    const before = eventCount();
    assert.throws(() => db.reserveHostedAgentRequest(f.actor, session.id, input("retry"), endpoints.slice(0, 1), limits),
      (error: unknown) => {
        assert.ok(error instanceof ApiError); assert.equal(error.code, "hosted_user_rate_limit");
        assert.deepEqual(error.details, { retry_after_seconds: 30 }); return true;
      });
    assert.equal(eventCount(), before);
    assert.equal(db.hostedActiveRuns(), 0);
    assert.ok(f.agent.status(f.actor).profiles.every((profile) => profile.status === "rate_limit"));
    db.close(); db = new CollaborationDatabase(f.path, f.options);
    f.advance(29_999);
    assert.equal(db.hostedAgentRateUsage(f.actor).retry_after_seconds, 1);
    assert.throws(() => db.reserveHostedAgentRequest(f.actor, session.id, input("retry"), endpoints.slice(0, 1), limits), errorCode("hosted_user_rate_limit"));
    f.advance(1);
    for (let n = 0; n < 8; n++) {
      const accepted = db.reserveHostedAgentRequest(f.actor, session.id, input(`retry-${n}`), endpoints.slice(0, 1), limits);
      db.finishHostedAgentRequest(accepted.event.id, { content: "done" }); f.advance();
    }
    assert.equal(db.hostedAgentUsage(f.actor, null, null).user_used_runs, 9);
    db.setHostedAgentUserLimit(f.actor.user_id, 0);
    assert.throws(() => db.reserveHostedAgentRequest(f.actor, session.id, input("blocked"), endpoints.slice(0, 1), limits), errorCode("hosted_user_quota"));
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("deleting a conversation cannot release a running container slot or reset cooldown; startup recovers orphan slots", () => {
  const f = fixture();
  let db = f.db;
  try {
    const first = f.create("deleted"), second = f.create("surviving");
    const run = db.reserveHostedAgentRequest(f.actor, first.id, input("deleted-run"), endpoints.slice(0, 1), limits);
    db.deleteSession(f.actor, first.id); f.advance();
    assert.equal(db.hostedAgentUsage(f.actor, 1, 1).user_used_runs, 1);
    assert.equal(db.hostedEndpointUsage(endpoints[0]!).daily, 1);
    assert.equal(db.hostedActiveRuns(), 1);
    assert.equal(db.hostedEndpointUsage(endpoints[0]!).active, 1);
    assert.throws(() => db.reserveHostedAgentRequest(f.actor, second.id, input("still-busy"), endpoints.slice(0, 1), limits), errorCode("hosted_user_busy"));
    assert.equal(db.finishHostedAgentRequest(run.event.id, {}), undefined);
    assert.equal(db.hostedActiveRuns(), 0);
    const next = db.reserveHostedAgentRequest(f.actor, second.id, input("next"), endpoints.slice(0, 1), limits);
    db.deleteSession(f.actor, second.id);
    assert.equal(db.hostedAgentRateUsage(f.actor).retry_after_seconds, 30);
    db.close(); db = new CollaborationDatabase(f.path, f.options);
    assert.equal(db.hostedActiveRuns(), 1);
    db.failInterruptedHostedAgentJobs();
    assert.equal(db.hostedActiveRuns(), 0);
    assert.equal(db.hostedAgentRateUsage(f.actor).retry_after_seconds, 30);
    assert.equal(db.finishHostedAgentRequest(next.event.id, {}), undefined);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("unlimited endpoints cannot point at paid models or another host", () => {
  const raw = JSON.parse(siliconFlowFreePreset(2, true));
  for (const override of [{ model: "Qwen/Qwen3.5-9B" }, { base_url: "https://other.example/v1" },
    { free_plan_confirmed: false }, { daily_runs: 0 }]) {
    assert.throws(() => parseHostedEndpoints(JSON.stringify([{ ...raw[0], ...override }]), { GATHERTHREAD_SILICONFLOW_API_KEY: "fixture-key" }));
  }
});
