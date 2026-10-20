import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AbortAgentShareJobInput, AgentShareJob } from "@gatherthread/protocol";
import * as recovery from "../src/shared-stop-receipts.js";
import { SharedStoppedReceiptOutbox, type SharedStoppedReceipt } from "../src/shared-stop-receipts.js";
import { SharedAgentJobController, type SharedAgentControlApi } from "../src/shared-agent-controller.js";

type Recover = (options: { privateControlRoot: string; projectId: string; ownerDeviceId: string;
  api: { abortAck(id: string, input: AbortAgentShareJobInput): Promise<unknown> } }) => Promise<number>;
function recover(): Recover {
  const fn = (recovery as unknown as { recoverSharedStoppedReceipts?: Recover }).recoverSharedStoppedReceipts;
  assert.equal(typeof fn, "function", "Known stopped work must recover independently of deleted source registration");
  return fn!;
}
const scope = { projectId: "project-fixture", ownerDeviceId: "device-fixture" };
const posixOnly = { skip: process.platform === "win32" ? "Private native sharing cleanup is unsupported on Windows" : false };
const receipt = (runtime = "runtime-deleted", job = "job-deleted"): SharedStoppedReceipt => ({ version: 1,
  sourceRuntimeId: runtime, projectId: scope.projectId, ownerDeviceId: scope.ownerDeviceId, jobId: job, claimAttempt: 2 });
