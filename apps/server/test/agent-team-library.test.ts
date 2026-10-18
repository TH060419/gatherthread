import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentTeamDraft, AgentTeamPlan } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams } from "../src/agent-teams.js";
import { AgentTeamLibrary } from "../src/agent-team-library.js";
import { ApiError } from "../src/errors.js";

function fixture() {
  let time = Date.now(); const clock = () => new Date(time);
  const database = new CollaborationDatabase(":memory:", { clock });
  const service = new CollaborationService(database);
  const actor = database.bootstrapIdentity({ display_name: "Library fixture", device_name: "Fixture desktop" }).actor;
  const peer = database.createIdentity({ display_name: "Other library fixture", device_name: "Other desktop", can_create_projects: true }).actor;
  const { session } = service.createSession(actor, { mode: "multi", title: "Library fixture", idempotency_key: "library-fixture-session" });
  const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "codex", provider: "openai",
    model: "fixture-model", context_deletion_version: 1, capture_fidelity: "harness_transcript", local_session_id: "fixture-library-local" });
  const target = { kind: "local" as const, runtime_id: runtime.id, harness: "codex" as const, provider: "openai", model: "fixture-model" };
  const draft: AgentTeamDraft = { name: "Saved team", team_prompt: "", nodes: [
    { id: "lead", label: "Lead", role: "Director", prompt: "Review public results", x: 30, y: 40, target },
    { id: "worker", label: "Worker", role: "Implementer", x: 350, y: 40, target },
  ], edges: [{ id: "route", source: "lead", target: "worker", direction: "one_way" }] };
  const teams = new AgentTeams(service, undefined, { clock, autoStart: false });
  const library = new AgentTeamLibrary(teams);
  const key = () => `fixture-${randomUUID()}`;
  const save = (id = "saved", custom = draft, revision: number | null = null, maxCalls = 12) => library.save(actor, id, {
    draft: custom, max_calls: maxCalls, max_duration_minutes: 30, expected_revision: revision, idempotency_key: key(),
  }).team;
  const readRun = (id: string) => teams.read(actor, session.id, id).run;
  const finishProbe = async (id: string, valid = true) => {
    for (let index = 0; index < 12; index++) {
      await teams.pump(); const run = readRun(id);
      if (run.status !== "running") return run;
      const step = run.steps.find(item => item.id === run.current_step_id);
      if (!step?.request_event_id) continue;
      const claim = service.claimAgentRequest(actor, session.id, step.request_event_id, runtime.id);
      if (claim.status !== "claimed") continue;
      const prompt = String((database.getEvent(session.id, step.request_event_id).payload as { content: string }).content);
      const response = JSON.parse(prompt.split("Respond exactly with these lines:\n")[1]!.split("\n")[0]!) as string[];
      service.completeAgentRequest(actor, session.id, step.request_event_id, runtime.id, key(),
        { text: valid ? response.join("\n") : "Wrong probe response" }, target.model, undefined, claim.attempt_count);
    }
    throw new Error("Connectivity test did not terminate");
  };
  const probe = (id: string, revision: number) => library.test(actor, id, session.id, {
    expected_revision: revision, content_revision: 0, idempotency_key: key(),
  });
  const close = () => { teams.close(); database.close(); };
  return { database, service, actor, peer, session, runtime, draft, target, teams, library, key, save, readRun, finishProbe, probe,
    advance: (ms: number) => { time += ms; }, close };
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("repeated edit/test cycles reclaim obsolete probe caches at capacity without reusing accepted keys or erasing task history", async () => {
  const f = fixture(); try {
    let saved = f.save();
    const firstInput = { expected_revision: saved.revision, content_revision: 0, idempotency_key: f.key() };
    const first = f.library.test(f.actor, saved.id, f.session.id, firstInput); await f.finishProbe(first.run.id);
    const firstRequestId = f.readRun(first.run.id).steps[0]!.request_event_id!; assert.ok(firstRequestId);
    f.service.setMembership(f.actor, f.session.id, f.peer.user_id, "participant", f.key());
    const peerRuntime = f.service.registerRuntime(f.peer, { session_id: f.session.id, device_id: f.peer.device_id,
      harness: "codex", provider: "openai", model: "fixture-model", context_deletion_version: 1,
      capture_fidelity: "harness_transcript", local_session_id: "peer-cache-owner" });
    const peerPlan = structuredClone(f.draft) as AgentTeamPlan;
    peerPlan.nodes = [{ ...peerPlan.nodes[0]!, target: { ...f.target, runtime_id: peerRuntime.id } }]; peerPlan.edges = [];
    const peerProbe = f.teams.start(f.peer, f.session.id, { plan: peerPlan, entry_node_id: "lead", content: "Other owner's cache",
      max_calls: 1, max_duration_minutes: 30, content_revision: 0, idempotency_key: f.key() }, { purpose: "test" }).run;
    f.teams.control(f.peer, f.session.id, peerProbe.id, { action: "stop", idempotency_key: f.key() });
    const task = f.teams.start(f.actor, f.session.id, { plan: f.draft as AgentTeamPlan, entry_node_id: "lead",
      content: "Retained human task", max_calls: 1, max_duration_minutes: 30, content_revision: 0, idempotency_key: f.key() }).run;
    f.teams.control(f.actor, f.session.id, task.id, { action: "stop", idempotency_key: f.key() });
    for (let index = 1; index <= 105; index++) {
      saved = f.save(saved.id, { ...f.draft, name: `Probe iteration ${index}` }, saved.revision);
      const probe = f.probe(saved.id, saved.revision); assert.equal((await f.finishProbe(probe.run.id)).status, "completed");
    }
    assert.ok(Number(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs WHERE purpose='test'").get()!.n) < 20,
      "obsolete connectivity caches must not exhaust the 100-run account capacity");
    assert.equal(f.readRun(task.id).content, "Retained human task", "ordinary task records remain explicitly clearable, never evicted for room");
    assert.equal(f.teams.read(f.peer, f.session.id, peerProbe.id).run.content, "Other owner's cache");
    assert.equal(f.library.read(f.actor, saved.id).test_status, "passed");
    const receipts = Number(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n);
    assert.throws(() => f.library.test(f.actor, saved.id, f.session.id, firstInput), code("conflict"));
    assert.equal(Number(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n), receipts);
    assert.equal(f.database.teamRequestMayExecute(firstRequestId), false);
    assert.equal(f.database.getEvent(f.session.id, firstRequestId).type, "agent_request", "cache reclamation leaves canonical messages in place");
  } finally { f.close(); }
});

test("probe-cache reclamation rolls back if retained task records still exhaust storage", async () => {
  const f = fixture(); try {
    let saved = f.save(); const old = f.probe(saved.id, saved.revision); await f.finishProbe(old.run.id);
    saved = f.save(saved.id, { ...f.draft, name: "Replacement configuration" }, saved.revision);
    for (let index = 0; index < 16; index++) {
      const task = f.teams.start(f.actor, f.session.id, { plan: f.draft as AgentTeamPlan, entry_node_id: "lead",
        content: "Retained terminal task", max_calls: 1, max_duration_minutes: 30, content_revision: 0, idempotency_key: f.key() }).run;
      f.teams.control(f.actor, f.session.id, task.id, { action: "stop", idempotency_key: f.key() });
    }
    // Model valid, fully consumed per-run control budgets without publishing
    // thousands of unrelated messages. The account is now at its 8-MiB cap.
    f.database.sqlite.prepare("UPDATE agent_team_runs SET bytes=524288 WHERE purpose='task'").run();
    const before = f.database.sqlite.prepare("SELECT id,bytes FROM agent_team_runs ORDER BY id").all();
    const receipts = Number(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n);
    assert.throws(() => f.probe(saved.id, saved.revision), code("agent_team_storage_full"));
    assert.deepEqual(f.database.sqlite.prepare("SELECT id,bytes FROM agent_team_runs ORDER BY id").all(), before);
    assert.equal(Number(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n), receipts);
    assert.ok(f.database.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE id=?").get(old.run.id));
  } finally { f.close(); }
});

test("recent terminal records cannot hide the older paused task that still needs Stop or Resume", () => {
  const f = fixture(); try {
    const start = () => f.teams.start(f.actor, f.session.id, { plan: f.draft as AgentTeamPlan,
      entry_node_id: "lead", content: "Synthetic bounded task", max_calls: 1, max_duration_minutes: 30,
      content_revision: 0, idempotency_key: f.key() }).run;
    const paused = start(); f.teams.control(f.actor, f.session.id, paused.id, { action: "pause", idempotency_key: f.key() });
    let latest: ReturnType<typeof start> | undefined;
    for (let index = 0; index < 50; index++) {
      f.advance(10); latest = start();
      f.teams.control(f.actor, f.session.id, latest.id, { action: "stop", idempotency_key: f.key() });
    }
    const listed = f.teams.list(f.actor, f.session.id).runs;
    assert.equal(listed.length, 50); assert.equal(listed[0]!.id, paused.id);
    assert.equal(listed[0]!.status, "paused"); assert.equal(listed[1]!.id, latest!.id);
    assert.equal(f.teams.control(f.actor, f.session.id, listed[0]!.id, { action: "stop", idempotency_key: f.key() }).run.status, "stopped");
  } finally { f.close(); }
});

test("hidden connectivity history cannot push ordinary ended tasks out of the bounded run list", () => {
  const f = fixture(); try {
    const input = () => ({ plan: f.draft as AgentTeamPlan, entry_node_id: "lead", content: "A retained bounded run",
      max_calls: 1, max_duration_minutes: 30, content_revision: 0, idempotency_key: f.key() });
    const task = f.teams.start(f.actor, f.session.id, input()).run;
    f.teams.control(f.actor, f.session.id, task.id, { action: "stop", idempotency_key: f.key() });
    for (let index = 0; index < 51; index++) {
      f.advance(1); const probe = f.teams.start(f.actor, f.session.id, input(), { purpose: "test" }).run;
      f.teams.control(f.actor, f.session.id, probe.id, { action: "stop", idempotency_key: f.key() });
    }
    const rows = f.teams.list(f.actor, f.session.id).runs;
    assert.equal(rows.length, 50); assert.ok(rows.some(run => run.id === task.id), "Web hides probes, so tasks must be prioritized before the list bound");
  } finally { f.close(); }
});

test("clearing or expiring a stopped/completed saved Team cannot turn an accepted key into a second execution", async t => {
  for (const end of ["stop-before-dispatch", "stop-after-dispatch", "complete"] as const) for (const cleanup of ["forget", "prune"] as const) {
    await t.test(`${end} then ${cleanup}`, async () => {
      const f = fixture(); try {
        const saved = f.save(), probe = f.probe(saved.id, saved.revision);
        assert.equal((await f.finishProbe(probe.run.id)).status, "completed");
        const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
          expected_revision: saved.revision, idempotency_key: f.key() }).team;
        const input = { content: "SYNTHETIC_PRIVATE_TASK_NOT_IN_RECEIPT", content_revision: 0,
          expected_revision: enabled.revision, idempotency_key: f.key() };
        const accepted = f.library.start(f.actor, saved.id, f.session.id, input);
        if (end !== "stop-before-dispatch") {
          await f.teams.pump(); const dispatched = f.readRun(accepted.run.id);
          assert.equal(dispatched.calls_used, 1);
          if (end === "complete") {
            const step = dispatched.steps[0]!, claim = f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.runtime.id);
            f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.runtime.id, f.key(), { content:
              `Public synthetic result.\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: step.id, action: "complete" })}\n\`\`\`` },
              f.target.model, undefined, claim.attempt_count);
            await f.teams.pump(); assert.equal(f.readRun(accepted.run.id).status, "completed");
          }
        }
        if (end !== "complete") f.teams.control(f.actor, f.session.id, accepted.run.id, { action: "stop", idempotency_key: f.key() });
        if (end === "stop-before-dispatch") assert.equal(f.readRun(accepted.run.id).calls_used, 0);
        if (cleanup === "forget") f.teams.forget(f.actor, f.session.id, accepted.run.id);
        else { f.advance(31 * 86400000); f.teams.store.prune(); }
        assert.equal(f.database.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE id=?").get(accepted.run.id), undefined);
        const receipt = f.teams.store.startReceipt(f.actor, f.session.id, input.idempotency_key)!;
        assert.equal(receipt.run_id, accepted.run.id); assert.equal(receipt.definition_id, saved.id);
        for (const forbidden of [input.content, input.idempotency_key, "Review public results", "Coordinate accurately"]) {
          assert.equal(JSON.stringify(receipt).includes(forbidden), false, "Consumed-key receipts contain no task, prompt, plan or raw key");
        }
        const before = {
          head: f.database.requireSession(f.session.id).next_sequence,
          runs: f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n,
          receipts: f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n,
          calls: f.database.sqlite.prepare("SELECT COALESCE(SUM(calls_used),0) AS n FROM agent_team_runs").get()!.n,
        };
        assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, input), code("conflict"));
        for (const changed of [{ ...input, content: "Changed task" }, { ...input, mentions: [] },
          { ...input, expected_revision: input.expected_revision + 1 }]) {
          assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, changed), code("idempotency_conflict"));
        }
        assert.throws(() => f.library.start(f.actor, "different-definition", f.session.id, input), code("idempotency_conflict"));
        assert.throws(() => f.library.test(f.actor, saved.id, f.session.id, { expected_revision: input.expected_revision,
          content_revision: 0, idempotency_key: input.idempotency_key }), code("idempotency_conflict"));
        // Current authority remains mandatory, and deleting/disabling a saved
        // definition cannot make its consumed start key available again.
        f.library.delete(f.actor, "team", saved.id, f.key());
        assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, input), code("conflict"));
        await f.teams.pump(); await Promise.resolve();
        assert.equal(f.database.requireSession(f.session.id).next_sequence, before.head);
        assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, before.runs);
        assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_start_receipts").get()!.n, before.receipts);
        assert.equal(f.database.sqlite.prepare("SELECT COALESCE(SUM(calls_used),0) AS n FROM agent_team_runs").get()!.n, before.calls);
        assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_agent_daily_usage").get()!.n, 0);
        assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_share_jobs").get()!.n, 0);
        f.database.revokeDevice(f.actor, f.actor.device_id);
        assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, input), code("unauthorized"));
      } finally { f.close(); }
    });
  }
});

