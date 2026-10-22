import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeCodeCliExecutor, readClaudePrivateJson, renderClaudeCanonicalPrompt, validateClaudeModel, writeClaudePrivateJson } from "../src/claude-code-executor.js";
import type { HarnessExecutionInput, HarnessProgressUpdate } from "../src/types.js";

const input = (): HarnessExecutionInput => ({
  request: { id: "request-1", sessionId: "session-1", sequence: 2, type: "agent_request", actorId: "user-1",
    timestamp: "2026-10-21T00:00:00.000Z", payload: { content: "Write a greeting", execution_profile: {
      harness: "claude-code", provider: "anthropic", model: "claude-sonnet-fixture", runtime_id: "runtime-1" } } },
  canonicalHistory: [{ id: "history-1", sessionId: "session-1", sequence: 1, type: "human_chat", actorId: "user-2",
    timestamp: "2026-10-21T00:00:00.000Z", payload: { content: "Public context", private_metadata: "DO_NOT_SEND" } }],
  runtime: { id: "runtime-1", userId: "user-1", deviceId: "device-1", sessionId: "session-1", harness: "claude-code",
    provider: "anthropic", model: "claude-sonnet-fixture", localSessionId: "binding-1", captureFidelity: "harness_transcript" },
});

async function fixture(mode = "normal") {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-executor-")));
  const script = path.join(dir, "fake.mjs");
  await writeFile(script, `import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),mode=process.env.CLAUDE_TEST_MODE; const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(args.includes('--version')) {console.log(mode==='old'?'2.1.233 (Claude Code)':'2.1.306 (Claude Code)');process.exit();}
if(args.includes('--help')) {console.log('--print --output-format '+(mode==='unsupported'?'':'--include-partial-messages')+' --session-id --model --permission-mode --permission-prompts --effort');process.exit();}
if(args[0]==='auth') {send({loggedIn:mode!=='loggedout',authMethod:'oauth_token',email:'PRIVATE_EMAIL'});process.exit();}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
appendFileSync(process.env.CLAUDE_TEST_CAPTURE,JSON.stringify({args,prompt,pid:process.pid,token:process.env.GATHERTHREAD_TOKEN})+'\\n');
if(mode==='hang'||mode==='hang-ignore-term'||mode==='malformed-hang'){
if(mode!=='hang')process.on('SIGTERM',()=>{});
if(mode==='malformed-hang')console.log('{broken');
setInterval(()=>{},1000);await new Promise(()=>{});}
if(mode==='malformed'){console.log('{broken');process.exit();}
if(mode==='oversize'){console.log('x'.repeat(1200000));process.exit();}
if(mode==='nonzero'){process.exit(2);}
const session_id=mode==='wrong-session'?'00000000-0000-4000-8000-000000000000':args[args.indexOf('--session-id')+1];send({type:'system',subtype:'init',session_id,model:mode==='wrong-model'?'claude-opus-fixture':'claude-sonnet-fixture'});
if(mode==='failure'){send({type:'result',subtype:'error_during_execution',session_id,is_error:true,result:'PRIVATE_PROVIDER_ERROR'});process.exit();}
if(mode==='no-final'){process.exit();}
send({type:'stream_event',session_id,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
send({type:'stream_event',session_id,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello, world! '}}});
if(mode==='rich'){
for(const delta of ['token=','gta_0123456789012345678901234567890123456789',' visible\\n'])send({type:'stream_event',session_id,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:delta}}});
send({type:'assistant',session_id,message:{model:'claude-sonnet-fixture',content:[{type:'tool_use',id:'native-tool-private',name:'Read',input:{file_path:process.cwd()+'/app.ts',privateInstructions:'DO_NOT_SHARE',password:'TEST_SECRET'}}]}});
send({type:'user',session_id,message:{content:[{type:'tool_result',tool_use_id:'native-tool-private',content:'PRIVATE_INSTRUCTION_SENTINEL from /Users/synthetic/private/CLAUDE.md password=veryprivate',is_error:true}]}});
send({type:'assistant',session_id,message:{model:'claude-sonnet-fixture',content:[{type:'tool_use',id:'native-plan-private',name:'TodoWrite',input:{todos:[{content:'Run tests',status:'in_progress'}]}}]}});
send({type:'assistant',session_id,message:{model:'claude-sonnet-fixture',content:[{type:'tool_use',id:'native-task-create',name:'TaskCreate',input:{subject:'Check files'}}]}});
send({type:'user',session_id,message:{content:[{type:'tool_result',tool_use_id:'native-task-create',content:'Task #1 created successfully'}]}});
send({type:'assistant',session_id,message:{model:'claude-sonnet-fixture',content:[{type:'tool_use',id:'native-task-update',name:'TaskUpdate',input:{taskId:'1',status:'completed'}}]}});
send({type:'assistant',session_id,parent_tool_use_id:'subagent-private',message:{content:[{type:'text',text:'UNRELATED_SUBAGENT'}]}});
send({type:'stream_event',session_id,event:{type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'HIDDEN_THINKING'}}});
}
send({type:'assistant',session_id,message:{id:'native-private-id',model:'claude-sonnet-fixture',content:[{type:'thinking',thinking:'HIDDEN_THINKING'},{type:'text',text:'Hello, world!'}]}});
if(mode==='native-tools')for(const name of ['Bash','PowerShell','WebFetch','WebSearch','Agent','mcp__PRIVATE_SERVER__PRIVATE_TOOL']){
const id='private-tool-'+name;send({type:'assistant',session_id,message:{model:'claude-sonnet-fixture',content:[{type:'tool_use',id,name,input:{command:'echo PRIVATE_COMMAND',url:'https://PRIVATE_URL',prompt:'PRIVATE_SUBAGENT_PROMPT',content:'PRIVATE_MCP_INPUT',description:'PRIVATE_DESCRIPTION'}}]}});
send({type:'user',session_id,message:{content:[{type:'tool_result',tool_use_id:id,content:'PRIVATE_TOOL_RESULT'}]}});}
if(mode==='private-files')for(const [index,file_path] of ['../PRIVATE_OUTSIDE/CLAUDE.md','.claude/settings.json','CLAUDE.md','AGENTS.md','private-link/settings.txt','private-hardlink.txt'].entries()){
send({type:'assistant',session_id,message:{model:'claude-sonnet-fixture',content:[{type:'tool_use',id:'private-file-'+index,name:'Write',input:{file_path,content:'PRIVATE_INSTRUCTION_SENTINEL',old_string:'PRIVATE_OLD_SENTINEL',new_string:'PRIVATE_NEW_SENTINEL',description:'PRIVATE_DESCRIPTION'}}]}});}
send({type:'result',subtype:mode==='denied-nonzero'?'error_during_execution':'success',session_id,is_error:mode==='denied-nonzero',result:'Hello, world!',...(mode.startsWith('denied')?{permission_denials:[{tool_name:'Bash',tool_input:{command:'PRIVATE_DENIED_COMMAND'}}]}:{})});
if(mode==='denied-nonzero')process.exitCode=1;
`);
  const capture = path.join(dir, "capture.jsonl");
  const options = { workspacePath: dir, statePath: path.join(dir, "state.json"), model: "claude-sonnet-fixture",
    command: process.execPath, commandArgs: [script], env: { ...process.env, CLAUDE_TEST_MODE: mode, CLAUDE_TEST_CAPTURE: capture, GATHERTHREAD_TOKEN: "gta_private_credential" } };
  const executor = new ClaudeCodeCliExecutor(options);
  return { dir, capture, executor, options };
}

