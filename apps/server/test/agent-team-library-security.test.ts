import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentTeamDraft } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentTeams } from "../src/agent-teams.js";
import { AgentTeamLibrary } from "../src/agent-team-library.js";
import { ApiError } from "../src/errors.js";

function fixture(path = ":memory:") {
  const db = new CollaborationDatabase(path), service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Synthetic library owner", device_name: "Synthetic browser one" }).actor;
  const second = { ...actor, device_id: db.createDevice(actor.user_id, "Synthetic browser two").device_id };
  const peer = db.createIdentity({ display_name: "Synthetic private peer", device_name: "Synthetic peer browser", can_create_projects: true }).actor;
  const { session } = service.createSession(actor, { mode: "multi", title: "Synthetic security fixture", idempotency_key: "library-security-session" });
  const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: "codex", provider: "openai",
    model: "synthetic-model", context_deletion_version: 1, capture_fidelity: "harness_transcript", local_session_id: "synthetic-library-security-native" });
  const target = { kind: "local" as const, runtime_id: runtime.id, harness: "codex" as const, provider: "openai", model: "synthetic-model" };
  const draft: AgentTeamDraft = { name: "Security fixture", team_prompt: "", nodes: [
    { id: "first", label: "First module", role: "", x: 0, y: 0, target },
    { id: "entry", label: "Selected entry", role: "", x: 350, y: 0, target },
  ], entry_node_id: "entry", edges: [{ id: "route", source: "entry", target: "first", direction: "one_way" }] };
  const teams = new AgentTeams(service, undefined, { autoStart: false }), library = new AgentTeamLibrary(teams);
  const key = () => `library-security-${randomUUID()}`;
  const save = (id = "security-team", selected = draft) => library.save(actor, id, { draft: selected,
    expected_revision: null, idempotency_key: key() }).team;
  const probeLines = (requestEventId: string, sessionId = session.id) => {
    const payload = db.getEvent(sessionId, requestEventId).payload as { content: string };
    const encoded = payload.content.split("\n").find(line => line.startsWith('["GT_TEAM_OK:'));
    assert.ok(encoded, "The fake executor must receive the expected public probe lines explicitly");
    const lines = JSON.parse(encoded) as string[];
    assert.ok(lines.every(line => typeof line === "string")); return lines;
  };
  const finishProbe = async (id: string, reply = (lines: string[]) => lines,
    { sessionId = session.id, runtimeId = runtime.id, coordinator = teams }: { sessionId?: string; runtimeId?: string; coordinator?: AgentTeams } = {}) => {
    for (let spin = 0; spin < 80; spin++) {
      await coordinator.pump();
      const run = coordinator.read(actor, sessionId, id).run;
      if (run.status !== "running") return run;
      const step = run.steps.find(item => item.id === run.current_step_id);
      if (!step?.request_event_id) continue;
      const claim = service.claimAgentRequest(actor, sessionId, step.request_event_id, runtimeId);
      if (claim.status !== "claimed") continue;
      const lines = probeLines(step.request_event_id, sessionId);
      assert.equal(lines[0], `GT_TEAM_OK:${step.node_id}:${step.id}`);
      service.completeAgentRequest(actor, sessionId, step.request_event_id, runtimeId, key(),
        { content: reply(lines).join("\n") }, target.model, undefined, claim.attempt_count);
    }
    assert.fail("Synthetic connectivity probe did not finish");
  };
  return { db, service, actor, second, peer, session, runtime, target, draft, teams, library, key, save, finishProbe, probeLines,
    close: () => { teams.close(); db.close(); } };
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("a non-first configured entry is tested first, then its outgoing route is checked after every initial module probe", async () => {
  const f = fixture(); try {
    const saved = f.save();
    const accepted = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() });
    assert.equal(accepted.run.current_node_id, "entry");
    const completed = await f.finishProbe(accepted.run.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.steps.map(step => step.node_id), ["entry", "first", "first"]);
    assert.equal(completed.calls_used, 3); assert.equal(completed.plan.entry_node_id, "entry");
    assert.equal(f.library.read(f.actor, saved.id).test_status, "passed");
  } finally { f.close(); }
});