test("saved Team starts bind exact quote and mention inputs to both lost-ack recovery and the original canonical request", async () => {
  const f = fixture(); try {
    f.service.setMembership(f.actor, f.session.id, f.peer.user_id, "participant", "library-reference-member");
    const saved = f.save(), probe = f.probe(saved.id, saved.revision);
    assert.equal((await f.finishProbe(probe.run.id)).status, "completed");
    const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
      expected_revision: saved.revision, idempotency_key: f.key() }).team;
    const quote = f.service.appendEvent(f.peer, f.session.id, { type: "human_chat", visibility: "session",
      payload: { content: "Synthetic saved-Team quote" }, idempotency_key: f.key() });
    const content = "  😀 @Other library fixture please review  \n", start = content.indexOf("@");
    const mentions = [{ user_id: f.peer.user_id, start, end: start + "@Other library fixture".length }];
    const input = { content, reply_to_event_id: quote.id, mentions, expected_revision: enabled.revision, content_revision: 0, idempotency_key: f.key() };
    const accepted = f.library.start(f.actor, saved.id, f.session.id, input);
    assert.equal(accepted.run.content, content);
    for (const changed of [{ ...input, reply_to_event_id: null }, { ...input, mentions: [] },
      { ...input, mentions: [{ ...mentions[0]!, end: mentions[0]!.end - 1 }] }]) {
      assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, changed), code("idempotency_conflict"));
    }
    await f.teams.pump();
    const run = f.readRun(accepted.run.id), request = f.database.getEvent(f.session.id, run.steps[0]!.request_event_id!);
    const payload = request.payload as { content: string; mentions: typeof mentions; agent_team: { task_content: string } };
    assert.equal(request.reply_to_event_id, quote.id); assert.equal(payload.agent_team.task_content, content);
    assert.equal(payload.content.slice(payload.mentions[0]!.start, payload.mentions[0]!.end), "@Other library fixture");
    assert.equal(f.library.start(f.actor, saved.id, f.session.id, input).replayed, true);
    f.library.delete(f.actor, "team", saved.id, f.key());
    assert.equal(f.library.start(f.actor, saved.id, f.session.id, input).run.id, run.id);
    assert.equal(f.readRun(run.id).calls_used, 1);
    assert.deepEqual(f.database.listProjectMentions(f.peer, f.session.project_id).mentions.map(item => item.excerpt), [content]);
  } finally { f.close(); }
});