async function waitForCapture(file: string): Promise<string> {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}

test("Claude preflight probes metadata only, then owned runs stream safely and replay without execution", async () => {
  const { executor, capture } = await fixture();
  const preflight = await executor.preflight();
  assert.equal(preflight.authentication, "oauth_token");
  assert.doesNotMatch(JSON.stringify(preflight), /PRIVATE_EMAIL/);
  await assert.rejects(readFile(capture), /ENOENT/);
  const updates: HarnessProgressUpdate[] = [];
  const request = { ...input(), publishProgress: async (update: HarnessProgressUpdate) => { updates.push(update); } };
  const first = await executor.execute(request);
  const replay = await executor.execute(request);
  assert.deepEqual(replay, first);
  assert.equal(first.events.at(-1)?.content, "Hello, world!");
  assert.match(first.localSessionId ?? "", /^claude-run-[a-f0-9]{24}$/);
  const record = JSON.parse((await readFile(capture, "utf8")).trim());
  const privateNativeId = record.args[record.args.indexOf("--session-id") + 1];
  assert.ok(!JSON.stringify(first).includes(privateNativeId));
  assert.ok(!JSON.stringify(updates).includes(privateNativeId));
  assert.equal(record.token, undefined);
  for (const flag of ["--restricted", "--safe-mode", "--tools", "--allowedTools", "--disallowedTools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--settings", "--permission-mode", "--dangerously-skip-permissions"]) assert.ok(!record.args.includes(flag), flag);
  assert.equal(record.args[record.args.indexOf("--permission-prompts") + 1], "none");
  assert.ok(updates.some(update => update.streamKind === "answer"));
  assert.doesNotMatch(JSON.stringify(updates), /HIDDEN_THINKING|native-private-id|PRIVATE_EMAIL|TEST_SECRET/);
  assert.equal((await readFile(capture, "utf8")).trim().split("\n").length, 1);
});

