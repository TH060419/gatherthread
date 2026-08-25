import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import {
  CodexCliExecutor,
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
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-production-stack-"));
  const running = await startCollaborationServer({ databasePath: join(directory, "stack.sqlite") }, 0);
  try {
    const identity = running.database.bootstrapIdentity({
      user_id: "alice",
      display_name: "Alice",
      device_id: "alice-laptop",
      device_name: "Alice laptop",
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

test("production server hydrates shared history into the built-in Codex executor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-codex-stack-"));
  const capturePath = join(directory, "prompt.txt");
  const fakeCodexPath = join(directory, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, `
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.FAKE_CODEX_CAPTURE, prompt);
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-integration" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { id: "answer-integration", type: "agent_message", text: "The shared constraint was received." },
}) + "\\n");
`);
  const running = await startCollaborationServer({ databasePath: join(directory, "stack.sqlite") }, 0);
  try {
    const identity = running.database.bootstrapIdentity({
      user_id: "alice",
      display_name: "Alice",
      device_id: "alice-laptop",
      device_name: "Alice laptop",
    });
    await request(running.origin, "/v1/sessions", {
      method: "POST",
      token: identity.token,
      body: {
        session_id: "codex-shared-project",
        idempotency_key: "create-codex-project",
        mode: "multi",
        title: "Codex shared project",
      },
    });
    const api = new HttpCollaborationClient({
      baseUrl: `${running.origin}/v1`,
      bearerToken: identity.token,
    });
    const bridge = new LocalBridge({
      api,
      cursorStore: new MemoryCursorStore(),
      runtime: {
        sessionId: "codex-shared-project",
        deviceId: "alice-laptop",
        harness: "codex",
        provider: "openai",
        model: "gpt-test",
        localSessionId: "codex-integration",
        captureFidelity: "harness_transcript",
      },
      transcriptRoots: {},
    });
    await bridge.connect();
    await api.appendEvent("codex-shared-project", {
      type: "human_chat",
      idempotencyKey: "shared-context",
      payload: { content: "Preserve the database migration ordering." },
    });
    const agentRequest = await api.appendEvent("codex-shared-project", {
      type: "agent_request",
      idempotencyKey: "local-request",
      payload: { content: "State the constraint you received." },
    });
    const executor = new CodexCliExecutor({
      workspacePath: directory,
      statePath: join(directory, "codex-state.json"),
      model: "gpt-test",
      command: process.execPath,
      commandArgs: [fakeCodexPath],
      env: { ...process.env, FAKE_CODEX_CAPTURE: capturePath, GATHERTHREAD_TOKEN: identity.token },
      shareToolEvents: false,
    });

    const result = await bridge.processAgentRequest(agentRequest, executor);
    assert.equal(result.claimed, true);
    assert.equal(result.completed.at(-1)?.runtime?.model, "gpt-test");
    assert.equal(result.completed.at(-1)?.payload?.text, "The shared constraint was received.");
    const prompt = readFileSync(capturePath, "utf8");
    assert.match(prompt, /Preserve the database migration ordering/);
    assert.match(prompt, /BEGIN_AUTHORIZED_LOCAL_REQUEST/);
    assert.match(prompt, /State the constraint you received/);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
