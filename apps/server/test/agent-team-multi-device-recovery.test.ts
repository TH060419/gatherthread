import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import type { AgentTeamDefinition, AgentTeamRunDetail, CanonicalEvent } from "@gatherthread/protocol";
import { startCollaborationServer } from "../src/server.js";
import { identityFixture, browserSessionFixture } from "./auth-fixtures.js";

// Exercise real browser cookies/HTTP and canonical replay without calling a paid
// provider. Every native claim and public result is from this synthetic executor.
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gt-team-two-device-"));
  const origin = "http://synthetic-team-recovery.invalid";
  const options = { databasePath: join(directory, "server.sqlite"), allowedOrigins: [origin],
    authTokenPepper: "synthetic-two-device-team-recovery-pepper-long-enough" };
  let server = await startCollaborationServer(options, 0);
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = identityFixture(server, {}).body.data, peer = identityFixture(server, {}).body.data;
  const second = server.database.createDevice(owner.actor.user_id, "Synthetic second browser");
  const cookie = (token: string) => browserSessionFixture(server, { token }).headers.get("set-cookie")!.split(";")[0]!;
  const cookies = [cookie(owner.token), cookie(second.token)], peerCookie = cookie(peer.token);
  const { session } = server.service.createSession(owner.actor, { mode: "multi", title: "Synthetic recovery", idempotency_key: "two-device-session" });
  server.service.setMembership(owner.actor, session.id, peer.actor.user_id, "participant", "two-device-peer");
  const runtime = server.service.registerRuntime(owner.actor, { session_id: session.id, device_id: owner.actor.device_id,
    harness: "codex", provider: "openai", model: "synthetic-recovery", context_deletion_version: 1,
    capture_fidelity: "harness_transcript", local_session_id: "synthetic-recovery-native" });
  const draft = { name: "Synthetic durable Team", team_prompt: "Synthetic team rules", nodes: [{ id: "lead", label: "Lead", role: "",
    x: 0, y: 0, target: { kind: "local", runtime_id: runtime.id, harness: "codex", provider: "openai", model: "synthetic-recovery" } }], edges: [] };
  const root = `/v1/sessions/${session.id}`, teamPath = `${root}/agent-teams/two-device-team`;
  async function api<T>(path: string, method = "GET", body?: unknown, auth = cookies[0]!) {
    const response = await fetch(server.origin + path, { method, headers: { cookie: auth, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() as { data: T; error?: { code: string } } };
  }
  const read = async (id: string, auth = cookies[0]!) => {
    const result = await api<{ run: AgentTeamRunDetail }>(`${root}/agent-team-runs/${id}`, "GET", undefined, auth);
    assert.equal(result.status, 200); return result.body!.data.run;
  };
  async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean) {
    for (let i = 0; i < 400; i++) { const value = await get(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail("Synthetic recovery did not reach its expected durable state");
  }
  const stepReady = (id: string) => until(() => read(id), run => Boolean(run.steps.find(step => step.id === run.current_step_id)?.request_event_id));
  const complete = (run: AgentTeamRunDetail, content: string) => {
    const step = run.steps.find(step => step.id === run.current_step_id)!;
    assert.ok(step.request_event_id);
    const claim = server.service.claimAgentRequest(owner.actor, session.id, step.request_event_id, runtime.id);
    assert.equal(claim.status, "claimed");
    return server.service.completeAgentRequest(owner.actor, session.id, step.request_event_id, runtime.id,
      `synthetic-complete-${step.id}`, { content }, runtime.model!, undefined, claim.attempt_count);
  };
  async function enabled() {
    const saved = await api<{ team: AgentTeamDefinition }>("/v1/agent-teams/two-device-team", "PUT", {
      draft, expected_revision: null, max_calls: 4, idempotency_key: "two-device-save" });
    assert.equal(saved.status, 200); const revision = saved.body!.data.team.revision;
    const tested = await api<{ run: AgentTeamRunDetail }>(`${teamPath}/test`, "POST", { expected_revision: revision,
      content_revision: 0, idempotency_key: "two-device-test" });
    assert.equal(tested.status, 202); const run = await stepReady(tested.body!.data.run.id);
    complete(run, `GT_TEAM_OK:lead:${run.current_step_id}`);
    await until(() => read(run.id), row => row.status === "completed");
    const active = await api<{ team: AgentTeamDefinition }>(`${teamPath}/control`, "POST", { enabled: true,
      expected_revision: revision, idempotency_key: "two-device-enable" });
    assert.equal(active.status, 200); return active.body!.data.team;
  }
  async function socket(auth = peerCookie, cursor = 0) {
    const ticket = await api<{ ticket: string }>("/v1/realtime-ticket", "POST", { session_id: session.id }, auth);
    assert.equal(ticket.status, 201);
    const ws = new WebSocket(server.origin.replace("http:", "ws:") + "/v1/ws", ["gatherthread-v1", `gatherthread-ticket.${ticket.body!.data.ticket}`], { origin });
    sockets.push(ws); await once(ws, "open");
    const frames: Array<{ type: string; events?: CanonicalEvent[]; event?: CanonicalEvent; cursor?: number }> = [];
    const received = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Synthetic reconnect did not subscribe")), 3000);
      ws.on("message", raw => { const message = JSON.parse(raw.toString()); frames.push(message);
        if (message.type === "subscribed") { clearTimeout(timer); resolve(); } });
    });
    ws.send(JSON.stringify({ type: "subscribe", session_id: session.id, after_sequence: cursor }));
    await received; return { ws, frames };
  }
  return { get server() { return server; }, cookies, peerCookie, session, owner, runtime, draft, root, teamPath,
    api, read, until, stepReady, complete, enabled, socket,
    async restart() { await server.close(); server = await startCollaborationServer(options, 0); },
    async discardReply(path: string, body: unknown) {
      return new Promise<number>((resolve, reject) => {
        const req = httpRequest(server.origin + path, { method: "POST", headers: { cookie: cookies[0]!, origin, "content-type": "application/json" } }, res => {
          // A server-accepted mutation whose response never reaches the JSON parser.
          const status = res.statusCode!; res.destroy(); resolve(status);
        });
        req.once("error", reject); req.setTimeout(3000, () => req.destroy(Error("Synthetic dropped ACK timed out")));
        req.end(JSON.stringify(body));
      });
    } };
}