test("every incoming route transports its exact source probe identity and test calls remain separate from the saved task budget", async () => {
  const f = fixture(); try {
    const draft = structuredClone(f.draft);
    draft.nodes.push({ id: "review", label: "Review module", role: "", x: 700, y: 0, target: f.target });
    draft.edges.push({ id: "entry-review", source: "entry", target: "review", direction: "one_way" },
      { id: "first-review", source: "first", target: "review", direction: "one_way" });
    const saved = f.library.save(f.actor, "fan-in-probe", { draft, max_calls: 1, max_duration_minutes: 1,
      expected_revision: null, idempotency_key: f.key() }).team;
    const accepted = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() });
    const completed = await f.finishProbe(accepted.run.id);
    assert.equal(completed.status, "completed"); assert.equal(completed.purpose, "test");
    assert.equal(completed.calls_used, 5); assert.equal(completed.max_calls, 5);
    assert.deepEqual(completed.steps.map(step => step.node_id), ["entry", "first", "review", "first", "review"]);
    const initial = completed.steps.slice(0, 3), routes = completed.steps.slice(3);
    const sourceStep = (nodeId: string) => initial.find(step => step.node_id === nodeId)!.id;
    assert.deepEqual(f.probeLines(routes[0]!.request_event_id!), [
      `GT_TEAM_OK:first:${routes[0]!.id}`, `GT_TEAM_ROUTE:route:entry:first:${sourceStep("entry")}`,
    ]);
    assert.deepEqual(f.probeLines(routes[1]!.request_event_id!), [
      `GT_TEAM_OK:review:${routes[1]!.id}`, `GT_TEAM_ROUTE:entry-review:entry:review:${sourceStep("entry")}`,
      `GT_TEAM_ROUTE:first-review:first:review:${sourceStep("first")}`,
    ]);
    const tested = f.library.read(f.actor, saved.id);
    assert.equal(tested.test_status, "passed"); assert.equal(tested.max_calls, 1); assert.equal(tested.max_duration_minutes, 1);
    const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
      expected_revision: tested.revision, idempotency_key: f.key() }).team;
    const task = f.library.start(f.actor, saved.id, f.session.id, { expected_revision: enabled.revision,
      content: "The actual task retains its own one-call budget", content_revision: 0, idempotency_key: f.key() }).run;
    assert.equal(task.purpose, "task"); assert.equal(task.calls_used, 0); assert.equal(task.max_calls, 1); assert.equal(task.max_duration_minutes, 1);
  } finally { f.close(); }
});

test("missing, forged or wrong-direction public route tokens fail connectivity and cannot unlock Enable", async t => {
  for (const mutation of ["missing", "forged-source-step", "wrong-direction"] as const) await t.test(mutation, async () => {
    const f = fixture(); try {
      const saved = f.save();
      const accepted = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
        content_revision: 0, idempotency_key: f.key() });
      let altered = false;
      const failed = await f.finishProbe(accepted.run.id, lines => {
        if (lines.length === 1) return lines;
        altered = true;
        if (mutation === "missing") return lines.slice(0, 1);
        if (mutation === "forged-source-step") return [lines[0]!, "GT_TEAM_ROUTE:route:entry:first:forged-source-probe"];
        return [lines[0]!, lines[1]!.replace(":entry:first:", ":first:entry:")];
      });
      assert.equal(altered, true); assert.equal(failed.status, "failed"); assert.equal(failed.error_code, "agent_team_probe_failed");
      assert.equal(failed.calls_used, 3); assert.equal(f.library.read(f.actor, saved.id).test_status, "failed");
      assert.throws(() => f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
        expected_revision: saved.revision, idempotency_key: f.key() }), code("conflict"));
    } finally { f.close(); }
  });
});

