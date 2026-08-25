import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BridgeDaemon,
  LocalBridge,
  MemoryCursorStore,
  type AppendEventInput,
  type CanonicalEvent,
  type CollaborationApi,
  type CompleteAgentRequestInput,
  type RegisteredRuntime,
  type RuntimeRegistration,
} from "../src/index.js";

class FakeApi implements CollaborationApi {
  readonly appended: AppendEventInput[] = [];
  readonly history: CanonicalEvent[] = [];
  completeInput?: CompleteAgentRequestInput;
  runtime: RegisteredRuntime = {
    id: "runtime-1",
    userId: "user-1",
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt",
    localSessionId: "local-1",
    captureFidelity: "harness_transcript",
  };

  async listSessions() { return []; }
  async registerRuntime(runtime: RuntimeRegistration) {
    this.runtime = { ...runtime, id: "runtime-1", userId: "user-1" };
    return this.runtime;
  }
  async readEvents(_sessionId: string, after: number) {
    const events = this.history.filter((item) => item.sequence > after);
    return { events, nextSequence: events.at(-1)?.sequence ?? after, hasMore: false };
  }
  async appendEvent(sessionId: string, input: AppendEventInput) {
    this.appended.push(input);
    return canonical(sessionId, this.appended.length, input);
  }
  async claimAgentRequest(_sessionId: string, requestId: string, runtimeId: string) {
    return { claimed: true, status: "claimed" as const, requestId, runtimeId };
  }
  async completeAgentRequest(_sessionId: string, _requestId: string, input: CompleteAgentRequestInput) {
    this.completeInput = input;
    return canonical("session-1", 10, {
      type: "agent_response",
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      runtimeId: input.runtimeId,
    });
  }
}

test("bridge imports authorized transcripts with redaction, provenance, and durable local cursor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-import-"));
  const transcript = path.join(root, "rollout.jsonl");
  await writeFile(transcript, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", id: "a1", content: "token=supersecretvalue" },
  })}\n`);
  const api = new FakeApi();
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: { codex: [root] },
  });
  await bridge.connect();
  const first = await bridge.importTranscript("session-1", "codex", transcript);
  const second = await bridge.importTranscript("session-1", "codex", transcript);

  assert.equal(first.appended.length, 1);
  assert.equal(second.appended.length, 0);
  assert.equal((api.appended[0]?.payload as any).text, "token=[REDACTED]");
  assert.equal(api.appended[0]?.runtime?.captureFidelity, "harness_transcript");
  assert.equal(api.appended[0]?.runtime?.deviceId, "device-1");
});

test("server cursor resumes incremental history", async () => {
  const api = new FakeApi();
  api.history.push(
    canonical("session-1", 1, { type: "human_chat", idempotencyKey: "1", payload: {} }),
    canonical("session-1", 2, { type: "human_chat", idempotencyKey: "2", payload: {} }),
  );
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await bridge.connect();
  assert.equal((await bridge.readServerIncrement("session-1")).length, 2);
  assert.equal((await bridge.readServerIncrement("session-1")).length, 0);
});

test("provider_request snapshots require explicit capture authorization and exact observation", async () => {
  const api = new FakeApi();
  const blocked = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await blocked.connect();
  await assert.rejects(blocked.uploadContextSnapshot("session-1", {
    captureFidelity: "provider_request",
    content: { messages: [] },
    exactProviderRequest: true,
    observedBy: "harness_hook",
  }), /explicit bridge authorization/);

  const allowed = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration("provider_request"),
    transcriptRoots: {},
    allowProviderRequestCapture: true,
  });
  await allowed.connect();
  await allowed.uploadContextSnapshot("session-1", {
    captureFidelity: "provider_request",
    content: { messages: [] },
    exactProviderRequest: true,
    observedBy: "authorized_proxy",
  });
  assert.equal((api.appended.at(-1)?.payload as any).capture_fidelity, "provider_request");
});

test("agent request claim hydrates canonical history and completes with redacted harness output", async () => {
  const api = new FakeApi();
  const request = canonical("session-1", 2, {
    type: "agent_request",
    idempotencyKey: "request",
    payload: { content: "answer" },
  });
  api.history.push(
    canonical("session-1", 1, { type: "human_chat", idempotencyKey: "chat", payload: { content: "context" } }),
    request,
  );
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await bridge.connect();
  const result = await bridge.processAgentRequest(request, {
    async execute(input) {
      assert.deepEqual(input.canonicalHistory.map((item) => item.sequence), [1, 2]);
      return {
        events: [{
          kind: "assistant",
          localEventId: "answer-1",
          harness: "codex",
          captureFidelity: "harness_transcript",
          content: "Bearer abcdefghijklmnop",
        }],
      };
    },
  });
  assert.equal(result.claimed, true);
  assert.equal((api.completeInput?.payload as any).text, "[REDACTED]");
});

test("pending request polling persists the server cursor only after execution completes", async () => {
  const api = new FakeApi();
  const cursorStore = new MemoryCursorStore();
  const request = canonical("session-1", 2, {
    type: "agent_request",
    idempotencyKey: "request",
    payload: { text: "answer" },
  });
  api.history.push(
    canonical("session-1", 1, { type: "human_chat", idempotencyKey: "chat", payload: {} }),
    request,
  );
  const bridge = new LocalBridge({
    api,
    cursorStore,
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  await bridge.connect();
  await assert.rejects(bridge.processPendingAgentRequests({
    async execute() { throw new Error("adapter failed"); },
  }), /adapter failed/);
  assert.equal((await cursorStore.load()).server["session-1"], 1);

  const result = await bridge.processPendingAgentRequests({
    async execute() {
      return { events: [{
        kind: "assistant",
        localEventId: "answer-2",
        harness: "codex",
        captureFidelity: "harness_transcript",
        content: "done",
      }] };
    },
  });
  assert.equal(result.claimed, 1);
  assert.equal((await cursorStore.load()).server["session-1"], 2);
});

test("bridge daemon exits cleanly when its abort signal is raised", async () => {
  const api = new FakeApi();
  api.history.push(canonical("session-1", 1, {
    type: "agent_request",
    idempotencyKey: "request",
    payload: { text: "answer" },
  }));
  const bridge = new LocalBridge({
    api,
    cursorStore: new MemoryCursorStore(),
    runtime: runtimeRegistration(),
    transcriptRoots: {},
  });
  const shutdown = new AbortController();
  const daemon = new BridgeDaemon({
    bridge,
    signal: shutdown.signal,
    pollIntervalMs: 60_000,
    executor: {
      async execute() {
        shutdown.abort();
        return { events: [{
          kind: "assistant",
          localEventId: "answer-3",
          harness: "codex",
          captureFidelity: "harness_transcript",
          content: "done",
        }] };
      },
    },
  });
  await daemon.run();
  assert.equal(api.completeInput?.payload && (api.completeInput.payload as any).text, "done");
});

function canonical(
  sessionId: string,
  sequence: number,
  input: AppendEventInput,
): CanonicalEvent {
  return {
    id: `event-${sequence}`,
    sessionId,
    sequence,
    type: input.type,
    actorId: "user-1",
    timestamp: "2026-08-25T00:00:00.000Z",
    payload: input.payload,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  };
}

function runtimeRegistration(
  captureFidelity: RuntimeRegistration["captureFidelity"] = "harness_transcript",
): RuntimeRegistration {
  return {
    sessionId: "session-1",
    deviceId: "device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt",
    localSessionId: "local-1",
    captureFidelity,
  };
}
