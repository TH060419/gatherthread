import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient, CodexAppServerExecutor, type CanonicalEvent } from "../src/index.js";

for (const mode of ["present", "lost-start", "lost-interrupt", "stale-terminal", "typed-stale-lost-start", "typed-stale-ack", "executor"] as const) {
test(`canceling native preparation compaction preserves another live thread (${mode})`, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-compact-cancel-")));
  const fixture = path.join(root, "app-server.mjs"), compactEffect = path.join(root, "compact.txt"), otherEffect = path.join(root, "other.txt");
  const rpc = path.join(root, "rpc.jsonl");
  await writeFile(fixture, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const effects=new Map();
for await (const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line);if(message.method==='initialized')continue;
 appendFileSync(process.env.RPC,JSON.stringify(message)+'\\n');
 if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'compact-thread'}}});
 else if(message.method==='thread/read')send({id:message.id,result:{thread:{id:message.params.threadId,status:{type:'idle'},turns:[]}}});
 else if(message.method==='turn/start'){
   effects.set('other-thread',setInterval(()=>appendFileSync(process.env.OTHER,'work\\n'),10));
   send({id:message.id,result:{turn:{id:'other-turn'}}});
 }else if(message.method==='thread/compact/start'){
   effects.set('compact-thread',setInterval(()=>appendFileSync(process.env.COMPACT,'work\\n'),10));
   if(process.env.MODE!=='lost-start'&&process.env.MODE!=='typed-stale-lost-start')send({id:message.id,result:{}});
   if(process.env.MODE==='stale-terminal')send({method:'turn/completed',params:{threadId:'compact-thread',turn:{id:'old-turn',status:'failed',items:[]}}});
   if(process.env.MODE.startsWith('typed-stale'))send({method:'item/completed',params:{threadId:'compact-thread',turnId:'old-compact',item:{type:'contextCompaction'}}});
   setTimeout(()=>send({method:'item/started',params:{threadId:'compact-thread',turnId:'compact-turn',item:{type:'contextCompaction'}}}),process.env.MODE.includes('stale')?20:0);
 }else if(message.method==='turn/interrupt'){
   clearInterval(effects.get(message.params.threadId));if(process.env.MODE!=='lost-interrupt')send({id:message.id,result:{}});
   setTimeout(()=>send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.turnId,status:'interrupted',items:[]}}}),20);
 }else send({id:message.id,result:{}});
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fixture], cwd: root,
    env: { ...process.env, MODE: mode, RPC: rpc, COMPACT: compactEffect, OTHER: otherEffect }, requestTimeoutMs: 2500, turnTimeoutMs: 6000 });
  t.after(() => client.dispose());
  const otherAbort = new AbortController(), compactAbort = new AbortController();
  let otherSettled = false;
  const other = client.runTurn({ threadId: "other-thread", prompt: "other fictional task", clientUserMessageId: "other-request", signal: otherAbort.signal })
    .then(() => { otherSettled = true; }, () => { otherSettled = true; });
  const history: CanonicalEvent = { id: "history-1", sessionId: "session-1", sequence: 1, actorId: "user-1", type: "human_chat",
    timestamp: "2026-10-20T00:00:00.000Z", payload: { text: "synthetic context ".repeat(1500) } };
  const request: CanonicalEvent = { ...history, id: "request-2", sequence: 2, type: "agent_request", payload: { text: "fictional preparation cancellation", agent_team: {} } };
  const preparing = mode === "executor" ? new CodexAppServerExecutor({ client, workspacePath: root, statePath: path.join(root, "state.json"),
    threadName: "compaction preparation fixture", model: "gpt-test", contextWindowTokens: 4096, maxInjectionItemBytes: 1024, threadSource: "exec" })
    .execute({ request, canonicalHistory: [history, request], claimAttempt: 1, signal: compactAbort.signal, runtime: { id: "runtime-1", userId: "user-1", sessionId: "session-1",
      deviceId: "device-1", harness: "codex", provider: "openai", model: "gpt-test", localSessionId: "owned-local", captureFidelity: "harness_transcript" } })
    : client.compactThread("compact-thread", compactAbort.signal);
  const compact = preparing
    .then(() => undefined, (error: unknown) => error);
  const deadline = Date.now() + 4000;
  while ((await readFile(compactEffect, "utf8").catch(() => "")).length < (mode.includes("stale") ? 25 : 1)) {
    assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5));
  }
  compactAbort.abort(new Error("compact fixture aborted"));
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([compact.then(() => true), new Promise<boolean>((resolve) => { waitTimer = setTimeout(() => resolve(false), 1000); })]);
  clearTimeout(waitTimer);
  if (!settled) await client.close();
  const error = await compact;
  const otherWasStillRunning = !otherSettled;
  const compactWrites = await readFile(compactEffect, "utf8"), otherWrites = await readFile(otherEffect, "utf8").catch(() => "");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const otherContinued = (await readFile(otherEffect, "utf8").catch(() => "")).length > otherWrites.length;
  if (mode.includes("lost")) await new Promise((resolve) => setTimeout(resolve, 2600));
  const otherSurvivedReceiptBudget = !otherSettled;
  otherAbort.abort(new Error("other fixture aborted")); await other;
  assert.equal(settled, true, "AbortSignal must interrupt preparation compaction before its ordinary native timeout");
  assert.ok(error instanceof Error);
  assert.equal(await readFile(compactEffect, "utf8"), compactWrites, "canceled compaction must stop its native work before returning");
  assert.equal(otherWasStillRunning, true, "a known compaction turn must not require closing the shared App Server");
  assert.equal(otherContinued, true);
  assert.equal(otherSurvivedReceiptBudget, true, "abandoned start/interrupt receipts must not later time out the shared native process");
  const calls = (await readFile(rpc, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((message) => message.method === "turn/interrupt" && message.params.threadId === "compact-thread" && message.params.turnId === "compact-turn"));
  if (mode === "executor") assert.equal(calls.some((message) => message.method === "turn/start" && message.params.threadId === "compact-thread"), false,
    "canceling during actual executor preparation must not start its paid task turn afterward");
});
}

