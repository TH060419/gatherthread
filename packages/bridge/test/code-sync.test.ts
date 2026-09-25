import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { CodeFile, CodeStatus } from "@gatherthread/protocol";
import { CodeSyncError, ProjectCodeSync } from "../src/code-sync.js";
import { parseCodexConnectArgs, processCodeSyncControlJobs, runProjectConnector, type ManagedSession } from "../src/codex-connect.js";
import type { HttpCollaborationClient } from "../src/http-client.js";
import type { ProjectHarnessAdapter } from "../src/project-harness.js";
import type { SnapshotRequestSummary } from "../src/types.js";

const exec = promisify(execFile);
const branchId = `branch-${"a".repeat(24)}`;
const sha = (text: string) => createHash("sha1").update(text).digest("hex");

function cloudFixture(initialFiles: CodeFile[] = []) {
  let files = initialFiles;
  let head: string | null = initialFiles.length ? sha(JSON.stringify(initialFiles)) : null;
  let own = initialFiles.length > 0;
  const requests: { pathname: string; body?: Record<string, unknown> }[] = [];
  const retries = new Map<string, { body: string; result: unknown }>();
  const status = (): CodeStatus => ({
    repository: { enabled: true, main_commit: head },
    branches: own && head ? [{ id: branchId, name: "gt/user", user_id: "user", head_commit: head, review_status: "draft" }] : [],
    own_branch_id: own ? branchId : null,
  });
  const response = (data: unknown, code = 200) => new Response(JSON.stringify({ data }), { status: code });
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(String(request));
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer local-test-device");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ pathname: url.pathname, ...(body ? { body } : {}) });
    if (url.pathname.endsWith("/checkpoints") && body) {
      const key = String(body.idempotency_key);
      const existing = retries.get(key);
      if (existing) { assert.equal(JSON.stringify(body), existing.body); return response(existing.result); }
      if (body.base_commit !== head) return response({}, 409);
      files = body.files as CodeFile[];
      head = sha(JSON.stringify([head, files]));
      own = true;
      const result = { status: status(), commit: head };
      retries.set(key, { body: JSON.stringify(body), result });
      return response(result);
    }
    if (url.pathname.endsWith("/snapshot")) return response({ snapshot: { branch_id: own ? branchId : "main", commit: head, files } });
    return response(status());
  };
  return { fetcher, requests, status, currentFiles: () => files, replace(next: CodeFile[]) { files = next; head = sha(JSON.stringify([head, next])); own = true; } };
}
const file = (name: string, content: string): CodeFile => ({ path: name, content_base64: Buffer.from(content).toString("base64"), executable: false });
async function fixture(initialFiles: CodeFile[] = []) {
  const temporary = await mkdtemp(path.join(tmpdir(), "gt-code-sync-"));
  const workspace = path.join(temporary, "workspace");
  await mkdir(workspace);
  const cloud = cloudFixture(initialFiles);
  const options = { apiUrl: "http://127.0.0.1:18787", token: "local-test-device", projectId: "project", actorId: "user", workspacePath: workspace, stateRoot: path.join(temporary, "state"), fetch: cloud.fetcher };
  return { temporary, workspace, cloud, options, manager: new ProjectCodeSync(options) };
}

test("code checkpoints inspect Git ignores and never change an existing index, branch or working source", async () => {
  const f = await fixture();
  await exec("git", ["init", "--quiet", f.workspace]);
  await writeFile(path.join(f.workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(f.workspace, "source.ts"), "export const answer = 42;\n");
  await writeFile(path.join(f.workspace, "ignored.txt"), "do not share");
  await writeFile(path.join(f.workspace, ".env"), "SECRET=example");
  await mkdir(path.join(f.workspace, "node_modules"));
  await writeFile(path.join(f.workspace, "node_modules", "package.js"), "generated");
  await exec("git", ["-C", f.workspace, "add", "source.ts"]);
  const index = await readFile(path.join(f.workspace, ".git", "index"));
  const result = await f.manager.upload();
  assert.equal(result.automatic_upload, false);
  assert.equal(result.local_changes, 0);
  assert.deepEqual(f.cloud.currentFiles().map((entry) => entry.path), [".gitignore", "source.ts"]);
  assert.deepEqual(await readFile(path.join(f.workspace, ".git", "index")), index);
  assert.equal(await readFile(path.join(f.workspace, "ignored.txt"), "utf8"), "do not share");
  const privateState = await readFile(path.join(f.options.stateRoot, "binding.json"), "utf8");
  assert.ok(!privateState.includes(f.options.token));
  const secondHarness = new ProjectCodeSync(f.options);
  assert.equal((await secondHarness.status()).base_commit, result.base_commit);
});

test("non-Git workspaces honor .gitignore and exclude symlink source", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(f.workspace, "ignored.txt"), "private");
  await writeFile(path.join(f.workspace, "a.txt"), "hello");
  await symlink(path.join(f.workspace, "ignored.txt"), path.join(f.workspace, "link.txt"));
  await f.manager.upload();
  assert.deepEqual(f.cloud.currentFiles().map((entry) => entry.path), [".gitignore", "a.txt"]);
  assert.ok(!(await readdir(f.workspace)).includes(".git"));
});

