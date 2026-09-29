import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGitHubCodeSync, runGitHubGit, type GitHubGitRunner } from "../src/github-code-sync.js";
import { parseCodexConnectArgs, processCodeSyncControlJobs, type ManagedSession } from "../src/codex-connect.js";
import type { SnapshotRequestSummary } from "../src/types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const branch = (user: string) => `gatherthread/${hash("project")}/${hash(user)}`;
const git: GitHubGitRunner = (args, options) => new Promise((resolve, reject) => {
  const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) },
  });
  const output: Buffer[] = []; let error = "";
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.on("data", (chunk: Buffer) => error += chunk.toString());
  child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(error)));
  child.stdin.on("error", () => {}); child.stdin.end(options.input);
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "gt-github-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git"); await mkdir(remote);
  await git(["init", "--bare", "--quiet", "."], { cwd: remote });
  const metadata = { repository: "sample/source", base_branch: "main", enabled: true, revision: randomUUID() };
  let canWrite = true; let loseAck = false; let metadataUnavailable = false;
  const calls: string[][] = []; const requests: string[] = [];
  const runner: GitHubGitRunner = async (args, options) => {
    calls.push(args);
    const result = await git(args.map((arg) => arg === "https://github.com/sample/source.git" ? remote : arg), options);
    if (loseAck && args[0] === "push") { loseAck = false; throw new Error("fixture lost push acknowledgement"); }
    return result;
  };
  async function client(user = "alice", name = user) {
    const workspace = path.join(root, name); await mkdir(workspace);
    const fetcher: typeof fetch = async (request, init) => {
      requests.push(String(request)); assert.equal(init?.method ?? "GET", "GET"); assert.equal(init?.body, undefined);
      assert.ok(String(request).endsWith("/v1/projects/project/github"));
      if (metadataUnavailable) throw new Error("fixture metadata unavailable");
      return new Response(JSON.stringify({ data: { connection: metadata, branch: branch(user), can_configure: user === "alice", can_write: canWrite } }));
    };
    const options = { apiUrl: "http://127.0.0.1:18787", token: "fixture-device", projectId: "project", actorId: user, workspacePath: workspace,
      stateRoot: path.join(root, `state-${name}`), repository: "sample/source", baseBranch: "main", revision: metadata.revision, fetch: fetcher };
    return { workspace, options, sync: createGitHubCodeSync(options, runner) };
  }
  return { root, remote, metadata, calls, requests, client, runner,
    setMetadataUnavailable: (value: boolean) => { metadataUnavailable = value; },
    setCanWrite: (value: boolean) => { canWrite = value; }, losePushAck: () => { loseAck = true; } };
}

test("repository attributes cannot amplify conflict objects in the private GitHub repository", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await writeFile(path.join(a.workspace, "a.txt"), "common\n");
  await writeFile(path.join(a.workspace, ".gitattributes"), "*.txt conflict-marker-size=65536\n");
  const initial = await a.sync.upload();
  await git(["update-ref", "refs/heads/main", initial.base_commit!], { cwd: f.remote });
  const b = await f.client("bob"); await b.sync.download();
  await writeFile(path.join(b.workspace, "a.txt"), "bob\n"); const own = await b.sync.upload();
  await writeFile(path.join(a.workspace, "a.txt"), "alice\n"); const upstream = await a.sync.upload();
  await git(["update-ref", "refs/heads/main", upstream.base_commit!], { cwd: f.remote });
  await assert.rejects(b.sync.execute("github_code_update"), { code: "code_sync_conflict" });
  const [namespace] = await readdir(b.options.stateRoot);
  assert.ok(namespace);
  const privateGit = path.join(b.options.stateRoot, namespace, "github.git");
  assert.equal(await readFile(path.join(privateGit, "info", "attributes"), "utf8"), "* conflict-marker-size=7\n");
  const objects = (await git(["cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)"], { cwd: privateGit })).toString();
  const blobSizes = objects.trim().split("\n").filter((line) => line.startsWith("blob ")).map((line) => Number(line.split(" ")[1]));
  assert.ok(blobSizes.length > 0);
  assert.ok(Math.max(...blobSizes) < 1_024, "conflict markers must not create oversized unreachable blobs");
  assert.equal((await git(["rev-parse", branch("bob")], { cwd: f.remote })).toString().trim(), own.base_commit);
  assert.equal(await readFile(path.join(b.workspace, "a.txt"), "utf8"), "bob\n");
});