test("the five-team limit is account-wide, transactional, replayable and releases capacity after deletion", () => {
  const f = fixture(); try {
    const input = { draft: f.draft, expected_revision: null, idempotency_key: f.key() };
    const first = f.library.save(f.actor, "team-0", input);
    assert.equal(f.library.save(f.actor, "team-0", input).replayed, true);
    for (let index = 1; index < 5; index++) f.save(`team-${index}`);
    assert.throws(() => f.save("sixth"), code("agent_team_limit"));
    assert.equal(f.library.list(f.actor).teams.length, 5);
    assert.equal(f.save("team-0", { ...f.draft, name: "Edited at capacity" }, first.team.revision).draft.name, "Edited at capacity");
    const other = f.library.save(f.peer, "peer-team", { ...input, idempotency_key: f.key() });
    assert.equal(other.team.id, "peer-team");
    assert.throws(() => f.library.read(f.peer, "team-0"), code("not_found"));
    const deletionKey = f.key();
    assert.equal(f.library.delete(f.actor, "team", "team-1", deletionKey).deleted, true);
    assert.equal(f.library.delete(f.actor, "team", "team-1", deletionKey).replayed, true);
    f.save("replacement"); assert.equal(f.library.list(f.actor).teams.length, 5);
  } finally { f.close(); }
});