test("an explicit unsupported-compaction refusal preserves unrelated native work", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-compact-unsupported-")));
  const fixture = path.join(root, "app-server.mjs"), effect = path.join(root, "other.txt");
  await writeFile(fixture, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let timer;
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.method==='initialized')continue;
 if(m.method==='turn/start'){timer=setInterval(()=>appendFileSync(process.env.EFFECT,'work\\n'),10);send({id:m.id,result:{turn:{id:'other-turn'}}});}
 else if(m.method==='thread/compact/start')send({id:m.id,error:{code:-32601,message:'Method not found'}});
 else if(m.method==='turn/interrupt'){clearInterval(timer);send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted',items:[]}}});}
 else send({id:m.id,result:{}});
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fixture], cwd: root,
    env: { ...process.env, EFFECT: effect }, requestTimeoutMs: 3000, turnTimeoutMs: 5000 });
  t.after(() => client.dispose());
  const abort = new AbortController();
  let otherSettled = false;
  const other = client.runTurn({ threadId: "other-thread", prompt: "fictional task", clientUserMessageId: "request-1", signal: abort.signal })
    .then(() => { otherSettled = true; }, () => { otherSettled = true; });
  const deadline = Date.now() + 4000;
  while (!(await readFile(effect, "utf8").catch(() => ""))) {
    assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(client.compactThread("compact-thread"), /Method not found/);
  const before = await readFile(effect, "utf8"); await new Promise((resolve) => setTimeout(resolve, 60));
  const continued = !otherSettled && (await readFile(effect, "utf8")).length > before.length;
  abort.abort(); await other;
  assert.equal(continued, true, "a version refusal proves no compaction started; it must not terminate another live thread");
});

for (const receipt of ["ack", "lost"] as const) {
test(`unbound legacy compaction completion cannot acknowledge native exit (${receipt} start receipt)`, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-compact-unbound-")));
  const fixture = path.join(root, "app-server.mjs"), effect = path.join(root, "effect.txt"), stopped = path.join(root, "stopped.txt");
  await writeFile(fixture, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let timer;
process.on('SIGTERM',()=>{clearInterval(timer);setTimeout(()=>{writeFileSync(process.env.STOPPED,'exited');process.exit(0);},40);});
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.method==='initialized')continue;
 if(m.method==='thread/compact/start'){
  writeFileSync(process.env.EFFECT,JSON.stringify({pid:process.pid})+'\\n');
  timer=setInterval(()=>appendFileSync(process.env.EFFECT,'work\\n'),10);
  send({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'contextCompaction'}}});
  if(process.env.RECEIPT==='ack')send({id:m.id,result:{}});
 }else send({id:m.id,result:{}});
}
`);
  const client = new CodexAppServerClient({ command: process.execPath, commandArgs: [fixture], cwd: root,
    env: { ...process.env, EFFECT: effect, STOPPED: stopped, RECEIPT: receipt }, requestTimeoutMs: 2500, turnTimeoutMs: 5000 });
  t.after(() => client.dispose());
  const controller = new AbortController();
  const compact = client.compactThread("owned-thread", controller.signal).then(() => undefined, (error: unknown) => error);
  const deadline = Date.now() + 3000;
  while (!(await readFile(effect, "utf8").catch(() => ""))) {
    assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (receipt === "lost") controller.abort(new Error("fixture stopped"));
  assert.ok(await compact instanceof Error, "an unbound completion cannot return success for a cancelable native operation");
  const before = await readFile(effect, "utf8");
  if (process.platform === "win32") {
    const native = JSON.parse(before.split("\n")[0]!);
    assert.throws(() => process.kill(native.pid, 0), "native child must actually exit before acknowledgment");
  } else assert.equal(await readFile(stopped, "utf8"), "exited", "a typed legacy marker is not an actual process-exit fence");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await readFile(effect, "utf8"), before);
});
}
