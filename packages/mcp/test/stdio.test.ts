import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import test from "node:test";
import type {
  AppendEventInput,
  CollaborationApi,
  CompleteAgentRequestInput,
  RuntimeRegistration,
} from "@gatherthread/bridge";
import { CollaborationMcpService, StdioMcpServer } from "../src/index.js";

const api: CollaborationApi = {
  async listSessions() { return []; },
  async readEvents(_sessionId, afterSequence) {
    return { events: [], nextSequence: afterSequence, hasMore: false };
  },
  async appendEvent(_sessionId: string, _event: AppendEventInput) { throw new Error("unused"); },
  async registerRuntime(runtime: RuntimeRegistration) { return { ...runtime, id: "r1", userId: "u1" }; },
  async claimAgentRequest(_sessionId, requestId, runtimeId) {
    return { claimed: true, status: "claimed", requestId, runtimeId };
  },
  async completeAgentRequest(_sessionId: string, _requestId: string, _input: CompleteAgentRequestInput) {
    throw new Error("unused");
  },
};

test("stdio MCP transport emits newline-delimited JSON-RPC and keeps notifications silent", async () => {
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
    "{broken-json\n",
  ]);
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  await new StdioMcpServer(new CollaborationMcpService({ api })).run({ input, output });
  const responses = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses, [
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
  ]);
});

test("stdio MCP transport supports JSON-RPC batches", async () => {
  const input = Readable.from([`${JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "ping" },
  ])}\n`]);
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  await new StdioMcpServer(new CollaborationMcpService({ api })).run({ input, output });
  assert.deepEqual(JSON.parse(text), [{ jsonrpc: "2.0", id: 1, result: {} }]);
});

test("stdio MCP transport drops oversized lines before buffering the next request", async () => {
  const input = Readable.from([
    "x".repeat(40),
    "x".repeat(40),
    `\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
  ]);
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  await new StdioMcpServer(new CollaborationMcpService({ api })).run({ input, output, maxMessageBytes: 64 });
  assert.deepEqual(text.trim().split("\n").map((line) => JSON.parse(line)), [
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message exceeds the configured size limit" } },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);
});

test("stdio rejects oversized batches without dispatch and still handles the next line", async () => {
  let calls = 0;
  const service = new CollaborationMcpService({ api: {
    ...api, async listSessions() { calls += 1; return []; },
  } });
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "collaboration_list_sessions", arguments: {},
  } };
  const input = Readable.from([
    `${JSON.stringify(Array.from({ length: 129 }, () => call))}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
  ]);
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  await new StdioMcpServer(service).run({ input, output });
  const responses = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls, 0);
  assert.equal(responses[0].error.code, -32600);
  assert.deepEqual(responses[1], { jsonrpc: "2.0", id: 2, result: {} });
});