test("Claude keeps explicit local permission-mode overrides without overriding tools or settings", async () => {
  for (const permissionMode of ["native", "manual", "default", "plan"] as const) {
    const { options, capture } = await fixture();
    const executor = new ClaudeCodeCliExecutor({ ...options, permissionMode });
    await executor.execute(input());
    const { args } = JSON.parse((await readFile(capture, "utf8")).trim());
    if (permissionMode === "native") assert.ok(!args.includes("--permission-mode"));
    else assert.equal(args[args.indexOf("--permission-mode") + 1], permissionMode);
    for (const flag of ["--tools", "--allowedTools", "--restricted", "--safe-mode", "--mcp-config"]) assert.ok(!args.includes(flag));
  }
});

test("Claude native command, network, subagent and MCP work is visible without private arguments/results", async () => {
  const { executor } = await fixture("native-tools"), updates: HarnessProgressUpdate[] = [];
  const result = await executor.execute({ ...input(), publishProgress: async update => { updates.push(update); } });
  const calls = result.events.filter(event => event.kind === "tool_call");
  assert.deepEqual(calls.map(event => event.toolName), ["Bash", "PowerShell", "WebFetch", "WebSearch", "Agent", "Native tool"]);
  assert.ok(calls.every(event => JSON.stringify(event.arguments) === "{}"));
  assert.equal(result.events.filter(event => event.kind === "tool_result").length, 6);
  assert.ok(updates.some(update => update.streamKind === "tool"));
  assert.doesNotMatch(JSON.stringify([result, updates]), /PRIVATE_|private-tool-/);
});

test("native file authority cannot publish outside/private instructions or linked file bodies", async () => {
  const { dir, executor } = await fixture("private-files"), updates: HarnessProgressUpdate[] = [];
  const external = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-private-input-")));
  await writeFile(path.join(external, "settings.txt"), "PRIVATE_LOCAL_FILE");
  await symlink(external, path.join(dir, "private-link"), process.platform === "win32" ? "junction" : "dir");
  await link(path.join(external, "settings.txt"), path.join(dir, "private-hardlink.txt"));
  const result = await executor.execute({ ...input(), publishProgress: async update => { updates.push(update); } });
  const calls = result.events.filter(event => event.kind === "tool_call");
  assert.equal(calls.length, 6);
  assert.ok(calls.every(event => JSON.stringify(event.arguments) === "{}"));
  assert.doesNotMatch(JSON.stringify([result, updates]), /PRIVATE_|CLAUDE\.md|settings\.json|private-link|private-hardlink/);
});

test("Claude reports native permission denials without approving or exposing denied commands", async t => {
  for (const mode of ["denied", "denied-nonzero"]) await t.test(mode, async () => {
  const { executor, capture } = await fixture(mode);
  await assert.rejects(executor.execute(input()), error => {
    assert.equal((error as any).failureCode, "claude_permission_required");
    assert.match(String(error), /local permission/);
    assert.doesNotMatch(String(error), /PRIVATE_DENIED_COMMAND/);
    return true;
  });
  await assert.rejects(executor.execute(input()), /local permission/);
  assert.equal((await readFile(capture, "utf8")).trim().split("\n").length, 1);
  });
});