test("a bidirectional data flow probes both directions using the correct first-phase source identities", async () => {
  const f = fixture(); try {
    const draft = structuredClone(f.draft); draft.edges[0]!.direction = "bidirectional";
    const saved = f.library.save(f.actor, "bidirectional-probe", { draft, max_calls: 1, max_duration_minutes: 1,
      expected_revision: null, idempotency_key: f.key() }).team;
    const accepted = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() });
    const completed = await f.finishProbe(accepted.run.id);
    assert.equal(completed.status, "completed"); assert.equal(completed.calls_used, 4); assert.equal(completed.max_calls, 4);
    assert.deepEqual(completed.steps.map(step => step.node_id), ["entry", "first", "entry", "first"]);
    const [entry, first, reverse, forward] = completed.steps;
    assert.deepEqual(f.probeLines(reverse!.request_event_id!), [
      `GT_TEAM_OK:entry:${reverse!.id}`, `GT_TEAM_ROUTE:route:first:entry:${first!.id}`,
    ]);
    assert.deepEqual(f.probeLines(forward!.request_event_id!), [
      `GT_TEAM_OK:first:${forward!.id}`, `GT_TEAM_ROUTE:route:entry:first:${entry!.id}`,
    ]);
    assert.equal(f.library.read(f.actor, saved.id).max_calls, 1);
  } finally { f.close(); }
});

test("different devices of one account share the same CAS revision and cannot overwrite or reenable a newer edit", async () => {
  const f = fixture(); try {
    const saved = f.save();
    const probe = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision, content_revision: 0, idempotency_key: f.key() });
    await f.finishProbe(probe.run.id);
    const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
      expected_revision: saved.revision, idempotency_key: f.key() }).team;
    const edited = f.library.save(f.second, saved.id, { draft: { ...f.draft, name: "Newer device's edit" },
      expected_revision: enabled.revision, idempotency_key: f.key() }).team;
    assert.equal(edited.enabled, false); assert.equal(edited.test_status, "not_tested");
    assert.throws(() => f.library.save(f.actor, saved.id, { draft: f.draft,
      expected_revision: enabled.revision, idempotency_key: f.key() }), code("conflict"));
    assert.throws(() => f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
      expected_revision: enabled.revision, idempotency_key: f.key() }), code("conflict"));
    assert.equal(f.library.read(f.actor, saved.id).draft.name, "Newer device's edit");
  } finally { f.close(); }
});

test("an account-wide saved Team never silently substitutes another session's native runtime; explicit rebinding requires a fresh test", async () => {
  const f = fixture(); try {
    const saved = f.save();
    const probe = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() }); await f.finishProbe(probe.run.id);
    const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
      expected_revision: saved.revision, idempotency_key: f.key() }).team;
    const other = f.service.createSession(f.actor, { project_id: f.session.project_id, mode: "multi", title: "Other session",
      idempotency_key: "library-native-other-session" }).session;
    const replacement = f.service.registerRuntime(f.actor, { session_id: other.id, device_id: f.actor.device_id,
      harness: "codex", provider: "openai", model: f.target.model, context_deletion_version: 1,
      local_session_id: "synthetic-new-session-native", capture_fidelity: "harness_transcript" });
    const before = Number(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n);
    const beforeHead = f.db.requireSession(other.id).next_sequence;
    assert.throws(() => f.library.start(f.actor, saved.id, other.id, { expected_revision: enabled.revision,
      content: "Never choose the replacement runtime automatically", content_revision: 0, idempotency_key: f.key() }), code("agent_team_target_unavailable"));
    assert.throws(() => f.library.test(f.actor, saved.id, other.id, { expected_revision: enabled.revision,
      content_revision: 0, idempotency_key: f.key() }), code("agent_team_target_unavailable"));
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, before);
    assert.equal(f.db.requireSession(other.id).next_sequence, beforeHead);
    const rebound = structuredClone(f.draft); for (const node of rebound.nodes) node.target = { ...f.target, runtime_id: replacement.id };
    const updated = f.library.save(f.actor, saved.id, { draft: rebound, expected_revision: enabled.revision, idempotency_key: f.key() }).team;
    assert.equal(updated.enabled, false); assert.equal(updated.tested_revision, null);
    assert.throws(() => f.library.start(f.actor, saved.id, other.id, { expected_revision: updated.revision,
      content: "Rebinding does not bypass the test gate", content_revision: 0, idempotency_key: f.key() }), code("conflict"));
    const retest = f.library.test(f.actor, saved.id, other.id, { expected_revision: updated.revision,
      content_revision: 0, idempotency_key: f.key() });
    const result = await f.finishProbe(retest.run.id, lines => lines, { sessionId: other.id, runtimeId: replacement.id });
    assert.equal(result.status, "completed"); assert.equal(f.library.read(f.actor, saved.id).test_session_id, other.id);
    const reenabled = f.library.control(f.actor, saved.id, other.id, { enabled: true,
      expected_revision: updated.revision, idempotency_key: f.key() }).team;
    assert.equal(reenabled.enabled, true);
    assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, { expected_revision: reenabled.revision,
      content: "The old session also cannot silently recover the old runtime", content_revision: 0, idempotency_key: f.key() }), code("agent_team_target_unavailable"));
  } finally { f.close(); }
});

