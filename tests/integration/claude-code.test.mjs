import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import { ClaudeCodeCliExecutor, HttpCollaborationClient, LocalBridge, MemoryCursorStore } from "../../packages/bridge/dist/src/index.js";

test("real HTTP dispatches an exact Claude request through the streamed CLI into canonical history", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "gt-claude-http-")));
  const running = await startCollaborationServer({ databasePath: join(directory, "stack.sqlite") }, 0);
  const sessionId = "claude-http-session", model = "claude-sonnet-fixture";
  let executor;
  try {
    const identity = running.database.bootstrapIdentity({ user_id: "claude-user", display_name: "Synthetic user",
      device_id: "claude-device", device_name: "Synthetic device" });
    const created = await fetch(`${running.origin}/v1/sessions`, { method: "POST", headers: {
      authorization: `Bearer ${identity.token}`, "content-type": "application/json",
    }, body: JSON.stringify({ session_id: sessionId, idempotency_key: "claude-create-session", mode: "multi", title: "Synthetic Claude integration" }) });
    assert.equal(created.status, 201);
    const api = new HttpCollaborationClient({ baseUrl: `${running.origin}/v1`, bearerToken: identity.token });
    const bridge = new LocalBridge({ api, cursorStore: new MemoryCursorStore(), runtime: {
      sessionId, deviceId: "claude-device", harness: "claude-code", provider: "anthropic", model,
      localSessionId: "claude-http-binding", captureFidelity: "harness_transcript", contextDeletionVersion: 1,
    }, transcriptRoots: {} });
    await bridge.connect();
    await api.appendEvent(sessionId, { type: "human_chat", idempotencyKey: "claude-http-context",
      payload: { content: "Preserve the reviewed migration ordering." } });
    const request = await api.appendEvent(sessionId, { type: "agent_request", idempotencyKey: "claude-http-request",
      payload: { content: "State the constraint.", execution_profile: {
        harness: "claude-code", provider: "anthropic", model, runtime_id: bridge.runtime.id,
      } } });
    const capture = join(directory, "capture.json");
    executor = new ClaudeCodeCliExecutor({ workspacePath: directory, statePath: join(directory, "state.json"), model,
      command: process.execPath, commandArgs: [fileURLToPath(new URL("./fixtures/claude-cli.mjs", import.meta.url))],
      env: { ...process.env, FAKE_CLAUDE_CAPTURE: capture, GATHERTHREAD_TOKEN: identity.token } });
    const result = await bridge.processAgentRequest(request, executor);
    assert.equal(result.claimed, true);
    assert.equal(result.completed.at(-1)?.payload?.text, "The reviewed migration ordering is preserved.");
    assert.equal(result.completed.at(-1)?.runtime?.harness, "claude-code");
    assert.equal(result.completed.at(-1)?.runtime?.model, model);
    const recorded = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(recorded.hasGatherThreadCredential, false);
    assert.match(recorded.prompt, /Preserve the reviewed migration ordering/);
    const history = (await api.readEvents(sessionId, 0, 100)).events;
    assert.ok(history.some(event => event.type === "agent_progress" && event.payload?.stream_kind === "answer"));
    assert.ok(history.some(event => event.type === "agent_progress" && event.payload?.stream_kind === "plan"));
    assert.equal(history.filter(event => event.type === "agent_response").length, 1);
    assert.doesNotMatch(JSON.stringify(history), new RegExp(recorded.nativeSessionId, "u"));
    assert.doesNotMatch(JSON.stringify(history), /HIDDEN_NATIVE_THINKING/u);
  } finally {
    await executor?.close();
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});