test("tracked secrets and recognizable credentials fail closed before code upload", async () => {
  const f = await fixture();
  await exec("git", ["init", "--quiet", f.workspace]);
  await writeFile(path.join(f.workspace, ".env"), "test only");
  await exec("git", ["-C", f.workspace, "add", ".env"]);
  await assert.rejects(f.manager.upload(), { code: "code_sync_secret" });
  assert.equal(f.cloud.requests.filter((r) => r.body).length, 0);
  await exec("git", ["-C", f.workspace, "rm", "--cached", ".env"]);
  await writeFile(path.join(f.workspace, "source.ts"), ["-----BEGIN", "PRIVATE KEY-----"].join(" "));
  await assert.rejects(f.manager.upload(), { code: "code_sync_secret" });
});

test("local source preflight rejects service credentials before transmitting file bytes", async () => {
  const f = await fixture();
  for (const prefix of ["gta_", "gtb_", "gti_", "gtd_", "sk-", "glpat-", "xoxb-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
    await writeFile(path.join(f.workspace, "source.ts"), `const fixtureCredential = "${prefix}${"fixture".repeat(6)}";`);
    await assert.rejects(f.manager.upload(), { code: "code_sync_secret" });
  }
  assert.equal(f.cloud.requests.filter((request) => request.body).length, 0);
});

test("a permitted long-path checkpoint keeps its complete private baseline readable", async () => {
  const f = await fixture();
  for (let index = 0; index < 900; index += 1) {
    await writeFile(path.join(f.workspace, `${index}-${"x".repeat(240)}`), "");
  }
  const uploaded = await f.manager.upload();
  assert.equal(uploaded.file_count, 900);
  assert.equal(uploaded.local_changes, 0);
  const reconnected = new ProjectCodeSync(f.options);
  assert.equal((await reconnected.status()).base_commit, uploaded.base_commit);
});

test("download and recovery accept an allowed 255-byte source filename", async () => {
  const name = "x".repeat(255);
  const f = await fixture([file(name, "portable source")]);
  await f.manager.download();
  assert.equal(await readFile(path.join(f.workspace, name), "utf8"), "portable source");
  const recovered = await f.manager.recover();
  assert.equal(await readFile(path.join(f.temporary, recovered.recovery_directory!, name), "utf8"), "portable source");
});

test("download refuses dirty and ignored-file collisions, then applies safe cloud progress", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "a.txt"), "first");
  await f.manager.upload();
  f.cloud.replace([file("a.txt", "cloud")]);
  await writeFile(path.join(f.workspace, "a.txt"), "local unfinished");
  await assert.rejects(f.manager.download(), { code: "code_sync_dirty" });
  assert.equal(await readFile(path.join(f.workspace, "a.txt"), "utf8"), "local unfinished");
  await writeFile(path.join(f.workspace, "a.txt"), "first");
  const downloaded = await f.manager.download();
  assert.equal(downloaded.local_changes, 0);
  assert.equal(downloaded.needs_download, false);
  assert.equal(await readFile(path.join(f.workspace, "a.txt"), "utf8"), "cloud");
});

