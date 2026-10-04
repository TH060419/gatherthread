import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { startCollaborationServer } from "../src/server.js";
import { TestGateStore, TEST_GATE_COOKIE } from "../src/test-gate.js";
import type { HostedAgentOptions } from "../src/hosted-agent.js";
import type { HostedGithubTask } from "@gatherthread/protocol";

const origin = "https://test.gatherthread.cn";
const unixTest = process.platform === "win32" ? test.skip : test;
const file = (path: string, content: string) => ({ path, content_base64: Buffer.from(content).toString("base64"), executable: false });
const files = [file("package.json", '{"name":"fixture"}'), file("package-lock.json", '{"lockfileVersion":3,"packages":{"":{}}}'), file("index.js", "export const value = 1;\n")];
async function fixture(t: TestContext) {
 const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-hosted-gate-")));
 const gate = { databasePath: join(directory, "gate.sqlite"), pepper: randomBytes(32).toString("hex"), origin };
 const admin = new TestGateStore(gate), grant = admin.issue(1, 1)[0]!, admission = admin.exchange(grant.admission_code);
 const mails: { code: string }[] = [], calls: { path: string; method: string; transport: string }[] = [], controls: string[] = [];
 const registration = { enabled: true, origin, siteKey: "fixture", challenge: { async verify() { return true; } },
  mailer: { async send(mail: { code: string }) { mails.push(mail); } } };
 let hold: ((path: string, method: string) => Promise<void>) | undefined;
 let modelCalls = 0, runs = 0;
 const fetcher: typeof fetch = async (url, init) => {
  const path = new URL(String(url)).pathname + new URL(String(url)).search, method = init?.method ?? "GET";
  calls.push({ path, method, transport: JSON.stringify(init) });
  await hold?.(path, method);
  if (path === "/login/oauth/access_token") return Response.json({ access_token: "ghu_fixture", refresh_token: "ghr_fixture", expires_in: 28800, refresh_token_expires_in: 15897600, scope: "" });
  if (path === "/user") return Response.json({ login: "fixture" });
  if (path === "/repos/owner/project") return Response.json({ id: 1, full_name: "owner/project", permissions: { push: true } });
  if (path.endsWith("/branches/main")) return Response.json({ commit: { sha: "b".repeat(40) } });
  if (path.endsWith(`/git/commits/${"b".repeat(40)}`)) return Response.json({ tree: { sha: "c".repeat(40) } });
  if (path.includes("/git/trees/") && method === "GET") return Response.json({ truncated: false, tree: files.map((f, n) => ({ path: f.path, type: "blob", mode: "100644", sha: `blob${n}`, size: Buffer.byteLength(f.content_base64, "base64") })) });
  if (path.includes("/git/blobs/blob")) return Response.json({ encoding: "base64", content: files[Number(path.slice(-1))]!.content_base64 });
  if (path.endsWith("/git/blobs")) return Response.json({ sha: "d".repeat(40) });
  if (path.endsWith("/git/trees")) return Response.json({ sha: "e".repeat(40) });
  if (path.endsWith("/git/commits")) return Response.json({ sha: "f".repeat(40) });
  if (path.includes("/git/matching-refs/") || path.includes("/pulls?")) return Response.json([]);
  if (path.endsWith("/git/refs")) return Response.json({ ref: JSON.parse(String(init?.body)).ref, object: { sha: "f".repeat(40) } });
  if (path.endsWith("/pulls")) return Response.json({ html_url: "https://github.com/owner/project/pull/1" });
  throw new Error(`Unexpected fixture GitHub request ${path}`);
 };
 const hostedAgent: HostedAgentOptions = { endpoints: [{ id: "fixture", profileId: "coding", label: "Fixture", provider: "openai-compatible", model: "coding",
  baseUrl: "https://model.example/v1", apiToken: "model-fixture", quotaGroup: "fixture", dailyRuns: 20, maxConcurrent: 2 }],
  image: `sha256:${"a".repeat(64)}`, userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 2,
  fetch: async (_url, init) => { modelCalls++; controls.push(JSON.stringify(init)); return Response.json({ choices: [] }); },
  runContainer: async (args) => {
   runs++; controls.push(JSON.stringify(args));
   const input = args.find((arg) => arg.endsWith("dst=/input,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
   const control = args.find((arg) => arg.endsWith("dst=/run/gatherthread,readonly"))?.split("src=")[1]!.split(",dst=")[0]!;
   if (control) controls.push(readFileSync(join(control, "prompt.txt"), "utf8"));
   const socket = args.find((arg) => arg.endsWith("dst=/run/model.sock"))!.split("src=")[1]!.split(",dst=")[0]!;
   const status = await new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: socket, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end(JSON.stringify({ model: "coding", messages: [{ role: "user", content: "Synthetic fixture" }] }));
   }); assert.equal(status, 200);
   const output = files.map((f) => file(f.path, readFileSync(join(input, f.path), "utf8")));
   output[2] = file("index.js", "export const value = 2;\n");
   return JSON.stringify({ answer: "Fixture answer", files: output, save_error: null });
  } };
 const server = await startCollaborationServer({ databasePath: join(directory, "db.sqlite"), authTokenPepper: randomBytes(32).toString("hex"),
  publicBaseUrl: origin, secureTransport: true, allowedOrigins: [origin], testGate: gate, registration, hostedAgent,
  hostedGithub: { clientId: "fixture", clientSecret: "fixture", encryptionKey: Buffer.alloc(32, 3).toString("base64"), callbackUrl: `${origin}/v1/hosted-github/callback`, appSlug: "fixture", fetch: fetcher } });
 t.after(async () => { await server.close(); admin.close(); rmSync(directory, { recursive: true, force: true }); });
 const registrationBrowser = `grc_${randomBytes(32).toString("base64url")}`;
 const sent = await server.database.registration.send({ email: "fixture@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, registrationBrowser, "fixture", registration);
 const identity = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id, code: mails[0]!.code,
  display_name: "Fixture", device_name: "Browser", password: "synthetic fixture password", remember_device: false, privacy_acknowledged: true }, registrationBrowser, "fixture", registration);
 const session = server.service.createSession(identity.actor, { session_id: "gate-hosted-session", mode: "solo", title: "Fixture", idempotency_key: "gate-hosted-session" }).session;
 const cookie = `${TEST_GATE_COOKIE}=${admission.token}; __Host-gatherthread_session=${identity.browser_session.token}`;
 const call = (path: string, method = "GET", body?: unknown, overrideCookie = cookie) => new Promise<Response>((resolve, reject) => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const req = request(server.origin + path, { method, headers: { host: new URL(origin).host, origin, cookie: overrideCookie, "content-type": "application/json",
   ...(text !== undefined ? { "content-length": String(Buffer.byteLength(text)) } : {}) } }, res => {
   const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode! })));
  }); req.on("error", reject); req.end(text);
 });
 const data = async <T>(reply: Response, status = 200): Promise<T> => { assert.equal(reply.status, status, await reply.clone().text()); return (await reply.json() as { data: T }).data; };
 const authorize = async () => new URL((await data<{ authorization_url: string }>(await call("/v1/hosted-github/authorize", "POST", {}))).authorization_url).searchParams.get("state")!;
 const connect = async () => { await data(await call("/v1/hosted-github/complete", "POST", { state: await authorize(), code: "fixture-code" })); };
 const bind = async () => { await data(await call(`/v1/projects/${session.project_id}/hosted-github/repository`, "POST", { repository: "owner/project", base_branch: "main" })); };
 const task = async () => {
  const value = await data<HostedGithubTask>(await call(`/v1/sessions/${session.id}/hosted-github-tasks`, "POST", { content: "Fixture change", profile_id: "coding", idempotency_key: randomUUID() }), 202);
  for (let n = 0; n < 100; n++) { const next = await data<HostedGithubTask>(await call(`/v1/hosted-github/tasks/${value.id}`)); if (next.state !== "running") { assert.equal(next.state, "completed"); return next; } await setTimeout(5); }
  throw new Error("Fixture task did not finish");
 };
 return { server, admin, grant, admission, gate, calls, controls, cookie, identity, session, call, data, authorize, connect, bind, task,
  hold: (value: typeof hold) => { hold = value; }, modelCalls: () => modelCalls, runs: () => runs,
  revoke: () => admin.revoke(grant.grant_id), count: (table: string) => Number(server.database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) };
}

