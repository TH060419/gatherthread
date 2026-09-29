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

const options: HostedAgentOptions = {
  accountId: "a".repeat(32), apiToken: "private-provider-token",
  image: `example/hosted@sha256:${"b".repeat(64)}`,
  defaultUserDailyNeurons: 2_000, globalDailyNeurons: 8_000, maxConcurrent: 1,
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

test("hosted model proxy permits only the fixed model endpoint and enforces a hard call cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-model-proxy-"));
  const socket = join(directory, "model.sock");
  const forwarded: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const proxy = new HostedModelProxy({ ...options, fetch: async (url, init) => {
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
      `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/v1/chat/completions`));
    assert.ok(forwarded.every((call) => call.authorization === `Bearer ${options.apiToken}`
      && call.body.model === HOSTED_MODEL && call.body.max_tokens === 1024));
  } finally {
    await proxy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hosted run uses isolated Docker arguments, persists an event, and reserves daily quota once", async () => {
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
    const input = { content: "Create a small project", include_code: false,
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
    assert.equal(args.includes(options.apiToken), false);
    assert.equal(args.some((argument) => argument.includes(input.content)), false);
    assert.equal((await agent.request(owner, session.id, input)).replayed, true);
    assert.equal(argsSeen.length, 1);
    assert.equal(agent.status(owner).user_used_neurons, 2_000);
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

test("hosted code changes checkpoint only to the requesting member's cloud branch", async () => {
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
    const result = await agent.request(owner, session.id, { content: "Create hello.txt", include_code: true,
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
