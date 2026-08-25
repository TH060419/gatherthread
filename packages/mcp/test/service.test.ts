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

test("MCP exposes the required collaboration tools and resources", async () => {
  const service = new CollaborationMcpService({ api: new FakeApi() });
  const tools = await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(tools && "result" in tools);
  const names = (tools as any).result.tools.map((item: any) => item.name);
  assert.deepEqual(names, [
    "collaboration_list_projects",
    "collaboration_list_project_sessions",
    "collaboration_list_sessions",
    "collaboration_read_history",
    "collaboration_append_chat",
    "collaboration_request_agent",
    "collaboration_register_runtime",
    "collaboration_claim_agent_request",
    "collaboration_complete_agent_request",
    "collaboration_upload_context_snapshot",
  ]);

  const resources = await service.handle({ jsonrpc: "2.0", id: 2, method: "resources/list" });
  assert.ok(resources && "result" in resources);
  assert.equal((resources as any).result.resources.length, 4);
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

test("provider request fidelity is rejected unless exact capture is explicitly authorized", async () => {
  const api = new FakeApi();
  const blocked = new CollaborationMcpService({ api });
  const failure = await callSnapshot(blocked);
  assert.ok(failure && "error" in failure);
  assert.match((failure as any).error.message, /explicit service authorization/);

  const allowed = new CollaborationMcpService({ api, allowProviderRequestCapture: true });
  const success = await callSnapshot(allowed);
  assert.ok(success && "result" in success);
  assert.equal((api.appended.at(-1)?.payload as any).capture_fidelity, "provider_request");
});

test("harness transcript snapshots fingerprint native session identifiers before append", async () => {
  const api = new FakeApi();
  const service = new CollaborationMcpService({ api });
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
