import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppendEventInput,
  CanonicalEvent,
  CollaborationApi,
  CompleteAgentRequestInput,
  RuntimeRegistration,
} from "@gatherthread/bridge";
import { CollaborationMcpService, createMcpHttpHandler } from "../src/index.js";

class FakeApi implements CollaborationApi {
  appended: AppendEventInput[] = [];
  async listProjects() { return [{ id: "p1", name: "Project", role: "owner" as const, state: "active" as const, sessionCount: 1 }]; }
  async listProjectSessions(projectId: string) {
    return [{ id: "s1", projectId, name: "Demo", mode: "multi" as const, role: "owner" as const }];
  }
  async listSessionMembers() {
    return [{
      displayName: "Owner",
      role: "owner" as const,
      runtime: {
        status: "online" as const,
        purpose: "execution" as const,
        harness: "codex",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    }];
  }
  async listSessions() { return [{ id: "s1", name: "Demo", mode: "multi" as const }]; }
  async readEvents(_sessionId: string, after: number) {
    return { events: [], nextSequence: after, hasMore: false };
  }
  async appendEvent(sessionId: string, input: AppendEventInput) {
    this.appended.push(input);
    return event(sessionId, this.appended.length, input);
  }
  async registerRuntime(runtime: RuntimeRegistration) { return { ...runtime, id: "r1", userId: "u1" }; }
  async claimAgentRequest(_sessionId: string, requestId: string, runtimeId: string) {
    return { claimed: true, status: "claimed" as const, requestId, runtimeId };
  }
  async completeAgentRequest(_sessionId: string, _requestId: string, input: CompleteAgentRequestInput) {
    return event("s1", 10, {
      type: "agent_response",
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      runtimeId: input.runtimeId,
    });
  }
}

test("user MCP exposes collaboration tools but no internal runtime controls", async () => {
  const service = new CollaborationMcpService({ api: new FakeApi() });
  const tools = await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(tools && "result" in tools);
  const listedTools = (tools as any).result.tools;
  const names = listedTools.map((item: any) => item.name);
  assert.deepEqual(names, [
    "collaboration_list_projects",
    "collaboration_list_project_sessions",
    "collaboration_list_sessions",
    "collaboration_read_history",
    "collaboration_read_context",
    "collaboration_append_chat",
    "collaboration_request_agent",
    "collaboration_get_connection_status",
    "collaboration_get_local_sync_status",
    "collaboration_set_local_auto_upload",
    "collaboration_upload_local_turns",
    "collaboration_import_codex_history",
  ]);
  const readOnlyNames = names.filter((name: string) =>
    !["collaboration_append_chat", "collaboration_request_agent", "collaboration_set_local_auto_upload", "collaboration_upload_local_turns", "collaboration_import_codex_history"].includes(name),
  );
  for (const name of readOnlyNames) {
    assert.deepEqual(listedTools.find((item: any) => item.name === name).annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  }
  for (const name of ["collaboration_append_chat", "collaboration_request_agent", "collaboration_set_local_auto_upload", "collaboration_upload_local_turns", "collaboration_import_codex_history"]) {
    assert.deepEqual(listedTools.find((item: any) => item.name === name).annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: name !== "collaboration_import_codex_history",
      openWorldHint: true,
    });
  }
  assert.match(listedTools.find((item: any) => item.name === "collaboration_import_codex_history").description, /new Desktop-visible Codex task.*archives old tasks manually/);
  assert.match(
    listedTools.find((item: any) => item.name === "collaboration_request_agent").description,
    /consume compute or other resources/,
  );
  for (const internalName of [
    "collaboration_register_runtime",
    "collaboration_claim_agent_request",
    "collaboration_complete_agent_request",
    "collaboration_upload_context_snapshot",
  ]) {
    const blocked = await service.handle({
      jsonrpc: "2.0",
      id: internalName,
      method: "tools/call",
      params: { name: internalName, arguments: {} },
    });
    assert.ok(blocked && "error" in blocked);
    assert.equal((blocked as any).error.code, -32601);
  }

  const resources = await service.handle({ jsonrpc: "2.0", id: 2, method: "resources/list" });
  assert.ok(resources && "result" in resources);
  assert.equal((resources as any).result.resources.length, 4);
});

test("runtime MCP profile exposes only internal execution tools", async () => {
  const service = new CollaborationMcpService({ api: new FakeApi(), toolProfile: "runtime" });
  const tools = await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(tools && "result" in tools);
  assert.deepEqual((tools as any).result.tools.map((item: any) => item.name), [
    "collaboration_register_runtime",
    "collaboration_claim_agent_request",
    "collaboration_complete_agent_request",
    "collaboration_upload_context_snapshot",
  ]);
  const blocked = await service.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "collaboration_read_context", arguments: { session_id: "s1" } } });
  assert.equal((blocked as any).error.code, -32601);
});