function response(proof: SharedStoppedReceipt) {
  const job: AgentShareJob = { id: proof.jobId, project_id: proof.projectId, share_id: "share-deleted", share_revision: 1,
    session_id: "session-deleted", request_event_id: "request-deleted", status: "cancelled", requester_user_id: "borrower-fixture",
    requester_display_name: "Synthetic borrower", execution_profile: { harness: "codex", provider: "synthetic", model: "synthetic-model" },
    created_at: "2026-10-20T00:00:00.000Z", deadline_at: null, finished_at: "2026-10-20T00:00:01.000Z",
    error_code: "access_changed", cleanup_pending: false };
  return { job, replayed: false };
}
async function directory(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gt-shared-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function stored(root: string, proof = receipt()) {
  const outbox = new SharedStoppedReceiptOutbox(path.join(root, proof.sourceRuntimeId)); await outbox.put(proof);
  const box = path.join(root, proof.sourceRuntimeId, "stopped-receipts");
  return { outbox, box, file: path.join(box, (await readdir(box))[0]!) };
}

test("controller flushes a confirmed stopped receipt before a permanently missing source report", posixOnly, async t => {
  const root = await directory(t), proof = receipt(), old = await stored(root, proof);
  const calls: string[] = [];
  const api = { async abortAck(id: string, input: AbortAgentShareJobInput) {
    calls.push("ack"); assert.equal(id, proof.jobId); assert.equal(input.claim_attempt, 2); return response(proof);
  }, async reportSourceAvailability() { calls.push("report"); throw new Error("Original source was deleted"); } } as unknown as SharedAgentControlApi;
  const controller = new SharedAgentJobController({ ...scope, sourceRuntimeId: proof.sourceRuntimeId,
    privateStateRoot: path.join(root, proof.sourceRuntimeId), api,
    executor: { async preflight() { return undefined; }, async execute() { throw new Error("No native work may start"); } } });
  await controller.tick();
  assert.deepEqual(calls, ["ack", "report"]);
  assert.deepEqual(await old.outbox.list(proof), []);
  await controller.stop();
});

test("live cleanup cannot forget exact proof after a wrong or incomplete acknowledgment", posixOnly, async t => {
  for (const invalid of ["empty", "job", "project", "pending", "running"] as const) await t.test(invalid, async t => {
    const root = await directory(t), proof = receipt(), old = await stored(root, proof);
    let acknowledgments = 0;
    const valid = response(proof), bad = invalid === "empty" ? {} : { ...valid, job: { ...valid.job,
      ...(invalid === "job" ? { id: "other-job" } : invalid === "project" ? { project_id: "other-project" }
        : invalid === "pending" ? { cleanup_pending: true } : { status: "running" }) } };
    const controller = new SharedAgentJobController({ ...scope, sourceRuntimeId: proof.sourceRuntimeId,
      privateStateRoot: path.join(root, proof.sourceRuntimeId), api: {
        async abortAck() { acknowledgments++; return bad; },
        async reportSourceAvailability() { throw new Error("Original source was deleted"); },
      } as unknown as SharedAgentControlApi,
      executor: { async preflight() { return undefined; }, async execute() { throw new Error("No native work may start"); } } });
    await controller.tick(); assert.equal(acknowledgments, 1);
    assert.deepEqual(await old.outbox.list(proof), [proof]); await controller.stop();
  });
});

test("bounded old receipt recovery uses exact metadata before any current host, runtime or history access", posixOnly, async t => {
  const root = await directory(t), one = receipt(), two = receipt("runtime-previous", "job-previous");
  const a = await stored(root, one), b = await stored(root, two), calls: string[] = [];
  const api = { async abortAck(id: string, input: AbortAgentShareJobInput) {
    const proof = id === one.jobId ? one : two; calls.push(id);
    assert.deepEqual(input, { claim_attempt: 2, executor_stopped: true, idempotency_key: `shared-abort:${id}:2` });
    assert.ok(await readFile(id === one.jobId ? a.file : b.file, "utf8"), "Do not remove evidence before the real ACK succeeds");
    return response(proof);
  } };
  assert.equal(await recover()({ privateControlRoot: root, ...scope, api }), 2);
  assert.deepEqual(calls.sort(), [one.jobId, two.jobId].sort());
  assert.deepEqual(await a.outbox.list(one), []); assert.deepEqual(await b.outbox.list(two), []);
  assert.equal(await recover()({ privateControlRoot: root, ...scope, api }), 0);
});

test("lost or malformed cleanup replies retain exact evidence and a later confirmed ACK retires it once", posixOnly, async t => {
  const root = await directory(t), proof = receipt(), old = await stored(root, proof), body = await readFile(old.file, "utf8");
  for (const reply of [new TypeError("Accepted ACK response lost"), {}, response({ ...proof, jobId: "wrong-job" }),
    response({ ...proof, projectId: "wrong-project" }), { ...response(proof), job: { ...response(proof).job, cleanup_pending: true } },
    { ...response(proof), job: { ...response(proof).job, status: "running" } }]) {
    await assert.rejects(recover()({ privateControlRoot: root, ...scope, api: { async abortAck() {
      if (reply instanceof Error) throw reply; return reply;
    } } }));
    assert.equal(await readFile(old.file, "utf8"), body);
  }
  assert.equal(await recover()({ privateControlRoot: root, ...scope, api: { async abortAck() { return response(proof); } } }), 1);
  assert.deepEqual(await old.outbox.list(proof), []);
});

test("absent recovery roots are never created or treated as evidence", async t => {
  const root = path.join(await directory(t), "absent"); let calls = 0;
  assert.equal(await recover()({ privateControlRoot: root, ...scope, api: { async abortAck() { calls++; } } }), 0);
  assert.equal(calls, 0); await assert.rejects(readdir(root), /ENOENT/u);
});

test("recovery validates every source and receipt before acknowledging any job", posixOnly, async t => {
  for (const invalid of ["foreign-project", "foreign-device", "foreign-runtime", "malformed", "wrong-name", "hardlink", "symlink", "insecure-file", "insecure-directory"] as const) await t.test(invalid, async t => {
    const root = await directory(t), good = await stored(root, receipt("a-runtime", "a-job"));
    const proof = receipt("z-runtime", "z-job"), bad = await stored(root, proof);
    if (invalid.startsWith("foreign-")) {
      await bad.outbox.remove(proof);
      const changed = invalid === "foreign-project" ? { ...proof, projectId: "foreign-project" }
        : invalid === "foreign-device" ? { ...proof, ownerDeviceId: "foreign-device" } : { ...proof, sourceRuntimeId: "foreign-runtime" };
      await bad.outbox.put(changed);
    } else if (invalid === "malformed") await writeFile(bad.file, "{invalid fixture");
    else if (invalid === "wrong-name") { await rm(bad.file); await writeFile(path.join(bad.box, "0".repeat(64) + ".json"), JSON.stringify(proof), { mode: 0o600 }); }
    else if (invalid === "hardlink") await link(bad.file, path.join(root, "hardlink-fixture"));
    else if (invalid === "symlink") { await rm(bad.file); await symlink(good.file, bad.file); }
    else if (invalid === "insecure-file") await chmod(bad.file, 0o644);
    else await chmod(path.dirname(bad.box), 0o755);
    let calls = 0;
    await assert.rejects(recover()({ privateControlRoot: root, ...scope, api: { async abortAck() { calls++; return response(proof); } } }));
    assert.equal(calls, 0); assert.ok(await readFile(good.file, "utf8"));
  });
});

test("recovery rejects symlink roots, runtime folders and outboxes without following them", posixOnly, async t => {
  for (const target of ["root", "runtime", "outbox"] as const) await t.test(target, async t => {
    const top = await directory(t), control = path.join(top, "control"), outside = path.join(top, "outside");
    await mkdir(control, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    const proof = receipt(), real = await stored(outside, proof);
    let supplied = control;
    if (target === "root") { supplied = path.join(top, "alias"); await symlink(outside, supplied); }
    else if (target === "runtime") await symlink(path.dirname(real.box), path.join(control, proof.sourceRuntimeId));
    else { const runtime = path.join(control, proof.sourceRuntimeId); await mkdir(runtime, { mode: 0o700 }); await symlink(real.box, path.join(runtime, "stopped-receipts")); }
    let calls = 0; await assert.rejects(recover()({ privateControlRoot: supplied, ...scope, api: { async abortAck() { calls++; } } }));
    assert.equal(calls, 0); assert.ok(await readFile(real.file, "utf8"));
  });
});

test("legacy growth above recovery bounds preserves receipts and refuses every ACK", posixOnly, async t => {
  for (const boundary of ["runtime-directories", "total-receipts"] as const) await t.test(boundary, async t => {
    const root = await directory(t), old = await stored(root), proof = receipt();
    if (boundary === "runtime-directories") await Promise.all(Array.from({ length: 4096 }, (_, i) => mkdir(path.join(root, `old-runtime-${i}`), { mode: 0o700 })));
    else for (let i = 0; i < 256; i++) await stored(root, receipt(i < 128 ? "runtime-previous" : "runtime-older", `old-job-${i}`));
    let calls = 0; await assert.rejects(recover()({ privateControlRoot: root, ...scope, api: { async abortAck() { calls++; return response(proof); } } }));
    assert.equal(calls, 0); assert.ok(await readFile(old.file, "utf8"));
  });
});

test("empty historical runtime directories do not consume stopped-receipt capacity", posixOnly, async t => {
  const root = await directory(t);
  await Promise.all(Array.from({ length: 129 }, (_, i) => mkdir(path.join(root, `old-runtime-${i}`), { mode: 0o700 })));
  assert.equal(await recover()({ privateControlRoot: root, ...scope, api: { async abortAck() { throw new Error("No native exit evidence exists"); } } }), 0);
});