test("changing the explicit permission mode never replays an old execution journal", async () => {
  const { executor, options, capture } = await fixture();
  await executor.execute(input());
  const changed = new ClaudeCodeCliExecutor({ ...options, permissionMode: "plan" });
  await assert.rejects(changed.execute(input()), /context.*changed/i);
  assert.equal((await readFile(capture, "utf8")).trim().split("\n").length, 1);
});

test("Claude owned session registration brackets actual execution and cleans up success and failure", async () => {
  for (const mode of ["normal", "failure", "malformed"]) {
    const { options, capture } = await fixture(mode), notifications: { id: string; active: boolean }[] = [];
    const executor = new ClaudeCodeCliExecutor({ ...options, onOwnedSession: (id, active) => { notifications.push({ id, active }); } });
    await executor.execute(input()).catch(() => undefined);
    const { args } = JSON.parse((await readFile(capture, "utf8")).trim());
    const id = args[args.indexOf("--session-id") + 1];
    assert.deepEqual(notifications, [{ id, active: true }, { id, active: false }]);
  }
});

test("Claude pause stops detached terminal descendants as well as its owned CLI, not unrelated processes", async t => {
  const { dir, options } = await fixture();
  const script = path.join(dir, "tree.mjs"), capture = path.join(dir, "child.pid"), lateCapture = path.join(dir, "late-child.pid");
  await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>{const late=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});late.unref();writeFileSync(process.env.CLAUDE_LATE_PID,String(late.pid));process.exit(0);});
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});child.unref();writeFileSync(process.env.CLAUDE_CHILD_PID,String(child.pid));setInterval(()=>{},1000);`);
  const executor = new ClaudeCodeCliExecutor({ ...options, commandArgs: [script], env: { ...options.env, CLAUDE_CHILD_PID: capture, CLAUDE_LATE_PID: lateCapture } });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => { unrelated.kill("SIGKILL"); });
  const controller = new AbortController(), running = executor.execute({ ...input(), signal: controller.signal });
  const pid = Number(await waitForCapture(capture));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped by the executor. */ } });
  t.after(async () => { try { process.kill(Number(await readFile(lateCapture, "utf8")), "SIGKILL"); } catch { /* No shutdown-handler child. */ } });
  controller.abort();
  await assert.rejects(running, /stopped/);
  assert.equal(executor.isActive(), false);
  assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  await assert.rejects(readFile(lateCapture), /ENOENT/);
  // The OS may briefly retain a reparented child while it is being reaped.
  const deadline = Date.now() + 5000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); break; }
    assert.ok(Date.now() < deadline, "terminal descendant survived cancellation");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
});

test("Claude prompt honors the derived context and excludes deleted content and arbitrary metadata", () => {
  const request = input();
  request.canonicalHistory.push({ ...request.canonicalHistory[0]!, id: "deleted", sequence: 0, deleted: {
    deletedAt: "2026-10-21T00:00:00.000Z", reason: "author" }, payload: { content: "ERASED_BODY" } });
  const plain = renderClaudeCanonicalPrompt(request);
  assert.match(plain, /Public context/);
  assert.match(plain, /respect native Claude Code settings, tools and local permissions/);
  assert.doesNotMatch(plain, /tools explicitly granted by the local connector|Keep work inside/);
  assert.doesNotMatch(plain, /ERASED_BODY|DO_NOT_SEND/);
  request.historyContext = { view: "summary", through_sequence: 1, content_revision: 0,
    items: [{ kind: "summary", event_id: "summary-1", sequence: 1, actor_user_id: "user-2", content: "Summary only", source_event_ids: ["history-1"] }] };
  const folded = renderClaudeCanonicalPrompt(request);
  assert.match(folded, /Summary only/);
  assert.doesNotMatch(folded, /Public context|ERASED_BODY/);
});

test("Claude requests preserve the exact public quote independently of a summarized context", () => {
  const request = input();
  request.request.replyTo = "history-1";
  request.historyContext = { view: "summary", through_sequence: 1, content_revision: 0,
    items: [{ kind: "summary", event_id: "summary-1", sequence: 1, actor_user_id: "user-2", content: "Folded public discussion", source_event_ids: ["history-1"] }] };
  const quoted = renderClaudeCanonicalPrompt(request);
  assert.match(quoted, /"event_id":"history-1"/);
  assert.match(quoted, /"content":"Public context"/);
  request.request.replyTo = "unavailable-message";
  assert.notEqual(renderClaudeCanonicalPrompt(request), quoted);
  request.request.replyTo = "history-1";
  request.canonicalHistory[0]!.deleted = { deletedAt: "2026-10-21T00:00:01Z", reason: "author" };
  assert.doesNotMatch(renderClaudeCanonicalPrompt(request), /Public context/);
});

test("Claude refuses a wrong route before spawning or persisting a run", async () => {
  const { executor, capture } = await fixture();
  const request = input();
  (request.request.payload as any).execution_profile.harness = "codex";
  assert.equal(await executor.shouldExecute(request.request, request.runtime), false);
  await assert.rejects(executor.execute(request), /target|route|harness/i);
  await assert.rejects(readFile(capture), /ENOENT/);
});

test("Claude refuses drifting aliases and model identifiers larger than the launcher contract", () => {
  for (const value of ["sonnet", "opus", "haiku", "default", "best", "fable", "opusplan", "claude-" + "a".repeat(114)]) assert.throws(() => validateClaudeModel(value), /explicit|alias/);
  validateClaudeModel("claude-sonnet-fixture");
});

test("Claude metadata preflight fails safely for old builds, missing features and missing login", async t => {
  for (const mode of ["old", "unsupported", "loggedout"]) await t.test(mode, async () => {
    const { executor, capture } = await fixture(mode);
    await assert.rejects(executor.preflight(), /Claude Code|Update Claude/);
    await assert.rejects(readFile(capture), /ENOENT/);
  });
});

test("Claude rejects malformed, oversized, wrong-owned, wrong-model, failed and incomplete runs", async t => {
  for (const mode of ["malformed", "oversize", "wrong-session", "wrong-model", "failure", "no-final", "nonzero"]) await t.test(mode, async () => {
    const { executor } = await fixture(mode);
    await assert.rejects(executor.execute(input()), /Claude/);
    await assert.rejects(executor.execute(input()), /Claude/);
  });
});

test("Claude abort waits for actual process exit and persists a non-reexecuting terminal journal", async () => {
  const { executor, capture } = await fixture("hang");
  const controller = new AbortController();
  const pending = executor.execute({ ...input(), signal: controller.signal });
  await waitForCapture(capture);
  controller.abort();
  await assert.rejects(pending, /stopped/);
  const run = JSON.parse((await readFile(capture, "utf8")).trim());
  assert.throws(() => process.kill(run.pid, 0), /ESRCH/);
  await assert.rejects(executor.execute(input()), /stopped/);
  assert.equal((await readFile(capture, "utf8")).trim().split("\n").length, 1);
});

test("Claude timeout and output caps terminate the exact process without retry", async () => {
  const hung = await fixture("hang");
  const timeout = new ClaudeCodeCliExecutor({ ...hung.options, timeoutMs: 100 });
  await assert.rejects(timeout.execute(input()), /time limit/);
  const noisy = await fixture("oversize");
  const capped = new ClaudeCodeCliExecutor({ ...noisy.options, maxOutputBytes: 1024 });
  await assert.rejects(capped.execute(input()), /output/);
});

test("Claude crash journal refuses an indeterminate replay and refuses changed same-request context", async () => {
  const { executor, options, capture } = await fixture();
  await executor.execute(input());
  const changed = input(); (changed.request.payload as any).content = "A different operation";
  await assert.rejects(executor.execute(changed), /context.*changed/i);
  const dir = `${options.statePath}.runs`, file = path.join(dir, (await readdir(dir))[0]!);
  const journal = JSON.parse(await readFile(file, "utf8"));
  journal.status = "started"; delete journal.result;
  await writeFile(file, JSON.stringify(journal), { mode: 0o600 });
  await assert.rejects(executor.execute(input()), /not executed again/);
  assert.equal((await readFile(capture, "utf8")).trim().split("\n").length, 1);
});

test("Claude live answer, tools and actual plans interleave without hidden work, private IDs or split credentials", async () => {
  const { executor, options } = await fixture("rich");
  const updates: HarnessProgressUpdate[] = [];
  const result = await executor.execute({ ...input(), publishProgress: async update => { updates.push(update); } });
  assert.ok(result.events.some(event => event.kind === "tool_call" && event.toolName === "Read"));
  assert.ok(updates.some(update => update.streamKind === "tool"));
  assert.ok(updates.some(update => update.streamKind === "plan" && update.plan?.some(step => step.status === "completed")));
  assert.doesNotMatch(JSON.stringify(updates), /native-tool-private|native-plan-private|HIDDEN_THINKING|UNRELATED_SUBAGENT|DO_NOT_SHARE|gta_012345|veryprivate|PRIVATE_INSTRUCTION_SENTINEL|\/Users\/synthetic\/private/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INSTRUCTION_SENTINEL|\/Users\/synthetic\/private/);
  const noTools = new ClaudeCodeCliExecutor({ ...options, statePath: `${options.statePath}.no-tools`, shareToolEvents: false, permissionMode: "plan" });
  const answerOnly = await noTools.execute(input());
  assert.deepEqual(answerOnly.events.map(event => event.kind), ["assistant"]);
});

test("a silent Claude process cannot fabricate activity to renew its claim", async t => {
  const { executor, capture } = await fixture("hang");
  const controller = new AbortController(), updates: HarnessProgressUpdate[] = [];
  t.mock.timers.enable({ apis: ["setInterval"] });
  const pending = executor.execute({ ...input(), signal: controller.signal,
    publishProgress: async update => { updates.push(update); } });
  const stopped = assert.rejects(pending, /stopped/);
  try {
    await waitForCapture(capture);
    t.mock.timers.tick(31_000);
    await Promise.resolve();
  } finally { controller.abort(); await stopped; t.mock.timers.reset(); }
  assert.deepEqual(updates, []);
});

test("malformed-output failure and close both force-stop a process that ignores SIGTERM", async t => {
  for (const mode of ["malformed-hang", "hang-ignore-term"]) await t.test(mode, async () => {
    const { executor, capture } = await fixture(mode);
    const pending = executor.execute(input());
    const rejected = assert.rejects(pending, /Claude/);
    // Measure cancellation after the child has started, not unrelated Node
    // startup/fixture scheduling on a busy test host.
    await waitForCapture(capture);
    const started = Date.now();
    if (mode === "hang-ignore-term") {
      await executor.close();
    }
    await rejected;
    assert.ok(Date.now() - started < 7000);
    const run = JSON.parse((await readFile(capture, "utf8")).trim());
    assert.throws(() => process.kill(run.pid, 0), /ESRCH/);
  });
});

test("Claude private state refuses linked parents, leaf symlinks and hardlinked files", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "gt-claude-state-"))), state = path.join(dir, "state.json");
  await writeClaudePrivateJson(state, { version: 1 });
  assert.deepEqual(await readClaudePrivateJson(state), { version: 1 });
  await assert.rejects(writeClaudePrivateJson(state, { body: "a".repeat(4 * 1024 * 1024) }), /storage budget/);
  assert.deepEqual(await readClaudePrivateJson(state), { version: 1 });
  const hard = path.join(dir, "hard.json"); await link(state, hard);
  await assert.rejects(readClaudePrivateJson(state), /private regular/);
  const target = path.join(dir, "real"); await mkdir(target, { mode: 0o700 });
  const linked = path.join(dir, "linked"); await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(writeClaudePrivateJson(path.join(linked, "state.json"), {}), /symbolic link/);
  const leaf = path.join(dir, "leaf.json"); await symlink(state, leaf);
  await assert.rejects(readClaudePrivateJson(leaf), /private regular/);
});