const taskPath = `/v1/hosted-github/tasks/gh-task-${"a".repeat(32)}`;
test("all hosted and OAuth HTTP routes require live browser admission before processing", async t => {
 const f = await fixture(t), projectPath = `/v1/projects/${f.session.project_id}/hosted-github`, sessionPath = `/v1/sessions/${f.session.id}`;
 const routes = [["GET", "/v1/hosted-agent"], ["POST", "/v1/hosted-github/authorize"], ["POST", "/v1/hosted-github/complete"],
  ["DELETE", "/v1/hosted-github/account"], ["GET", taskPath], ["DELETE", taskPath], ["POST", taskPath + "/pull-request"],
  ["GET", projectPath], ["POST", projectPath + "/repository"], ["GET", projectPath + "/tasks"],
  ["POST", sessionPath + "/hosted-github-tasks"], ["POST", sessionPath + "/hosted-agent-requests"],
  ["GET", `/v1/hosted-github/callback?state=${"a".repeat(43)}&code=fixture`]];
 for (const gateCookie of ["", `${TEST_GATE_COOKIE}=invalid`]) for (const [method, path] of routes) {
  const response = await f.call(path!, method!, {}, `${gateCookie}; __Host-gatherthread_session=${f.identity.browser_session.token}`);
  assert.equal(response.status, 403, path);
 }
 f.revoke(); for (const [method, path] of routes) assert.equal((await f.call(path!, method!, {})).status, 403, path);
 assert.equal(f.calls.length, 0); assert.equal(f.modelCalls(), 0); assert.equal(f.runs(), 0);
 assert.equal(f.count("hosted_github_oauth"), 0); assert.equal(f.count("hosted_agent_runs"), 0);
});

