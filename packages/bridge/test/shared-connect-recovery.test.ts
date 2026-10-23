import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { FileCursorStore, SharedStoppedReceiptOutbox, ensureProjectWorkspace,
  type HttpCollaborationClient, type ProjectHarnessAdapter } from "../src/index.js";
import { runProjectConnector } from "../src/codex-connect.js";

const executeFile = promisify(execFile);
const receipt = { version: 1 as const, jobId: "job-1", sourceRuntimeId: "deleted-runtime", projectId: "project-1", ownerDeviceId: "device-1", claimAttempt: 2 };
function response() { return { job: { id: receipt.jobId, project_id: receipt.projectId, share_id: "share-1", share_revision: 1,
  session_id: "deleted-session", request_event_id: "request-1", requester_user_id: "borrower-1", requester_display_name: "Borrower",
  execution_profile: { harness: "codex", provider: "openai", model: "fixture" }, status: "cancelled", created_at: "2026-10-20T00:00:00.000Z",
  deadline_at: null, finished_at: "2026-10-20T00:00:01.000Z", error_code: "agent_share_disabled", cleanup_pending: false }, replayed: true }; }

test("project connector replays a deleted source's stopped receipt before project access, native preflight, or new jobs", { skip: process.platform === "win32" }, async (t) => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "gt-shared-start-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const outbox = new SharedStoppedReceiptOutbox(path.join(stateRoot, "shared-control", receipt.sourceRuntimeId)); await outbox.put(receipt);
  const order: string[] = []; let hostCalls = 0, newJobs = 0;
  const api = { agentSharingApi() { return { async abortAck(id: string, input: any) {
    assert.equal(id, receipt.jobId); assert.equal(input.claim_attempt, 2); assert.equal(input.executor_stopped, true); order.push("exit-ack"); return response();
  } }; }, async listProjects() { order.push("project-read"); return []; } } as unknown as HttpCollaborationClient;
  const harness = { descriptor: { harness: "codex", provider: "openai", model: "fixture", captureFidelity: "harness_transcript", capabilities: [] },
    async preflight() { hostCalls++; throw new Error("native preflight must not run"); },
    createSessionBinding() { hostCalls++; throw new Error("native source must not register"); },
    async close() { hostCalls++; },
  } as unknown as ProjectHarnessAdapter;
  await assert.rejects(runProjectConnector({ api, actorUserId: "owner-1", actorDeviceId: receipt.ownerDeviceId,
    project: { id: receipt.projectId, name: "Deleted project", role: "owner", state: "active", sessionCount: 0 }, stateRoot,
    harness, token: "gta_fixture", signal: new AbortController().signal, hookMode: "project", hookSocketPath: path.join(stateRoot, "hook.sock"),
    hookSpoolPath: path.join(stateRoot, "spool"), hookRegistryPath: path.join(stateRoot, "hooks.json"), hookWorkspacePath: stateRoot,
    sharedExecutorFactory() { newJobs++; throw new Error("new shared work must not execute"); },
  }), /project access was revoked/);
  assert.deepEqual(order, ["exit-ack", "project-read"]); assert.equal(hostCalls, 0); assert.equal(newJobs, 0);
  assert.deepEqual(await outbox.list(receipt), []);
});

