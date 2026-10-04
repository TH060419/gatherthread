import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent } from "../src/hosted-agent.js";
import { startCollaborationServer } from "../src/server.js";
import { ApiError } from "../src/errors.js";

const endpoint = { id: "fixture", profileId: "fixture", label: "Fixture", provider: "openai-compatible" as const, model: "fixture",
 baseUrl: "https://fixture.invalid/v1", apiToken: "fixture-only", quotaGroup: "fixture", dailyRuns: 20, maxConcurrent: 1 };
const limits = { userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 1 };
const input = { profile_id: "fixture", include_code: false, content: "Run fixture", idempotency_key: "terminal-fixture" };
const quota = (error: unknown) => error instanceof ApiError && error.code === "storage_quota_exceeded";
function fixture(scope = "session") {
 const budget = scope === "deployment" ? 8192 : 4096;
 const directory = mkdtempSync(join(tmpdir(), "gt-hosted-terminal-")), path = join(directory, "db");
 const options = { authTokenPepper: "synthetic-terminal-private-pepper-32", maxEventBytes: 4096,
  maxSessionEventBytes: scope === "session" ? 4096 : scope === "deployment" ? budget : 65536,
  maxUserEventBytes: scope === "user" ? 4096 : scope === "deployment" ? budget : 65536,
  maxTotalEventBytes: scope === "deployment" ? budget : 65536 };
 const db = new CollaborationDatabase(path, options), service = new CollaborationService(db);
 const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Fixture" }).actor;
 const session = service.createSession(actor, { session_id: "terminal-fixture", mode: "multi", title: "Fixture", idempotency_key: "create-terminal-fixture" }).session;
 if (scope === "deployment") {
  const other = db.createIdentity({ display_name: "Other", device_name: "Fixture", can_create_projects: true }).actor;
  const elsewhere = service.createSession(other, { session_id: "elsewhere", mode: "solo", title: "Elsewhere", idempotency_key: "elsewhere-create" }).session;
  service.appendEvent(other, elsewhere.id, { type: "human_chat", visibility: "session", idempotency_key: "elsewhere-chat", payload: { content: "x".repeat(1000) } });
 }
 const used = () => Number(db.sqlite.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes FROM event_storage_usage${
  scope === "session" ? " WHERE session_id='terminal-fixture'" : scope === "user" ? " WHERE actor_user_id=?" : ""}`)
  .get(...(scope === "user" ? [actor.user_id] : []))!.bytes);
 const fill = () => {
  let count = 0;
  const overhead = 512 + JSON.stringify({ content: "" }).length;
  while (used() < budget - 50) {
   const remaining = budget - 50 - used();
   let bytes = Math.min(3500 + overhead, remaining);
   if (remaining > bytes && remaining - bytes <= overhead) bytes = remaining - overhead - 1;
   service.appendEvent(actor, session.id, { type: "human_chat", visibility: "session",
    idempotency_key: `concurrent-chat-${count++}`, payload: { content: "x".repeat(bytes - overhead) } });
  }
 };
 return { directory, path, options, db, service, actor, session, used, fill, budget };
}
const socketTest = process.platform === "win32" ? test.skip : test;
for (const scope of ["session", "user", "deployment", "event"]) {
 socketTest(`settled executor terminates once despite ${scope} storage quota`, async () => {
  const f = fixture(scope); let finished = 0;
  try {
   const agent = new HostedAgent(f.service, new CodeRepository(f.db, join(f.directory, "code")), {
    ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`,
    runContainer: async () => { if (scope !== "event") f.fill(); finished++;
     return JSON.stringify({ answer: scope === "event" ? "x".repeat(12000) : "Fixture completed", files: [], save_error: null }); },
   });
   const result = await agent.request(f.actor, f.session.id, input);
   const payload = result.response_event?.payload as { status: string; error: unknown };
   assert.equal(finished, 1); assert.equal(payload.status, "failed");
   assert.deepEqual(payload.error, { code: "storage_quota_exceeded" });
   assert.equal(f.db.hostedActiveRuns(), 0);
   assert.equal(f.db.sqlite.prepare("SELECT status FROM hosted_agent_runs").get()!.status, "failed");
   assert.equal(f.db.finishHostedAgentRequest(result.request_event.id, {}), undefined);
   assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_response'").get()!.n, 1);
   if (scope !== "event") {
    assert.ok(f.used() > f.budget && f.used() <= f.budget + 1024);
    assert.throws(() => f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "still-full", payload: { content: "No quota bypass" } }), quota);
   }
  } finally { f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
 });
}
for (const outcome of ["success", "failure", "recovery"]) {
 test(`participant cannot poison hosted ${outcome} with a public idempotency key`, () => {
  const f = fixture();
  try {
   const member = f.db.createIdentity({ display_name: "Participant", device_name: "Fixture" }).actor;
   f.service.setMembership(f.actor, f.session.id, member.user_id, "participant", "add-participant");
   const run = f.db.reserveHostedAgentRequest(f.actor, f.session.id, input, [endpoint], limits);
   const poison = f.service.appendEvent(member, f.session.id, { type: "human_chat", visibility: "session",
     idempotency_key: `hosted-agent-result-${run.event.id}`, payload: { content: "Ordinary participant chat" } });
   const result = outcome === "recovery" ? f.db.failInterruptedHostedAgentJobs()[0]
     : f.db.finishHostedAgentRequest(run.event.id, outcome === "success" ? { content: "Done" } : {});
   assert.equal(result?.type, "agent_response"); assert.equal(result?.reply_to_event_id, run.event.id);
   assert.notEqual(result?.idempotency_key, poison.idempotency_key);
   assert.equal(f.db.hostedActiveRuns(), 0); assert.equal(f.db.finishHostedAgentRequest(run.event.id, {}), undefined);
   assert.equal(f.db.getEvent(f.session.id, poison.id).type, "human_chat");
   assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent_response'").get()!.n, 1);
  } finally { f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
 });
}
socketTest("full legacy session above lowered caps cannot prevent real server startup and unrelated projects remain usable", async () => {
 const f = fixture(); let server: Awaited<ReturnType<typeof startCollaborationServer>> | undefined;
 const runner = { ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`, runContainer: async () => "{}" };
 try {
  const run = f.db.reserveHostedAgentRequest(f.actor, f.session.id, input, [endpoint], limits); f.fill();
  assert.equal(f.used(), 4046); f.db.close();
  server = await startCollaborationServer({ databasePath: f.path, ...f.options,
   maxEventBytes: 512, maxSessionEventBytes: 2048, hostedAgent: runner });
  assert.equal((await fetch(`${server.origin}/health`)).status, 200);
  assert.equal(server.database.hostedActiveRuns(), 0);
  assert.equal(server.database.sqlite.prepare("SELECT status FROM hosted_agent_runs").get()!.status, "failed");
  const charged = Number(server.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM event_storage_usage WHERE session_id=?").get(f.session.id)!.bytes);
  assert.ok(charged > 4046 && charged <= 4046 + 1024);
  assert.equal(server.database.finishHostedAgentRequest(run.event.id, {}), undefined);
  assert.throws(() => server!.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
   idempotency_key: "still-full-after-upgrade", payload: { content: "Ordinary writes remain blocked" } }), quota);
  // Restore the ordinary per-event cap for this separate, fresh request.
  await server.close(); server = undefined;
  server = await startCollaborationServer({ databasePath: f.path, ...f.options, hostedAgent: runner });
  const other = server.database.createIdentity({ display_name: "Other", device_name: "Fixture", can_create_projects: true }).actor;
  const session = server.service.createSession(other, { session_id: "other-terminal", mode: "solo", title: "Other", idempotency_key: "other-terminal-session" }).session;
  assert.equal(server.database.reserveHostedAgentRequest(other, session.id, { ...input, idempotency_key: "other-terminal-request" }, [endpoint], limits).created, true);
 } finally { if (server) await server.close(); else if (f.db.sqlite.isOpen) f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