test("context tool follows the project policy, returns source-aware summaries and keeps canonical history exact", async () => {
  const original = { kind: "original", event_id: "e1", sequence: 1, actor_user_id: "u1", content: "Original confirmed decision. ".repeat(500) };
  const summary = { kind: "summary", event_id: "e3", sequence: 1, actor_user_id: "u1", content: "Confirmed the decision; next step is testing.", source_event_ids: ["e1"] };
  const contextCalls: unknown[][] = [];
  const rawCalls: unknown[][] = [];
  const rawResult = { events: [event("s1", 1, { type: "human_chat", idempotencyKey: "exact-history", payload: { text: original.content } })], nextSequence: 14, hasMore: true };
  const api = Object.assign(new FakeApi(), {
    async readContext(sessionId: string, view?: "summary" | "original") {
      contextCalls.push([sessionId, view]);
      const selected = view ?? "original";
      return { view: selected, through_sequence: 3, items: [selected === "summary" ? summary : original] };
    },
    async readEvents(sessionId: string, after: number, limit?: number) {
      rawCalls.push([sessionId, after, limit]);
      return rawResult;
    },
  });
  const service = new CollaborationMcpService({ api: api as any });
  const listed = await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const definition = (listed as any).result.tools.find((item: any) => item.name === "collaboration_read_context");
  assert.match(definition.description, /project.*policy/i);
  assert.match(definition.description, /collaboration_read_history/);
  assert.deepEqual(definition.inputSchema.properties.view.enum, ["summary", "original"]);
  assert.equal(definition.inputSchema.properties.view.default, undefined);
  assert.deepEqual(definition.inputSchema.required, ["session_id"]);
  const call = async (name: string, args: unknown) => service.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const policy = await call("collaboration_read_context", { session_id: "s1" });
  assert.equal((policy as any).result.structuredContent.result.view, "original");
  const summarized = await call("collaboration_read_context", { session_id: "s1", view: "summary" });
  const result = (summarized as any).result.structuredContent.result;
  assert.deepEqual(result, { view: "summary", through_sequence: 3, items: [summary] });
  assert.ok(JSON.stringify(result).length < original.content.length / 10);
  const originals = await call("collaboration_read_context", { session_id: "s1", view: "original" });
  assert.deepEqual((originals as any).result.structuredContent.result.items, [original]);
  const raw = await call("collaboration_read_history", { session_id: "s1", after_sequence: 4, limit: 7 });
  assert.deepEqual((raw as any).result.structuredContent.result, rawResult);
  assert.deepEqual(rawCalls, [["s1", 4, 7]]);
  assert.deepEqual(contextCalls, [["s1", undefined], ["s1", "summary"], ["s1", "original"]]);
});

test("context tool fails closed for unsupported APIs and never substitutes raw history", async () => {
  let reads = 0;
  const api = new FakeApi();
  api.readEvents = async () => { reads += 1; return { events: [], nextSequence: 0, hasMore: false }; };
  const service = new CollaborationMcpService({ api });
  const response = await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "collaboration_read_context", arguments: { session_id: "s1" } } });
  assert.match((response as any).error.message, /context.*unavailable.*not substituted/i);
  assert.equal(reads, 0);
});

test("context tool rejects invalid arguments and actor overrides before any API read", async () => {
  let calls = 0;
  const api = Object.assign(new FakeApi(), { async readContext() { calls += 1; return { view: "summary", through_sequence: 0, items: [] }; } });
  const service = new CollaborationMcpService({ api: api as any });
  for (const args of [
    {}, { session_id: "" }, { session_id: " " }, { session_id: "../s1" }, { session_id: "s1\n" },
    { session_id: "s".repeat(129) }, { session_id: "s1", view: "raw" }, { session_id: "s1", view: null },
    { session_id: "s1", actor_user_id: "another-user" }, { session_id: "s1", after_sequence: 3 },
  ]) {
    const response = await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "collaboration_read_context", arguments: args } });
    assert.equal((response as any).error.code, -32602);
  }
  assert.equal(calls, 0);
});

test("context tool surfaces authorization failures and rejects mislabeled API responses", async () => {
  let forbidden = true;
  let calls = 0;
  const api = Object.assign(new FakeApi(), {
    async readContext() {
      calls += 1;
      if (forbidden) throw new Error("Session is not available for this user");
      return { view: "original", through_sequence: 0, items: [] };
    },
  });
  const service = new CollaborationMcpService({ api: api as any });
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "collaboration_read_context", arguments: { session_id: "s1", view: "summary" } } };
  assert.match((await service.handle(request) as any).error.message, /not available for this user/);
  forbidden = false;
  assert.match((await service.handle(request) as any).error.message, /context.*view/i);
  assert.equal(calls, 2);
});