test("same-tree base updates record ancestry so the next upstream edit merges cleanly", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await writeFile(path.join(a.workspace, "a.txt"), "one\n"); const initial = await a.sync.upload();
  await git(["update-ref", "refs/heads/main", initial.base_commit!], { cwd: f.remote });
  const b = await f.client("bob"); await b.sync.download();
  await writeFile(path.join(b.workspace, "a.txt"), "two\n"); const own = await b.sync.upload();
  // An intermediate commit ensures independently produced equal trees have distinct commits.
  await writeFile(path.join(a.workspace, "a.txt"), "intermediate\n"); await a.sync.upload();
  await writeFile(path.join(a.workspace, "a.txt"), "two\n"); const upstream = await a.sync.upload();
  assert.notEqual(own.base_commit, upstream.base_commit);
  await git(["update-ref", "refs/heads/main", upstream.base_commit!], { cwd: f.remote });
  await b.sync.execute("github_code_update");
  const merged = (await git(["rev-parse", branch("bob")], { cwd: f.remote })).toString().trim();
  assert.notEqual(merged, own.base_commit);
  await git(["merge-base", "--is-ancestor", upstream.base_commit!, merged], { cwd: f.remote });
  assert.equal((await git(["rev-parse", `${merged}^{tree}`], { cwd: f.remote })).toString(),
    (await git(["rev-parse", `${own.base_commit}^{tree}`], { cwd: f.remote })).toString());
  const pushes = f.calls.filter((call) => call[0] === "push").length;
  await b.sync.execute("github_code_update");
  assert.equal(f.calls.filter((call) => call[0] === "push").length, pushes, "already merged bases must not create another checkpoint");
  await writeFile(path.join(a.workspace, "a.txt"), "three\n"); const newer = await a.sync.upload();
  await git(["update-ref", "refs/heads/main", newer.base_commit!], { cwd: f.remote });
  await b.sync.execute("github_code_update"); await b.sync.download();
  assert.equal(await readFile(path.join(b.workspace, "a.txt"), "utf8"), "three\n");
});

test("automatic upload revocation stays durable when metadata refresh is offline", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await a.sync.setAutomaticUpload(true); assert.equal(await a.sync.automaticUploadEnabled(), true);
  f.setMetadataUnavailable(true);
  const callsBefore = f.calls.length;
  const result = await a.sync.setAutomaticUpload(false);
  assert.equal(result.automatic_upload, false); assert.equal(result.local_status_unknown, true);
  assert.equal(f.calls.length, callsBefore, "failed metadata must not initiate GitHub IO");
  assert.equal(await a.sync.automaticUploadEnabled(), false);
  const restarted = createGitHubCodeSync(a.options, f.runner);
  assert.equal(await restarted.automaticUploadEnabled(), false);
  await assert.rejects(restarted.setAutomaticUpload(true));
  assert.equal(await restarted.automaticUploadEnabled(), false);
  f.setMetadataUnavailable(false); assert.equal((await restarted.status()).automatic_upload, false);
});

test("GitHub inventory accepts supported long paths whose Git listing exceeds two MiB", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await git(["init", "--quiet"], { cwd: a.workspace });
  const directory = path.join(a.workspace, "d".repeat(200)); await mkdir(directory);
  const count = 4_500;
  for (let offset = 0; offset < count; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, count - offset) }, (_, index) =>
      writeFile(path.join(directory, `${"f".repeat(240)}${String(offset + index).padStart(4, "0")}.txt`), "source\n")));
  }
  await git(["-c", "core.longpaths=true", "add", "."], { cwd: a.workspace });
  const listing = await git(["ls-files", "--stage", "-z"], { cwd: a.workspace });
  assert.ok(listing.length > 2 * 1024 * 1024, "fixture must exceed the former inventory output limit");
  const index = await readFile(path.join(a.workspace, ".git", "index"));
  const status = await a.sync.status();
  assert.equal(status.file_count, count); assert.equal(status.local_changes, count); assert.equal(status.excluded_count, 0);
  assert.deepEqual(await readFile(path.join(a.workspace, ".git", "index")), index);
  assert.equal(f.calls.some((call) => call[0] === "push"), false);
});