test("a server-interrupted connectivity probe cannot enable a saved Team or accept late output; a replacement probe starts from scratch", async () => {
  const f = fixture(); let restored: AgentTeams | undefined;
  try {
    const saved = f.save();
    const accepted = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() }); await f.teams.pump();
    const step = f.teams.read(f.actor, f.session.id, accepted.run.id).run.steps[0]!;
    const claim = f.service.claimAgentRequest(f.actor, f.session.id, step.request_event_id!, f.runtime.id);
    assert.equal(claim.status, "claimed"); f.teams.close();
    restored = new AgentTeams(f.service, undefined, { autoStart: false });
    const library = new AgentTeamLibrary(restored), interrupted = restored.read(f.actor, f.session.id, accepted.run.id).run;
    assert.equal(interrupted.status, "paused"); assert.equal(interrupted.error_code, "server_restart"); assert.equal(interrupted.calls_used, 1);
    for (let spin = 0; spin < 3; spin++) await restored.pump();
    assert.equal(restored.read(f.actor, f.session.id, accepted.run.id).run.calls_used, 1, "A restart cannot retry a paid probe automatically");
    assert.equal(library.read(f.actor, saved.id).test_status, "failed");
    assert.throws(() => library.control(f.actor, saved.id, f.session.id, { enabled: true,
      expected_revision: saved.revision, idempotency_key: f.key() }), code("conflict"));
    assert.throws(() => f.service.completeAgentRequest(f.actor, f.session.id, step.request_event_id!, f.runtime.id, f.key(),
      { content: `GT_TEAM_OK:${step.node_id}:${step.id}` }, f.target.model, undefined, claim.attempt_count));
    const replacement = library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() });
    assert.notEqual(replacement.run.id, accepted.run.id); assert.equal(replacement.run.calls_used, 0);
    const finished = await f.finishProbe(replacement.run.id, lines => lines, { coordinator: restored });
    assert.equal(finished.status, "completed"); assert.equal(finished.calls_used, 3);
    assert.deepEqual(finished.steps.map(item => item.node_id), ["entry", "first", "first"]);
    assert.equal(restored.read(f.actor, f.session.id, accepted.run.id).run.status, "stopped");
    assert.equal(library.read(f.actor, saved.id).test_run_id, replacement.run.id); assert.equal(library.read(f.actor, saved.id).test_status, "passed");
  } finally { restored?.close(); f.close(); }
});