test("fresh device downloads existing cloud branch and stale checkpoints cannot overwrite newer work", async () => {
  const f = await fixture([file("a.txt", "cloud")]);
  await writeFile(path.join(f.workspace, "a.txt"), "my new unrelated project");
  await assert.rejects(f.manager.upload(), { code: "code_sync_conflict" });
  await rm(path.join(f.workspace, "a.txt"));
  await f.manager.download();
  f.cloud.replace([file("a.txt", "other device")]);
  await writeFile(path.join(f.workspace, "a.txt"), "local device");
  await assert.rejects(f.manager.upload(), { code: "code_sync_conflict" });
  assert.equal(await readFile(path.join(f.workspace, "a.txt"), "utf8"), "local device");
});

test("recovery works after full workspace loss and never recreates or switches the original directory", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "a.txt"), "source checkpoint");
  await f.manager.upload();
  const moved = path.join(f.temporary, "lost-workspace-backup");
  await rename(f.workspace, moved);
  const checkpointCount = f.cloud.requests.filter((request) => request.pathname.endsWith("/checkpoints")).length;
  await assert.rejects(f.manager.upload(), { code: "code_sync_recovery_required" });
  assert.equal(f.cloud.requests.filter((request) => request.pathname.endsWith("/checkpoints")).length, checkpointCount);
  assert.equal(f.cloud.currentFiles().length, 1, "missing local root must never erase cloud source");
  const recovered: string[] = [];
  const manager = new ProjectCodeSync({ ...f.options, onRecovery: (target) => recovered.push(target) });
  const result = await manager.recover();
  assert.ok(result.recovery_directory?.startsWith("workspace-recovered-"));
  assert.ok(!JSON.stringify(result).includes(f.temporary));
  assert.equal(await readFile(path.join(recovered[0]!, "a.txt"), "utf8"), "source checkpoint");
  assert.equal(await readFile(path.join(moved, "a.txt"), "utf8"), "source checkpoint");
  await assert.rejects(readFile(path.join(f.workspace, "a.txt")), { code: "ENOENT" });
});

test("remote unsafe paths and destination symlinks are rejected before overwriting files", async () => {
  const f = await fixture([file("../escape.txt", "bad")]);
  await assert.rejects(f.manager.download(), { code: "code_sync_unavailable" });
  f.cloud.replace([file("nested/a.txt", "cloud")]);
  const other = path.join(f.temporary, "other");
  await mkdir(other);
  await symlink(other, path.join(f.workspace, "nested"), "dir");
  await assert.rejects(f.manager.download(), { code: "code_sync_unsafe_path" });
  assert.deepEqual(await readdir(other), []);
});

test("local binding mismatch and concurrent operation locks fail closed", async () => {
  const f = await fixture();
  await f.manager.initialize();
  await assert.rejects(new ProjectCodeSync({ ...f.options, actorId: "someone-else" }).initialize(), { code: "code_sync_binding" });
  await writeFile(path.join(f.options.stateRoot, "operation.lock"), "in-use");
  await assert.rejects(f.manager.status(), { code: "code_sync_locked" });
});

test("a transient initialization lock can be retried on the same code-sync manager", async () => {
  const f = await fixture();
  await mkdir(f.options.stateRoot);
  const lock = path.join(f.options.stateRoot, "operation.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.manager.initialize(), { code: "code_sync_locked" });
  await rm(lock);
  await f.manager.initialize();
  assert.equal((await f.manager.status()).automatic_upload, false);
});

test("invalid and unsupported code bindings fail closed without stopping conversation polling", async () => {
  const f = await fixture();
  await f.manager.initialize();
  const bindingPath = path.join(f.options.stateRoot, "binding.json");
  const valid = JSON.parse(await readFile(bindingPath, "utf8"));
  for (const invalid of [null, { ...valid, version: 2 }, { ...valid, baseline: { "../outside": "a".repeat(64) } }]) {
    await writeFile(bindingPath, JSON.stringify(invalid));
    await assert.rejects(f.manager.upload(), { code: "code_sync_binding" });
  }
  const shutdown = new AbortController();
  let snapshots = 0;
  await runProjectConnector({
    api: { listProjectSessions: async () => [] } as unknown as HttpCollaborationClient,
    actorUserId: "user", actorDeviceId: "device",
    project: { id: "project", name: "Project", role: "owner", state: "active", sessionCount: 0 },
    stateRoot: path.join(f.temporary, "conversation-state"),
    harness: { processSnapshotJobs: async () => { snapshots += 1; shutdown.abort(); } } as unknown as ProjectHarnessAdapter,
    signal: shutdown.signal, token: f.options.token,
    hookSocketPath: path.join(f.temporary, "unused.sock"),
    hookSpoolPath: path.join(f.temporary, "unused-spool"),
    hookRegistryPath: path.join(f.temporary, "unused-registry"),
    hookWorkspacePath: f.workspace, hookMode: "disabled", codeSync: f.manager,
  });
  assert.equal(snapshots, 1);
  assert.equal(f.cloud.requests.length, 0);
  assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), { ...valid, baseline: { "../outside": "a".repeat(64) } });
});

