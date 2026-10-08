import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeRepository } from "../src/code-repository.js";
import { CollaborationDatabase } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { HostedAgent, HostedModelProxy, HOSTED_MODEL, type HostedAgentOptions } from "../src/hosted-agent.js";
import { CollaborationService } from "../src/service.js";

const unixSocketTest = process.platform === "win32" ? test.skip : test;

const options: HostedAgentOptions = {
  endpoints: [{ id: "first", profileId: "default", label: "Qwen3", provider: "cloudflare-workers-ai",
    model: HOSTED_MODEL, baseUrl: `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1`,
    apiToken: "private-provider-token", quotaGroup: "cf-account", dailyRuns: 4, maxConcurrent: 1 }],
  image: `example/hosted@sha256:${"b".repeat(64)}`,
  userDailyRuns: 1, globalDailyRuns: 4, maxConcurrent: 1,
};

function unixPost(socketPath: string, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: "POST",
      headers: { "content-type": "application/json" } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

unixSocketTest("model proxy slow body cannot dispatch after revocation or charge provider cooldown", async () => {
 const directory = mkdtempSync(join(tmpdir(), "gt-slow-model-")), entered = Promise.withResolvers<void>();
 const socket = join(directory, "model.sock"); let authorized = true, calls = 0, cooldowns = 0;
 const proxy = new HostedModelProxy({ endpoint: options.endpoints[0]!, authorize: () => {
  if (!authorized) throw new ApiError(403, "fixture_revoked", "Revoked"); entered.resolve();
 }, fetch: async () => { calls++; return Response.json({ choices: [] }); }, onUnavailable: () => { cooldowns++; } });
 try {
  await proxy.listen(socket);
  const body = JSON.stringify({ model: HOSTED_MODEL, messages: [{ role: "user", content: "Fixture" }] });
  const reply = Promise.withResolvers<number>();
  const req = httpRequest({ socketPath: socket, method: "POST", path: "/v1/chat/completions", headers: {
   "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, (res) => { res.resume(); res.on("end", () => reply.resolve(res.statusCode!)); });
  req.on("error", reply.reject); req.write(body.slice(0, 1)); await entered.promise;
  authorized = false; req.end(body.slice(1));
  assert.equal(await reply.promise, 502); assert.equal(calls, 0); assert.equal(cooldowns, 0);
  authorized = true;
  for (let n = 0; n < 8; n++) assert.equal(await unixPost(socket, "/v1/chat/completions", JSON.parse(body)), 200);
  assert.equal(calls, 8); assert.equal(cooldowns, 0);
 } finally { await proxy.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const revocation of ["revoke-device", "viewer", "delete-session", "finish-job"] as const) {
 unixSocketTest(`trial model slow body rechecks ${revocation} before dispatch`, { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-trial-body-"));
  const db = new CollaborationDatabase(join(directory, "db"), { authTokenPepper: "trial-body-fixture-pepper" });
  const service = new CollaborationService(db), owner = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
  const session = service.createSession(owner, { session_id: "body-session", idempotency_key: "body-session", mode: "multi", title: "Fixture" }).session;
  const actor = db.createIdentity({ display_name: "Participant", device_name: "Fixture", can_create_projects: true }).actor;
  const invite = service.createProjectInvitation(owner, session.project_id, { role: "participant", ttl: "1h" });
  service.claimInvitationForActor(actor, invite.invite_token);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), bodyStarted = Promise.withResolvers<void>();
  let armed = false, calls = 0, status = 0;
  const active = db.assertActiveDevice.bind(db);
  db.assertActiveDevice = (actor) => { active(actor); if (armed) bodyStarted.resolve(); };
  const agent = new HostedAgent(service, new CodeRepository(db, join(directory, "code")), { ...options,
   fetch: async () => { calls++; return Response.json({ choices: [] }); }, runContainer: async (args) => {
    const socket = args.find((arg) => arg.endsWith("dst=/run/model.sock"))!.split("src=")[1]!.split(",dst=")[0]!;
    const body = JSON.stringify({ model: HOSTED_MODEL, messages: [{ role: "user", content: "Fixture" }] });
    const reply = Promise.withResolvers<number>();
    const req = httpRequest({ socketPath: socket, method: "POST", path: "/v1/chat/completions", headers: {
     "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, (res) => { res.resume(); res.on("end", () => reply.resolve(res.statusCode!)); });
    req.on("error", reply.reject); armed = true; req.write(body.slice(0, 1)); await bodyStarted.promise;
    armed = false; entered.resolve(); await release.promise; req.end(body.slice(1)); status = await reply.promise;
    return JSON.stringify({ answer: "Fixture", files: [], save_error: null });
   } });
  let pending: Promise<unknown> | undefined;
  try {
   pending = agent.request(actor, session.id, { profile_id: "default", content: "Fixture", include_code: false, idempotency_key: "slow-trial-model" });
   const outcome = pending.catch(() => {}); await entered.promise;
   if (revocation === "revoke-device") db.revokeDevice(actor, actor.device_id);
   if (revocation === "viewer") db.setProjectMembership(owner, session.project_id, actor.user_id, "viewer");
   if (revocation === "delete-session") db.deleteSession(owner, session.id);
   if (revocation === "finish-job") db.sqlite.prepare("UPDATE hosted_agent_runs SET status='failed' WHERE session_id=?").run(session.id);
   release.resolve(); await outcome;
   assert.equal(status, 502); assert.equal(calls, 0);
   assert.equal((agent as unknown as { cooldowns: Map<string, number> }).cooldowns.size, 0);
  } finally { release.resolve(); await pending?.catch(() => {}); db.close(); rmSync(directory, { recursive: true, force: true }); }
 });
}

unixSocketTest("hosted model proxy permits only the fixed model endpoint and enforces a hard call cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-model-proxy-"));
  const socket = join(directory, "model.sock");
  const forwarded: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const proxy = new HostedModelProxy({ endpoint: options.endpoints[0]!, fetch: async (url, init) => {
    forwarded.push({ url: String(url), authorization: (init?.headers as Record<string, string>).Authorization,
      body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ choices: [{ message: { content: "okay" } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } });
  try {
    await proxy.listen(socket);
    const body = { model: HOSTED_MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 1024 };
    assert.equal(await unixPost(socket, "/v1/other", body), 404);
    assert.equal(await unixPost(socket, "/v1/chat/completions", { ...body, model: "other" }), 400);
    assert.equal(await unixPost(socket, "/v1/chat/completions", { ...body, max_tokens: 999999 }), 400);
    for (let i = 0; i < 8; i += 1) assert.equal(await unixPost(socket, "/v1/chat/completions", body), 200);
    assert.equal(await unixPost(socket, "/v1/chat/completions", body), 429);
    assert.equal(forwarded.length, 8);
    assert.ok(forwarded.every((call) => call.url ===
      `${options.endpoints[0]!.baseUrl}/chat/completions`));
    assert.ok(forwarded.every((call) => call.authorization === `Bearer ${options.endpoints[0]!.apiToken}`
      && call.body.model === HOSTED_MODEL && call.body.max_tokens === 1024));
  } finally {
    await proxy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

unixSocketTest("hosted run uses isolated Docker arguments, persists an event, and reserves daily quota once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-hosted-run-"));
  const database = new CollaborationDatabase(join(directory, "db.sqlite"), {
    authTokenPepper: "hosted-test-auth-token-pepper",
  });
  try {
    const owner = database.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
    const service = new CollaborationService(database);
    const session = service.createSession(owner, { session_id: "hosted-session",
      idempotency_key: "create-hosted-session", mode: "solo", title: "Hosted" }).session;
    const argsSeen: string[][] = [];
    const agent = new HostedAgent(service, new CodeRepository(database, join(directory, "code")), {
      ...options, runContainer: async (args) => { argsSeen.push(args);
        return JSON.stringify({ answer: "Created a starter file plan.", files: [], save_error: null }); },
    });
    const input = { profile_id: "default", content: "Create a small project", include_code: false,
      idempotency_key: "hosted-first-request" };
    const result = await agent.request(owner, session.id, input);
    assert.equal(result.replayed, false);
    assert.equal(result.response_event?.type, "agent_response");
    assert.equal(argsSeen.length, 1);
    const args = argsSeen[0]!;
    for (const required of ["--network", "none", "--read-only", "--cap-drop", "ALL",
      "no-new-privileges", "--memory", "768m", "--user", "10001:10001",
      "/workspace:rw,nosuid,size=32m,mode=1777"]) {
      assert.ok(args.includes(required), `missing ${required}`);
    }
    assert.ok(args.some((argument) => argument.includes("dst=/input,readonly")));
    assert.equal(args[args.indexOf("--memory-swap") + 1], "768m");
    assert.equal(args.includes(options.endpoints[0]!.apiToken), false);
    assert.equal(args.some((argument) => argument.includes(input.content)), false);
    assert.equal((await agent.request(owner, session.id, input)).replayed, true);
    assert.equal(argsSeen.length, 1);
    assert.equal(agent.status(owner).user_used_runs, 1);
    const outsider = database.createIdentity({ display_name: "Outsider", device_name: "Laptop" }).actor;
    await assert.rejects(agent.request(outsider, session.id, { ...input, idempotency_key: "outsider-request" }),
      (error: unknown) => error instanceof ApiError && error.status === 404);
    await assert.rejects(agent.request(owner, session.id, { ...input, content: "Different request" }),
      (error: unknown) => error instanceof ApiError && error.status === 409);
    await assert.rejects(agent.request(owner, session.id, { ...input, idempotency_key: "hosted-second-request" }),
      (error: unknown) => error instanceof ApiError && error.code === "hosted_user_quota");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

unixSocketTest("hosted code changes checkpoint only to the requesting member's cloud branch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-hosted-code-"));
  const database = new CollaborationDatabase(join(directory, "db.sqlite"), {
    authTokenPepper: "hosted-test-auth-token-pepper",
  });
  try {
    const owner = database.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
    const service = new CollaborationService(database);
    const session = service.createSession(owner, { session_id: "hosted-code-session",
      idempotency_key: "create-hosted-code-session", mode: "solo", title: "Hosted code" }).session;
    const repository = new CodeRepository(database, join(directory, "code"));
    repository.enable(owner, session.project_id, { idempotency_key: "enable-hosted-code" });
    const file = { path: "hello.txt", content_base64: Buffer.from("hello\n").toString("base64"), executable: false };
    const agent = new HostedAgent(service, repository, {
      ...options, runContainer: async () => JSON.stringify({ answer: "Wrote hello.txt", files: [file], save_error: null }),
    });
    const result = await agent.request(owner, session.id, { profile_id: "default", content: "Create hello.txt", include_code: true,
      idempotency_key: "hosted-code-request" });
    assert.equal(result.response_event?.type, "agent_response");
    const status = repository.status(owner, session.project_id);
    assert.ok(status.own_branch_id);
    assert.deepEqual(repository.snapshot(owner, session.project_id, status.own_branch_id).snapshot.files, [file]);
    assert.deepEqual(repository.snapshot(owner, session.project_id, "main").snapshot.files, []);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

unixSocketTest("DeepSeek proxy pins the chosen model and reports rate-limit cooldown without forwarding credentials to the container", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-deepseek-proxy-"));
  const socket = join(directory, "model.sock");
  let calls = 0;
  const cooldowns: number[] = [];
  const endpoint = { ...options.endpoints[0]!, provider: "deepseek" as const, model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" };
  const proxy = new HostedModelProxy({ endpoint, onUnavailable: (ms) => cooldowns.push(ms), fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.n, 1);
    assert.equal(body.model, "deepseek-chat");
    return new Response("private upstream detail", { status: 429, headers: { "retry-after": "120" } });
  } });
  try {
    await proxy.listen(socket);
    assert.equal(await unixPost(socket, "/v1/chat/completions", { model: "other", messages: [] }), 400);
    assert.equal(calls, 0); assert.equal(cooldowns.length, 0);
    assert.equal(await unixPost(socket, "/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "test" }] }), 429);
    assert.deepEqual(cooldowns, [120_000]);
    assert.equal(calls, 1);
  } finally { await proxy.close(); rmSync(directory, { recursive: true, force: true }); }
});