test("five private immutable favorite snapshots remain independent of team copies", () => {
  const f = fixture(); try {
    const { id: _id, x: _x, y: _y, ...module } = f.draft.nodes[0]!;
    const input = { module, idempotency_key: f.key() };
    f.library.favorite(f.actor, "favorite-0", input);
    assert.equal(f.library.favorite(f.actor, "favorite-0", input).replayed, true);
    for (let index = 1; index < 5; index++) f.library.favorite(f.actor, `favorite-${index}`, { module, idempotency_key: f.key() });
    assert.throws(() => f.library.favorite(f.actor, "sixth", { module, idempotency_key: f.key() }), code("agent_team_favorite_limit"));
    const copy = structuredClone(f.draft); copy.nodes[0]!.prompt = "Independent prompt"; f.save("copy", copy);
    assert.equal(f.library.list(f.actor).modules[0]!.module.prompt, "Review public results");
    assert.equal(f.library.list(f.peer).modules.length, 0);
    assert.throws(() => f.library.delete(f.peer, "favorite", "favorite-0", f.key()), code("not_found"));
    f.library.delete(f.actor, "favorite", "favorite-0", f.key());
    f.library.favorite(f.actor, "replacement", { module, idempotency_key: f.key() });
    assert.equal(f.library.list(f.actor).modules.length, 5);
  } finally { f.close(); }
});

