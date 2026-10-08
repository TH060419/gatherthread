import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";
import { HostedGithub } from "../src/hosted-github.js";
import { ApiError } from "../src/errors.js";
import { cleanupHostedExecution, HostedExecutorCleanupError, stopHostedContainer } from "../src/hosted-agent-recovery.js";
import { HostedNpmProxy } from "../src/hosted-npm-proxy.js";
import { HostedGithubStatusSchema, type CodeFile } from "@gatherthread/protocol";
import { createServer, request } from "node:http";
import { redactJson } from "../src/redaction.js";
import { HostedRepositoryRunner } from "../src/hosted-repository-runner.js";

const unixTest = process.platform === "win32" ? test.skip : test;
// SQLite setup/teardown in parallel Windows CI can exceed the default case budget.
const fixtureTimeout = process.platform === "win32" ? 60_000 : 10_000;
const file = (path: string, content: string): CodeFile => ({ path, content_base64: Buffer.from(content).toString("base64"), executable: false });
const initial = [file("package.json", '{"name":"fixture","version":"1.0.0","scripts":{"test":"node --test"}}'),
  file("package-lock.json", '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}'), file("src/index.ts", "export const value = 1;\n")];
const options: HostedAgentOptions = { endpoints: [{ id: "one", profileId: "coding", label: "Coding", provider: "openai-compatible",
  model: "coding", baseUrl: "https://model.example/v1", apiToken: "fake-model-secret", quotaGroup: "one", dailyRuns: 20, maxConcurrent: 2 }],
  image: `sha256:${"a".repeat(64)}`, userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 2 };

