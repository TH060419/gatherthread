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
import { redactJson } from "../src/redaction.js";
import { HostedRepositoryRunner } from "../src/hosted-repository-runner.js";

const unixTest = process.platform === "win32" ? test.skip : test;
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
   f.db.sqlite.prepare("UPDATE hosted_github_tasks SET input_json=?,state='running' WHERE id=?").run(JSON.stringify(input), done.id);
   for (let restart = 0; restart < 2; restart++) {
     restored = new HostedGithub(f.service, f.agent, f.runOptions, f.githubOptions);
     const row = f.db.sqlite.prepare("SELECT input_json,input_fingerprint FROM hosted_github_tasks WHERE id=?").get(done.id)!;
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