test("retrying the same recovery job reuses its private receipt instead of creating duplicate folders", async () => {
  const f = await fixture([file("a.txt", "cloud")]);
  const first = await f.manager.execute("code_recover", { operationId: "recovery-job-123" });
  const second = await f.manager.execute("code_recover", { operationId: "recovery-job-123" });
  assert.deepEqual(second, first);
  assert.equal((await readdir(f.temporary)).filter((name) => name.startsWith("workspace-recovered-")).length, 1);
});

test("recovery bounds the sibling folder name for a long authorized workspace basename", async () => {
  const f = await fixture([file("a.txt", "cloud")]);
  const workspacePath = path.join(f.temporary, "w".repeat(255));
  await rename(f.workspace, workspacePath);
  const manager = new ProjectCodeSync({ ...f.options, workspacePath });
  const recovered = await manager.recover();
  assert.ok(Buffer.byteLength(recovered.recovery_directory!) <= 255);
  assert.equal(await readFile(path.join(f.temporary, recovered.recovery_directory!, "a.txt"), "utf8"), "cloud");
});

test("recovery ignores unsafe old source and the recovered workspace can upload new edits immediately", async () => {
  const f = await fixture([file("a.txt", "cloud")]);
  await writeFile(path.join(f.workspace, "private.txt"), ["-----BEGIN", "PRIVATE KEY-----"].join(" "));
  const result = await f.manager.recover();
  assert.equal(result.local_status_unknown, true);
  const workspacePath = await (await import("node:fs/promises")).realpath(path.join(f.temporary, result.recovery_directory!));
  const stateRoot = path.join(f.temporary, createHash("sha256").update(workspacePath).digest("hex"));
  const restored = new ProjectCodeSync({ ...f.options, workspacePath, stateRoot });
  assert.equal((await restored.status()).local_changes, 0);
  await writeFile(path.join(workspacePath, "a.txt"), "continued on restored source");
  assert.equal((await restored.upload()).local_changes, 0);
  assert.equal(Buffer.from(f.cloud.currentFiles()[0]!.content_base64, "base64").toString(), "continued on restored source");
});

test("automatic code upload is distinct from conversation upload and refuses active Agent runs", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "a.txt"), "one");
  await f.manager.tick({ busy: false });
  assert.equal(f.cloud.requests.filter((r) => r.body).length, 0);
  assert.equal((await f.manager.setAutomaticUpload(true)).automatic_upload, true);
  await assert.rejects(f.manager.execute("code_download", { busy: true }), { code: "code_sync_busy" });
  await f.manager.tick({ busy: true });
  assert.equal(f.cloud.requests.filter((r) => r.body).length, 0);
  assert.equal((await f.manager.execute("code_auto_upload_disable", { busy: true })).automatic_upload, false);
});

test("automatic upload waits for settled idle files and pauses mass deletion after local file loss", async (t) => {
  const f = await fixture();
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  await writeFile(path.join(f.workspace, "a.txt"), "one");
  await f.manager.setAutomaticUpload(true);
  await f.manager.tick({ busy: false });
  assert.equal(f.cloud.requests.filter((r) => r.body).length, 0);
  now += 6_000;
  assert.equal((await f.manager.tick({ busy: false }))?.local_changes, 0);
  assert.equal(f.cloud.requests.filter((r) => r.body).length, 1);
  await writeFile(path.join(f.workspace, "a.txt"), "two");
  now += 20_000;
  await f.manager.tick({ busy: true });
  await f.manager.tick({ busy: false });
  assert.equal(f.cloud.requests.filter((r) => r.body).length, 1);
  now += 6_000;
  assert.equal((await f.manager.tick({ busy: false }))?.local_changes, 0);
  await rm(path.join(f.workspace, "a.txt"));
  now += 20_000;
  await f.manager.tick({ busy: false });
  now += 6_000;
  await assert.rejects(f.manager.tick({ busy: false }), { code: "code_sync_dirty" });
  assert.equal(f.cloud.currentFiles().length, 1);
});

