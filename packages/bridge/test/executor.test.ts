import assert from "node:assert/strict";
import test from "node:test";
import { SubprocessHarnessExecutor } from "../src/index.js";

test("subprocess adapter receives hydrated input while GatherThread credentials are removed", async () => {
  const script = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    localSessionId: "adapter-local",
    events: [{
      kind: "assistant",
      localEventId: "answer-1",
      harness: parsed.runtime.harness,
      captureFidelity: "harness_transcript",
      content: [
        process.env.GATHERTHREAD_TOKEN,
        process.env.GATHERTHREAD_BEARER_TOKEN,
        process.env.GATHERTHREAD_AUTHORIZATION_TOKEN,
        process.env.GATHERTHREAD_AUTH_TOKEN_PEPPER,
        process.env.RELAYROOM_TOKEN,
        process.env.RELAYROOM_BEARER_TOKEN,
        process.env.RELAYROOM_AUTHORIZATION_TOKEN,
        process.env.ACP_AUTH_TOKEN_PEPPER
      ].every(value => value === undefined) ? "credentials-removed" : "credential-leaked"
    }]
  }));
});`;
  const executor = new SubprocessHarnessExecutor({
    command: process.execPath,
    args: ["-e", script],
    harness: "codex",
    env: {
      ...process.env,
      GATHERTHREAD_TOKEN: "secret-token",
      GATHERTHREAD_BEARER_TOKEN: "secret-bearer",
      GATHERTHREAD_AUTHORIZATION_TOKEN: "secret-authorization",
      GATHERTHREAD_AUTH_TOKEN_PEPPER: "secret-pepper",
      RELAYROOM_TOKEN: "legacy-secret-token",
      RELAYROOM_BEARER_TOKEN: "legacy-secret-bearer",
      RELAYROOM_AUTHORIZATION_TOKEN: "legacy-secret-authorization",
      ACP_AUTH_TOKEN_PEPPER: "legacy-secret-pepper"
    },
  });
  const result = await executor.execute({
    request: canonicalRequest(),
    canonicalHistory: [canonicalRequest()],
    runtime: {
      id: "runtime-1",
      userId: "user-1",
      sessionId: "session-1",
      deviceId: "device-1",
      harness: "codex",
      provider: "openai",
      model: "gpt-5",
      localSessionId: "local-1",
      captureFidelity: "harness_transcript",
    },
  });
  assert.equal(result.localSessionId, "adapter-local");
  assert.equal(result.events[0]?.content, "credentials-removed");
});

test("subprocess adapter rejects forged provenance", async () => {
  const executor = new SubprocessHarnessExecutor({
    command: process.execPath,
    args: ["-e", `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({events:[{kind:"assistant",localEventId:"a",harness:"claude-code",captureFidelity:"harness_transcript",content:"x"}]})))`],
    harness: "codex",
  });
  await assert.rejects(executor.execute({
    request: canonicalRequest(),
    canonicalHistory: [],
    runtime: {
      id: "runtime-1",
      userId: "user-1",
      sessionId: "session-1",
      deviceId: "device-1",
      harness: "codex",
      provider: "openai",
      model: "gpt-5",
      localSessionId: "local-1",
      captureFidelity: "harness_transcript",
    },
  }), /invalid provenance/);
});

function canonicalRequest() {
  return {
    id: "request-1",
    sessionId: "session-1",
    sequence: 1,
    type: "agent_request" as const,
    actorId: "user-1",
    timestamp: "2026-08-25T00:00:00.000Z",
    payload: { text: "answer" },
  };
}
