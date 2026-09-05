import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationApi } from "@gatherthread/bridge";
import {
  adaptCollaborationApi,
  createHttpDshCollaborationApi,
} from "../src/collaboration-api.js";

test("HTTP compatibility sends credentials only as an Authorization header", async () => {
  const credential = "gta_01234567890123456789012345678901";
  const observed: Array<{ url: string; authorization: string | null; body: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    observed.push({ url, authorization: headers.get("authorization"), body });
    if (url.endsWith("/me")) {
      return Response.json({ data: {
        id: "user-1",
        username: "Fixture User",
        device_id: "device-1",
      } });
    }
    return new Response(JSON.stringify({ data: { runtime: {
      id: "runtime-1",
      user_id: "user-1",
      session_id: "session-1",
      device_id: "device-1",
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      local_session_id: "gatherthread-local",
      capture_fidelity: "harness_transcript",
    } } }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const api = createHttpDshCollaborationApi({
    baseUrl: "https://gatherthread.example/v1",
    credential,
    fetch,
  });

  const actor = await api.getCurrentActor();

  const runtime = await api.registerRuntime({
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "deepseek-harness",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    localSessionId: "gatherthread-local",
    captureFidelity: "harness_transcript",
    capabilities: ["agent_request", "durable_session_events"],
    purpose: "execution",
  });
  const heartbeat = await api.heartbeatRuntime(runtime.id);

  assert.equal(runtime.harness, "deepseek-harness");
  assert.deepEqual(actor, { id: "user-1", displayName: "Fixture User", deviceId: "device-1" });
  assert.equal(heartbeat.id, runtime.id);
  assert.equal(observed.length, 3);
  assert.match(observed[2]?.url ?? "", /\/runtimes\/runtime-1\/heartbeat$/);
  for (const request of observed) {
    assert.equal(request.authorization, `Bearer ${credential}`);
    assert.doesNotMatch(request.url, new RegExp(credential));
    assert.doesNotMatch(request.body, new RegExp(credential));
  }
});

test("compatibility boundary rejects a Collaboration API without heartbeat support", () => {
  const withoutHeartbeat = {
    listProjectSessions: async () => [],
    appendAgentProgress: async () => { throw new Error("unused"); },
  } as unknown as CollaborationApi;
  assert.throws(
    () => adaptCollaborationApi(withoutHeartbeat),
    /lacks required session, heartbeat, or progress support/,
  );
});
