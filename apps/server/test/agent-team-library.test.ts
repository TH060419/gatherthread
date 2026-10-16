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
  const database = new CollaborationDatabase(":memory:");
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
  const teams = new AgentTeams(service, undefined, { autoStart: false });
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
  return { database, service, actor, peer, session, runtime, draft, target, teams, library, key, save, readRun, finishProbe, probe, close };
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

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