test("automatic upload cannot publish changes made after its stable-file and deletion checks", async (t) => {
  const f = await fixture();
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  await writeFile(path.join(f.workspace, "a.txt"), "original");
  await writeFile(path.join(f.workspace, "b.txt"), "keep this file");
  await f.manager.upload();
  let mutateDuringUpload = false;
  const manager = new ProjectCodeSync({ ...f.options, fetch: async (url, init) => {
    if (mutateDuringUpload && String(url).endsWith("/code")) {
      mutateDuringUpload = false;
      await writeFile(path.join(f.workspace, "a.txt"), "unfinished work");
      await rm(path.join(f.workspace, "b.txt"));
    }
    return f.cloud.fetcher(url, init);
  } });
  await manager.setAutomaticUpload(true);
  await writeFile(path.join(f.workspace, "a.txt"), "settled work");
  await manager.tick({ busy: false });
  now += 6_000;
  mutateDuringUpload = true;
  await assert.rejects(manager.tick({ busy: false }), { code: "code_sync_busy" });
  assert.equal(f.cloud.requests.filter((request) => request.pathname.endsWith("/checkpoints")).length, 1);
  assert.deepEqual(f.cloud.currentFiles(), [file("a.txt", "original"), file("b.txt", "keep this file")]);
});

test("download retains a private original-source backup and clears its recovery journal only after verification", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "a.txt"), "original source");
  await f.manager.upload();
  f.cloud.replace([file("a.txt", "cloud source")]);
  await f.manager.download();
  const backupRoot = path.join(f.options.stateRoot, "download-backups");
  const backups = await readdir(backupRoot);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(backupRoot, backups[0]!, "a.txt"), "utf8"), "original source");
  const binding = JSON.parse(await readFile(path.join(f.options.stateRoot, "binding.json"), "utf8"));
  assert.equal(binding.interrupted_download, undefined);
  binding.interrupted_download = true;
  await writeFile(path.join(f.options.stateRoot, "binding.json"), JSON.stringify(binding));
  await assert.rejects(f.manager.upload(), { code: "code_sync_recovery_required" });
  assert.ok((await f.manager.recover()).recovery_directory);
});

test("an empty initial Git commit accepts the first explicit source checkpoint", async () => {
  const f = await fixture();
  f.cloud.replace([]);
  const bootstrapHead = f.cloud.status().repository.main_commit;
  await writeFile(path.join(f.workspace, "a.txt"), "new project");
  assert.equal((await f.manager.upload()).local_changes, 0);
  assert.equal(f.cloud.requests.find((r) => r.body)?.body?.base_commit, bootstrapHead);
});

test("an uncertain upload retries the same key and payload without losing the original baseline", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "a.txt"), "first");
  await f.manager.upload();
  const baseline = (await f.manager.status()).base_commit;
  await writeFile(path.join(f.workspace, "a.txt"), "second");
  let dropResponse = true;
  const manager = new ProjectCodeSync({ ...f.options, fetch: async (url, init) => {
    const response = await f.cloud.fetcher(url, init);
    if (String(url).endsWith("/checkpoints") && dropResponse) { dropResponse = false; throw new Error("response lost"); }
    return response;
  } });
  await assert.rejects(manager.upload(), { code: "code_sync_unavailable" });
  assert.equal((await manager.status()).base_commit, baseline);
  assert.equal((await manager.upload()).local_changes, 0);
  const posts = f.cloud.requests.filter((r) => r.body);
  assert.deepEqual(posts[1]?.body, posts[2]?.body);
});