for (const action of ["authorize", "complete", "bind", "repository", "trial", "publish"] as const) {
 unixTest(`hosted ${action} slow HTTP body rejects revoked admission before mutation`, { timeout: 10_000 }, async t => {
  const f = await fixture(t); let path: string, body: unknown;
  if (action === "authorize") { path = "/v1/hosted-github/authorize"; body = {}; }
  else if (action === "complete") { path = "/v1/hosted-github/complete"; body = { state: await f.authorize(), code: "fixture" }; }
  else if (action === "bind") { await f.connect(); path = `/v1/projects/${f.session.project_id}/hosted-github/repository`; body = { repository: "owner/project", base_branch: "main" }; }
  else if (action === "repository") { await f.connect(); await f.bind(); path = `/v1/sessions/${f.session.id}/hosted-github-tasks`; body = { content: "Fixture", profile_id: "coding", idempotency_key: randomUUID() }; }
  else if (action === "trial") { path = `/v1/sessions/${f.session.id}/hosted-agent-requests`; body = { content: "Fixture", profile_id: "coding", include_code: false, idempotency_key: randomUUID() }; }
  else { await f.connect(); await f.bind(); const task = await f.task(); path = `/v1/hosted-github/tasks/${task.id}/pull-request`; body = { title: "Fixture", body: "", expected_revision: task.revision }; }
  const before = [f.calls.length, f.count("hosted_github_oauth"), f.count("hosted_github_accounts"), f.count("hosted_github_bindings"), f.count("hosted_agent_runs")];
  const started = Promise.withResolvers<void>(), reply = Promise.withResolvers<Response>();
  const authenticate = f.server.database.authenticateBrowserSession.bind(f.server.database);
  t.mock.method(f.server.database, "authenticateBrowserSession", (...args: Parameters<typeof authenticate>) => { const value = authenticate(...args); started.resolve(); return value; });
  const text = JSON.stringify(body);
  const req = request(f.server.origin + path, { method: "POST", headers: { host: new URL(origin).host, origin, cookie: f.cookie,
   "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } }, res => {
    const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk))); res.on("end", () => reply.resolve(new Response(Buffer.concat(chunks), { status: res.statusCode! })));
  }); req.on("error", reply.reject); t.after(() => req.destroy()); req.write(text.slice(0, 1));
  await started.promise; f.revoke(); req.end(text.slice(1));
  assert.equal((await reply.promise).status, 403);
  assert.deepEqual([f.calls.length, f.count("hosted_github_oauth"), f.count("hosted_github_accounts"), f.count("hosted_github_bindings"), f.count("hosted_agent_runs")], before);
 });
}

