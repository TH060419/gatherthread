import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient, CodexAppServerExecutor, CollaborationHttpError, LocalBridge, MemoryCursorStore, FileCursorStore,
  type CanonicalEvent, type CollaborationApi, type RuntimeRegistration } from "../src/index.js";

for (const action of ["stop", "pause", "deadline", "concurrent-stop", "deleted-session"] as const) {
  test(`native Team ${action} interrupts the actual stdio turn before releasing execution capacity`, async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), `gt-team-${action}-`)));
    const rpc = path.join(root, "rpc.jsonl"), effect = path.join(root, "effect.txt"), stopped = path.join(root, "stopped.txt");
    const fixture = path.join(root, "app-server.mjs");
    await writeFile(fixture, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let effect;
for await (const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line); if(message.method==='initialized')continue;
 appendFileSync(process.env.RPC,JSON.stringify(message)+'\\n');
 if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'owned-team-thread'}}});
 else if(message.method==='turn/start') {
   send({id:message.id,result:{turn:{id:'owned-team-turn'}}});
   effect=setInterval(()=>appendFileSync(process.env.EFFECT,'write\\n'),10);
 } else if(message.method==='turn/interrupt') {
   clearInterval(effect);send({id:message.id,result:{}});
   setTimeout(()=>{writeFileSync(process.env.STOPPED,'native stopped');send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.turnId,status:'interrupted',items:[]}}});},60);
 } else send({id:message.id,result:{}});
}



`);
    const registration: RuntimeRegistration = { sessionId: "session-1", deviceId: "device-1", harness: "codex",
      provider: "openai", model: "gpt-test", localSessionId: "local-1", captureFidelity: "harness_transcript" };
    const request: CanonicalEvent = { id: "request-1", sessionId: "session-1", sequence: 1, actorId: "user-1",
      type: "agent_request", timestamp: "2026-10-20T00:00:00.000Z", payload: { text: "fictional local test", agent_team: { run_id: "run-1" } } };
    let active = true, held = false, acknowledgments = 0, completions = 0;
    const api = {
      async registerRuntime() { return { ...registration, id: "runtime-1", userId: "user-1" }; },
      async listSessions() { return []; },
      async readEvents(_session: string, after: number) { const events = after < 1 ? [request] : []; return { events, nextSequence: 1, hasMore: false }; },
      async readContext() { return { view: "original", through_sequence: 0, items: [], content_revision: 0 }; },
      async claimAgentRequest(_session: string, requestId: string, runtimeId: string) {
        if (held && requestId !== request.id) throw new CollaborationHttpError(409, "Native capacity remains occupied", "runtime_busy");
        held = true; return { claimed: true, status: "claimed", requestId, runtimeId, attemptCount: 1 };
      },
      async readAgentExecution() {
        if (!active && action === "deleted-session") throw new CollaborationHttpError(404, "session removed");
        return { active };
      },
      async acknowledgeAgentExecutionStopped() {
        assert.equal(await readFile(stopped, "utf8"), "native stopped", "control acceptance is not native exit confirmation");
        held = false; acknowledgments += 1;
      },
      async appendAgentProgress() { return { ...request, id: "progress-1", sequence: 2, type: "agent_progress" }; },
      async completeAgentRequest() { completions += 1; throw new Error("Canceled work must not complete"); },
      async appendEvent() { throw new Error("Canceled work must not publish"); },
    } as unknown as CollaborationApi;
    const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fixture], cwd: root,
      env: { ...process.env, RPC: rpc, EFFECT: effect, STOPPED: stopped }, turnTimeoutMs: 6000 });
    t.after(() => client.dispose());
    const executor = new CodexAppServerExecutor({ client, workspacePath: root, statePath: path.join(root, "state.json"),
      threadName: "Team cancellation fixture", model: "gpt-test", threadSource: "exec" });
    const bridge = new LocalBridge({ api, cursorStore: new MemoryCursorStore(), runtime: registration, transcriptRoots: {} });
    await bridge.connect();
    const turn = bridge.processAgentRequest(request, executor);
    const rejected = assert.rejects(turn, (error: unknown) => error instanceof CollaborationHttpError && error.code === "agent_execution_cancelled");
    const until = Date.now() + 4000;
    while (!(await readFile(rpc, "utf8").catch(() => "")).includes('"method":"turn/start"')) {
      assert.ok(Date.now() < until, "native stdio turn must actually start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let duplicateError: unknown;
    if (action === "concurrent-stop") {
      // A repeated exact claim is idempotent server-side. The second executor
      // fails its writer lock while the first native turn is still running.
      await bridge.processAgentRequest(request, executor).catch((error: unknown) => { duplicateError = error; });
    }
    active = false;
    await assert.rejects(api.claimAgentRequest("session-1", "request-2", "runtime-1"), /capacity/);
    assert.equal(acknowledgments, 0);
    await rejected;
    assert.equal(acknowledgments, 1); assert.equal(held, false); assert.equal(completions, 0);
    const calls = (await readFile(rpc, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((message) => message.method === "turn/interrupt").length, 1);
    const writes = await readFile(effect, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await readFile(effect, "utf8"), writes, "no filesystem effects may continue after stop is acknowledged");
    assert.equal((await api.claimAgentRequest("session-1", "request-2", "runtime-1")).claimed, true);
    if (action === "concurrent-stop") assert.match(String(duplicateError), /process-local writer/,
      "a refused duplicate writer must not attempt native exit acknowledgment");
  });
}

test("cancellation during a lost turn/start reply closes the actual native process before returning", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-team-lost-native-start-")));
  const started = path.join(root, "started"), stopped = path.join(root, "stopped"), fixture = path.join(root, "app-server.mjs");
  await writeFile(fixture, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
process.on('SIGTERM',()=>{setTimeout(()=>{writeFileSync(process.env.STOPPED,'exited');process.exit(0);},60);});
for await (const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line);if(message.method==='initialized')continue;
 if(message.method==='turn/start'){writeFileSync(process.env.STARTED,JSON.stringify({pid:process.pid}));continue;}
 send({id:message.id,result:{}});
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fixture], cwd: root,
    env: { ...process.env, STARTED: started, STOPPED: stopped }, requestTimeoutMs: 2500, turnTimeoutMs: 5000 });
  t.after(() => client.dispose());
  const controller = new AbortController();
  const turn = client.runTurn({ threadId: "owned-thread", prompt: "fictional test", clientUserMessageId: "request-1", signal: controller.signal });
  const rejected = assert.rejects(turn, /closing|abort/i);
  const until = Date.now() + 3000;
  while (!(await readFile(started, "utf8").catch(() => ""))) {
    assert.ok(Date.now() < until); await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort(new Error("fixture stopped before start receipt"));
  await rejected;
  if (process.platform === "win32") {
    const native = JSON.parse(await readFile(started, "utf8"));
    assert.throws(() => process.kill(native.pid, 0), "Windows cancellation must reap the real child before returning");
  } else assert.equal(await readFile(stopped, "utf8"), "exited", "returning from cancellation must await process close");
});

for (const source of ["cursor", "journal"] as const) {
test(`AppServer ${source} exit recovery precedes registration of a deleted session`, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-appserver-exit-recovery-")));
  const fixture = path.join(root, "app-server.mjs"), calls = path.join(root, "calls.jsonl");
  await writeFile(fixture, `
