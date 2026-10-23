import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, truncate } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CodexCliExecutor, CodexAppServerClient, CodexAppServerExecutor, SubprocessHarnessExecutor, HarnessExecutionTerminatedError, HarnessExecutionUnconfirmedError,
  CollaborationHttpError, FileCursorStore, LocalBridge,
  type CanonicalEvent, type CollaborationApi, type CompleteAgentRequestInput, type HarnessExecutionInput, type HarnessExecutor, type RegisteredRuntime } from "../src/index.js";

const runtime: RegisteredRuntime = { id: "runtime-process-1", userId: "user-1", sessionId: "session-1", deviceId: "device-1",
  harness: "codex", provider: "openai", model: "gpt-fixture", localSessionId: "local-1", captureFidelity: "harness_transcript" };
const request: CanonicalEvent = { id: "request-1", sessionId: runtime.sessionId, sequence: 1, actorId: runtime.userId,
  type: "agent_request", timestamp: "2026-10-20T00:00:00.000Z", payload: { text: "fictional local process test", agent_team: {} } };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function processFixture(t: TestContext, kind: "cli" | "adapter", options: { mode?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; maxPromptBytes?: number; command?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), `gt-${kind}-control-`));
  const worker = path.join(directory, "worker.mjs"), started = path.join(directory, "started.json"), stopped = path.join(directory, "stopped"), effect = path.join(directory, "effect.txt"), starts = path.join(directory, "starts.jsonl"), descendant = path.join(directory, "descendant.json");
  t.after(async () => {
    try {
      const native = await readFile(started, "utf8").then(JSON.parse).catch(() => undefined);
      if (native) { try { process.kill(native.pid, "SIGKILL"); } catch {} }
      const child = await readFile(descendant, "utf8").then(JSON.parse).catch(() => undefined);
      if (child) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await writeFile(worker, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let input='';for await(const chunk of process.stdin)input+=chunk;
if(process.env.MODE==='descendant')spawn(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync(process.env.DESCENDANT,JSON.stringify({pid:process.pid}));setInterval(()=>fs.appendFileSync(process.env.EFFECT,'child work\\\\n'),10)"],{stdio:'ignore'});
appendFileSync(process.env.STARTS,JSON.stringify({pid:process.pid})+'\\n');
writeFileSync(process.env.EFFECT,'work\\n');
const timer=setInterval(()=>appendFileSync(process.env.EFFECT,'work\\n'),10);
process.on('SIGTERM',()=>{setTimeout(()=>{clearInterval(timer);writeFileSync(process.env.STOPPED,'exited');process.exit(0);},90);});
writeFileSync(process.env.STARTED,JSON.stringify({pid:process.pid}));
if(process.env.MODE==='success'){
 clearInterval(timer);writeFileSync(process.env.STOPPED,'exited');
 if(process.env.KIND==='adapter')process.stdout.write(JSON.stringify({events:[{kind:'assistant',localEventId:'answer-1',harness:'codex',captureFidelity:'harness_transcript',content:'fixture answer'}]}));
 else for(const event of [{type:'thread.started',thread_id:'fixture-thread'},{type:'item.completed',item:{id:'answer-1',type:'agent_message',text:'fixture answer'}},{type:'turn.completed'}])process.stdout.write(JSON.stringify(event)+'\\n');
 process.exit(0);
}else if(process.env.MODE==='failed'){clearInterval(timer);writeFileSync(process.env.STOPPED,'exited');process.stderr.write('PRIVATE_PROVIDER_FAILURE');process.exit(7);}
else if(process.env.MODE==='invalid'){clearInterval(timer);writeFileSync(process.env.STOPPED,'exited');process.stdout.write('INVALID_PRIVATE_OUTPUT');process.exit(0);}
else if(process.env.MODE==='flood')process.stdout.write('PRIVATE_OVER_LIMIT_OUTPUT'.repeat(300));
`);
  const common = { command: options.command ?? process.execPath, timeoutMs: options.timeoutMs ?? 1500,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    env: { ...process.env, STARTED: started, STOPPED: stopped, EFFECT: effect, STARTS: starts, DESCENDANT: descendant, KIND: kind, MODE: options.mode ?? "running" } };
  const journalPath = kind === "cli" ? path.join(directory, "state.json.execution.json") : path.join(directory, "execution.json");
  const createExecutor = (): HarnessExecutor => kind === "cli"
    ? new CodexCliExecutor({ ...common, commandArgs: [worker], workspacePath: directory, statePath: path.join(directory, "state.json"), model: runtime.model,
      ...(options.maxPromptBytes === undefined ? {} : { maxPromptBytes: options.maxPromptBytes }) })
    : new SubprocessHarnessExecutor({ ...common, args: [worker], harness: "codex", executionStatePath: journalPath });
  const executor = createExecutor();
  return { executor, createExecutor, directory, started, effect, stopped, starts, journalPath, descendant,
    async waitStarted() {
      const deadline = Date.now() + 3000;
      while (!(await readFile(started, "utf8").catch(() => ""))) { assert.ok(Date.now() < deadline, "controlled native worker must start"); await sleep(5); }
    },
    async assertExited() {
      const native = JSON.parse(await readFile(started, "utf8"));
      assert.throws(() => process.kill(native.pid, 0), "native child must be reaped before exit acknowledgment");
      if (process.platform !== "win32") assert.equal(await readFile(stopped, "utf8"), "exited");
      const before = await readFile(effect, "utf8"); await sleep(50);
      assert.equal(await readFile(effect, "utf8"), before, "native side effects must stop before settlement");
    } };
}

for (const kind of ["cli", "adapter"] as const) {
  test(`${kind} cancellation stops the owned native descendants before physical-exit evidence`, { skip: process.platform === "win32" }, async (t) => {
    const fixture = await processFixture(t, kind, { mode: "descendant" });
    const controller = new AbortController();
    const turn = fixture.executor.execute({ request, canonicalHistory: [request], runtime, claimAttempt: 2, signal: controller.signal }).catch((error: unknown) => error);
    await fixture.waitStarted();
    const deadline = Date.now() + 3000;
    while (!(await readFile(fixture.descendant, "utf8").catch(() => ""))) { assert.ok(Date.now() < deadline); await sleep(5); }
    controller.abort();
    assert.ok(await turn instanceof HarnessExecutionTerminatedError);
    await fixture.assertExited();
    const child = JSON.parse(await readFile(fixture.descendant, "utf8"));
    assert.throws(() => process.kill(child.pid, 0), "an owned descendant cannot continue after native exit is acknowledged");
  });
}

for (const kind of ["cli", "adapter"] as const) {
  for (const source of ["cursor", "journal"] as const) {
    test(`${kind} ${source} exits recover before a deleted-session registration can reject startup`, async (t) => {
      const fixture = await processFixture(t, kind, { mode: "success" });
      await fixture.executor.execute({ request, canonicalHistory: [request], runtime, claimAttempt: 2 }); await fixture.assertExited();
      const store = new FileCursorStore(path.join(fixture.directory, "cursor.json"));
      const receipt = { sessionId: runtime.sessionId, requestId: request.id, runtimeId: runtime.id, claimAttempt: 2 };
      if (source === "cursor") await store.save({ server: {}, local: {}, stoppedExecutions: [receipt] });
      let acknowledged = 0;
      const api = {
        async acknowledgeAgentExecutionStopped(sessionId: string, requestId: string, runtimeId: string, attempt: number) {
          await fixture.assertExited(); assert.deepEqual([sessionId, requestId, runtimeId, attempt], [runtime.sessionId, request.id, runtime.id, 2]); acknowledged++;
        },
        async registerRuntime() { assert.equal(acknowledged, 1, "old execution cleanup must precede registration permission checks"); throw new CollaborationHttpError(404, "original session deleted"); },
      } as unknown as CollaborationApi;
      const bridge = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} });
      await assert.rejects(bridge.connect(fixture.createExecutor()), /original session deleted/);
      assert.equal(acknowledged, 1); assert.deepEqual((await store.load()).stoppedExecutions, []);
      assert.deepEqual(await fixture.createExecutor().readStoppedExecutions!(), []);
      assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1);
    });
  }
  for (const terminal of ["agent_request_failed", "agent_request_already_completed"] as const) {
    test(`${kind} canonical ${terminal} consumes polling without guessing a receipt generation to prune`, { skip: process.platform === "win32" }, async (t) => {
      const fixture = await processFixture(t, kind, { mode: "success" });
      await fixture.executor.execute({ request, canonicalHistory: [request], runtime, claimAttempt: 2 }); await fixture.assertExited();
      const store = new FileCursorStore(path.join(fixture.directory, "cursor.json"));
      let acknowledged = 0;
      const api = {
        async registerRuntime() { return runtime; },
        async readEvents(_session: string, after: number) { return { events: after < 1 ? [request] : [], nextSequence: 1, hasMore: false }; },
        async claimAgentRequest() { throw new CollaborationHttpError(409, "canonical request is terminal", terminal); },
        async readAgentExecution() { return { active: false }; }, async acknowledgeAgentExecutionStopped() { acknowledged++; },
      } as unknown as CollaborationApi;
      const recovered = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} }); await recovered.connect(fixture.createExecutor());
      assert.deepEqual(await recovered.processPendingAgentRequests(fixture.createExecutor()), { examined: 1, claimed: 0, completed: 0 });
      assert.equal(acknowledged, 1); assert.equal((await store.load()).server[runtime.sessionId], 1);
      const retained = Object.values<any>(JSON.parse(await readFile(fixture.journalPath, "utf8")).entries);
      assert.equal(retained.length, 1); assert.equal(retained[0]?.exitAcknowledged, true);
      assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1);
    });
  }
  for (const mode of ["success", "invalid"] as const) {
    test(`${kind} ${mode} exit survives a crash before the Bridge cursor receipt exists`, { skip: process.platform === "win32" }, async (t) => {
      const fixture = await processFixture(t, kind, { mode });
      const outcome = await fixture.executor.execute({ request, canonicalHistory: [request], runtime, claimAttempt: 2 }).catch((error: unknown) => error);
      if (mode === "invalid") assert.ok(outcome instanceof HarnessExecutionTerminatedError);
      await fixture.assertExited();
      const store = new FileCursorStore(path.join(fixture.directory, "cursor.json"));
      assert.equal((await store.load()).stoppedExecutions, undefined, "simulate a connector crash before cursor receipt persistence");
      let acknowledged = 0, claimCalls = 0, held = true;
      const api = {
        async registerRuntime() { return runtime; },
        async acknowledgeAgentExecutionStopped(sessionId: string, requestId: string, runtimeId: string, claimAttempt: number) {
          await fixture.assertExited();
          assert.deepEqual((await store.load()).stoppedExecutions, [{ sessionId, requestId, runtimeId, claimAttempt }]);
          assert.deepEqual([sessionId, requestId, runtimeId, claimAttempt], [runtime.sessionId, request.id, runtime.id, 2]);
          acknowledged++; held = false;
        },
        async claimAgentRequest() {
          assert.equal(held, false, "recover physical exit before trying another claim"); claimCalls++;
          return { claimed: false, status: "paused", requestId: request.id, runtimeId: runtime.id, attemptCount: 2 };
        },
        async readAgentExecution() { return { active: false }; },
        async readEvents() { throw new Error("paused exit recovery must not need history contents"); },
      } as unknown as CollaborationApi;
      const recovered = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} }); await recovered.connect();
      assert.deepEqual(await recovered.processAgentRequest(request, fixture.createExecutor()), { claimed: false, completed: [] });
      assert.equal(acknowledged, 1); assert.equal(claimCalls, 1);
      assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1);
      assert.deepEqual(JSON.parse(await readFile(fixture.journalPath, "utf8")).entries, {}, "a confirmed paused exact attempt can retire its already-ACKed replay cache");
    });
  }
  test(`${kind} output limits and failed spawn also produce evidence only after owned process cleanup`, async (t) => {
    const fixture = await processFixture(t, kind, { mode: "flood", maxOutputBytes: 1024 });
    const input: HarnessExecutionInput = { request, canonicalHistory: [request], runtime, claimAttempt: 2 };
    const failure = await fixture.executor.execute(input).catch((error: unknown) => error);
    assert.ok(failure instanceof HarnessExecutionTerminatedError); assert.match(failure.failureCode, /output_limit/);
    await fixture.assertExited();
    assert.doesNotMatch(failure.publicMessage + JSON.stringify(failure), /PRIVATE_OVER_LIMIT_OUTPUT/);
    const missing = await processFixture(t, kind, { command: path.join(fixture.directory, "nonexistent-executable") });
    const notStarted = await missing.executor.execute(input).catch((error: unknown) => error);
    assert.ok(notStarted instanceof HarnessExecutionTerminatedError); assert.match(notStarted.failureCode, /start_failed/);
    await assert.rejects(readFile(missing.started), /ENOENT/);
    assert.equal(Object.values<any>(JSON.parse(await readFile(missing.journalPath, "utf8")).entries)[0]?.phase, "settled");
  });
  test(`${kind} an already canceled execution never starts a new process or invents an exit receipt`, async (t) => {
    const fixture = await processFixture(t, kind);
    const controller = new AbortController(), reason = new Error("pre-dispatch fixture cancellation"); controller.abort(reason);
    const failure = await fixture.executor.execute({ request, canonicalHistory: [request], runtime, claimAttempt: 2, signal: controller.signal }).catch((error: unknown) => error);
    assert.equal(failure, reason); assert.ok(!(failure instanceof HarnessExecutionTerminatedError));
    await assert.rejects(readFile(fixture.started), /ENOENT/);
  });
  test(`${kind} bounded recovery storage never evicts old accepted evidence to run another process`, async (t) => {
    const fixture = await processFixture(t, kind, { mode: "success" });
    const entries = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
      const requestId = `old-request-${index}`;
      const key = createHash("sha256").update(JSON.stringify([runtime.sessionId, runtime.id, requestId, 1])).digest("hex");
      return [key, { sessionId: runtime.sessionId, runtimeId: runtime.id, requestId, claimAttempt: 1, fingerprint: "0".repeat(64),
        phase: "settled", failure: { code: "harness_execution_cancelled", message: "Native process exited after cancellation." } }];
    }));
    const body = JSON.stringify({ version: 1, entries }); await writeFile(fixture.journalPath, body);
    const input: HarnessExecutionInput = { request, canonicalHistory: [request], runtime, claimAttempt: 2 };
    await assert.rejects(fixture.executor.execute(input), /recovery storage is full/);
    assert.equal(await readFile(fixture.journalPath, "utf8"), body, "admission cannot discard any replay evidence");
    await assert.rejects(readFile(fixture.started), /ENOENT/);
    await fixture.executor.acknowledgeCanonicalCompletion!({ ...request, id: "old-request-0" }, runtime, 1);
    assert.equal((await fixture.executor.execute(input)).events.at(-1)?.content, "fixture answer");
    assert.equal(Object.keys(JSON.parse(await readFile(fixture.journalPath, "utf8")).entries).length, 1000);
    await fixture.executor.acknowledgeCanonicalCompletion!(request, runtime, 2);
    assert.equal(Object.keys(JSON.parse(await readFile(fixture.journalPath, "utf8")).entries).length, 999);
  });
  test(`${kind} oversized or unowned recovery files fail closed before a native spawn`, async (t) => {
    const fixture = await processFixture(t, kind);
    const input: HarnessExecutionInput = { request, canonicalHistory: [request], runtime, claimAttempt: 2 };
    await writeFile(fixture.journalPath, "{}"); await truncate(fixture.journalPath, 64 * 1024 * 1024 + 1);
    await assert.rejects(fixture.executor.execute(input), /recovery state could not be verified/);
    await writeFile(fixture.journalPath, JSON.stringify({ version: 1, entries: {} }));
    const owner = JSON.stringify({ version: 1, pid: 99999999, owner: "unconfirmed-old-owner" });
    await writeFile(`${fixture.journalPath}.owner`, owner);
    await assert.rejects(fixture.executor.execute(input), /another or indeterminate owner/);
    assert.equal(await readFile(`${fixture.journalPath}.owner`, "utf8"), owner, "a vanished PID does not authorize stealing native ownership");
    await assert.rejects(readFile(fixture.started), /ENOENT/);
  });
  test(`${kind} constructor shutdown and request cancellation both reach the same native exit fence`, async (t) => {
    const shutdown = new AbortController(), requestAbort = new AbortController();
    const fixture = await processFixture(t, kind, { signal: shutdown.signal });
    const turn = fixture.executor.execute({ request, canonicalHistory: [request], runtime, claimAttempt: 2, signal: requestAbort.signal }).catch((error: unknown) => error);
    await fixture.waitStarted(); shutdown.abort(new Error("private shutdown reason"));
    const failure = await turn;
    assert.ok(failure instanceof HarnessExecutionTerminatedError); assert.match(failure.failureCode, /cancelled/);
    assert.equal(requestAbort.signal.aborted, false); await fixture.assertExited();
    assert.doesNotMatch(failure.publicMessage, /private shutdown reason/);
  });
}

test("CLI preparation refusal retains uncertain claim ownership instead of creating a false stopped receipt", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await processFixture(t, "cli", { maxPromptBytes: 16 });
  const store = new FileCursorStore(path.join(fixture.directory, "cursor.json"));
  let acknowledgments = 0;
  const api = {
    async registerRuntime() { return runtime; },
    async readEvents() { return { events: [request], nextSequence: 1, hasMore: false }; },
    async claimAgentRequest() { return { claimed: true, status: "claimed", requestId: request.id, runtimeId: runtime.id, attemptCount: 2 }; },
    async readAgentExecution() { return { active: true }; },
    async acknowledgeAgentExecutionStopped() { acknowledgments++; },
    async completeAgentRequest() { throw new Error("preparation is not a confirmed native execution failure"); },
  } as unknown as CollaborationApi;
  const bridge = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} }); await bridge.connect();
  await assert.rejects(bridge.processAgentRequest(request, fixture.executor), /hydration prompt exceeds/);
  assert.equal(acknowledgments, 0); assert.equal((await store.load()).stoppedExecutions, undefined);
  await assert.rejects(readFile(fixture.started), /ENOENT/);
  await assert.rejects(bridge.processAgentRequest(request, fixture.createExecutor()), /prepared, active or indeterminate/);
  assert.equal(acknowledgments, 0);
});

test("Desktop-only Codex projections cannot advertise native Team execution control", async (t) => {
  const fixture = await processFixture(t, "cli");
  const client = new CodexAppServerClient({ command: "must-not-start", cwd: fixture.directory }); t.after(() => client.dispose());
  const desktop = new CodexAppServerExecutor({ client, workspacePath: fixture.directory, statePath: path.join(fixture.directory, "desktop.json"),
    threadName: "Fixture Desktop", model: runtime.model, desktopHookOnly: true });
  assert.equal(desktop.executionControlVersion, undefined);
});

test("malformed recovered execution receipts never reach a claim, ACK, or private cursor file", async (t) => {
  const fixture = await processFixture(t, "cli");
  const store = new FileCursorStore(path.join(fixture.directory, "cursor.json"));
  let claims = 0, acknowledgments = 0;
  const api = { async registerRuntime() { return runtime; },
    async claimAgentRequest() { claims++; throw new Error("must not claim"); },
    async readAgentExecution() { return { active: true }; }, async acknowledgeAgentExecutionStopped() { acknowledgments++; },
  } as unknown as CollaborationApi;
  const bridge = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} }); await bridge.connect();
  const invalid = [{ sessionId: runtime.sessionId, runtimeId: runtime.id, requestId: request.id, claimAttempt: 0 },
    { sessionId: runtime.sessionId, runtimeId: runtime.id, requestId: request.id, claimAttempt: 2, content: "PRIVATE_RECOVERY_CONTENT" }];
  for (const receipt of invalid) await assert.rejects(bridge.processAgentRequest(request, { executionControlVersion: 1,
    async readStoppedExecutions() { return [receipt] as any; }, async execute() { throw new Error("must not execute"); } }), /Invalid native execution stop receipts/);
  assert.equal(claims, 0); assert.equal(acknowledgments, 0);
  assert.equal((await store.load()).stoppedExecutions, undefined);
});

test("an unrelated unknown native journal cannot block an already confirmed cursor exit receipt", async (t) => {
  const fixture = await processFixture(t, "cli");
  const store = new FileCursorStore(path.join(fixture.directory, "cursor.json"));
  const receipt = { sessionId: runtime.sessionId, requestId: request.id, runtimeId: runtime.id, claimAttempt: 2 };
  await store.save({ server: {}, local: {}, stoppedExecutions: [receipt] });
  let acknowledgments = 0, registrations = 0;
  const unknown = new HarnessExecutionUnconfirmedError("another native writer remains unknown");
  const api = { async acknowledgeAgentExecutionStopped(sessionId: string, requestId: string, runtimeId: string, claimAttempt: number) {
    assert.deepEqual({ sessionId, requestId, runtimeId, claimAttempt }, receipt); acknowledgments++;
  }, async registerRuntime() { registrations++; throw new Error("must not register over unknown native work"); } } as unknown as CollaborationApi;
  const bridge = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} });
  await assert.rejects(bridge.connect({ executionControlVersion: 1, async readStoppedExecutions() { throw unknown; },
    async acknowledgeExecutionExit() { throw unknown; }, async execute() { throw new Error("must not execute"); } }), (error: unknown) => error === unknown);
  assert.equal(acknowledgments, 1); assert.equal(registrations, 0); assert.deepEqual((await store.load()).stoppedExecutions, []);
});

for (const kind of ["cli", "adapter"] as const) {
  for (const action of ["stop", "timeout", "failed", "invalid", "lost-stop-ack", "lost-completion"] as const) {
    test(`${kind} Bridge ${action} persists exact exit evidence before releasing the native permit`, { skip: process.platform === "win32" }, async (t) => {
      const fixture = await processFixture(t, kind, { mode: action === "lost-completion" ? "success" : action === "failed" || action === "invalid" ? action : "running",
        timeoutMs: action === "timeout" ? 300 : 6000 });
      const cursorPath = path.join(fixture.directory, "cursor.json"), store = new FileCursorStore(cursorPath);
      let active = true, held = false, claimCalls = 0, acknowledgments = 0, completionCalls = 0;
      let completed = false;
      let completion: CompleteAgentRequestInput | undefined;
      const api = {
        async registerRuntime() { return runtime; },
        async readEvents(_session: string, after: number) { return { events: after < 1 ? [request] : [], nextSequence: 1, hasMore: false }; },
        async claimAgentRequest(sessionId: string, requestId: string, runtimeId: string, version?: 1) {
          assert.equal(sessionId, runtime.sessionId); assert.equal(runtimeId, runtime.id); assert.equal(version, 1);
          claimCalls++;
          if (held && requestId !== request.id) throw new CollaborationHttpError(409, "native permit held", "runtime_busy");
          if (completed && requestId === request.id) return { claimed: false, status: "completed", requestId, runtimeId, attemptCount: 2 };
          held = true; return { claimed: true, status: "claimed", requestId, runtimeId, attemptCount: 2 };
        },
        async readAgentExecution() { return { active }; },
        async acknowledgeAgentExecutionStopped(sessionId: string, requestId: string, runtimeId: string, attempt: number) {
          assert.deepEqual([sessionId, requestId, runtimeId, attempt], [runtime.sessionId, request.id, runtime.id, 2]);
          await fixture.assertExited();
          assert.deepEqual((await store.load()).stoppedExecutions, [{ sessionId, requestId, runtimeId, claimAttempt: attempt }], "ACK requires a disk-backed exact receipt first");
          acknowledgments++;
          if (action === "lost-stop-ack" && acknowledgments === 1) throw new TypeError("ACK response lost");
          held = false;
        },
        async completeAgentRequest(_session: string, _request: string, input: CompleteAgentRequestInput) {
          await fixture.assertExited(); completionCalls++; completion = input;
          if (action === "lost-completion" && completionCalls === 1) throw new TypeError("completion response unknown");
          completed = true; held = false;
          return { ...request, id: "response-1", sequence: 2, type: "agent_response", payload: input.payload };
        },
        async appendEvent() { throw new Error("fixture publishes only final responses"); },
      } as unknown as CollaborationApi;
      const bridge = new LocalBridge({ api, cursorStore: store, runtime, transcriptRoots: {} });
      await bridge.connect();
      const turn = bridge.processAgentRequest(request, fixture.executor).then((value) => value, (error: unknown) => error);
      await fixture.waitStarted();
      if (action === "stop" || action === "lost-stop-ack") {
        await assert.rejects(bridge.processAgentRequest(request, fixture.createExecutor()), HarnessExecutionUnconfirmedError,
          "an idempotent same-attempt claim cannot spawn or acknowledge a concurrent writer");
        assert.equal(acknowledgments, 0);
        await assert.rejects(api.claimAgentRequest(runtime.sessionId, "request-2", runtime.id, 1), /permit held/);
        active = false;
      }
      const result = await turn;
      await fixture.assertExited();
      assert.equal(acknowledgments, 1);
      if (action === "lost-stop-ack") {
        assert.match(String(result), /ACK response lost/); assert.equal(held, true);
        assert.equal((await new FileCursorStore(cursorPath).load()).stoppedExecutions?.length, 1);
        await new LocalBridge({ api, cursorStore: new FileCursorStore(cursorPath), runtime, transcriptRoots: {} }).connect();
        assert.equal(acknowledgments, 2); assert.equal(held, false);
      } else if (action === "lost-completion") {
        assert.match(String(result), /completion response unknown/);
        const reconnected = new LocalBridge({ api, cursorStore: new FileCursorStore(cursorPath), runtime, transcriptRoots: {} });
        await reconnected.connect();
        assert.equal((await reconnected.processAgentRequest(request, fixture.createExecutor())).completed.length, 1);
        assert.equal(completionCalls, 2);
      } else if (action === "stop") {
        assert.ok(result instanceof CollaborationHttpError); assert.equal(result.code, "agent_execution_cancelled"); assert.equal(completionCalls, 0);
      } else {
        assert.ok(!(result instanceof Error));
        assert.equal((completion?.payload as any).status, "failed");
        assert.match((completion?.payload as any).error.code, /timeout|failed|invalid/);
        assert.doesNotMatch(JSON.stringify(completion?.payload), /PRIVATE_PROVIDER_FAILURE|INVALID_PRIVATE_OUTPUT/);
      }
      assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1, "recovery must never spawn a second worker");
      assert.equal(held, false);
      assert.equal((await api.claimAgentRequest(runtime.sessionId, "request-2", runtime.id, 1)).claimed, true);
      assert.ok(claimCalls >= 2);
      if (completed) assert.deepEqual(JSON.parse(await readFile(fixture.journalPath, "utf8")).entries, {}, "only confirmed canonical completion permits pruning the exact replay cache");
    });
  }
}

test("unsupported custom executors refuse Team work before any claim, while ordinary old-server work stays compatible", async (t) => {
  const fixture = await processFixture(t, "adapter", { mode: "success" });
  const executor = new SubprocessHarnessExecutor({ command: process.execPath, args: ["-e", "process.exit(91)"], harness: "codex" });
  assert.equal(executor.executionControlVersion, undefined, "a custom adapter without a durable journal cannot promise Team recovery");
  let claims = 0;
  const api = {
    async registerRuntime() { return runtime; },
    async claimAgentRequest() { claims++; throw new Error("must not claim unsupported Team work"); },
    async readAgentExecution() { return { active: true }; }, async acknowledgeAgentExecutionStopped() {},
  } as unknown as CollaborationApi;
  const bridge = new LocalBridge({ api, cursorStore: new FileCursorStore(path.join(fixture.directory, "cursor.json")), runtime, transcriptRoots: {} });
  await bridge.connect();
  await assert.rejects(bridge.processAgentRequest(request, executor), (error: unknown) => error instanceof CollaborationHttpError && error.code === "connector_update_required");
  await assert.rejects(bridge.processAgentRequest(request, { async execute() { throw new Error("unsupported fake must never execute"); } }), /cannot safely run/);
  assert.equal(claims, 0);
  if (process.platform === "win32") {
    assert.equal(fixture.executor.executionControlVersion, undefined);
    await assert.rejects(bridge.processAgentRequest(request, fixture.executor), /cannot safely run/);
    assert.equal(claims, 0, "Windows process fallbacks cannot claim Team work without verified process-tree containment");
  }
  const ordinary = { ...request, payload: { text: "ordinary legacy test" } };
  api.claimAgentRequest = async (_session, requestId, runtimeId, version) => {
    assert.equal(version, undefined, "ordinary requests must not require the new claim wire field on older servers");
    claims++; return { claimed: true, status: "claimed", requestId, runtimeId, attemptCount: 1 };
  };
  api.readAgentExecution = async () => { throw new CollaborationHttpError(404, "old server"); };
  api.readEvents = async () => ({ events: [ordinary], nextSequence: 1, hasMore: false });
  api.completeAgentRequest = async (_session, _request, input) => ({ ...ordinary, id: "response-1", type: "agent_response", sequence: 2, payload: input.payload });
  api.acknowledgeAgentExecutionStopped = async () => { throw new Error("ordinary requests never create Team exit ACKs"); };
  assert.equal((await bridge.processAgentRequest(ordinary, fixture.executor)).completed.length, 1);
  assert.ok(claims >= 2, "ordinary author-Pause observation rechecks the same claim before publication");
  assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1, "observation never starts a second native process");
});

for (const kind of ["cli", "adapter"] as const) {
  test(`${kind} prepared/started ownership is never cleared by restart, missing PID, or a changed attempt`, async (t) => {
    const fixture = await processFixture(t, kind);
    const firstInput: HarnessExecutionInput = { request, canonicalHistory: [request], runtime, claimAttempt: 2 };
    const controller = new AbortController();
    const first = fixture.executor.execute({ ...firstInput, signal: controller.signal }).catch((error: unknown) => error);
    await fixture.waitStarted();
    const state = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(Object.values<any>(state.entries)[0]?.phase, "started");
    await assert.rejects(fixture.createExecutor().execute({ ...firstInput, claimAttempt: 3 }), HarnessExecutionUnconfirmedError);
    controller.abort();
    assert.ok(await first instanceof HarnessExecutionTerminatedError);
    await fixture.assertExited();
    // Simulate an interrupted connector whose durable native-exit write was
    // lost: PID liveness is insufficient to turn this entry into settled work.
    const entry = Object.values<any>(state.entries)[0]!;
    entry.pid = 99999999;
    await writeFile(fixture.journalPath, JSON.stringify(state));
    for (const phase of ["prepared", "started"]) {
      entry.phase = phase; await writeFile(fixture.journalPath, JSON.stringify(state));
      await assert.rejects(fixture.createExecutor().execute(firstInput), /prepared, active or indeterminate/);
      await assert.rejects(fixture.createExecutor().execute({ ...firstInput, claimAttempt: 3 }), /no confirmed exit/);
    }
    assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1);
  });
  test(`${kind} durable settled replay binds the exact input and retains the original safe failure`, async (t) => {
    const fixture = await processFixture(t, kind, { mode: "invalid" });
    const input: HarnessExecutionInput = { request, canonicalHistory: [request], runtime, claimAttempt: 2 };
    const first = await fixture.executor.execute(input).catch((error: unknown) => error);
    assert.ok(first instanceof HarnessExecutionTerminatedError);
    await fixture.assertExited();
    const recovered = await fixture.createExecutor().execute(input).catch((error: unknown) => error);
    assert.ok(recovered instanceof HarnessExecutionTerminatedError); assert.equal(recovered.failureCode, first.failureCode);
    await assert.rejects(fixture.createExecutor().execute({ ...input, request: { ...request, payload: { text: "different instructions", agent_team: {} } } }), /recovery input changed/);
    assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1);
  });
}

for (const kind of ["cli", "adapter"] as const) {
  test(`${kind} request-only cancellation returns physical exit evidence`, async (t) => {
    const fixture = await processFixture(t, kind);
    const controller = new AbortController();
    const input: HarnessExecutionInput = { request, canonicalHistory: [request], runtime, claimAttempt: 1, signal: controller.signal };
    const result = fixture.executor.execute(input).catch((error: unknown) => error);
    await fixture.waitStarted();
    controller.abort(new Error("fixture caller canceled"));
    const error = await result;
    assert.ok(error instanceof HarnessExecutionTerminatedError, "actual child close must carry typed physical-exit evidence");
    await fixture.assertExited();
    assert.doesNotMatch(error.publicMessage + JSON.stringify(error), /fixture caller canceled/);
  });
}