function fixture() {
 const directory = mkdtempSync(join(tmpdir(), "gt-github-test-"));
 let now = Date.parse("2026-10-03T00:00:00Z");
 const db = new CollaborationDatabase(join(directory, "db"), { authTokenPepper: "github-test-pepper-long", clock: () => new Date(now) });
 const service = new CollaborationService(db);
 const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
 const session = service.createSession(actor, { session_id: "gh-session", idempotency_key: "gh-create-session", mode: "solo", title: "GitHub" }).session;
 let base = "b".repeat(40), commit = "", remoteRef = "", pr: any = null, runs = 0;
 const calls: Array<{ path: string; method: string; body: any; authorization: string | undefined }> = [];
 const fetcher: typeof fetch = async (url, init) => {
   const path = new URL(String(url)).pathname + new URL(String(url)).search;
   const method = init?.method ?? "GET";
   const body = init?.body ? JSON.parse(String(init.body)) : null;
   calls.push({ path, method, body, authorization: (init?.headers as Record<string, string>)?.authorization });
   const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
   if (path === "/login/oauth/access_token") return reply({ access_token: "ghu_test", refresh_token: "ghr_test", expires_in: 28800, refresh_token_expires_in: 15897600, scope: "" });
   if (path === "/user") return reply({ login: "fixture-owner" });
   if (path === "/repos/owner/project") return reply({ id: 123, full_name: "owner/project", permissions: { push: true } });
   if (path === "/repos/owner/project/branches/main") return reply({ commit: { sha: base } });
   if (path === `/repos/owner/project/git/commits/${base}`) return reply({ tree: { sha: "c".repeat(40) } });
   if (path.includes("/git/trees/") && method === "GET") return reply({ truncated: false, tree: initial.map((f, i) => ({ path: f.path, type: "blob", mode: "100644", sha: `blob${i}`, size: Buffer.byteLength(f.content_base64, "base64") })) });
   if (path.includes("/git/blobs/blob")) return reply({ encoding: "base64", content: initial[Number(path.slice(-1))]!.content_base64 });
   if (path.endsWith("/git/blobs") && method === "POST") return reply({ sha: "d".repeat(40) });
   if (path.endsWith("/git/trees") && method === "POST") return reply({ sha: "e".repeat(40) });
   if (path.endsWith("/git/commits") && method === "POST") { commit = "f".repeat(40); return reply({ sha: commit }); }
   if (path.includes("/git/matching-refs/")) return reply(remoteRef ? [{ ref: remoteRef, object: { sha: commit } }] : []);
   if (path.endsWith("/git/refs") && method === "POST") { remoteRef = body.ref; return reply({ ref: remoteRef, object: { sha: body.sha } }); }
   if (path.includes("/pulls?") && method === "GET") return reply(pr ? [pr] : []);
   if (path.endsWith("/pulls") && method === "POST") { pr = { html_url: "https://github.com/owner/project/pull/1", head: { ref: body.head, sha: commit } }; return reply(pr); }
   throw new Error(`Unexpected GitHub fixture request: ${path}`);
 };
 const runOptions: HostedAgentOptions = { ...options, runContainer: async (args, timeout) => {
   runs++;
   assert.ok(args.includes("none") && args.includes("2048m") && args.includes("GT_HOSTED_REPOSITORY=1"));
   assert.equal(args[args.indexOf("--memory-swap") + 1], "2048m");
   assert.equal(timeout, 900000);
   assert.ok(!JSON.stringify(args).includes("ghu_test") && !JSON.stringify(args).includes("fake-model-secret"));
   const mount = args.find((arg) => arg.endsWith("dst=/input,readonly"))!;
   const root = mount.split("src=")[1]!.split(",dst=")[0]!;
   const files = initial.map((f) => file(f.path, readFileSync(join(root, f.path), "utf8")));
   files.find((f) => f.path === "src/index.ts")!.content_base64 = Buffer.from("export const value = 2;\n").toString("base64");
   return JSON.stringify({ answer: "Changed value; fixture tests passed.", files, save_error: null });
 } };
 const agent = new HostedAgent(service, new CodeRepository(db, join(directory, "code")), runOptions);
 const githubOptions = { clientId: "client-id", clientSecret: "test-app", encryptionKey: Buffer.alloc(32, 3).toString("base64"),
   callbackUrl: "https://gt.example/v1/hosted-github/callback", appSlug: "gatherthread-fixture", fetch: fetcher };
 const github = new HostedGithub(service, agent, runOptions, githubOptions);
 return { directory, db, service, actor, session, github, agent, runOptions, githubOptions, calls, setBase: (sha: string) => { base = sha; }, runs: () => runs,
   advance: () => { now += 30_000; },
   close: async () => { await github.close(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function connect(f: ReturnType<typeof fixture>) {
 const authorization = new URL(f.github.authorize(f.actor).authorization_url);
 assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
 await f.github.complete(f.actor, { state: authorization.searchParams.get("state")!, code: "fixture-code" });
 await f.github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
}
async function settled(f: ReturnType<typeof fixture>, id: string) {
 for (let n = 0; n < 100; n++) { const task = f.github.view(f.actor, id); if (task.state !== "running") return task; await setTimeout(5); }
 throw new Error("Cloud task did not settle");
}

function deferred() {
 let resolve!: () => void;
 const promise = new Promise<void>((done) => { resolve = done; });
 return { promise, resolve };
}

for (const stage of ["/login/oauth/access_token", "/user"]) {
 for (const action of ["disconnect", "reconnect-first", "reconnect-last", "second-instance"] as const) {
  test(`OAuth ${stage} completion cannot resurrect or replace a newer ${action}`, async () => {
   const f = fixture(), entered = deferred(), release = deferred();
   const peer = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Second browser").device_id };
   const fetcher = f.githubOptions.fetch;
   let armed = true, old: Promise<unknown> | undefined, other: HostedGithub | undefined;
   f.githubOptions.fetch = async (url, init) => {
    if (armed && new URL(String(url)).pathname === stage) { armed = false; entered.resolve(); await release.promise; }
    return fetcher(url, init);
   };
   try {
    const state = new URL(f.github.authorize(f.actor).authorization_url).searchParams.get("state")!;
    old = f.github.complete(f.actor, { state, code: "old-fixture" });
    const outcome = old.then(() => null, (error: unknown) => error);
    await entered.promise;
    if (action === "second-instance") {
     other = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
     other.disconnect(peer);
    } else if (action === "disconnect") f.github.disconnect(peer);
    else {
     const freshState = new URL(f.github.authorize(peer).authorization_url).searchParams.get("state")!;
     if (action === "reconnect-first") {
      await f.github.complete(peer, { state: freshState, code: "new-fixture" });
      await f.github.bind(peer, f.session.project_id, { repository: "owner/project", base_branch: "main" });
     }
     release.resolve(); assert.ok(await outcome instanceof ApiError);
     if (action === "reconnect-last") {
      assert.equal(f.github.status(peer, f.session.project_id).connected, false);
      await f.github.complete(peer, { state: freshState, code: "new-fixture" });
      await f.github.bind(peer, f.session.project_id, { repository: "owner/project", base_branch: "main" });
     }
     assert.ok(f.github.status(peer, f.session.project_id).binding);
     return;
    }
    release.resolve(); assert.ok(await outcome instanceof ApiError);
    assert.equal(f.github.status(peer, f.session.project_id).connected, false);
    if (stage === "/login/oauth/access_token") assert.equal(f.calls.some((call) => call.path === "/user"), false);
    // Disconnect remains effective after reopening the service, then a fresh flow works.
    await other?.close(); other = undefined; await f.github.close();
    f.github = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
    assert.equal(f.github.status(peer, f.session.project_id).connected, false);
    const fresh = new URL(f.github.authorize(peer).authorization_url).searchParams.get("state")!;
    await f.github.complete(peer, { state: fresh, code: "fresh-fixture" });
    assert.equal(f.github.status(peer, f.session.project_id).connected, true);
   } finally { release.resolve(); await old?.catch(() => {}); await other?.close(); await f.close(); }
  });
 }
}

test("legacy OAuth states are invalidated atomically while current credentials survive repeated startup", async () => {
 const f = fixture();
 try {
  await connect(f);
  const state = new URL(f.github.authorize(f.actor).authorization_url).searchParams.get("state")!;
  const credentials = f.db.sqlite.prepare("SELECT credentials FROM hosted_github_accounts").get()!.credentials;
  await f.github.close();
  f.db.sqlite.exec(`ALTER TABLE hosted_github_oauth RENAME TO old_oauth;
   CREATE TABLE hosted_github_oauth(state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,device_id TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
   INSERT INTO hosted_github_oauth SELECT state_hash,user_id,device_id,verifier,expires_at FROM old_oauth;
   DROP TABLE old_oauth; DROP TABLE hosted_github_authorizations;`);
  for (let n = 0; n < 2; n++) {
   f.github = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
   assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM hosted_github_oauth").get()!.n, 0);
   assert.equal(f.db.sqlite.prepare("SELECT credentials FROM hosted_github_accounts").get()!.credentials, credentials);
   await assert.rejects(f.github.complete(f.actor, { state, code: "legacy-fixture" }), (e: unknown) => e instanceof ApiError && e.code === "github_state");
   await f.github.close();
  }
  await connect(f);
 } finally { await f.close(); }
});

for (const stage of ["repository", "branch"] as const) {
 for (const action of ["disconnect-first", "disconnect-last", "reconnect-first", "reconnect-last", "choice-first", "choice-last", "another-instance"] as const) {
  test(`binding ${stage} lookup respects newer ${action} across devices`, { timeout: fixtureTimeout }, async () => {
   const f = fixture(), entered = deferred(), release = deferred(), nextEntered = deferred(), nextRelease = deferred();
   const peer = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Second browser").device_id };
   const fetcher = f.githubOptions.fetch;
   let armed = false, login = "fixture-owner", old: Promise<unknown> | undefined, next: Promise<unknown> | undefined;
   let other: HostedGithub | undefined, otherDb: CollaborationDatabase | undefined;
   const pathAt = (repository: string) => `/repos/${repository}${stage === "branch" ? "/branches/main" : ""}`;
   f.githubOptions.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (armed && path === pathAt("owner/project")) { armed = false; entered.resolve(); await release.promise; }
    if (action === "choice-last" && path === pathAt("new-owner/new-project")) { nextEntered.resolve(); await nextRelease.promise; }
    if (path === "/user") return Response.json({ login });
    if (path === "/repos/new-owner/new-project") return Response.json({ id: 456, full_name: "new-owner/new-project", permissions: { push: true } });
    if (path === "/repos/new-owner/new-project/branches/main") return Response.json({ commit: { sha: "c".repeat(40) } });
    return fetcher(url, init);
   };
   try {
    await connect(f); armed = true;
    old = f.github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
    const outcome = old.then(() => null, (error: unknown) => error);
    await entered.promise;
    if (action === "disconnect-last") {
     release.resolve(); assert.equal(await outcome, null); f.github.disconnect(peer);
    } else if (action === "disconnect-first") {
     f.github.disconnect(peer); release.resolve(); assert.ok(await outcome instanceof ApiError);
    } else {
     let current = f.github;
     if (action === "another-instance") {
      // Separate SQLite connection and service: no process-local cancellation lock.
      otherDb = new CollaborationDatabase(join(f.directory, "db"), { authTokenPepper: "github-test-pepper-long" });
      other = new HostedGithub(new CollaborationService(otherDb), f.agent, f.runOptions, f.githubOptions); current = other;
     }
     if (action.startsWith("reconnect")) {
      const state = new URL(current.authorize(peer).authorization_url).searchParams.get("state")!;
      if (action === "reconnect-last") { release.resolve(); assert.ok(await outcome instanceof ApiError); }
      login = "new-account"; await current.complete(peer, { state, code: "new-fixture" });
     }
     next = current.bind(peer, f.session.project_id, { repository: "new-owner/new-project", base_branch: "main" });
     const nextOutcome = next.then(() => null, (error: unknown) => error);
     if (action === "choice-last") {
      await nextEntered.promise; release.resolve(); assert.ok(await outcome instanceof ApiError);
      assert.equal(current.status(peer, f.session.project_id).binding?.repository, "owner/project");
      nextRelease.resolve();
     }
     assert.equal(await nextOutcome, null);
     release.resolve(); assert.ok(await outcome instanceof ApiError);
     const status = HostedGithubStatusSchema.parse(f.github.status(peer, f.session.project_id));
     assert.ok(status.enabled);
     assert.equal(status.connected, true); assert.equal(status.binding?.repository, "new-owner/new-project");
     assert.equal(status.login, action.startsWith("reconnect") ? "new-account" : "fixture-owner");
     return;
    }
    const status = HostedGithubStatusSchema.parse(f.github.status(peer, f.session.project_id));
    assert.ok(status.enabled);
    assert.equal(status.connected, false); assert.equal(status.binding, null);
   } finally {
    release.resolve(); nextRelease.resolve(); await old?.catch(() => {}); await next?.catch(() => {});
    await other?.close(); otherDb?.close(); await f.close();
   }
  });
 }
}

test("successful same-account OAuth completion cancels a bind started during the exchange", async () => {
 const f = fixture(), entered = deferred(), release = deferred();
 const fetcher = f.githubOptions.fetch;
 let old: Promise<unknown> | undefined;
 try {
  await connect(f);
  const state = new URL(f.github.authorize(f.actor).authorization_url).searchParams.get("state")!;
  f.githubOptions.fetch = async (url, init) => {
   if (new URL(String(url)).pathname === "/repos/owner/project/branches/main") { entered.resolve(); await release.promise; }
   return fetcher(url, init);
  };
  old = f.github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
  const outcome = old.then(() => null, (error: unknown) => error);
  await entered.promise; await f.github.complete(f.actor, { state, code: "same-account" });
  release.resolve(); assert.ok(await outcome instanceof ApiError);
  assert.equal(f.github.status(f.actor, f.session.project_id).binding, null);
 } finally { release.resolve(); await old?.catch(() => {}); await f.close(); }
});

test("failed latest choice preserves committed consent and still cancels an older bind", async () => {
 const f = fixture(), entered = deferred(), release = deferred();
 const fetcher = f.githubOptions.fetch; let old: Promise<unknown> | undefined;
 try {
  await connect(f);
  const revision = f.db.sqlite.prepare("SELECT revision FROM hosted_github_bindings").get()!.revision;
  f.githubOptions.fetch = async (url, init) => {
   const path = new URL(String(url)).pathname;
   if (path === "/repos/owner/project/branches/main") { entered.resolve(); await release.promise; }
   if (path === "/repos/denied/project") return Response.json({ id: 456, full_name: "denied/project", permissions: { push: false } });
   return fetcher(url, init);
  };
  old = f.github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
  const outcome = old.then(() => null, (error: unknown) => error);
  await entered.promise;
  await assert.rejects(f.github.bind(f.actor, f.session.project_id, { repository: "denied/project", base_branch: "main" }), ApiError);
  release.resolve(); assert.ok(await outcome instanceof ApiError);
  assert.equal(f.db.sqlite.prepare("SELECT revision FROM hosted_github_bindings").get()!.revision, revision);
  f.githubOptions.fetch = fetcher;
  await f.github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
 } finally { release.resolve(); await old?.catch(() => {}); await f.close(); }
});

test("binding migration removes orphaned consent while preserving connected consent on repeated startup", async () => {
 const f = fixture();
 try {
  await connect(f);
  const connected = f.db.sqlite.prepare("SELECT * FROM hosted_github_bindings").get();
  const orphan = f.db.createIdentity({ display_name: "Disconnected", device_name: "Other" }).actor;
  f.db.sqlite.prepare("INSERT INTO hosted_github_bindings VALUES(?,?,?,?,?,?)")
   .run(orphan.user_id, f.session.project_id, "owner/project", 123, "main", "orphan");
  f.db.sqlite.prepare("INSERT INTO hosted_github_binding_attempts VALUES(?,?,?)").run(orphan.user_id, f.session.project_id, "orphan");
  await f.github.close();
  for (let n = 0; n < 2; n++) {
   f.github = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
   assert.deepEqual(f.db.sqlite.prepare("SELECT * FROM hosted_github_bindings").get(), connected);
   assert.equal(f.db.sqlite.prepare("SELECT 1 FROM hosted_github_binding_attempts WHERE user_id=?").get(orphan.user_id), undefined);
   await f.github.close();
  }
 } finally { await f.close(); }
});

for (const revocation of ["disconnect", "delete-session", "revoke-device"] as const) {
 unixTest(`repository model slow body rechecks ${revocation} before provider dispatch`, { timeout: 10_000 }, async () => {
  const f = fixture(), entered = deferred(), release = deferred(), bodyStarted = deferred();
  let calls = 0, armed = false, modelStatus = 0;
  const active = f.db.assertActiveDevice.bind(f.db);
  f.db.assertActiveDevice = (actor) => { active(actor); if (armed) bodyStarted.resolve(); };
  f.runOptions.fetch = async () => { calls++; return Response.json({ choices: [] }); };
  const run = f.runOptions.runContainer!;
  f.runOptions.runContainer = async (args, timeout) => {
   const socket = args.find((arg) => arg.endsWith("dst=/run/model.sock"))!.split("src=")[1]!.split(",dst=")[0]!;
   const body = JSON.stringify({ model: "coding", messages: [{ role: "user", content: "Fixture" }] });
   const result = Promise.withResolvers<number>();
   const req = request({ socketPath: socket, method: "POST", path: "/v1/chat/completions", headers: {
    "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, (res) => {
     res.resume(); res.on("end", () => result.resolve(res.statusCode!));
   }); req.on("error", result.reject); armed = true; req.write(body.slice(0, 1));
   await bodyStarted.promise; armed = false; entered.resolve(); await release.promise;
   req.end(body.slice(1)); modelStatus = await result.promise;
   return run(args, timeout);
  };
  try {
   await connect(f);
   const task = f.github.start(f.actor, f.session.id, { content: "Fixture", profile_id: "coding", idempotency_key: "slow-model-body" });
   await entered.promise;
   if (revocation === "disconnect") f.github.disconnect(f.actor);
   if (revocation === "delete-session") f.db.deleteSession(f.actor, f.session.id);
   if (revocation === "revoke-device") f.db.revokeDevice(f.actor, f.actor.device_id);
   release.resolve(); await f.github.close();
   assert.equal(modelStatus, 502); assert.equal(calls, 0);
   assert.equal((f.agent as unknown as { cooldowns: Map<string, number> }).cooldowns.size, 0);
  } finally { release.resolve(); await f.close(); }
 });
}

const revocations = ["downgrade", "remove-member", "archive", "rebind", "disconnect", "delete-task",
 "delete-session", "delete-project", "revoke-device", "delete-account"] as const;
const snapshotSteps = ["", "/branches/main", `/git/commits/${"b".repeat(40)}`,
 `/git/trees/${"c".repeat(40)}`, "/git/blobs/blob0"] as const;
for (const [index, step] of snapshotSteps.entries()) {
 for (const boundary of ["response", "refresh"] as const) {
  const actions = index === 4 && boundary === "refresh" ? [...revocations, "shutdown" as const]
    : ["downgrade", "rebind", "shutdown"] as const;
  for (const action of actions) {
   test(`snapshot ${step || "repository"} ${boundary} fences ${action} before further source acquisition`, { timeout: fixtureTimeout }, async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    const owner = f.actor;
    f.session = f.service.createSession(owner, { session_id: "shared-source", idempotency_key: "shared-source",
      mode: "multi", title: "Shared source" }).session;
    f.actor = f.db.createIdentity({ display_name: "Member", device_name: "Browser", can_create_projects: true }).actor;
    const invite = f.service.createProjectInvitation(owner, f.session.project_id, { role: "participant", ttl: "1h" });
    f.service.claimInvitationForActor(f.actor, invite.invite_token);
    const peer = { ...f.actor, device_id: f.db.createDevice(f.actor.user_id, "Second browser").device_id };
    const expireToken = () => {
     const seal = (f.github as unknown as { seal: (value: unknown, owner: string) => string }).seal.bind(f.github);
     f.db.sqlite.prepare("UPDATE hosted_github_accounts SET credentials=? WHERE user_id=?").run(seal({
      access_token: "ghu_test", refresh_token: "ghr_test", expires_at: 0,
      refresh_expires_at: Date.now() + 600_000,
     }, f.actor.user_id), f.actor.user_id);
    };
    const fetcher = f.githubOptions.fetch;
    const afterRevocation: string[] = [];
    let armed = false, revoked = false, closing: Promise<void> | undefined;
    f.githubOptions.fetch = async (url, init) => {
     const path = new URL(String(url)).pathname;
     const body = init?.body ? JSON.parse(String(init.body)) : null;
     if (revoked) afterRevocation.push(path);
     if (armed && (boundary === "response" ? path === `/repos/owner/project${step}`
       : path === "/login/oauth/access_token" && body?.grant_type === "refresh_token")) {
      armed = false; entered.resolve(); await release.promise;
     }
     const response = await fetcher(url, init);
     if (armed && boundary === "refresh" && index > 0 && path === `/repos/owner/project${snapshotSteps[index - 1]}`) expireToken();
     return response;
    };
    try {
     await connect(f); armed = true;
     if (boundary === "refresh" && index === 0) expireToken();
     const started = f.github.start(f.actor, f.session.id, { content: "Inspect source", profile_id: "coding", idempotency_key: "source-fence" });
     await entered.promise;
     switch (action) {
      case "downgrade": f.db.setProjectMembership(owner, f.session.project_id, f.actor.user_id, "viewer"); break;
      case "remove-member": f.db.removeProjectMembership(owner, f.session.project_id, f.actor.user_id); break;
      case "archive": f.db.sqlite.prepare("UPDATE sessions SET state='archived' WHERE id=?").run(f.session.id); break;
      case "rebind":
       if (boundary === "response") await f.github.bind(peer, f.session.project_id, { repository: "owner/project", base_branch: "main" });
       else f.db.sqlite.prepare("UPDATE hosted_github_bindings SET revision='concurrent-binding' WHERE user_id=? AND project_id=?")
         .run(f.actor.user_id, f.session.project_id);
       break;
      case "disconnect": f.github.disconnect(peer); break;
      case "delete-task": f.db.sqlite.prepare("DELETE FROM hosted_github_tasks WHERE id=?").run(started.id); break;
      case "delete-session": f.db.deleteSession(owner, f.session.id); break;
      case "delete-project": f.service.deleteProject(owner, f.session.project_id); break;
      case "revoke-device": f.db.revokeDevice(f.actor, f.actor.device_id); break;
      case "delete-account": f.db.deleteAccount(f.actor); break;
      case "shutdown": closing = f.github.close(); break;
     }
     revoked = true; release.resolve();
     for (let n = 0; n < 100; n++) {
      const row = f.db.sqlite.prepare("SELECT state FROM hosted_github_tasks WHERE id=?").get(started.id);
      if (!row || row.state !== "running") break;
      await setTimeout(5);
     }
     await f.github.close();
     assert.deepEqual(afterRevocation, [], "no GitHub metadata or blob request may be dispatched after revocation");
     assert.equal(f.runs(), 0, "revoked source must never reach the executor/model");
     const saved = f.db.sqlite.prepare("SELECT state,initial_files,starting_files,result_files FROM hosted_github_tasks WHERE id=?").get(started.id);
     if (saved) {
      assert.notEqual(saved.state, "running");
      assert.equal(saved.initial_files, null); assert.equal(saved.starting_files, null); assert.equal(saved.result_files, null);
     }
     assert.equal(f.db.hostedActiveRuns(), 0);
    } finally { release.resolve(); await closing; await f.close(); }
   });
  }
 }
}
for (const phase of ["headers", "body"] as const) {
 test(`snapshot shutdown aborts the actual pending ${phase} download without saving source`, { timeout: fixtureTimeout }, async () => {
  const f = fixture(), entered = deferred(), aborted = deferred();
  const server = createServer((_request, response) => {
   response.on("close", aborted.resolve);
   if (phase === "body") {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"id":');
   }
   entered.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const fetcher = f.githubOptions.fetch;
  let armed = false;
  f.githubOptions.fetch = (url, init) => armed && new URL(String(url)).pathname === "/repos/owner/project"
   ? globalThis.fetch(`http://127.0.0.1:${address.port}/`, init) : fetcher(url, init);
  try {
   await connect(f); armed = true;
   const before = f.calls.length;
   const task = f.github.start(f.actor, f.session.id, { content: "Download source", profile_id: "coding", idempotency_key: `abort-${phase}` });
   await entered.promise; await f.github.close(); await aborted.promise;
   assert.equal(f.calls.length, before, "no later metadata request may start");
   assert.equal(f.runs(), 0); assert.equal(f.db.hostedActiveRuns(), 0);
   const saved = f.db.sqlite.prepare("SELECT state,initial_files,starting_files,result_files FROM hosted_github_tasks WHERE id=?").get(task.id);
   assert.equal(saved?.state, "interrupted");
   assert.equal(saved?.initial_files, null); assert.equal(saved?.starting_files, null); assert.equal(saved?.result_files, null);
  } finally {
   server.closeAllConnections();
   await new Promise<void>((resolve) => server.close(() => resolve()));
   await f.close();
  }
 });
}
const publicationSteps = [
 ["/git/blobs", "/branches/main", "GET"],
 ["/git/trees", "/git/blobs", "POST"],
 ["/git/commits", "/git/trees", "POST"],
 ["/git/refs", "/git/matching-refs/", "GET"],
 ["/pulls", "/pulls?", "GET"],
] as const;
for (const [step, previous, method] of publicationSteps) {
 for (const revocation of (step === "/pulls" ? revocations : ["downgrade"] as const)) {
  unixTest(`publication rechecks ${revocation} after token refresh before POST ${step}`, async () => {
   const f = fixture(), refreshStarted = deferred(), refreshReply = deferred();
   const owner = f.actor;
   f.session = f.service.createSession(owner, { session_id: "shared-refresh", idempotency_key: "shared-refresh",
     mode: "multi", title: "Shared" }).session;
   f.actor = f.db.createIdentity({ display_name: "Member", device_name: "Browser", can_create_projects: true }).actor;
   const invite = f.service.createProjectInvitation(owner, f.session.project_id, { role: "participant", ttl: "1h" });
   f.service.claimInvitationForActor(f.actor, invite.invite_token);
   const fetcher = f.githubOptions.fetch;
   let armed = false;
   f.githubOptions.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === "/login/oauth/access_token" && body?.grant_type === "refresh_token") {
     refreshStarted.resolve(); await refreshReply.promise;
    }
    const reply = await fetcher(url, init);
    if (armed && path.includes(previous) && (init?.method ?? "GET") === method) {
     armed = false;
     const seal = (f.github as unknown as { seal: (value: unknown, owner: string) => string }).seal.bind(f.github);
     f.db.sqlite.prepare("UPDATE hosted_github_accounts SET credentials=? WHERE user_id=?").run(seal({
      access_token: "ghu_test", refresh_token: "ghr_test", expires_at: 0,
      refresh_expires_at: Date.now() + 600_000,
     }, f.actor.user_id), f.actor.user_id);
    }
    return reply;
   };
   let publication: Promise<unknown> | undefined;
   try {
    await connect(f);
    const started = f.github.start(f.actor, f.session.id, { content: "Fixture change", profile_id: "coding", idempotency_key: "refresh-task" });
    const task = await settled(f, started.id); assert.equal(task.state, "completed");
    armed = true;
    publication = f.github.publish(f.actor, task.id, { expected_revision: task.revision!, title: "Fixture PR", body: "" });
    const outcome = publication.then(() => null, (error: unknown) => error);
    await Promise.race([refreshStarted.promise, setTimeout(1500).then(() => { throw new Error("Fixture refresh did not start"); })]);
    const writeCount = f.calls.filter((call) => call.method === "POST" && call.path.startsWith("/repos/")).length;
    switch (revocation) {
     case "downgrade": f.db.setProjectMembership(owner, f.session.project_id, f.actor.user_id, "viewer"); break;
     case "remove-member": f.db.removeProjectMembership(owner, f.session.project_id, f.actor.user_id); break;
     case "archive": f.db.sqlite.prepare("UPDATE sessions SET state='archived' WHERE id=?").run(f.session.id); break;
     case "rebind": f.db.sqlite.prepare("UPDATE hosted_github_bindings SET revision='concurrent-binding' WHERE user_id=? AND project_id=?")
       .run(f.actor.user_id, f.session.project_id); break;
     case "disconnect": f.github.disconnect(f.actor); break;
     case "delete-task": f.db.sqlite.prepare("DELETE FROM hosted_github_tasks WHERE id=?").run(task.id); break;
     case "delete-session": f.db.deleteSession(owner, f.session.id); break;
     case "delete-project": f.service.deleteProject(owner, f.session.project_id); break;
     case "revoke-device": f.db.revokeDevice(f.actor, f.actor.device_id); break;
     case "delete-account": f.db.deleteAccount(f.actor); break;
    }
    refreshReply.resolve();
    assert.ok(await outcome instanceof ApiError);
    assert.equal(f.calls.filter((call) => call.method === "POST" && call.path.startsWith("/repos/")).length, writeCount);
    assert.ok(!f.calls.some((call) => call.method === "POST" && call.path.endsWith(step)));
   } finally { refreshReply.resolve(); await publication?.catch(() => {}); await f.close(); }
  });
 }
}

unixTest("deleted GitHub account retains an anonymous executor slot until the held runner settles", async () => {
 const f = fixture(), entered = deferred(), release = deferred();
 const run = f.runOptions.runContainer!;
 f.runOptions.runContainer = async (args, timeout) => { entered.resolve(); await release.promise; return run(args, timeout); };
 try {
  await connect(f);
  f.github.start(f.actor, f.session.id, { content: "Held fixture", profile_id: "coding", idempotency_key: "held-deleted-account" });
  await entered.promise;
  f.service.deleteProject(f.actor, f.session.project_id); f.db.deleteAccount(f.actor);
  assert.equal(f.db.hostedActiveRuns(), 1);
  assert.equal(f.db.hostedEndpointUsage(f.runOptions.endpoints[0]!).active, 1);
  const slot = f.db.sqlite.prepare("SELECT * FROM hosted_agent_active_runs").get()!;
  assert.equal(slot.user_id, null); assert.equal(Object.keys(slot).length, 4);
  release.resolve(); await f.github.close();
  assert.equal(f.db.hostedActiveRuns(), 0);
 } finally { release.resolve(); await f.close(); }
});

for (const cleanupFailure of ["classified", "unexpected-client", "client-and-filesystem"]) {
unixTest(`repository cleanup failure retains capacity until confirmed startup recovery (${cleanupFailure})`, async () => {
 const f = fixture();
 (f.github as unknown as { runner: { run: () => Promise<never> } }).runner.run = async () => {
  if (cleanupFailure === "client-and-filesystem") await cleanupHostedExecution(() => {
   throw new Error("ENOSPC: private Docker client fixture");
  }, [() => { throw new Error("EACCES: private directory fixture"); }]);
  if (cleanupFailure === "unexpected-client") stopHostedContainer(`gt-repository-${"b".repeat(32)}`, () => {
   throw new Error("ENOSPC: private Docker client fixture");
  });
  throw new HostedExecutorCleanupError();
 };
 try {
  await connect(f);
  const task = f.github.start(f.actor, f.session.id, { content: "Cleanup fixture", profile_id: "coding", idempotency_key: "cleanup-held-slot" });
  assert.equal((await settled(f, task.id)).state, "failed");
  assert.equal(f.db.hostedActiveRuns(), 1);
  assert.equal(f.db.hostedEndpointUsage(f.runOptions.endpoints[0]!).active, 1);
  // The injected executor has no Docker resource; this models verified recovery.
  f.db.failInterruptedHostedAgentJobs(); assert.equal(f.db.hostedActiveRuns(), 0);
 } finally { await f.close(); }
});
}

for (const state of ["failed", "interrupted"] as const) {
 unixTest(`continuing a ${state} child retains its actual starting source and cumulative PR baseline`, async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const run = f.runOptions.runContainer!;
  const inputs: string[] = [];
  let closing: Promise<void> | undefined;
  try {
   await connect(f);
   const a = f.github.start(f.actor, f.session.id, { content: "A changes value", profile_id: "coding", idempotency_key: "snapshot-task-a" });
   assert.equal((await settled(f, a.id)).state, "completed"); f.advance();
   f.runOptions.runContainer = async (args, timeout) => {
    const mount = args.find((arg) => arg.endsWith("dst=/input,readonly"))!;
    const root = mount.split("src=")[1]!.split(",dst=")[0]!;
    inputs.push(readFileSync(join(root, "src/index.ts"), "utf8")); entered.resolve();
    if (state === "interrupted") { await release.promise; return run(args, timeout); }
    throw new Error("Synthetic continuation failure");
   };
   const b = f.github.start(f.actor, f.session.id, { content: "B continues A", profile_id: "coding", idempotency_key: "snapshot-task-b", continue_task_id: a.id });
   await entered.promise;
   if (state === "interrupted") { closing = f.github.close(); release.resolve(); await closing;
    f.github = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions); }
   const saved = await settled(f, b.id); assert.equal(saved.state, state); assert.equal(saved.resumable, true);
   assert.equal(Buffer.from(saved.changes.find((change) => change.path === "src/index.ts")!.after_base64!, "base64").toString(), "export const value = 2;\n");
   if (state === "failed") {
    // Simulate an earlier preview with only cumulative baseline retained.
    f.db.sqlite.prepare("UPDATE hosted_github_tasks SET starting_files=NULL WHERE id=?").run(b.id);
    await f.github.close(); f.github = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
   } else {
    // Newly saved starting files stay usable even after their parent is removed.
    f.github.remove(f.actor, a.id);
   }
   f.advance();
   f.runOptions.runContainer = async (args) => {
    const mount = args.find((arg) => arg.endsWith("dst=/input,readonly"))!;
    const root = mount.split("src=")[1]!.split(",dst=")[0]!;
    const files = initial.map((item) => file(item.path, readFileSync(join(root, item.path), "utf8")));
    inputs.push(readFileSync(join(root, "src/index.ts"), "utf8"));
    return JSON.stringify({ answer: "Kept inherited change", files, save_error: null });
   };
   const c = f.github.start(f.actor, f.session.id, { content: "C continues B", profile_id: "coding", idempotency_key: "snapshot-task-c", continue_task_id: b.id });
   const completed = await settled(f, c.id); assert.equal(completed.state, "completed");
   assert.deepEqual(inputs, ["export const value = 2;\n", "export const value = 2;\n"]);
   const change = completed.changes.find((item) => item.path === "src/index.ts")!;
   assert.equal(Buffer.from(change.before_base64!, "base64").toString(), "export const value = 1;\n");
   assert.equal(Buffer.from(change.after_base64!, "base64").toString(), "export const value = 2;\n");
   const published = await f.github.publish(f.actor, c.id, { expected_revision: completed.revision!, title: "Inherited fixture", body: "" });
   assert.equal(published.pull_request_url, "https://github.com/owner/project/pull/1");
  } finally { release.resolve(); await closing; await f.close(); }
 });
}
unixTest("legacy failed continuation with a missing parent refuses unknown source before reserving a run", async () => {
 const f = fixture();
 try {
  await connect(f);
  const a = f.github.start(f.actor, f.session.id, { content: "A changes value", profile_id: "coding", idempotency_key: "legacy-source-a" });
  assert.equal((await settled(f, a.id)).state, "completed"); f.advance();
  f.runOptions.runContainer = async () => { throw new Error("Synthetic child failure"); };
  const b = f.github.start(f.actor, f.session.id, { content: "B continues A", profile_id: "coding", idempotency_key: "legacy-source-b", continue_task_id: a.id });
  assert.equal((await settled(f, b.id)).state, "failed");
  f.github.remove(f.actor, a.id); await f.github.close();
  f.db.sqlite.exec("ALTER TABLE hosted_github_tasks DROP COLUMN starting_files");
  f.advance();
  const usage = f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs;
  const events = f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()!.n;
  for (let restart = 0; restart < 2; restart++) {
   f.github = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
   assert.equal(f.github.view(f.actor, b.id).resumable, false);
   assert.equal(f.db.sqlite.prepare("SELECT starting_files FROM hosted_github_tasks WHERE id=?").get(b.id)!.starting_files, null);
   assert.throws(() => f.github.start(f.actor, f.session.id, { content: "C refuses unknown input", profile_id: "coding",
    idempotency_key: "legacy-source-c", continue_task_id: b.id }), (e: unknown) => e instanceof ApiError && e.code === "github_task_access");
   assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, usage);
   assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get()!.n, events);
   assert.equal(f.db.hostedActiveRuns(), 0); await f.github.close();
  }
 } finally { await f.close(); }
});
unixTest("GitHub requests are redacted before private persistence, container input and model transport without weakening exact retries", async () => {
 const f = fixture();
 const prompts: string[] = [], modelBodies: string[] = [];
 const run = f.runOptions.runContainer!;
 f.runOptions.fetch = async (_url, init) => { modelBodies.push(String(init?.body)); return Response.json({ choices: [{ message: { role: "assistant", content: "Fixture answer" } }] }); };
 f.runOptions.runContainer = async (args, timeout) => {
   const mount = args.find((arg) => arg.endsWith("dst=/run/gatherthread,readonly"))!;
   const prompt = readFileSync(join(mount.split("src=")[1]!.split(",dst=")[0]!, "prompt.txt"), "utf8");
   prompts.push(prompt);
   const socket = args.find((arg) => arg.endsWith("dst=/run/model.sock"))!.split("src=")[1]!.split(",dst=")[0]!;
   await new Promise<void>((resolve, reject) => {
     const req = request({ socketPath: socket, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
       res.resume(); res.once("end", () => res.statusCode === 200 ? resolve() : reject(new Error("Fixture model transport failed")));
     });
     req.once("error", reject); req.end(JSON.stringify({ model: "coding", messages: [{ role: "user", content: prompt }] }));
   });
   return run(args, timeout);
 };
 try {
   await connect(f);
   const marker = "ghp_" + "Z".repeat(24), changedMarker = "ghp_" + "Y".repeat(24);
   const quote = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
     idempotency_key: "ordinary-quote", payload: { content: "Keep the existing npm tests and src/index.ts reference." } });
   const content = `Inspect src/index.ts and test. Accidental credential ${marker}; API_KEY=fixtureSensitiveValue. Preserve ordinary text.`;
   const input = { content, profile_id: "coding", reply_to_event_id: quote.id, idempotency_key: "redacted-task" };
   const first = f.github.start(f.actor, f.session.id, input);
   assert.equal(f.github.start(f.actor, f.session.id, input).id, first.id);
   assert.throws(() => f.github.start(f.actor, f.session.id, { ...input, content: content.replace(marker, changedMarker) }),
     (e: unknown) => e instanceof ApiError && e.code === "github_revision");
   const done = await settled(f, first.id);
   assert.equal(done.state, "completed");
   const row = f.db.sqlite.prepare("SELECT request_event_id,input_json FROM hosted_github_tasks WHERE id=?").get(first.id)!;
   const canonical = f.db.getEvent(f.session.id, String(row.request_event_id));
   assert.equal(canonical.reply_to_event_id, quote.id);
   assert.equal((canonical.payload as { content: string }).content, redactJson(content));
   assert.equal(JSON.parse(String(row.input_json)).content, redactJson(content));
   f.advance();
   const continuation = { ...input, idempotency_key: "redacted-continue", continue_task_id: first.id };
   const next = f.github.start(f.actor, f.session.id, continuation);
   assert.equal((await settled(f, next.id)).state, "completed");
   assert.equal(f.github.start(f.actor, f.session.id, continuation).id, next.id);
   assert.throws(() => f.github.start(f.actor, f.session.id, { ...continuation, continue_task_id: next.id }), ApiError);
   for (const text of [String(row.input_json), JSON.stringify(canonical), ...prompts, ...modelBodies]) {
     assert.ok(!text.includes(marker) && !text.includes("fixtureSensitiveValue"));
     assert.match(text, /Inspect src\/index.ts and test/);
   }
   assert.equal(prompts.length, 2); assert.equal(modelBodies.length, 2);
   assert.ok(prompts.every((text) => text.includes("Keep the existing npm tests and src/index.ts reference.")));
   assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 2);
 } finally { await f.close(); }
});
unixTest("startup scrubs legacy raw task inputs atomically and preserves exact retries through repeated recovery", async () => {
 const f = fixture();
 let restored: HostedGithub | undefined;
 try {
   await connect(f);
   const marker = "sk-" + "Q".repeat(24), changedMarker = "sk-" + "R".repeat(24);
   const input = { content: `Inspect src/index.ts. Accidental ${marker}`, profile_id: "coding", idempotency_key: "legacy-input-migration" };
   const done = await settled(f, f.github.start(f.actor, f.session.id, input).id);
   await f.github.close();
   // Exact earlier table shape and an interrupted retained task containing synthetic raw input.
   f.db.sqlite.exec("ALTER TABLE hosted_github_tasks DROP COLUMN input_fingerprint");
   f.db.sqlite.exec("ALTER TABLE hosted_github_tasks DROP COLUMN starting_files");
   f.db.sqlite.prepare("UPDATE hosted_github_tasks SET input_json=?,state='running' WHERE id=?").run(JSON.stringify(input), done.id);
   let savedStart: unknown;
   for (let restart = 0; restart < 2; restart++) {
     restored = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
     const row = f.db.sqlite.prepare("SELECT input_json,input_fingerprint,starting_files FROM hosted_github_tasks WHERE id=?").get(done.id)!;
     assert.equal(typeof row.starting_files, "string");
     if (restart === 0) savedStart = row.starting_files;
     else assert.equal(row.starting_files, savedStart, "repeated migration preserves the sealed starting snapshot");
     assert.equal(JSON.parse(String(row.input_json)).content, redactJson(input.content));
     assert.ok(!JSON.stringify(row).includes(marker)); assert.match(String(row.input_fingerprint), /^[a-f0-9]{64}$/u);
     assert.equal(restored.view(f.actor, done.id).state, "interrupted");
     assert.equal(restored.start(f.actor, f.session.id, input).id, done.id);
     for (const changed of [{ ...input, content: input.content.replace(marker, changedMarker) },
       { ...input, content: String(redactJson(input.content)) }, { ...input, reply_to_event_id: "different-reference" }]) {
       assert.throws(() => restored!.start(f.actor, f.session.id, changed), (e: unknown) => e instanceof ApiError && e.code === "github_revision");
     }
     assert.equal(f.runs(), 1); assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 1);
     await restored.close();
   }
   f.advance();
   restored = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
   const next = restored.start(f.actor, f.session.id, { ...input, idempotency_key: "migrated-continuation", continue_task_id: done.id });
   assert.equal((await settled(f, next.id)).state, "completed");
   assert.ok(!String(f.db.sqlite.prepare("SELECT input_json FROM hosted_github_tasks WHERE id=?").get(next.id)!.input_json).includes(marker));
 } finally { await restored?.close(); await f.close(); }
});
unixTest("invalid legacy input rolls back all scrubbing and fails startup without leaking its text", async () => {
 const f = fixture();
 let restored: HostedGithub | undefined;
 try {
   await connect(f);
   const marker = "ghp_" + "W".repeat(24);
   const first = { content: `Inspect index.ts ${marker}`, profile_id: "coding", idempotency_key: "migration-atomic-first" };
   const one = await settled(f, f.github.start(f.actor, f.session.id, first).id);
   f.advance();
   const second = { ...first, idempotency_key: "migration-atomic-second" };
   const two = await settled(f, f.github.start(f.actor, f.session.id, second).id);
   await f.github.close();
   f.db.sqlite.exec("ALTER TABLE hosted_github_tasks DROP COLUMN input_fingerprint");
   f.db.sqlite.prepare("UPDATE hosted_github_tasks SET input_json=? WHERE id=?").run(JSON.stringify(first), one.id);
   f.db.sqlite.prepare("UPDATE hosted_github_tasks SET input_json=? WHERE id=?").run(`invalid JSON ${marker}`, two.id);
   assert.throws(() => new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions),
     (e: unknown) => e instanceof Error && e.message === "Invalid stored cloud task input" && !e.message.includes(marker));
   assert.ok(!f.db.sqlite.prepare("PRAGMA table_info(hosted_github_tasks)").all().some((r) => r.name === "input_fingerprint"));
   assert.equal(f.db.sqlite.prepare("SELECT input_json FROM hosted_github_tasks WHERE id=?").get(one.id)!.input_json, JSON.stringify(first));
   assert.equal(f.runs(), 2);
   f.db.sqlite.prepare("UPDATE hosted_github_tasks SET input_json=? WHERE id=?").run(JSON.stringify(second), two.id);
   restored = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
   assert.ok(f.db.sqlite.prepare("SELECT input_json FROM hosted_github_tasks").all().every((r) => !String(r.input_json).includes(marker)));
 } finally { await restored?.close(); await f.close(); }
});
unixTest("invalid legacy starting snapshot rolls back schema and input migration without leaking stored content", async () => {
 const f = fixture();
 try {
  await connect(f);
  const input = { content: "Inspect source", profile_id: "coding", idempotency_key: "invalid-starting-snapshot" };
  const done = await settled(f, f.github.start(f.actor, f.session.id, input).id);
  await f.github.close();
  f.db.sqlite.exec("ALTER TABLE hosted_github_tasks DROP COLUMN input_fingerprint; ALTER TABLE hosted_github_tasks DROP COLUMN starting_files");
  f.db.sqlite.prepare("UPDATE hosted_github_tasks SET input_json=?,initial_files=? WHERE id=?")
   .run(JSON.stringify(input), "invalid-encrypted-snapshot-fixture", done.id);
  assert.throws(() => new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions),
   (e: unknown) => e instanceof Error && e.message === "Invalid stored cloud task snapshot");
  const columns = f.db.sqlite.prepare("PRAGMA table_info(hosted_github_tasks)").all();
  assert.ok(!columns.some((r) => r.name === "starting_files" || r.name === "input_fingerprint"));
  assert.equal(f.db.sqlite.prepare("SELECT input_json FROM hosted_github_tasks WHERE id=?").get(done.id)!.input_json, JSON.stringify(input));
  assert.equal(f.runs(), 1); assert.equal(f.db.hostedActiveRuns(), 0);
 } finally { await f.close(); }
});
unixTest("repository runner redacts a direct prompt before writing the container control file", async () => {
 const marker = "sk-" + "V".repeat(24);
 const prompt = `Inspect src/index.ts. Accidental ${marker}. Keep npm tests.`;
 let observed = "";
 const runner = new HostedRepositoryRunner({ ...options, runContainer: async (args) => {
   const control = args.find((arg) => arg.endsWith("dst=/run/gatherthread,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
   observed = readFileSync(join(control, "prompt.txt"), "utf8");
   return JSON.stringify({ answer: "Fixture", files: initial, save_error: null });
 } });
 await runner.run(initial, prompt, options.endpoints[0]!, () => undefined);
 assert.equal(observed, redactJson(prompt)); assert.ok(!observed.includes(marker));
});
unixTest("cloud GitHub task persists private encrypted files, reserves atomically, reviews and creates one draft PR", async () => {
 const f = fixture();
 try {
   await connect(f);
   const input = { content: "Change value to two and test", profile_id: "coding", idempotency_key: "github-task-first" };
   const accepted = f.github.start(f.actor, f.session.id, input);
   assert.equal(accepted.state, "running");
   assert.equal(f.github.start(f.actor, f.session.id, input).id, accepted.id);
   assert.throws(() => f.github.start(f.actor, f.session.id, { ...input, content: "Other" }), ApiError);
   const completed = await settled(f, accepted.id);
   assert.equal(completed.state, "completed"); assert.equal(completed.changes.length, 1);
   assert.equal(completed.changes[0]!.path, "src/index.ts"); assert.equal(f.runs(), 1);
   assert.equal(f.agent.status(f.actor).user_used_runs, 1);
   const stored = f.db.sqlite.prepare("SELECT initial_files,result_files FROM hosted_github_tasks WHERE id=?").get(accepted.id)!;
   assert.ok(!JSON.stringify(stored).includes("export const"));
   const account = f.db.sqlite.prepare("SELECT credentials FROM hosted_github_accounts").get()!;
   assert.ok(!JSON.stringify(account).includes("ghu_test"));
   const outsider = f.db.createIdentity({ display_name: "Outsider", device_name: "Laptop" }).actor;
   assert.throws(() => f.github.view(outsider, accepted.id), (e: unknown) => e instanceof ApiError && e.status === 404);
   await assert.rejects(f.github.publish(f.actor, accepted.id, { title: "Changes", body: "Review", expected_revision: "0".repeat(64) }), ApiError);
   const published = await f.github.publish(f.actor, accepted.id, { title: "Changes", body: "Review", expected_revision: completed.revision! });
   assert.equal(published.pull_request_url, "https://github.com/owner/project/pull/1");
   await f.github.publish(f.actor, accepted.id, { title: "Changes", body: "Review", expected_revision: completed.revision! });
   assert.equal(f.calls.filter((c) => c.path.endsWith("/pulls") && c.method === "POST").length, 1);
   assert.equal(f.calls.find((c) => c.path.endsWith("/pulls") && c.method === "POST")!.body.draft, true);
   assert.ok(f.calls.filter((c) => c.method !== "GET").every((c) => c.method !== "PATCH"));
 } finally { await f.close(); }
});
unixTest("cloud GitHub refuses stale base, changed binding and replayed OAuth; continues source after restart", async () => {
 const f = fixture();
 try {
   const authorization = new URL(f.github.authorize(f.actor).authorization_url);
   const state = authorization.searchParams.get("state")!;
   const other = f.db.createIdentity({ display_name: "Other", device_name: "Laptop" }).actor;
   await assert.rejects(f.github.complete(other, { state, code: "fixture" }), ApiError);
   await f.github.complete(f.actor, { state, code: "fixture" });
   await assert.rejects(f.github.complete(f.actor, { state, code: "fixture" }), ApiError);
   await f.github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
   const input = { content: "Fix", profile_id: "coding", idempotency_key: "github-second-test" };
   const done = await settled(f, f.github.start(f.actor, f.session.id, input).id);
   f.setBase("1".repeat(40));
   await assert.rejects(f.github.publish(f.actor, done.id, { title: "Fix", body: "Review", expected_revision: done.revision! }), (e: unknown) => e instanceof ApiError && e.code === "github_base_changed");
   await f.github.close();
   const restored = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
   assert.equal(restored.view(f.actor, done.id).changes.length, 1);
   f.advance();
   const next = restored.start(f.actor, f.session.id, { ...input, idempotency_key: "github-continue-test", continue_task_id: done.id });
   await settled(f, next.id); await restored.close(); assert.equal(restored.view(f.actor, next.id).state, "completed");
   await restored.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
   await assert.rejects(restored.publish(f.actor, done.id, { title: "Fix", body: "Review", expected_revision: done.revision! }), (e: unknown) => e instanceof ApiError && e.code === "github_binding_changed");
 } finally { await f.close(); }
});
unixTest("npm egress permits exact integrity-pinned lockfile tarballs and refuses arbitrary sources", async () => {
 const directory = mkdtempSync(join(tmpdir(), "gt-npm-proxy-"));
 const path = "/fixture/-/fixture-1.0.0.tgz";
 const files = [initial[0]!, file("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/fixture": {
   resolved: `https://registry.npmjs.org${path}`, integrity: "sha512-YWJj" } } }))];
 let calls = 0, authorized = true;
 const proxy = new HostedNpmProxy(files, async () => { calls++; return new Response("tarball"); }, () => { if (!authorized) throw new Error("access_revoked"); });
 const socket = join(directory, "npm.sock");
 const get = (url: string) => new Promise<number>((resolve, reject) => { const req = request({ socketPath: socket, path: url }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode!)); }); req.once("error", reject); req.end(); });
 try {
   await proxy.listen(socket);
   assert.equal(await get(path), 200); assert.equal(await get("/other/-/other-1.tgz"), 403);
   assert.equal(await get(`${path}?token=secret`), 403); assert.equal(calls, 1);
   authorized = false; assert.equal(await get(path), 502); assert.equal(calls, 1);
   assert.throws(() => new HostedNpmProxy([initial[0]!, file("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/private": { resolved: "https://127.0.0.1/private.tgz", integrity: "sha512-YWJj" } } }))]), ApiError);
 } finally { await proxy.close(); rmSync(directory, { recursive: true, force: true }); }
});