import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.method==='initialized')continue;appendFileSync(process.env.CALLS,JSON.stringify(m)+'\\n');
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'owned-thread'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'owned-turn'}}});
  send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'owned-turn',status:'completed',items:[{type:'agentMessage',id:'answer-1',text:'fixture answer'}]}}});
 }else send({id:m.id,result:{}});
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fixture], cwd: root, env: { ...process.env, CALLS: calls } });
  t.after(() => client.dispose());
  const runtime = { id: "runtime-1", userId: "user-1", sessionId: "session-1", deviceId: "device-1", harness: "codex" as const,
    provider: "openai", model: "gpt-fixture", localSessionId: "local-1", captureFidelity: "harness_transcript" as const };
  const request: CanonicalEvent = { id: "request-1", sessionId: runtime.sessionId, actorId: runtime.userId, sequence: 1,
    type: "agent_request", timestamp: "2026-10-20T00:00:00.000Z", payload: { text: "fictional request", agent_team: {} } };
  const executor = () => new CodexAppServerExecutor({ client, workspacePath: root, statePath: path.join(root, "state.json"), threadName: "fixture", model: runtime.model, threadSource: "exec" });
  await executor().execute({ request, runtime, claimAttempt: 2, canonicalHistory: [request] });
  const store = new FileCursorStore(path.join(root, "cursor.json"));
  if (source === "cursor") await store.save({ server: {}, local: {}, stoppedExecutions: [{ sessionId: runtime.sessionId, requestId: request.id, runtimeId: runtime.id, claimAttempt: 2 }] });
  let acknowledgments = 0;
  const api = {
    async acknowledgeAgentExecutionStopped(sessionId: string, requestId: string, runtimeId: string, attempt: number) {
      assert.deepEqual([sessionId, requestId, runtimeId, attempt], [runtime.sessionId, request.id, runtime.id, 2]); acknowledgments++;
    },
    async registerRuntime() { assert.equal(acknowledgments, 1); throw new CollaborationHttpError(404, "session deleted"); },
  } as unknown as CollaborationApi;
  const bridge = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} });
  await assert.rejects(bridge.connect(executor()), /session deleted/);
  assert.deepEqual((await store.load()).stoppedExecutions, []);
  assert.deepEqual(await executor().readStoppedExecutions(), []);
  assert.equal((await readFile(calls, "utf8")).split("\n").filter((line) => line.includes('"method":"turn/start"')).length, 1,
    "metadata-only recovery must never repeat the paid turn");
});
}