test("another account cannot read, mutate, test, enable, start or delete a private saved Team", () => {
  const f = fixture(); try {
    const saved = f.save();
    f.service.setMembership(f.actor, f.session.id, f.peer.user_id, "participant", "private-peer-shares-project-not-library");
    assert.deepEqual(f.library.list(f.peer).teams, []);
    assert.throws(() => f.library.read(f.peer, saved.id), code("not_found"));
    assert.throws(() => f.library.save(f.peer, saved.id, { draft: f.draft,
      expected_revision: saved.revision, idempotency_key: f.key() }), code("not_found"));
    assert.throws(() => f.library.test(f.peer, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() }), code("not_found"));
    assert.throws(() => f.library.control(f.peer, saved.id, f.session.id, { enabled: false, idempotency_key: f.key() }), code("not_found"));
    assert.throws(() => f.library.start(f.peer, saved.id, f.session.id, { expected_revision: saved.revision,
      content: "Must not run another account's configuration", content_revision: 0, idempotency_key: f.key() }), code("not_found"));
    assert.throws(() => f.library.delete(f.peer, "team", saved.id, f.key()), code("not_found"));
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_runs").get()!.n, 0);
    assert.equal(f.library.read(f.actor, saved.id).revision, saved.revision);
  } finally { f.close(); }
});

test("emergency disable keeps reserved receipt capacity when ordinary configuration writes are full", async () => {
  const f = fixture(); try {
    const saved = f.save();
    const probe = f.library.test(f.actor, saved.id, f.session.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() }); await f.finishProbe(probe.run.id);
    const enabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: true,
      expected_revision: saved.revision, idempotency_key: f.key() }).team;
    const existing = Number(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_team_library_receipts WHERE user_id=?").get(f.actor.user_id)!.n);
    const insert = f.db.sqlite.prepare("INSERT INTO agent_team_library_receipts(user_id,idempotency_key,input_digest,result_json,created_at) VALUES(?,?,?,?,?)");
    for (let index = existing; index < 1024; index++) insert.run(f.actor.user_id, `synthetic-full-receipt-${index}`, "metadata-only-digest",
      JSON.stringify({ kind: "team", id: saved.id }), new Date().toISOString());
    assert.throws(() => f.library.save(f.actor, saved.id, { draft: { ...f.draft, name: "At receipt capacity" },
      expected_revision: enabled.revision, idempotency_key: f.key() }), code("agent_team_storage_full"));
    const disabled = f.library.control(f.actor, saved.id, f.session.id, { enabled: false, idempotency_key: f.key() }).team;
    assert.equal(disabled.enabled, false); assert.ok(disabled.revision > enabled.revision);
    assert.throws(() => f.library.start(f.actor, saved.id, f.session.id, { expected_revision: enabled.revision,
      content: "A stale enabled browser cannot start a new task", content_revision: 0, idempotency_key: f.key() }), code("conflict"));
  } finally { f.close(); }
});

test("deleting a private configuration still fences its pending probe after its owner loses session membership", async () => {
  const f = fixture(); try {
    const projectOwner = f.peer;
    const otherSession = f.service.createSession(projectOwner, { mode: "multi", title: "Peer-owned fixture", idempotency_key: "private-delete-lost-project" }).session;
    f.service.setMembership(projectOwner, otherSession.id, f.actor.user_id, "participant", "private-delete-add-owner");
    const runtime = f.service.registerRuntime(f.actor, { session_id: otherSession.id, device_id: f.actor.device_id,
      harness: "codex", provider: "openai", model: f.target.model, context_deletion_version: 1,
      local_session_id: "synthetic-other-project-runtime", capture_fidelity: "harness_transcript" });
    const draft = structuredClone(f.draft); for (const node of draft.nodes) node.target = { ...f.target, runtime_id: runtime.id };
    const saved = f.save("lost-membership-team", draft);
    const accepted = f.library.test(f.actor, saved.id, otherSession.id, { expected_revision: saved.revision,
      content_revision: 0, idempotency_key: f.key() }); await f.teams.pump();
    const step = f.teams.read(f.actor, otherSession.id, accepted.run.id).run.steps[0]!;
    assert.ok(step.request_event_id);
    f.service.setMembership(projectOwner, otherSession.id, f.actor.user_id, "viewer", "private-delete-remove-write");
    f.library.delete(f.actor, "team", saved.id, f.key());
    assert.equal(f.db.teamRequestMayExecute(step.request_event_id!), false);
    assert.equal(f.teams.store.row(accepted.run.id).status, "stopped");
    assert.equal(f.library.list(f.actor).teams.length, 0);
  } finally { f.close(); }
});

