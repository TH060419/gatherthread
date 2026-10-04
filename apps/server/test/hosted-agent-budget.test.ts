import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { parseHostedEndpoints, siliconFlowFreePreset } from "../src/hosted-agent-pool.js";
import { ApiError } from "../src/errors.js";

const endpoints = parseHostedEndpoints(siliconFlowFreePreset(2, true), { GATHERTHREAD_SILICONFLOW_API_KEY: "fixture-only" });
const limits = { userDailyRuns: null, globalDailyRuns: null, maxConcurrent: 2 };
const input = (key: string, profile = endpoints[0]!.profileId) => ({ profile_id: profile, include_code: false,
  content: "Inspect and test ordinary source", idempotency_key: key });
const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gt-daily-budget-"));
  const path = join(directory, "db");
  let now = Date.parse("2026-10-03T00:00:00Z");
  const options = { authTokenPepper: "hosted-budget-fixture-pepper", clock: () => new Date(now) };
  const db = new CollaborationDatabase(path, options);
  const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
  const create = (database: CollaborationDatabase, id: string, owner = actor) => new CollaborationService(database).createSession(owner,
    { session_id: id, mode: "solo", title: id, idempotency_key: `create-${id}` }).session;
  return { directory, path, options, db, actor, create, advance: (ms = 30_000) => { now += ms; } };
}

for (const deletion of ["session", "project"] as const) {
  for (const scope of ["user", "global", "account"] as const) {
    test(`${scope} daily budget survives ${deletion} deletion for completed and failed tasks and exact retries`, () => {
      const f = fixture();
      let db = f.db;
      try {
        const allocation = endpoints.map((e) => ({ ...e, dailyRuns: scope === "account" ? 2 : null }));
        const finite = { ...limits, globalDailyRuns: scope === "global" ? 2 : null };
        if (scope === "user") db.setHostedAgentUserLimit(f.actor.user_id, 2);
        const sessions = [f.create(db, "completed"), f.create(db, "failed")];
        for (const [n, session] of sessions.entries()) {
          const request = input(`budget-${n}`, allocation[n]!.profileId);
          const run = db.reserveHostedAgentRequest(f.actor, session.id, request, [allocation[n]!], finite);
          assert.equal(db.reserveHostedAgentRequest(f.actor, session.id, request, [allocation[n]!], finite).created, false);
          db.finishHostedAgentRequest(run.event.id, n === 0 ? { content: "Done" } : {});
          assert.equal(db.reserveHostedAgentRequest(f.actor, session.id, request, [allocation[n]!], finite).created, false);
          assert.throws(() => db.reserveHostedAgentRequest(f.actor, session.id, { ...request, content: "Changed" },
            [allocation[n]!], finite), errorCode("idempotency_conflict"));
          f.advance();
        }
        for (const session of sessions) {
          if (deletion === "session") db.deleteSession(f.actor, session.id);
          else db.deleteProject(f.actor, session.project_id);
        }
        assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_agent_runs").get()!.n, 0);
        assert.equal(db.hostedAgentUsage(f.actor, null, finite.globalDailyRuns).user_used_runs, 2);
        assert.equal(db.hostedAgentUsage(f.actor, null, finite.globalDailyRuns).global_used_runs, 2);
        assert.equal(db.hostedEndpointUsage(allocation[1]!).daily, 2);
        // Restarting after deletion must retain the charge even though no job/event can be backfilled.
        db.close(); db = new CollaborationDatabase(f.path, f.options); db.failInterruptedHostedAgentJobs();
        const other = scope === "user" ? f.actor : db.createIdentity({ display_name: "Other", device_name: "Phone", can_create_projects: true }).actor;
        const next = f.create(db, "next", other);
        assert.throws(() => db.reserveHostedAgentRequest(other, next.id, input("blocked-next", allocation[1]!.profileId),
          [allocation[1]!], finite), errorCode(scope === "user" ? "hosted_user_quota" : scope === "global" ? "hosted_global_budget" : "hosted_profile_busy"));
        assert.equal(db.hostedActiveRuns(), 0);
        assert.equal(db.hostedAgentUsage(f.actor, null, null).global_used_runs, 2);
      } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
    });
  }
}

