import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDshCanonicalPrompt,
  requestedDshProfile,
} from "../src/canonical-prompt.js";
import type { DshCanonicalEvent } from "../src/types.js";

function canonical(
  sequence: number,
  type: DshCanonicalEvent["type"],
  payload: unknown,
): DshCanonicalEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    type,
    actorId: "user-1",
    actorDisplayName: "User",
    timestamp: "2026-09-05T00:00:00.000Z",
    payload,
  };
}

test("only explicit DeepSeek Harness requests are eligible", () => {
  assert.equal(requestedDshProfile(canonical(1, "agent_request", { content: "default" })), undefined);
  assert.equal(requestedDshProfile(canonical(1, "agent_request", {
    content: "Codex request",
    execution_profile: { harness: "codex", model: "gpt-5.6-terra" },
  })), undefined);
  assert.deepEqual(requestedDshProfile(canonical(1, "agent_request", {
    content: "DSH request",
    execution_profile: {
      harness: " DeepSeek-Harness ",
      provider: " Local Provider ",
      model: " Custom/Model-X ",
      runtime_id: " dsh-runtime-1 ",
    },
  })), {
    harness: "deepseek-harness",
    provider: "Local Provider",
    model: "Custom/Model-X",
    runtimeId: "dsh-runtime-1",
  });
  assert.throws(() => requestedDshProfile(canonical(1, "agent_request", {
    content: "DSH request",
    execution_profile: { harness: "deepseek-harness", model: "Custom/Model-X", runtime_id: "bad runtime" },
  })), /invalid DeepSeek Harness runtime target/);
  assert.throws(() => requestedDshProfile(canonical(1, "agent_request", {
    content: "DSH request",
    execution_profile: { harness: "deepseek-harness", provider: "bad\nprovider", model: "Custom/Model-X" },
  })), /invalid execution profile/);
});

test("canonical prompt is one bounded allowlisted delta with no provenance or hidden fields", () => {
  const history = [
    canonical(1, "human_chat", {
      content: "shared constraint",
      reasoning: "PRIVATE_PAYLOAD_REASONING",
      token: "PRIVATE_PAYLOAD_TOKEN",
    }),
    canonical(2, "tool_result", { meta: "PRIVATE_TOOL_METADATA" }),
    canonical(3, "agent_response", {
      text: "earlier answer",
      rawThinking: "PRIVATE_RAW_THINKING",
    }),
  ];
  const request = canonical(4, "agent_request", {
    content: "perform work password=hunter2",
    execution_profile: { harness: "deepseek-harness", model: "deepseek-v4-flash" },
    system_prompt: "PRIVATE_SYSTEM_PROMPT",
  });
  const prompt = buildDshCanonicalPrompt([...history, request], request);
  assert.match(prompt, /shared constraint/);
  assert.match(prompt, /earlier answer/);
  assert.match(prompt, /perform work password=\[REDACTED\]/);
  assert.doesNotMatch(prompt, /PRIVATE_|runtime|provenance|rawThinking|system_prompt/);
  assert.equal((prompt.match(/Current GatherThread Agent request:/g) ?? []).length, 1);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 128 * 1_024);
});

test("prompt excludes this DSH runtime's native outputs but keeps other public runtime updates", () => {
  const ownRuntime = {
    userId: "user-1",
    deviceId: "device-1",
    runtimeId: "runtime-own",
    harness: "codex" as const,
    provider: "test",
    model: "test",
    localSessionId: "local-own",
    captureFidelity: "harness_transcript" as const,
  };
  const otherRuntime = { ...ownRuntime, runtimeId: "runtime-other", localSessionId: "local-other" };
  const ownResponse = { ...canonical(2, "agent_response", { text: "OWN_RESPONSE_ALREADY_NATIVE" }), runtime: ownRuntime };
  const ownTool = { ...canonical(3, "tool_result", { tool_call_id: "own", result: "OWN_TOOL_ALREADY_NATIVE" }), runtime: ownRuntime };
  const otherProgress = { ...canonical(4, "agent_progress", { content: "OTHER_RUNTIME_PROGRESS" }), runtime: otherRuntime };
  const otherTool = { ...canonical(5, "tool_result", { tool_call_id: "other", result: "OTHER_RUNTIME_TOOL" }), runtime: otherRuntime };
  const next = canonical(6, "agent_request", { content: "next request" });
  const prompt = buildDshCanonicalPrompt(
    [ownResponse, ownTool, otherProgress, otherTool, next],
    next,
    "runtime-own",
  );
  assert.doesNotMatch(prompt, /OWN_RESPONSE_ALREADY_NATIVE|OWN_TOOL_ALREADY_NATIVE/);
  assert.match(prompt, /OTHER_RUNTIME_PROGRESS/);
  assert.match(prompt, /OTHER_RUNTIME_TOOL/);
});