test("simultaneous browser devices use one canonical start, while an offline member recovers the Team result through ordered replay", async t => {
  const f = await fixture(t), team = await f.enabled();
  const before = await f.socket(), cursor = before.frames.find(frame => frame.type === "subscribed")!.cursor!;
  before.ws.close(); await once(before.ws, "close");
  const input = { expected_revision: team.revision, content: "One explicitly human-started task", content_revision: 0, idempotency_key: "two-device-identical-start" };
  const accepted = await Promise.all(f.cookies.map(cookie => f.api<{ run: AgentTeamRunDetail; replayed: boolean }>(`${f.teamPath}/start`, "POST", input, cookie)));
  assert.deepEqual(accepted.map(item => item.status), [202, 202]);
  assert.equal(accepted[0]!.body!.data.run.id, accepted[1]!.body!.data.run.id);
  assert.deepEqual(accepted.map(item => item.body!.data.replayed).sort(), [false, true]);
  const id = accepted[0]!.body!.data.run.id, current = await f.stepReady(id);
  assert.equal(current.calls_used, 1);
  f.complete(current, `Synthetic result.\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: current.current_step_id, action: "complete" })}\n\`\`\``);
  await f.until(() => f.read(id), run => run.status === "completed");
  const reconnected = await f.socket(), events = reconnected.frames.flatMap(frame => frame.events ?? []);
  const missing = events.filter(event => event.sequence > cursor);
  assert.equal(missing.filter(event => event.type === "agent_request").length, 1);
  assert.equal(missing.filter(event => event.type === "agent_response").length, 1);
  const exactCursor = await f.socket(f.peerCookie, cursor), replayed = exactCursor.frames.flatMap(frame => frame.events ?? []);
  assert.deepEqual(replayed.map(event => event.id), missing.map(event => event.id));
  assert.deepEqual(replayed.map(event => event.sequence), [...replayed.map(event => event.sequence)].sort((a, b) => a - b));
  assert.equal(new Set(replayed.map(event => event.id)).size, replayed.length);
  assert.equal((await f.api(`${f.root}/agent-team-runs/${id}`, "GET", undefined, f.peerCookie)).status, 404);
  assert.deepEqual((await f.api<{ teams: unknown[] }>("/v1/agent-teams", "GET", undefined, f.peerCookie)).body!.data.teams, []);
});