test("daily usage backfills legacy and current jobs once, survives recovery, and expires on the next UTC day", () => {
  const f = fixture();
  let db = f.db;
  try {
    const session = f.create(db, "migration");
    const requests = ["completed", "failed", "legacy-running"].map((key) => input(key));
    const ids: string[] = [];
    for (const [n, request] of requests.entries()) {
      const run = db.reserveHostedAgentRequest(f.actor, session.id, request, endpoints.slice(0, 1), limits);
      ids.push(run.event.id);
      if (n < 2) db.finishHostedAgentRequest(run.event.id, n === 0 ? { content: "Done" } : {});
      f.advance();
    }
    // Reconstruct both earlier schema generations without a daily ledger.
    db.sqlite.exec("DROP TABLE hosted_agent_daily_usage");
    db.sqlite.prepare("DELETE FROM hosted_agent_runs WHERE request_event_id=?").run(ids[2]!);
    db.sqlite.prepare("DELETE FROM hosted_agent_active_runs WHERE request_event_id=?").run(ids[2]!);
    db.sqlite.prepare(`INSERT INTO hosted_agent_jobs(request_event_id,session_id,user_id,device_id,utc_day,
      reserved_neurons,status,created_at) VALUES(?,?,?,?,?,2000,'running',?)`)
      .run(ids[2]!, session.id, f.actor.user_id, f.actor.device_id, "2026-10-03", "2026-10-03T00:01:00.000Z");
    db.close(); db = new CollaborationDatabase(f.path, f.options);
    assert.equal(db.hostedAgentUsage(f.actor, 3, 3).user_used_runs, 3);
    assert.equal(db.hostedEndpointUsage(endpoints[1]!).daily, 3);
    db.failInterruptedHostedAgentJobs();
    assert.equal(db.hostedActiveRuns(), 0);
    assert.equal(db.hostedAgentUsage(f.actor, 3, 3).global_used_runs, 3);
    db.close(); db = new CollaborationDatabase(f.path, f.options);
    assert.equal(db.hostedAgentUsage(f.actor, 3, 3).global_used_runs, 3);
    assert.deepEqual(db.sqlite.prepare("PRAGMA table_info(hosted_agent_daily_usage)").all().map((r) => r.name),
      ["request_event_id", "user_id", "utc_day", "quota_group"]);
    assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_list(hosted_agent_daily_usage)").all(), []);
    db.deleteProject(f.actor, session.project_id);
    db.close(); db = new CollaborationDatabase(f.path, f.options);
    assert.equal(db.hostedAgentUsage(f.actor, 3, 3).global_used_runs, 3);
    f.advance(86_400_000);
    const next = f.create(db, "new-day");
    assert.equal(db.hostedAgentUsage(f.actor, 3, 3).user_used_runs, 0);
    const run = db.reserveHostedAgentRequest(f.actor, next.id, input("next-day"), endpoints.slice(0, 1), { ...limits, userDailyRuns: 3, globalDailyRuns: 3 });
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_agent_daily_usage").get()!.n, 1);
    db.finishHostedAgentRequest(run.event.id, {});
    db.close(); db = new CollaborationDatabase(f.path, f.options);
    assert.equal(db.hostedAgentUsage(f.actor, 3, 3).user_used_runs, 1);
  } finally { db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("failed persistence rolls back the daily ledger with the canonical request and rate reservation", () => {
  const f = fixture();
  try {
    const session = f.create(f.db, "rollback");
    const sequence = session.next_sequence;
    assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, session.id, input("rollback-budget"), endpoints.slice(0, 1), limits,
      () => { throw new Error("fixture persistence failure"); }), /fixture persistence failure/);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_agent_daily_usage").get()!.n, 0);
    assert.equal(f.db.hostedEndpointUsage(endpoints[0]!).daily, 0);
    assert.equal(f.db.requireSession(session.id).next_sequence, sequence);
    assert.equal(f.db.hostedActiveRuns(), 0);
    assert.equal(f.db.hostedAgentRateUsage(f.actor).retry_after_seconds, 0);
  } finally { f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