test("incomplete drafts save but cannot pass testing; disconnected directions fail before any Agent call", () => {
  const f = fixture(); try {
    const empty = f.save("empty", { name: "Empty draft", team_prompt: "", nodes: [], edges: [] });
    assert.throws(() => f.probe(empty.id, empty.revision), code("agent_team_incomplete"));
    const unbound = structuredClone(f.draft); unbound.nodes[0]!.target = null;
    const saved = f.save("unbound", unbound);
    assert.throws(() => f.probe(saved.id, saved.revision), code("agent_team_incomplete"));
    const disconnected = structuredClone(f.draft); disconnected.edges[0]!.source = "worker"; disconnected.edges[0]!.target = "lead";
    const wrongDirection = f.save("disconnected", disconnected);
    assert.throws(() => f.probe(wrongDirection.id, wrongDirection.revision), code("agent_team_disconnected"));
    assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 0);
    assert.throws(() => f.library.control(f.actor, empty.id, f.session.id, { enabled: true, expected_revision: empty.revision, idempotency_key: f.key() }), code("conflict"));
  } finally { f.close(); }
});

test("connectivity calls every module once, has a separate budget, and gates enabled immutable task starts", async () => {
  const f = fixture(); try {
    const saved = f.save("tested", f.draft, null, 1);
    const input = { expected_revision: saved.revision, content_revision: 0, idempotency_key: f.key() };
    const accepted = f.library.test(f.actor, saved.id, f.session.id, input);
    assert.equal(f.library.test(f.actor, saved.id, f.session.id, input).run.id, accepted.run.id);
    const result = await f.finishProbe(accepted.run.id);
    assert.equal(result.status, "completed"); assert.equal(result.calls_used, 3); assert.equal(result.purpose, "test");
    assert.deepEqual(result.steps.map(step => step.node_id), ["lead", "worker", "worker"]);
    const tested = f.library.read(f.actor, saved.id); assert.equal(tested.test_status, "passed");
    assert.equal(tested.enabled, false); assert.equal(tested.max_calls, 1);
    const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true, expected_revision: tested.revision, idempotency_key: f.key() }).team;
    const task = { expected_revision: enabled.revision, content_revision: 0, content: "Execute the human task", idempotency_key: f.key() };
    const started = f.library.start(f.actor, saved.id, f.session.id, task);
    assert.equal(started.run.max_calls, 1); assert.equal(started.run.purpose, "task");
    f.library.control(f.actor, saved.id, f.session.id, { enabled: false, idempotency_key: f.key() });
    assert.equal(f.library.start(f.actor, saved.id, f.session.id, task).run.id, started.run.id);
    assert.equal(f.library.start(f.actor, saved.id, f.session.id, task).replayed, true);
    assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, { ...task, content: "Changed task" }), code("idempotency_conflict"));
    assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, { ...task, idempotency_key: f.key() }), code("conflict"));
    assert.deepEqual(started.run.plan, f.draft as AgentTeamPlan);
  } finally { f.close(); }
});