test("connection status omits private runtime and device identifiers", async () => {
  const service = new CollaborationMcpService({ api: new FakeApi() });
  const response = await service.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "collaboration_get_connection_status", arguments: { project_id: "p1" } },
  });
  assert.ok(response && "result" in response);
  const serialized = JSON.stringify((response as any).result.structuredContent.result);
  assert.match(serialized, /"status":"online"/);
  assert.match(serialized, /"harness":"codex"/);
  assert.doesNotMatch(serialized, /deviceId|device_id|localSession|local_session|runtimeId|runtime_id/);
});

test("project tools preserve project grouping before session-level history access", async () => {
  const service = new CollaborationMcpService({ api: new FakeApi() });
  const projects = await service.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "collaboration_list_projects", arguments: {} },
  });
  const sessions = await service.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "collaboration_list_project_sessions", arguments: { project_id: "p1" } },
  });
  assert.equal((projects as any).result.structuredContent.result[0].id, "p1");
  assert.equal((sessions as any).result.structuredContent.result[0].projectId, "p1");
});

test("chat and agent request tools append distinct canonical events and redact secrets", async () => {
  const api = new FakeApi();
  const service = new CollaborationMcpService({ api });
  for (const [name, key] of [
    ["collaboration_append_chat", "chat-key-0001"],
    ["collaboration_request_agent", "request-key-0001"],
  ] as const) {
    await service.handle({
      jsonrpc: "2.0",
      id: key,
      method: "tools/call",
      params: { name, arguments: { session_id: "s1", content: "token=secretvalue123", idempotency_key: key } },
    });
  }
  assert.deepEqual(api.appended.map((item) => item.type), ["human_chat", "agent_request"]);
  assert.ok(api.appended.every((item) => (item.payload as any).text === "token=[REDACTED]"));
});

test("user MCP exposes explicit per-conversation automatic and manual local upload controls", async () => {
  const calls: string[] = [];
  const localSync = {
    async getLocalSyncStatus(sessionId: string) {
      calls.push(`status:${sessionId}`);
      return { sessionId, localSessionId: "thread-1", automaticUpload: true, pendingLocalTurns: 0, uploadableLocalTurns: 1 };
    },
    async setLocalAutoUpload(sessionId: string, enabled: boolean) {
      calls.push(`auto:${sessionId}:${enabled}`);
      return { sessionId, localSessionId: "thread-1", automaticUpload: enabled, pendingLocalTurns: 0, uploadableLocalTurns: 1 };
    },
    async uploadLocalTurns(sessionId: string) {
      calls.push(`upload:${sessionId}`);
      return { sessionId, localSessionId: "thread-1", automaticUpload: false, pendingLocalTurns: 0, uploadableLocalTurns: 0, discoveredLocalTurns: 1, uploadedLocalTurns: 1 };
    },
    async importVisibleHistorySnapshot(sessionId: string) {
      calls.push(`history:${sessionId}`);
      return { status: "imported" as const, threadId: "thread-2", throughSequence: 2, compacted: false };
    },
  };
  const service = new CollaborationMcpService({ api: new FakeApi(), localSync });
  for (const [name, argumentsValue] of [
    ["collaboration_get_local_sync_status", { session_id: "s1" }],
    ["collaboration_set_local_auto_upload", { session_id: "s1", enabled: false }],
    ["collaboration_upload_local_turns", { session_id: "s1" }],
    ["collaboration_import_codex_history", { session_id: "s1" }],
  ] as const) {
    const response = await service.handle({
      jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: argumentsValue },
    });
    assert.ok(response && "result" in response);
  }
  assert.deepEqual(calls, ["status:s1", "auto:s1:false", "upload:s1", "history:s1"]);
});

test("provider request fidelity is rejected unless exact capture is explicitly authorized", async () => {
  const api = new FakeApi();
  const blocked = new CollaborationMcpService({ api, toolProfile: "runtime" });
  const failure = await callSnapshot(blocked);
  assert.ok(failure && "error" in failure);
  assert.match((failure as any).error.message, /explicit service authorization/);

  const allowed = new CollaborationMcpService({ api, toolProfile: "runtime", allowProviderRequestCapture: true });
  const success = await callSnapshot(allowed);
  assert.ok(success && "result" in success);
  assert.equal((api.appended.at(-1)?.payload as any).capture_fidelity, "provider_request");
});

test("harness transcript snapshots fingerprint native session identifiers before append", async () => {
  const api = new FakeApi();
  const service = new CollaborationMcpService({ api, toolProfile: "runtime" });
  const localSessionId = "/private/local/codex/thread.jsonl";
  const response = await service.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "collaboration_upload_context_snapshot",
      arguments: {
        session_id: "s1",
        capture_fidelity: "harness_transcript",
        content: { messages: [] },
        local_session_id: localSessionId,
      },
    },
  });
  assert.ok(response && "result" in response);
  const serialized = JSON.stringify(api.appended.at(-1)?.payload);
  assert.doesNotMatch(serialized, new RegExp(localSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(serialized, /local_session_fingerprint/);
});

