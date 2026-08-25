import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import {
  HttpCollaborationClient,
  LocalBridge,
  MemoryCursorStore,
} from "../../packages/bridge/dist/src/index.js";

async function request(origin, path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.ok(response.ok, JSON.stringify(payload));
  return payload.data;
}

test("production server and local bridge complete a provenance-labelled agent turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-production-stack-"));
  const running = await startCollaborationServer({ databasePath: join(directory, "stack.sqlite") }, 0);
  try {
    const identity = await request(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: {
        user_id: "alice",
        display_name: "Alice",
        device_id: "alice-laptop",
        device_name: "Alice laptop",
      },
    });
    const token = identity.token;
    await request(running.origin, "/v1/sessions", {
      method: "POST",
      token,
      body: {
        session_id: "shared-project",
        idempotency_key: "create-shared-project",
        mode: "multi",
        title: "Shared project",
      },
    });

    const api = new HttpCollaborationClient({
      baseUrl: `${running.origin}/v1`,
      bearerToken: token,
    });
    const bridge = new LocalBridge({
      api,
      cursorStore: new MemoryCursorStore(),
      runtime: {
        runtimeId: "alice-codex-runtime",
        sessionId: "shared-project",
        deviceId: "alice-laptop",
        harness: "codex",
        provider: "openai",
        model: "gpt-5.6-sol",
        localSessionId: "codex-local-session",
        captureFidelity: "harness_transcript",
      },
      transcriptRoots: {},
    });
    await bridge.connect();

    await api.appendEvent("shared-project", {
      type: "human_chat",
      idempotencyKey: "alice-chat-context",
      payload: { content: "Remember the shared migration constraint." },
    });
    const agentRequest = await api.appendEvent("shared-project", {
      type: "agent_request",
      idempotencyKey: "alice-agent-request",
      payload: { content: "Propose the next migration step." },
    });

    const execution = await bridge.processAgentRequest(agentRequest, {
      async execute({ canonicalHistory, runtime }) {
        assert.deepEqual(
          canonicalHistory.slice(-2).map((event) => event.type),
          ["human_chat", "agent_request"],
        );
        assert.equal(runtime.model, "gpt-5.6-sol");
        return {
          events: [{
            kind: "assistant",
            localEventId: "assistant-answer-1",
            harness: "codex",
            captureFidelity: "harness_transcript",
            content: "Use Bearer abcdefghijklmnop only as a redaction fixture.",
          }],
        };
      },
    });

    assert.equal(execution.claimed, true);
    assert.equal(execution.completed.at(-1)?.type, "agent_response");
    assert.equal(execution.completed.at(-1)?.runtime?.model, "gpt-5.6-sol");
    assert.match(JSON.stringify(execution.completed.at(-1)?.payload), /\[REDACTED\]/);

    const history = await api.readEvents("shared-project", 0, 100);
    assert.deepEqual(
      history.events.slice(-3).map((event) => event.type),
      ["human_chat", "agent_request", "agent_response"],
    );
    assert.equal(history.nextSequence, 4);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