test("edits invalidate successful tests, disable a team and fence late enable requests", async () => {
  const f = fixture(); try {
    const saved = f.save(); const accepted = f.probe(saved.id, saved.revision); await f.finishProbe(accepted.run.id);
    const tested = f.library.read(f.actor, saved.id);
    const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true, expected_revision: tested.revision, idempotency_key: f.key() }).team;
    const disabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: false, idempotency_key: f.key() }).team;
    assert.throws(() => f.library.control(f.actor, saved.id, f.session.id,
      { enabled: true, expected_revision: enabled.revision, idempotency_key: f.key() }), code("conflict"));
    const edited = f.save(saved.id, { ...f.draft, name: "Updated team" }, disabled.revision);
    assert.equal(edited.enabled, false); assert.equal(edited.tested_revision, null); assert.equal(edited.test_status, "not_tested");
    assert.throws(() => f.library.control(f.actor, saved.id, f.session.id,
      { enabled: true, expected_revision: edited.revision, idempotency_key: f.key() }), code("conflict"));
    assert.throws(() => f.save(saved.id, f.draft, enabled.revision), code("conflict"));
  } finally { f.close(); }
});

test("successful connectivity remains tested after its private run is forgotten or pruned without a library poll", async t => {
  for (const cleanup of ["forget", "prune"] as const) await t.test(cleanup, async () => {
    const f = fixture(); try {
      const saved = f.save(), accepted = f.probe(saved.id, saved.revision);
      assert.equal((await f.finishProbe(accepted.run.id)).status, "completed");
      // A browser can disconnect immediately after starting a test. No library
      // read may be required to durably accept its verified successful result.
      if (cleanup === "forget") f.teams.forget(f.actor, f.session.id, accepted.run.id);
      else { f.advance(31 * 86400000); f.teams.store.prune(); }
      const recovered = f.library.read(f.actor, saved.id);
      assert.equal(recovered.test_status, "passed"); assert.equal(recovered.tested_revision, recovered.revision);
      assert.equal(f.database.sqlite.prepare("SELECT 1 FROM agent_team_runs WHERE id=?").get(accepted.run.id), undefined);
      if (cleanup === "forget") assert.equal(f.library.control(f.actor, saved.id, f.session.id,
        { enabled: true, expected_revision: recovered.revision, idempotency_key: f.key() }).team.enabled, true);
    } finally { f.close(); }
  });
});

test("a stale or malformed probe cannot enable a team; editing cancels its pending native request", async () => {
  const f = fixture(); try {
    const saved = f.save(); const accepted = f.probe(saved.id, saved.revision);
    assert.equal((await f.finishProbe(accepted.run.id, false)).status, "failed");
    assert.equal(f.library.read(f.actor, saved.id).test_status, "failed");
    const next = f.probe(saved.id, saved.revision); await f.teams.pump();
    const step = f.readRun(next.run.id).steps[0]!;
    assert.ok(step.request_event_id);
    f.save(saved.id, { ...f.draft, name: "Changed during test" }, saved.revision);
    assert.equal(f.readRun(next.run.id).status, "stopped");
    assert.notEqual(f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.runtime.id).status, "claimed");
    assert.equal(f.library.read(f.actor, saved.id).test_status, "not_tested");
  } finally { f.close(); }
});

test("revoked devices cannot read private libraries, and retry keys cannot change actions", () => {
  const f = fixture(); try {
    const input = { draft: f.draft, expected_revision: null, idempotency_key: f.key() };
    f.library.save(f.actor, "saved", input);
    assert.throws(() => f.library.save(f.actor, "other-id", input), code("idempotency_conflict"));
    assert.throws(() => f.library.delete(f.actor, "team", "saved", input.idempotency_key), code("idempotency_conflict"));
    f.database.revokeDevice(f.actor, f.actor.device_id);
    assert.throws(() => f.library.list(f.actor));
    assert.throws(() => f.library.save(f.actor, "another", { ...input, idempotency_key: f.key() }));
  } finally { f.close(); }
});
