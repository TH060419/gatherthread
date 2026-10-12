import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";

const unixTest = process.platform === "win32" ? test.skip : test;
const options: HostedAgentOptions = { endpoints: [{ id: "fixture", profileId: "default", label: "Fixture", provider: "openai-compatible",
  model: "fixture", baseUrl: "https://fixture.invalid/v1", apiToken: "fake-not-a-provider-key", quotaGroup: "fixture", dailyRuns: 10, maxConcurrent: 1 }],
  image: `sha256:${"a".repeat(64)}`, userDailyRuns: 10, globalDailyRuns: 10, maxConcurrent: 1,
  userMinIntervalSeconds: 1, userMaxConcurrent: 1 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gt-deletion-hosted-")); const file = join(dir, "db.sqlite");
  const db = new CollaborationDatabase(file, { authTokenPepper: "deletion-hosted-fixture" });
  const other = new CollaborationDatabase(file, { authTokenPepper: "deletion-hosted-fixture" });
  const actor = db.bootstrapIdentity({ display_name: "Author", device_name: "Browser" }).actor;
  const service = new CollaborationService(db);
  const session = service.createSession(actor, { title: "Hosted", mode: "multi", idempotency_key: "hosted-delete-session" }).session;
  const chat = (content: string) => service.appendEvent(actor, session.id, { type: "human_chat", visibility: "session", idempotency_key: randomUUID(), payload: { content } });
  const repository = new CodeRepository(db, join(dir, "code"));
  return { dir, db, other, actor, service, session, chat, repository, close: () => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function prompt(args: string[]): string {
  const mount = args.find((arg) => arg.endsWith("dst=/run/gatherthread,readonly"))!;
  return readFileSync(join(mount.split("src=")[1]!.split(",dst=")[0]!, "prompt.txt"), "utf8");
}

unixTest("deletion aborts cloud work, holds its slot until exit and excludes the source from the actual next prompt", { timeout: 5000 }, async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const source = f.chat("HOSTED_DELETED_UNIQUE_SOURCE"); f.chat("HOSTED_SURVIVING_SOURCE");
  let runs = 0, signal: AbortSignal | undefined;
  const prompts: string[] = [];
  const agent = new HostedAgent(f.service, f.repository, { ...options, runContainer: async (args, _timeout, cancellation) => {
    runs++; prompts.push(prompt(args)); signal = cancellation;
    if (runs === 1) { entered.resolve(); return release.promise; }
    return JSON.stringify({ answer: "Fresh answer", files: [] });
  } });
  let pending: ReturnType<HostedAgent["request"]> | undefined;
  try {
    pending = agent.request(f.actor, f.session.id, { profile_id: "default", content: "Use shared history", include_code: false, idempotency_key: "before-deletion" });
    await entered.promise;
    const request = f.service.replay(f.actor, f.session.id, 0, 100).events.find((event) => event.type === "agent_request")!;
    assert.match(prompts[0]!, /HOSTED_DELETED_UNIQUE_SOURCE/);
    f.service.deleteMessage(f.actor, f.session.id, source.id, "hosted-source-delete");
    assert.equal(signal?.aborted, true);
    assert.equal(f.db.hostedActiveRuns(), 1, "deletion cannot make a still-running executor slot available");
    assert.equal(f.service.appendHostedAgentProgress(request.id, { id: "late", content: "HOSTED_DELETED_UNIQUE_SOURCE", phase: "stream",
      streamId: randomUUID(), streamMode: "snapshot", streamKind: "answer", streamRevision: 1, streamState: "running" }), false);
    release.resolve(JSON.stringify({ answer: "HOSTED_DELETED_UNIQUE_SOURCE", files: [] }));
    const result = await pending;
    assert.equal(result.response_event, undefined); assert.equal(f.db.hostedActiveRuns(), 0);
    assert.doesNotMatch(JSON.stringify(f.service.replay(f.actor, f.session.id, 0, 100)), /HOSTED_DELETED_UNIQUE_SOURCE/);
    f.db.sqlite.prepare("UPDATE hosted_agent_user_activity SET last_started_at=? WHERE user_id=?")
      .run(new Date(Date.now() - 2000).toISOString(), f.actor.user_id);
    await agent.request(f.actor, f.session.id, { profile_id: "default", content: "Continue", include_code: false, content_revision: 1, idempotency_key: "after-deletion" });
    assert.doesNotMatch(prompts[1]!, /HOSTED_DELETED_UNIQUE_SOURCE/); assert.match(prompts[1]!, /HOSTED_SURVIVING_SOURCE/);
    assert.equal(f.db.hostedAgentUsage(f.actor, 10, 10).user_used_runs, 2, "privacy cancellation cannot silently rerun or refund accepted provider use");
  } finally { release.resolve(JSON.stringify({ answer: "late", files: [] })); await pending?.catch(() => undefined); agent.close(); f.close(); }
});

unixTest("cloud reservation rejects a context read that another database handle invalidated before dispatch", async () => {
  const f = fixture(); const source = f.chat("RESERVATION_OLD_SOURCE"); let runs = 0;
  f.repository.enable(f.actor, f.session.project_id, { idempotency_key: "enable-reservation" });
  const snapshot = f.repository.snapshot.bind(f.repository);
  f.repository.snapshot = (...args) => {
    const result = snapshot(...args); f.other.deleteMessage(f.actor, f.session.id, source.id, "delete-during-snapshot"); return result;
  };
  const agent = new HostedAgent(f.service, f.repository, { ...options, runContainer: async () => { runs++; return JSON.stringify({ answer: "Must not dispatch", files: [] }); } });
  try {
    await assert.rejects(agent.request(f.actor, f.session.id, { profile_id: "default", content: "Work", include_code: true, idempotency_key: "stale-reservation" }),
      (error: unknown) => (error as { code?: string }).code === "context_changed");
    assert.equal(runs, 0); assert.equal(f.db.hostedActiveRuns(), 0); assert.equal(f.db.hostedAgentUsage(f.actor, 10, 10).user_used_runs, 0);
  } finally { agent.close(); f.close(); }
});

unixTest("a cloud checkpoint rechecks history revision in its own transaction after the executor returns", async () => {
  const f = fixture(); const source = f.chat("CHECKPOINT_OLD_SOURCE");
  const enabled = f.repository.enable(f.actor, f.session.project_id, { idempotency_key: "enable-checkpoint" });
  const checkpoint = f.repository.checkpoint.bind(f.repository);
  (f.repository as any).checkpoint = (...args: any[]) => {
    f.other.deleteMessage(f.actor, f.session.id, source.id, "delete-at-checkpoint"); return (checkpoint as any)(...args);
  };
  const agent = new HostedAgent(f.service, f.repository, { ...options, runContainer: async () => JSON.stringify({ answer: "CHECKPOINT_OLD_SOURCE", save_error: null,
    files: [{ path: "late.txt", executable: false, content_base64: Buffer.from("CHECKPOINT_OLD_SOURCE").toString("base64") }] }) });
  try {
    const result = await agent.request(f.actor, f.session.id, { profile_id: "default", content: "Work", include_code: true, idempotency_key: "stale-checkpoint" });
    assert.equal(result.response_event, undefined); assert.equal(f.db.hostedActiveRuns(), 0);
    const status = f.repository.status(f.actor, f.session.project_id);
    assert.equal(status.own_branch_id, null); assert.equal(status.repository.main_commit, enabled.commit);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM code_mutations WHERE operation='checkpoint'").get()?.n, 0);
  } finally { agent.close(); f.close(); }
});