test("cloud code errors preserve only bounded known codes, never arbitrary server messages", async () => {
  const f = await fixture();
  for (const code of ["code_secret_detected", "code_storage_quota_exceeded", "code_git_unavailable", "code_storage_unavailable", "code_not_enabled", "arbitrary_error"]) {
    const manager = new ProjectCodeSync({ ...f.options, fetch: async () => new Response(JSON.stringify({
      error: { code, message: `PRIVATE: ${f.workspace}; local-test-device` },
    }), { status: 503 }) });
    await assert.rejects(manager.status(), (error: unknown) => {
      assert.ok(error instanceof CodeSyncError);
      assert.equal(error.code, code === "arbitrary_error" ? "code_sync_unavailable" : code);
      assert.doesNotMatch(error.message, /PRIVATE|local-test-device|gt-code-sync-/u);
      return true;
    });
  }
});

test("Codex source sync is opt-in and requires reviewed activity hooks", () => {
  const regular = parseCodexConnectArgs(["--url", "http://localhost:18787"]);
  assert.ok(regular !== "help" && !regular.codeSync);
  assert.throws(() => parseCodexConnectArgs(["--url", "http://localhost:18787", "--code-sync"]), /requires --plugin-hooks/u);
  const enabled = parseCodexConnectArgs(["--url", "http://localhost:18787", "--code-sync", "--plugin-hooks"]);
  assert.ok(enabled !== "help" && enabled.codeSync);
  const recovery = parseCodexConnectArgs(["--url", "http://localhost:18787", "--workspace", "/missing/workspace", "--recover-code"]);
  assert.ok(recovery !== "help" && recovery.recoverCode && !recovery.codeSync);
});

test("Codex code jobs require exact runtime and explicit local authorization, errors never leak paths", async () => {
  const job: SnapshotRequestSummary = { id: "job-1", sessionId: "s1", kind: "code_upload", targetRuntimeId: "runtime-1", status: "pending", throughSequence: 0 };
  const results: unknown[] = [];
  const failures: unknown[] = [];
  const api = {
    listSnapshotRequests: async (status: string) => status === "pending" ? [job] : [],
    claimSnapshotRequest: async () => ({ ...job, status: "claimed" as const }),
    completeSnapshotRequest: async (_id: string, _runtime: string, result: unknown) => { results.push(result); return { ...job, status: "completed" as const }; },
    failSnapshotRequest: async (_id: string, _runtime: string, error: unknown) => { failures.push(error); return { ...job, status: "failed" as const }; },
  };
  const managed = new Map([["s1", { bridge: { runtime: { id: "runtime-1", harness: "codex" } } } as ManagedSession]]);
  await processCodeSyncControlJobs({ api, managed, busy: false });
  assert.equal((failures[0] as CodeSyncError).code, "code_sync_disabled");
  job.targetRuntimeId = "another-runtime";
  await processCodeSyncControlJobs({ api, managed, busy: false });
  assert.equal(failures.length, 1);
  job.targetRuntimeId = "runtime-1";
  await processCodeSyncControlJobs({ api, managed, busy: false, codeSync: { execute: async () => { throw new Error("private /Users/example/.secret-token"); } } });
  assert.ok(!JSON.stringify(failures).includes("/Users"));
  assert.equal(results.length, 0);
});

test("code job completion failure keeps a successful recovery retryable without duplicate folders", async () => {
  const f = await fixture([file("a.txt", "cloud")]);
  const job: SnapshotRequestSummary = { id: "recovery-job-retry", sessionId: "s1", kind: "code_recover", targetRuntimeId: "runtime-1", status: "claimed", throughSequence: 0 };
  const failures: unknown[] = [];
  let completions = 0;
  const api = {
    listSnapshotRequests: async (status: string) => status === "claimed" ? [job] : [],
    claimSnapshotRequest: async () => job,
    completeSnapshotRequest: async () => {
      if (++completions === 1) throw new Error("completion connection failed");
      return { ...job, status: "completed" as const };
    },
    failSnapshotRequest: async (_id: string, _runtime: string, error: unknown) => { failures.push(error); return { ...job, status: "failed" as const }; },
  };
  const managed = new Map([["s1", { bridge: { runtime: { id: "runtime-1", harness: "codex" } } } as ManagedSession]]);
  await assert.rejects(processCodeSyncControlJobs({ api, managed, busy: false, codeSync: f.manager }), /completion connection failed/u);
  assert.equal(failures.length, 0);
  await processCodeSyncControlJobs({ api, managed, busy: false, codeSync: f.manager });
  assert.equal(completions, 2);
  assert.equal((await readdir(f.temporary)).filter((name) => name.startsWith("workspace-recovered-")).length, 1);
});