const concurrentWriter = String.raw`
  import { parentPort, workerData } from "node:worker_threads";
  const { CollaborationDatabase } = await import(workerData.databaseModule);
  const { CollaborationService } = await import(workerData.serviceModule);
  const { AgentTeams } = await import(workerData.teamsModule);
  const { AgentTeamLibrary } = await import(workerData.libraryModule);
  const database = new CollaborationDatabase(workerData.path);
  const teams = new AgentTeams(new CollaborationService(database), undefined, { autoStart: false });
  const library = new AgentTeamLibrary(teams);
  parentPort.postMessage({ ready: true });
  parentPort.once("message", () => {
    const result = {};
    try { result.team = library.save(workerData.actor, workerData.id, {
      draft: workerData.draft, expected_revision: null, idempotency_key: workerData.id + "-save"
    }).team.id; } catch (error) { result.team_error = error.code || error.message; }
    try { result.favorite = library.favorite(workerData.actor, workerData.id + "-module", {
      module: { label: "Concurrent saved module", role: "", target: null }, idempotency_key: workerData.id + "-favorite"
    }).favorite.id; } catch (error) { result.favorite_error = error.code || error.message; }
    teams.close(); database.close(); parentPort.postMessage(result); parentPort.close();
  });
`;
test("independent SQLite writers cannot exceed the account-wide fifth Team or fifth favorite slot", async () => {
  const folder = mkdtempSync(join(tmpdir(), "gt-library-race-")), f = fixture(join(folder, "race.db"));
  const workers: Worker[] = [];
  try {
    const draft: AgentTeamDraft = { name: "Concurrent empty draft", team_prompt: "", nodes: [], edges: [] };
    for (let index = 0; index < 4; index++) {
      f.save(`existing-team-${index}`, draft);
      f.library.favorite(f.actor, `existing-module-${index}`, { module: { label: "Saved module", role: "", target: null }, idempotency_key: f.key() });
    }
    const pending = [0, 1].map(index => {
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(concurrentWriter)}`), { workerData: {
        path: join(folder, "race.db"), actor: index ? f.second : f.actor, id: `racing-team-${index}`, draft,
        databaseModule: new URL("../src/database.js", import.meta.url).href,
        serviceModule: new URL("../src/service.js", import.meta.url).href,
        teamsModule: new URL("../src/agent-teams.js", import.meta.url).href,
        libraryModule: new URL("../src/agent-team-library.js", import.meta.url).href,
      } }); workers.push(worker);
      let markReady!: () => void;
      const ready = new Promise<void>(resolve => { markReady = resolve; });
      const result = new Promise<{ team?: string; team_error?: string; favorite?: string; favorite_error?: string }>((resolve, reject) => {
        worker.on("message", message => { if (message.ready) markReady(); else resolve(message); });
        worker.once("error", reject);
        worker.once("exit", status => { if (status !== 0) reject(new Error(`Synthetic SQLite writer exited ${status}`)); });
      });
      return { ready, result, worker };
    });
    await Promise.all(pending.map(item => item.ready));
    for (const item of pending) item.worker.postMessage("write");
    const results = await Promise.all(pending.map(item => item.result));
    assert.equal(results.filter(item => item.team).length, 1);
    assert.equal(results.filter(item => item.team_error === "agent_team_limit").length, 1);
    assert.equal(results.filter(item => item.favorite).length, 1);
    assert.equal(results.filter(item => item.favorite_error === "agent_team_favorite_limit").length, 1);
    assert.equal(f.library.list(f.actor).teams.length, 5); assert.equal(f.library.list(f.second).modules.length, 5);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); f.close(); rmSync(folder, { recursive: true, force: true }); }
});
