import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostedModelProxy } from "../src/hosted-agent.js";
import { ApiError } from "../src/errors.js";

const socketTest = process.platform === "win32" ? test.skip : test;
const endpoint = { id: "anthropic", profileId: "anthropic", label: "Claude fixture", provider: "anthropic" as const,
  transport: "anthropic-messages" as const, model: "claude-fixture", baseUrl: "https://api.anthropic.com/v1",
  apiToken: "private-anthropic-key", quotaGroup: "personal-fixture", dailyRuns: 100, maxConcurrent: 1 };
const nativeBody = { model: endpoint.model, messages: [{ role: "user", content: "Fixture" }], max_tokens: 512, stream: true };
function post(path: string, socketPath: string, body: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "x-api-key": "untrusted" } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body })); res.on("error", reject);
    }); req.on("error", reject); req.end(JSON.stringify(body));
  });
}
socketTest("native Anthropic uses fixed Messages route and host-only credentials, streaming tools intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "gt-native-api-")), socket = join(root, "model.sock"); let calls = 0;
  const stream = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"bash","id":"tool-1","input":{}}}\n\n';
  const proxy = new HostedModelProxy({ endpoint, fetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.anthropic.com/v1/messages"); assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers); assert.equal(headers.get("x-api-key"), endpoint.apiToken);
    assert.equal(headers.get("anthropic-version"), "2023-06-01"); assert.equal(headers.get("authorization"), null);
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, endpoint.model); assert.equal(body.max_tokens, 1024);
    assert.equal(body.n, undefined); assert.equal(body.max_completion_tokens, undefined); assert.equal(body.thinking, undefined);
    return new Response(stream, { headers: { "content-type": "text/event-stream", "x-private-provider": endpoint.apiToken } });
  } });
  try {
    await proxy.listen(socket);
    assert.equal((await post("/v1/chat/completions", socket, nativeBody)).status, 404);
    assert.equal((await post("/v1/messages", socket, { ...nativeBody, model: "other" })).status, 400);
    assert.equal((await post("/v1/messages", socket, { ...nativeBody, max_tokens: 8192 })).status, 400);
    const response = await post("/v1/messages", socket, { ...nativeBody, thinking: { type: "enabled", budget_tokens: 8096 } });
    assert.equal(response.status, 200); assert.equal(response.body, stream); assert.equal(calls, 1);
    for (let n = 0; n < 7; n++) assert.equal((await post("/v1/messages", socket, nativeBody)).status, 200);
    assert.equal((await post("/v1/messages", socket, nativeBody)).status, 429); assert.equal(calls, 8);
  } finally { await proxy.close(); rmSync(root, { recursive: true, force: true }); }
});
socketTest("native streaming rechecks authorization on each chunk and cancels pending upstream", async () => {
  const root = mkdtempSync(join(tmpdir(), "gt-native-revoke-")), socket = join(root, "model.sock");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let authorized = true, upstreamSignal: AbortSignal | undefined;
  const proxy = new HostedModelProxy({ endpoint, authorize: () => { if (!authorized) throw new ApiError(403, "revoked", "Revoked"); },
    fetch: async (_url, init) => { upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ async start(control) {
        control.enqueue(new TextEncoder().encode("first")); entered.resolve(); await release.promise;
        control.enqueue(new TextEncoder().encode("private late content")); control.close();
      } }), { headers: { "content-type": "text/event-stream" } }); },
  });
  try {
    await proxy.listen(socket); const reply = post("/v1/messages", socket, nativeBody).catch(() => ({ status: 0, body: "" }));
    await entered.promise; authorized = false; release.resolve(); const response = await reply;
    assert.doesNotMatch(response.body, /private late content/); assert.equal(upstreamSignal?.aborted, true);
  } finally { release.resolve(); await proxy.close(); rmSync(root, { recursive: true, force: true }); }
});
