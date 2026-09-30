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
import { HostedNpmProxy } from "../src/hosted-npm-proxy.js";
import type { CodeFile } from "@gatherthread/protocol";
import { request } from "node:http";

const unixTest = process.platform === "win32" ? test.skip : test;
const file = (path: string, content: string): CodeFile => ({ path, content_base64: Buffer.from(content).toString("base64"), executable: false });
const initial = [file("package.json", '{"name":"fixture","version":"1.0.0","scripts":{"test":"node --test"}}'),
  file("package-lock.json", '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}'), file("src/index.ts", "export const value = 1;\n")];
const options: HostedAgentOptions = { endpoints: [{ id: "one", profileId: "coding", label: "Coding", provider: "openai-compatible",
  model: "coding", baseUrl: "https://model.example/v1", apiToken: "fake-model-secret", quotaGroup: "one", dailyRuns: 20, maxConcurrent: 2 }],
  image: `sha256:${"a".repeat(64)}`, userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 2 };

function fixture() {
 const directory = mkdtempSync(join(tmpdir(), "gt-github-test-"));
 const db = new CollaborationDatabase(join(directory, "db"), { authTokenPepper: "github-test-pepper-long" });
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
   assert.ok(args.includes("none") && args.includes("2g") && args.includes("GT_HOSTED_REPOSITORY=1"));
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