test("resource reads support incremental history cursors", async () => {
  let seenAfter = -1;
  const api = new FakeApi();
  api.readEvents = async (_sessionId, after) => {
    seenAfter = after;
    return { events: [], nextSequence: after, hasMore: false };
  };
  const service = new CollaborationMcpService({ api });
  const response = await service.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: "collaboration://sessions/s1/events?after_sequence=42" },
  });
  assert.ok(response && "result" in response);
  assert.equal(seenAfter, 42);
});

test("Streamable HTTP handler accepts JSON-RPC POST and rejects unapproved origins", async () => {
  const handler = createMcpHttpHandler(new CollaborationMcpService({ api: new FakeApi() }), {
    allowedOrigins: ["https://trusted.example"],
  });
  const forbidden = await handler(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }));
  assert.equal(forbidden.status, 403);

  const response = await handler(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://trusted.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: {} });
});

test("HTTP MCP rejects oversized and excessively large batches before executing tools", async () => {
  const api = new FakeApi();
  const handler = createMcpHttpHandler(new CollaborationMcpService({ api }));
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "collaboration_append_chat",
    arguments: { session_id: "s1", content: "hello", idempotency_key: "bounded-test" },
  } };
  const post = (payload: unknown) => handler(new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  const tooLarge = await post({ ...call, padding: "x".repeat(1_048_576) });
  assert.equal(tooLarge.status, 413);
  assert.equal(api.appended.length, 0);
  const oversizedBatch = await post(Array.from({ length: 129 }, () => call));
  assert.equal(oversizedBatch.status, 200);
  assert.equal((await oversizedBatch.json() as { error: { code: number } }).error.code, -32600);
  assert.equal(api.appended.length, 0);
  const valid = await post([call, { jsonrpc: "2.0", method: "notifications/initialized" }]);
  assert.equal((await valid.json() as unknown[]).length, 1);
  assert.equal(api.appended.length, 1);
});

test("HTTP MCP rejects a lookalike content type and handles bounded invalid JSON", async () => {
  const handler = createMcpHttpHandler(new CollaborationMcpService({ api: new FakeApi() }));
  const invalidType = await handler(new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "text/plain; charset=application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }));
  assert.equal(invalidType.status, 415);
  const broken = await handler(new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: "{broken-json",
  }));
  assert.deepEqual(await broken.json(), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
});

test("HTTP MCP bounds actual streamed bytes, not just declared Content-Length", async () => {
  const handler = createMcpHttpHandler(new CollaborationMcpService({ api: new FakeApi() }));
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"padding":"'));
      controller.enqueue(new Uint8Array(1_048_576).fill(120));
    },
    cancel() { canceled = true; },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body, duplex: "half",
  };
  assert.equal((await handler(new Request("http://localhost/mcp", init))).status, 413);
  assert.equal(canceled, true);
});

test("HTTP MCP bounds nested and wide JSON before dispatching tools", async () => {
  const handler = createMcpHttpHandler(new CollaborationMcpService({ api: new FakeApi() }));
  let nested: unknown = "leaf";
  for (let depth = 0; depth < 70; depth += 1) nested = { child: nested };
  for (const padding of [nested, Array.from({ length: 50_001 }, () => 0)]) {
    const result = await handler(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding }),
    }));
    assert.equal((await result.json() as { error: { code: number } }).error.code, -32600);
  }
});

test("invalid JSON-RPC IDs never dispatch a mutating tool", async () => {
  const api = new FakeApi();
  const service = new CollaborationMcpService({ api });
  for (const id of [{ nested: "not-an-id" }, [], true, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await service.handle({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "collaboration_append_chat",
      arguments: { session_id: "s1", content: "hello", idempotency_key: "invalid-id" },
    } });
    assert.deepEqual(result, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  assert.equal(api.appended.length, 0);
});

function callSnapshot(service: CollaborationMcpService) {
  return service.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "collaboration_upload_context_snapshot",
      arguments: {
        session_id: "s1",
        capture_fidelity: "provider_request",
        content: { messages: [] },
        exact_provider_request: true,
        observed_by: "harness_hook",
        runtime_id: "r1",
      },
    },
  });
}

function event(sessionId: string, sequence: number, input: AppendEventInput): CanonicalEvent {
  return {
    id: `e${sequence}`,
    sessionId,
    sequence,
    type: input.type,
    actorId: "u1",
    timestamp: "2026-08-25T00:00:00.000Z",
    payload: input.payload,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  };
}
