import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CodexAppServerClient, CodexAppServerExecutor, HarnessExecutionTerminatedError, HarnessExecutionUnconfirmedError,
  type CanonicalEvent, type HarnessExecutionInput } from "../src/index.js";

async function fixture(t: TestContext, mode: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "gt-native-evidence-")), state = path.join(directory, "state.json");
  const worker = path.join(directory, "worker.mjs"), calls = path.join(directory, "calls.jsonl"), waiting = path.join(directory, "waiting");
  await writeFile(worker, `
import{appendFileSync,writeFileSync}from'node:fs';import{createInterface}from'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.method==='initialized')continue;appendFileSync(process.env.CALLS,JSON.stringify(m)+'\\n');
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'owned-thread'}}});
 else if(m.method==='turn/start'||m.method==='thread/compact/start'){
  if(process.env.MODE.startsWith('unknown')){writeFileSync(process.env.WAITING,'active');continue;}
  send({id:m.id,result:{turn:{id:'owned-turn'}}});
  send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'owned-turn',status:'completed',items:process.env.MODE==='invalid'?[]:[{id:'answer-1',type:'agentMessage',text:'fixture answer'}]}}});
 }else if(m.method==='thread/unsubscribe'&&process.env.MODE==='unsubscribe')send({id:m.id,error:{code:-32603,message:'PRIVATE_UNSUBSCRIBE_FAILURE'}});
 else send({id:m.id,result:{}});
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [worker], cwd: directory,
    env: { ...process.env, MODE: mode, CALLS: calls, WAITING: waiting, STATE: state }, requestTimeoutMs: 5000, turnTimeoutMs: 6000 });
  t.after(async () => { try { await client.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } });
  if (mode === "state-save") {
    const runNativeTurn = client.runTurn.bind(client);
    client.runTurn = async (input) => {
      // Inject the save failure only after the real RPC client has observed
      // the matching terminal, never while onStarted is still persisting.
      const completed = await runNativeTurn(input);
      await rm(state); await mkdir(state);
      return completed;
    };
  }
  const runtime = { id: "runtime-1", sessionId: "session-1", userId: "user-1", deviceId: "device-1", harness: "codex" as const,
    provider: "openai", model: "gpt-fixture", localSessionId: "local-1", captureFidelity: "harness_transcript" as const };
  const request: CanonicalEvent = { id: "request-1", sequence: 1, sessionId: runtime.sessionId, actorId: runtime.userId,
    type: "agent_request", timestamp: "2026-10-20T00:00:00.000Z", payload: { text: "fictional local test", agent_team: {} } };
  const executor = new CodexAppServerExecutor({ client, workspacePath: directory, statePath: state, model: runtime.model,
    threadName: "fixture", threadSource: mode === "unsubscribe" ? "vscode" : "exec", contextWindowTokens: mode === "unknown-compact" ? 4096 : 128000,
    ...(mode === "reveal" ? { revealThread: async () => { throw new Error("PRIVATE_REVEAL_FAILURE"); } } : {}) });
  return { executor, runtime, request, calls, waiting, state };
}

for (const windowsStub of [false, true]) {
for (const mode of ["invalid", "unsubscribe", "state-save", "reveal"]) {
  test(`confirmed native completion preserves exact exit evidence through ${mode} postprocessing${windowsStub ? " (Windows semantics)" : ""}`, async (t) => {
    if (windowsStub) {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
      t.after(() => { Object.defineProperty(process, "platform", descriptor); });
    }
    const f = await fixture(t, mode), input: HarnessExecutionInput = { request: f.request, runtime: f.runtime, claimAttempt: 2, canonicalHistory: [f.request] };
    const result = await f.executor.execute(input).catch((error: unknown) => error);
    if (mode === "reveal" || mode === "unsubscribe") assert.equal((result as any).events.at(-1)?.content, "fixture answer");
    else {
      assert.ok(result instanceof HarnessExecutionTerminatedError, String(result)); assert.equal(result.failureCode, "codex_postprocessing_failed");
      assert.doesNotMatch(result.publicMessage + JSON.stringify(result), /PRIVATE_/);
    }
    assert.deepEqual(await f.executor.readStoppedExecutions(), [{ sessionId: f.runtime.sessionId, requestId: f.request.id, runtimeId: f.runtime.id, claimAttempt: 2 }]);
    await f.executor.execute(input).catch(() => undefined);
    assert.equal((await readFile(f.calls, "utf8")).split("\n").filter((line) => line.includes('"method":"turn/start"')).length, 1);
  });
}
}

for (const mode of ["unknown-run", "unknown-compact"]) {
  test(`Windows ${mode} fallback never upgrades process close into a Team exit acknowledgment`, async (t) => {
    const f = await fixture(t, mode), controller = new AbortController();
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      const history: CanonicalEvent = { ...f.request, id: "history-1", sequence: 1, type: "human_chat", payload: { text: "synthetic context ".repeat(1500) } };
      const request = mode === "unknown-compact" ? { ...f.request, sequence: 2 } : f.request;
      const result = f.executor.execute({ request, runtime: f.runtime, claimAttempt: 2, canonicalHistory: mode === "unknown-compact" ? [history, request] : [request], signal: controller.signal }).catch((error: unknown) => error);
      const deadline = Date.now() + 4000;
      while (!(await readFile(f.waiting, "utf8").catch(() => ""))) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5)); }
      controller.abort(new Error("fixture stop"));
      assert.ok(await result instanceof HarnessExecutionUnconfirmedError);
      assert.deepEqual(await f.executor.readStoppedExecutions(), [], "aborted outer and inner catches must retain unknown ownership");
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });
}

test("a pre-dispatch abort cannot relabel an old unowned native journal as an exact exited attempt", async (t) => {
  const f = await fixture(t, "success");
  const ordinary = { ...f.request, payload: { text: "ordinary fixture" } };
  await f.executor.execute({ request: ordinary, runtime: f.runtime, canonicalHistory: [ordinary] });
  const state = JSON.parse(await readFile(f.state, "utf8"));
  state.executionJournal[f.request.id] = { requestId: f.request.id, status: "started", turnId: "old-unconfirmed-turn" };
  await writeFile(f.state, JSON.stringify(state));
  const controller = new AbortController(); controller.abort(new Error("prepare canceled"));
  await assert.rejects(f.executor.execute({ request: f.request, runtime: f.runtime, claimAttempt: 2, canonicalHistory: [f.request], signal: controller.signal }), HarnessExecutionUnconfirmedError);
  assert.deepEqual(await f.executor.readStoppedExecutions(), []);
  assert.equal((await readFile(f.calls, "utf8")).split("\n").filter((line) => line.includes('"method":"turn/start"')).length, 1);
});