test("local Git LFS pointers are rejected before any remote push", async (t) => {
  const f = await fixture(t); const a = await f.client();
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1234\n`;
  await writeFile(path.join(a.workspace, "asset.dat"), pointer);
  await assert.rejects(a.sync.upload(), { code: "code_sync_unsupported" });
  assert.equal(f.calls.some((call) => call[0] === "push"), false);
  assert.equal((await git(["for-each-ref", "--format=%(refname)"], { cwd: f.remote })).toString(), "");
  assert.equal(await readFile(path.join(a.workspace, "asset.dat"), "utf8"), pointer);
});

test("production Git runner ignores inherited URL rewriting, helpers and hooks without contacting a remote", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await git(["init", "--quiet"], { cwd: a.workspace });
  const hookDirectory = path.join(f.root, "hooks"); await mkdir(hookDirectory);
  const hook = path.join(hookDirectory, "pre-commit"); await writeFile(hook, "#!/bin/sh\nexit 99\n"); await chmod(hook, 0o700);
  await git(["config", "core.hooksPath", hookDirectory], { cwd: a.workspace });
  await git(["remote", "add", "origin", "https://github.com/sample/source.git"], { cwd: a.workspace });
  const globalConfig = path.join(f.root, "poisoned-global-config");
  await writeFile(globalConfig, '[url "https://attacker.invalid/"]\n\tinsteadOf = https://github.com/\n[credential]\n\thelper = !exit 99\n');
  const overrides = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://environment.invalid/.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/" };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    assert.equal((await runGitHubGit(["remote", "get-url", "origin"], { cwd: a.workspace })).toString().trim(), "https://github.com/sample/source.git");
    assert.equal((await runGitHubGit(["config", "--get-all", "credential.helper"], { cwd: a.workspace })).toString(), "\n!gh auth git-credential\n");
    await runGitHubGit(["commit", "--quiet", "--allow-empty", "-m", "offline hook isolation fixture"], { cwd: a.workspace });
    assert.equal((await git(["rev-list", "--count", "HEAD"], { cwd: a.workspace })).toString().trim(), "1");
    // This is a local path, never an HTTPS request; the production protocol policy must reject it.
    await assert.rejects(runGitHubGit(["ls-remote", f.remote], { cwd: a.workspace }), { code: "code_sync_unavailable" });
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("GitHub uploads only my branch without sending files to GT or changing the workspace index", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await git(["init", "--quiet"], { cwd: a.workspace });
  await writeFile(path.join(a.workspace, "a.txt"), "hello"); await git(["add", "a.txt"], { cwd: a.workspace });
  const index = await readFile(path.join(a.workspace, ".git", "index"));
  const result = await a.sync.upload();
  assert.equal(result.provider, "github"); assert.equal(result.branch, branch("alice")); assert.equal(result.local_changes, 0); assert.equal(result.automatic_upload, true);
  assert.deepEqual(await readFile(path.join(a.workspace, ".git", "index")), index);
  assert.equal((await git(["show", `${branch("alice")}:a.txt`], { cwd: f.remote })).toString(), "hello");
  await assert.rejects(git(["rev-parse", "--verify", "main"], { cwd: f.remote }));
  assert.ok(f.requests.length > 0); assert.ok(f.calls.filter((call) => call[0] === "push").every((call) => !call.some((arg) => arg.startsWith("--force"))));
  const status = await createGitHubCodeSync(a.options, async (args, opts) => git(args.map((arg) => arg === "https://github.com/sample/source.git" ? f.remote : arg), opts)).status();
  assert.equal(status.base_commit, result.base_commit);
});

test("GitHub supports larger source checkpoints and recovery into a new folder", async (t) => {
  const f = await fixture(t); const a = await f.client();
  const content = "a".repeat(3 * 1024 * 1024);
  await writeFile(path.join(a.workspace, "large.txt"), content);
  const uploaded = await a.sync.upload();
  const recovered = await a.sync.recover("recover-1");
  const retry = await a.sync.recover("recover-1");
  assert.equal(recovered.recovery_directory, retry.recovery_directory);
  assert.equal(await readFile(path.join(f.root, recovered.recovery_directory!, "large.txt"), "utf8"), content);
  assert.equal(recovered.base_commit, uploaded.base_commit);
  assert.ok(!(await readdir(a.workspace)).includes(".git"));
  const restoredPath = await realpath(path.join(f.root, recovered.recovery_directory!));
  const restored = createGitHubCodeSync({ ...a.options, workspacePath: restoredPath,
    stateRoot: path.join(f.root, createHash("sha256").update(restoredPath).digest("hex")),
  }, f.runner);
  assert.equal((await restored.status()).local_changes, 0);
  await writeFile(path.join(restoredPath, "new.txt"), "recovered edit\n");
  const edited = await restored.upload();
  assert.notEqual(edited.base_commit, uploaded.base_commit);
  assert.equal((await git(["show", `${branch("alice")}:new.txt`], { cwd: f.remote })).toString(), "recovered edit\n");
  assert.equal((await a.sync.status()).needs_download, true, "recovery must not change the original transport or baseline");
});

test("two users remain on independent branches; base updates need a safe download", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await writeFile(path.join(a.workspace, "a.txt"), "shared"); const first = await a.sync.upload();
  await git(["update-ref", "refs/heads/main", first.base_commit!], { cwd: f.remote });
  const b = await f.client("bob"); await b.sync.download();
  await writeFile(path.join(b.workspace, "b.txt"), "bob work"); const bob = await b.sync.upload();
  assert.notEqual(bob.branch, first.branch);
  await writeFile(path.join(a.workspace, "a.txt"), "new shared"); const newer = await a.sync.upload();
  await git(["update-ref", "refs/heads/main", newer.base_commit!], { cwd: f.remote });
  const updated = await b.sync.execute("github_code_update"); assert.equal(updated.needs_download, true);
  await writeFile(path.join(b.workspace, "b.txt"), "unuploaded"); await assert.rejects(b.sync.download(), { code: "code_sync_dirty" });
  await writeFile(path.join(b.workspace, "b.txt"), "bob work"); await b.sync.download();
  assert.equal(await readFile(path.join(b.workspace, "a.txt"), "utf8"), "new shared");
  assert.equal(await readFile(path.join(b.workspace, "b.txt"), "utf8"), "bob work");
});

test("configuration/role changes stop direct GitHub IO and paused state allows automatic upload off", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await a.sync.setAutomaticUpload(true);
  f.metadata.enabled = false;
  const before = f.calls.length; assert.equal((await a.sync.setAutomaticUpload(false)).automatic_upload, false); assert.equal(f.calls.length, before);
  await assert.rejects(a.sync.upload(), { code: "code_sync_disabled" });
  f.metadata.enabled = true; f.metadata.revision = randomUUID();
  await assert.rejects(a.sync.status(), { code: "code_sync_binding" });
  f.setCanWrite(false); await assert.rejects(a.sync.status(), { code: "code_sync_binding" });
});

test("ambiguous push completion retries without duplicate commits or losing local work", async (t) => {
  const f = await fixture(t); const a = await f.client(); await writeFile(path.join(a.workspace, "a.txt"), "one");
  await a.sync.upload(); await writeFile(path.join(a.workspace, "a.txt"), "two");
  f.losePushAck(); await assert.rejects(a.sync.upload());
  const head = (await git(["rev-parse", branch("alice")], { cwd: f.remote })).toString().trim();
  const result = await a.sync.upload(); assert.equal(result.base_commit, head); assert.equal(result.local_changes, 0);
  assert.equal((await git(["rev-list", "--count", branch("alice")], { cwd: f.remote })).toString().trim(), "2");
});

test("remote unsafe tree fails closed and leaves local source untouched", async (t) => {
  const f = await fixture(t); const a = await f.client();
  await writeFile(path.join(a.workspace, "a.txt"), "safe"); await a.sync.upload();
  const evil = await f.client("bob", "external"); await git(["init", "--quiet"], { cwd: evil.workspace });
  await writeFile(path.join(evil.workspace, ".env"), "EXAMPLE=value"); await git(["add", ".env"], { cwd: evil.workspace });
  await git(["commit", "--quiet", "-m", "unsafe fixture"], { cwd: evil.workspace });
  await git(["push", f.remote, `HEAD:refs/heads/${branch("bob")}`], { cwd: evil.workspace });
  await assert.rejects(evil.sync.download(), { code: "code_sync_unsafe_path" });
  assert.equal(await readFile(path.join(evil.workspace, ".env"), "utf8"), "EXAMPLE=value");
});

test("Codex GitHub flags are exact and separate from cloud consent", () => {
  const args = ["--url", "http://127.0.0.1:18787", "--github-code-sync", "owner/repo", "--plugin-hooks"];
  const options = parseCodexConnectArgs(args); assert.notEqual(options, "help"); if (options === "help") return;
  assert.equal(options.githubCodeSync, "owner/repo"); assert.equal(options.codeSync, false); assert.equal(options.githubBaseBranch, "main");
  assert.throws(() => parseCodexConnectArgs(args.slice(0, -1)), /requires/);
  assert.throws(() => parseCodexConnectArgs([...args, "--github-base-branch", "gatherthread/private"]), /Invalid/);
  assert.throws(() => parseCodexConnectArgs(["--url", "http://127.0.0.1:18787", "--recover-github-code"]), /requires/);
});

test("Codex GitHub controls route only to exact matching runtime and never cloud provider", async () => {
  const job = { id: "job", sessionId: "session", kind: "github_code_upload", status: "pending", targetRuntimeId: "runtime" } as SnapshotRequestSummary;
  const calls: string[] = [];
  const api = { listSnapshotRequests: async (status: string) => status === "pending" ? [job] : [],
    claimSnapshotRequest: async () => ({ ...job, status: "claimed" as const }), completeSnapshotRequest: async () => { calls.push("complete"); return job; },
    failSnapshotRequest: async () => { calls.push("fail"); return job; } };
  const managed = new Map([["session", { bridge: { runtime: { id: "runtime", harness: "codex" } } } as ManagedSession]]);
  await processCodeSyncControlJobs({ api, managed, busy: false, codeSync: { execute: async () => { throw new Error("wrong provider"); } },
    githubCodeSync: { execute: async (kind) => { calls.push(kind); return { enabled: true, automatic_upload: false, local_changes: 0, file_count: 0, excluded_count: 0, base_commit: null, cloud_commit: null, branch_id: null, needs_download: false }; } } });
  assert.deepEqual(calls, ["github_code_upload", "complete"]);
});

test("Codex browser sign-in job uses only its exact local runtime and returns no credential", async () => {
  const job = { id: "auth-job", sessionId: "session", kind: "github_auth_connect", status: "pending", targetRuntimeId: "runtime" } as SnapshotRequestSummary;
  const results: unknown[] = []; let opens = 0;
  const api = { listSnapshotRequests: async (status: string) => status === "pending" ? [job] : [],
    claimSnapshotRequest: async () => ({ ...job, status: "claimed" as const }),
    completeSnapshotRequest: async (_id: string, _runtime: string, result: unknown) => { results.push(result); return job; },
    failSnapshotRequest: async () => { throw new Error("GitHub sign-in unexpectedly failed"); } };
  const managed = new Map([["session", { bridge: { runtime: { id: "runtime", harness: "codex" } } } as ManagedSession]]);
  await processCodeSyncControlJobs({ api, managed, busy: false,
    connectGitHub: async () => { opens += 1; } });
  assert.equal(opens, 1);
  assert.deepEqual(results, [{ kind: "github_auth_connect", provider: "github", connected: true }]);
});
