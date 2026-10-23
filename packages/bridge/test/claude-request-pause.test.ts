import assert from "node:assert/strict";
import test from "node:test";
import { LocalBridge } from "../src/bridge.js";
import { MemoryCursorStore } from "../src/cursors.js";
import type { CanonicalEvent, CollaborationApi, RegisteredRuntime } from "../src/types.js";

test("an ordinary paused Claude claim aborts the owned process even without a context API and never publishes a final", async () => {
  const request: CanonicalEvent = { id: "request-1", sessionId: "session-1", sequence: 1, type: "agent_request", actorId: "user-1",
    timestamp: "2026-10-22T00:00:00.000Z", payload: { content: "Fixture" } };
  const runtime: RegisteredRuntime = { id: "runtime-1", sessionId: "session-1", userId: "user-1", deviceId: "device-1", harness: "claude-code",
    provider: "anthropic", model: "claude-sonnet-fixture", localSessionId: "binding-1", captureFidelity: "harness_transcript" };
  let claims = 0, completions = 0, aborted = false;
  const api = { async registerRuntime() { return runtime; }, async readEvents() { return { events: [request], nextSequence: 1, hasMore: false }; },
    async claimAgentRequest() { const paused = ++claims > 1; return { requestId: request.id, runtimeId: runtime.id,
      claimed: !paused, status: paused ? "paused" : "claimed", attemptCount: 1 }; },
    async completeAgentRequest() { completions++; return request; },
  } as unknown as CollaborationApi;
  const bridge = new LocalBridge({ api, cursorStore: new MemoryCursorStore(), runtime, transcriptRoots: {} });
  await bridge.connect();
  const result = await bridge.processAgentRequest(request, { execute: input => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ events: [{ kind: "assistant", content: "Should not publish", localEventId: "native-1",
      harness: "claude-code", captureFidelity: "harness_transcript" }] }), 1500);
    input.signal?.addEventListener("abort", () => { aborted = true; clearTimeout(timer); reject(new Error("Fixture process stopped")); }, { once: true });
  }) });
  assert.equal(aborted, true);
  assert.equal(completions, 0);
  assert.deepEqual(result, { claimed: true, completed: [] });
});