test("a lost start ACK survives server restart and recovery from another device without replaying the paid call or accepting its stale completion", async t => {
  const f = await fixture(t), team = await f.enabled();
  const input = { expected_revision: team.revision, content: "Synthetic interrupted task", content_revision: 0, idempotency_key: "two-device-lost-ack-start" };
  assert.equal(await f.discardReply(`${f.teamPath}/start`, input), 202);
  const accepted = await f.api<{ run: AgentTeamRunDetail; replayed: boolean }>(`${f.teamPath}/start`, "POST", input, f.cookies[1]!);
  assert.equal(accepted.status, 202); assert.equal(accepted.body!.data.replayed, true);
  const id = accepted.body!.data.run.id, running = await f.stepReady(id);
  const oldStep = running.steps.find(step => step.id === running.current_step_id)!;
  const claim = f.server.service.claimAgentRequest(f.owner.actor, f.session.id, oldStep.request_event_id!, f.runtime.id);
  assert.equal(claim.status, "claimed");
  await f.restart();
  const recovered = await f.api<{ run: AgentTeamRunDetail; replayed: boolean }>(`${f.teamPath}/start`, "POST", input, f.cookies[1]!);
  assert.equal(recovered.status, 202); assert.equal(recovered.body!.data.replayed, true);
  assert.equal(recovered.body!.data.run.id, id); assert.equal(recovered.body!.data.run.status, "paused");
  assert.equal(recovered.body!.data.run.error_code, "server_restart"); assert.equal(recovered.body!.data.run.calls_used, 1);
  const canonical = f.server.database.requireSession(f.session.id).next_sequence;
  for (let index = 0; index < 3; index++) await f.read(id, f.cookies[1]!);
  assert.equal(f.server.database.requireSession(f.session.id).next_sequence, canonical, "Reading/replaying a receipt must not dispatch another call");
  assert.throws(() => f.server.service.completeAgentRequest(f.owner.actor, f.session.id, oldStep.request_event_id!, f.runtime.id,
    "synthetic-stale-completion", { content: "Stale output after restart" }, f.runtime.model!, undefined, claim.attempt_count), { code: "conflict" });
  const resumed = await f.api<{ run: AgentTeamRunDetail }>(`${f.root}/agent-team-runs/${id}/control`, "POST", {
    action: "resume", idempotency_key: "two-device-recovery-resume" }, f.cookies[1]!);
  assert.equal(resumed.status, 200);
  const next = await f.until(() => f.read(id), run => run.calls_used === 2 && Boolean(run.current_step_id && run.current_step_id !== oldStep.id));
  assert.notEqual(next.steps.find(step => step.id === next.current_step_id)!.request_event_id, oldStep.request_event_id);
  const nextRequest = next.steps.find(step => step.id === next.current_step_id)!.request_event_id!;
  assert.throws(() => f.server.service.claimAgentRequest(f.owner.actor, f.session.id, nextRequest, f.runtime.id), { code: "runtime_busy" },
    "Server restart alone does not prove that the previous native executor exited");
  // The synthetic executor has now exited; only its exact metadata receipt can
  // release the surviving capacity hold before the resumed native call starts.
  f.server.service.acknowledgeAgentExecutionStopped(f.owner.actor, f.session.id, oldStep.request_event_id!, f.runtime.id, claim.attempt_count!);
  f.complete(next, `Recovered result.\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: next.current_step_id, action: "complete" })}\n\`\`\``);
  const done = await f.until(() => f.read(id), run => run.status === "completed"); assert.equal(done.calls_used, 2);
  const replay = await f.api<{ run: AgentTeamRunDetail }>(`${f.root}/agent-team-runs/${id}/control`, "POST", {
    action: "resume", idempotency_key: "two-device-recovery-resume" }, f.cookies[1]!);
  assert.equal(replay.status, 200); assert.equal(replay.body!.data.run.status, "completed"); assert.equal(replay.body!.data.run.calls_used, 2);
});

test("simultaneous device edits accept one CAS winner and reject the other without replacing the saved winner", async t => {
  const f = await fixture(t), team = await f.enabled();
  const edited = await Promise.all(f.cookies.map((cookie, index) => f.api<{ team: AgentTeamDefinition }>("/v1/agent-teams/two-device-team", "PUT", {
    draft: { ...f.draft, name: `Device ${index} edit` }, expected_revision: team.revision, idempotency_key: `two-device-parallel-save-${index}` }, cookie)));
  assert.deepEqual(edited.map(item => item.status).sort(), [200, 409]);
  const winner = edited.find(item => item.status === 200)!.body!.data.team;
  const library = await f.api<{ teams: AgentTeamDefinition[] }>("/v1/agent-teams", "GET", undefined, f.cookies[1]!);
  assert.equal(library.body!.data.teams[0]!.draft.name, winner.draft.name);
  assert.equal(library.body!.data.teams[0]!.revision, winner.revision);
  assert.equal(library.body!.data.teams[0]!.enabled, false); assert.equal(library.body!.data.teams[0]!.test_status, "not_tested");
});