unixTest("cloud repository reservation rolls back task/event/quota on persistence failure", async () => {
 const f = fixture();
 try {
   await connect(f);
   const nextSequence = f.db.requireSession(f.session.id).next_sequence;
   assert.throws(() => f.agent.reserveRepository(f.actor, f.session.id, { content: "Fix", profile_id: "coding",
     include_code: false, github_task_id: `gh-task-${"a".repeat(32)}`, idempotency_key: "github-atomic-failure" }, () => { throw new Error("fixture_persistence_failure"); }));
   assert.equal(f.agent.status(f.actor).user_used_runs, 0);
   assert.equal(f.db.requireSession(f.session.id).next_sequence, nextSequence);
   assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_github_tasks").get()!.n, 0);
 } finally { await f.close(); }
});
unixTest("revoking the initiating device prevents result source persistence and canonical success", async () => {
 const f = fixture();
 let release: ((text: string) => void) | undefined;
 f.runOptions.runContainer = async () => new Promise<string>((resolve) => { release = resolve; });
 try {
   await connect(f);
   const task = f.github.start(f.actor, f.session.id, { content: "Fix", profile_id: "coding", idempotency_key: "github-revoke-running" });
   for (let n = 0; n < 100 && !release; n++) await setTimeout(5);
   assert.ok(release);
   f.service.revokeDevice(f.actor, f.actor.device_id);
   release!(JSON.stringify({ answer: "Done", files: initial, save_error: null }));
   for (let n = 0; n < 100; n++) {
     if (f.db.sqlite.prepare("SELECT state FROM hosted_github_tasks WHERE id=?").get(task.id)!.state !== "running") break;
     await setTimeout(5);
   }
   const stored = f.db.sqlite.prepare("SELECT state,result_files FROM hosted_github_tasks WHERE id=?").get(task.id)!;
   assert.equal(stored.state, "failed"); assert.equal(stored.result_files, null);
   assert.equal(f.db.sqlite.prepare("SELECT status FROM hosted_agent_runs").get()!.status, "failed");
 } finally { release?.(JSON.stringify({ answer: "Done", files: initial })); await f.close(); }
});