for (const stage of ["/login/oauth/access_token", "/user"]) {
 test(`OAuth ${stage} reply after admission revocation cannot store credentials`, { timeout: 10_000 }, async t => {
  const f = await fixture(t), state = await f.authorize(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.hold(async path => { if (path === stage) { entered.resolve(); await release.promise; } });
  const response = f.call("/v1/hosted-github/complete", "POST", { state, code: "fixture" });
  await entered.promise; f.revoke(); release.resolve(); assert.equal((await response).status, 403);
  assert.equal(f.count("hosted_github_accounts"), 0); assert.equal(f.count("hosted_github_bindings"), 0);
  if (stage === "/login/oauth/access_token") assert.equal(f.calls.some(call => call.path === "/user"), false);
 });
}
for (const stage of ["/repos/owner/project", "/repos/owner/project/branches/main"]) {
 test(`binding ${stage} reply after admission revocation cannot persist consent`, { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.connect();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.hold(async path => { if (path === stage) { entered.resolve(); await release.promise; } });
  const response = f.call(`/v1/projects/${f.session.project_id}/hosted-github/repository`, "POST", { repository: "owner/project", base_branch: "main" });
  await entered.promise; f.revoke(); release.resolve(); assert.equal((await response).status, 403);
  assert.equal(f.count("hosted_github_bindings"), 0);
  if (stage === "/repos/owner/project") assert.equal(f.calls.some(call => call.path.endsWith("/branches/main")), false);
 });
}

for (const [next, previous, method] of [["/git/blobs", "/branches/main", "GET"], ["/git/trees", "/git/blobs", "POST"],
 ["/git/commits", "/git/trees", "POST"], ["/git/refs", "/git/matching-refs/", "GET"], ["/pulls", "/pulls?", "GET"]]) {
 unixTest(`publication after revoked admission never dispatches the next POST ${next}`, { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.connect(); await f.bind(); const task = await f.task();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.hold(async (path, verb) => { if (path.includes(previous!) && verb === method) { entered.resolve(); await release.promise; } });
  const response = f.call(`/v1/hosted-github/tasks/${task.id}/pull-request`, "POST", { title: "Fixture", body: "", expected_revision: task.revision });
  await entered.promise; const writes = f.calls.filter(call => call.method === "POST" && call.path.startsWith("/repos/")).length;
  f.revoke(); release.resolve(); assert.equal((await response).status, 403);
  assert.equal(f.calls.filter(call => call.method === "POST" && call.path.startsWith("/repos/")).length, writes);
  assert.equal(f.calls.some(call => call.method === "POST" && call.path.endsWith(next!)), false);
  assert.equal(f.server.database.sqlite.prepare("SELECT pr_url FROM hosted_github_tasks WHERE id=?").get(task.id)!.pr_url, null);
 });
}

unixTest("admission secrets stay outside model/GitHub transports, runner controls and public/private task payloads", async t => {
 const f = await fixture(t); await f.connect(); await f.bind(); const task = await f.task();
 const publicData = await f.data(await f.call(`/v1/projects/${f.session.project_id}/hosted-github/tasks`));
 const row = f.server.database.sqlite.prepare("SELECT input_json FROM hosted_github_tasks WHERE id=?").get(task.id)!;
 const canonical = f.server.database.sqlite.prepare("SELECT payload_json FROM events").all();
 const transport = JSON.stringify([f.calls, f.controls, publicData, task, row, canonical]);
 for (const secret of [f.grant.admission_code, f.admission.token, f.gate.pepper, f.cookie]) assert.equal(transport.includes(secret), false);
 assert.equal(f.modelCalls(), 1); assert.equal(f.runs(), 1);
});

unixTest("refresh finishing after admission revocation cannot save credentials or dispatch publication", { timeout: 10_000 }, async t => {
 const f = await fixture(t); await f.connect(); await f.bind(); const task = await f.task();
 const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 3), iv);
 cipher.setAAD(Buffer.from(f.identity.actor.user_id));
 const expired = Buffer.concat([iv, cipher.update(JSON.stringify({ access_token: "ghu_fixture", refresh_token: "ghr_fixture", expires_at: 0,
  refresh_expires_at: Date.now() + 600000 })), cipher.final(), cipher.getAuthTag()]).toString("base64");
 f.server.database.sqlite.prepare("UPDATE hosted_github_accounts SET credentials=? WHERE user_id=?").run(expired, f.identity.actor.user_id);
 const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 f.hold(async path => { if (path === "/login/oauth/access_token") { entered.resolve(); await release.promise; } });
 const response = f.call(`/v1/hosted-github/tasks/${task.id}/pull-request`, "POST", { title: "Fixture", body: "", expected_revision: task.revision });
 await entered.promise; const before = f.calls.length; f.revoke(); release.resolve();
 assert.equal((await response).status, 403);
 assert.equal(f.calls.length, before);
 assert.equal(f.server.database.sqlite.prepare("SELECT credentials FROM hosted_github_accounts WHERE user_id=?").get(f.identity.actor.user_id)!.credentials, expired);
});