async function cliFixture(t: TestContext, createWorkspace: boolean, wrongScope = false, includeRenamedWorkspace = false, native = false) {
  const recoveryHome = await mkdtemp(path.join(tmpdir(), "gt-shared-cli-recovery-")), apiUrl = "https://fixture.invalid/v1";
  t.after(() => rm(recoveryHome, { recursive: true, force: true }));
  const workspace = createWorkspace ? await ensureProjectWorkspace({ apiUrl, projectId: receipt.projectId, projectName: "Old project name", homeDirectory: recoveryHome })
    : await mkdtemp(path.join(tmpdir(), "gt-shared-known-workspace-"));
  if (!createWorkspace) t.after(() => rm(workspace, { recursive: true, force: true }));
  const canonicalWorkspace = await realpath(workspace);
  const mapping = createHash("sha256").update([apiUrl, receipt.ownerDeviceId, receipt.projectId, path.resolve(canonicalWorkspace)].join("\0")).digest("hex").slice(0, 24);
  const stateRoot = path.join(recoveryHome, ".gatherthread", "codex", mapping);
  const outbox = new SharedStoppedReceiptOutbox(path.join(stateRoot, "shared-control", receipt.sourceRuntimeId));
  const stored = wrongScope ? { ...receipt, ownerDeviceId: "different-device" } : receipt; await outbox.put(stored);
  const sessionKey = createHash("sha256").update("deleted-session").digest("hex").slice(0, 24);
  const cursor = new FileCursorStore(path.join(stateRoot, `${sessionKey}-cursor.json`));
  if (native) await cursor.save({ server: {}, local: {}, stoppedExecutions: [{ sessionId: "deleted-session", runtimeId: "deleted-runtime",
    requestId: "request-1", claimAttempt: 2 }] });
  const outboxes = [outbox];
  if (includeRenamedWorkspace) {
    const previousWorkspace = await realpath(await ensureProjectWorkspace({ apiUrl, projectId: receipt.projectId,
      projectName: "Another former project name", homeDirectory: recoveryHome }));
    const previousMapping = createHash("sha256").update([apiUrl, receipt.ownerDeviceId, receipt.projectId, path.resolve(previousWorkspace)].join("\0")).digest("hex").slice(0, 24);
    const previousOutbox = new SharedStoppedReceiptOutbox(path.join(recoveryHome, ".gatherthread", "codex", previousMapping, "shared-control", receipt.sourceRuntimeId));
    await previousOutbox.put(stored); outboxes.push(previousOutbox);
  }
  const calls = path.join(recoveryHome, "calls.jsonl"), runner = path.join(recoveryHome, "run.mjs");
  const entry = new URL("../src/codex-connect.js", import.meta.url).href;
  await writeFile(runner, `
import {appendFileSync} from 'node:fs';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
os.homedir=()=>process.env.GT_SHARED_RECOVERY_HOME;
syncBuiltinESMExports();
globalThis.fetch=async (input,init)=>{const url=String(input);appendFileSync(process.env.CALLS,JSON.stringify({url,body:init?.body?JSON.parse(init.body):undefined})+'\\n');
 if(url.endsWith('/me'))return Response.json({data:{id:'owner-1',username:'Owner',device_id:'device-1'}});
 if(url.endsWith('/execution/stopped')){if(process.env.LOSE_ACK==='1')throw new TypeError('fixture ACK lost');return Response.json({data:{active:false}});}
 if(url.endsWith('/abort-ack')){if(process.env.LOSE_ACK==='1')throw new TypeError('fixture ACK lost');return Response.json({data:${JSON.stringify(response())}});}
 if(url.endsWith('/projects'))return Response.json({data:{projects:[]}});
 throw new Error('unexpected native/source/job transport');
};
const {runCodexConnectCli}=await import(${JSON.stringify(entry)});
try{await runCodexConnectCli(JSON.parse(process.env.ARGS),process.env);}catch(error){process.stderr.write(error.message);process.exitCode=1;}
`);
  const argv = ["--url", apiUrl, "--project", receipt.projectId, ...(createWorkspace ? ["--create-workspace"] : ["--workspace", workspace]), "--codex-command", "must-not-start-native"];
  return { outbox, outboxes, stored, calls, cursor, async run(lose = false) {
    await assert.rejects(executeFile(process.execPath, [runner], { env: { ...process.env, GT_SHARED_RECOVERY_HOME: recoveryHome, CALLS: calls,
      GATHERTHREAD_TOKEN: "gta_fixture", LOSE_ACK: lose ? "1" : "0", ARGS: JSON.stringify(argv) } }), /requested project is unavailable|fixture ACK lost|scope mismatch/);
    return (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  } };
}

for (const createWorkspace of [false, true]) {
  test(`actual CLI recovers ordinary native exits before deleted-project selection (${createWorkspace ? "known marker" : "explicit workspace"})`, { skip: process.platform === "win32" }, async t => {
    const f = await cliFixture(t, createWorkspace, false, false, true), calls = await f.run();
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/v1/me",
      "/v1/sessions/deleted-session/agent-requests/request-1/execution/stopped", "/v1/agent-share-jobs/job-1/abort-ack", "/v1/projects"]);
    assert.deepEqual((await f.cursor.load()).stoppedExecutions, []);
  });
}

for (const createWorkspace of [false, true]) {
  test(`actual CLI replays shared cleanup before selecting a deleted project (${createWorkspace ? "private workspace marker" : "explicit real workspace"})`, { skip: process.platform === "win32" }, async (t) => {
    const f = await cliFixture(t, createWorkspace), calls = await f.run();
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/v1/me", "/v1/agent-share-jobs/job-1/abort-ack", "/v1/projects"]);
    assert.deepEqual(await f.outbox.list(receipt), []);
  });
}

test("actual CLI recovers every exact historical workspace after project renames without an ambiguous selection", { skip: process.platform === "win32" }, async (t) => {
  const f = await cliFixture(t, true, false, true), calls = await f.run();
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/v1/me", "/v1/agent-share-jobs/job-1/abort-ack", "/v1/agent-share-jobs/job-1/abort-ack", "/v1/projects"]);
  for (const outbox of f.outboxes) assert.deepEqual(await outbox.list(receipt), []);
});

test("actual CLI retains and replays the same shared stopped attempt after a lost ACK without any new source", { skip: process.platform === "win32" }, async (t) => {
  const f = await cliFixture(t, false);
  let calls = await f.run(true); assert.equal(calls.length, 2); assert.equal((await f.outbox.list(receipt)).length, 1);
  calls = await f.run();
  const acks = calls.filter((call) => call.url.endsWith("/abort-ack"));
  assert.equal(acks.length, 2); assert.deepEqual(acks[0].body, acks[1].body);
  assert.deepEqual(await f.outbox.list(receipt), []);
});

test("actual CLI refuses a foreign-device receipt before project lookup or native source creation", { skip: process.platform === "win32" }, async (t) => {
  const f = await cliFixture(t, false, true), calls = await f.run();
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/v1/me"]);
  assert.equal((await f.outbox.list(f.stored)).length, 1);
});
