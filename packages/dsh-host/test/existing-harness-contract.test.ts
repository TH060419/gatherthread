import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeCodeProjectAdapter,
  CodexRolloutAdapter,
} from "@gatherthread/adapters";

test("the opt-in DSH package preserves the existing Codex transcript contract", () => {
  const adapter = new CodexRolloutAdapter();
  const records = [
    { type: "response_item", payload: { type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "hello" }] } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "private" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: "hidden" } },
    { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: "{\"cmd\":\"pwd\"}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } },
  ];

  const events = records.flatMap((record) => adapter.parseLine(JSON.stringify(record)));
  assert.deepEqual(events, [
    {
      kind: "user",
      localEventId: "u1",
      content: "hello",
      harness: "codex",
      captureFidelity: "harness_transcript",
    },
    {
      kind: "tool_call",
      localEventId: "codex-ee48ba77",
      toolName: "shell",
      toolCallId: "c1",
      arguments: { cmd: "pwd" },
      harness: "codex",
      captureFidelity: "harness_transcript",
    },
    {
      kind: "tool_result",
      localEventId: "codex-535ec3e8",
      toolCallId: "c1",
      result: "ok",
      harness: "codex",
      captureFidelity: "harness_transcript",
    },
  ]);
});

test("the opt-in DSH package preserves the existing Claude Code transcript contract", () => {
  const adapter = new ClaudeCodeProjectAdapter();
  const assistant = adapter.parseLine(JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "working" },
        { type: "tool_use", id: "t1", name: "Read", input: { file: "a" } },
      ],
    },
  }));
  const result = adapter.parseLine(JSON.stringify({
    type: "user",
    uuid: "u1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "contents" }],
    },
  }));

  assert.deepEqual([...assistant, ...result], [
    {
      kind: "assistant",
      localEventId: "a1:text",
      content: "working",
      harness: "claude-code",
      captureFidelity: "harness_transcript",
    },
    {
      kind: "tool_call",
      localEventId: "a1:2",
      toolName: "Read",
      toolCallId: "t1",
      arguments: { file: "a" },
      harness: "claude-code",
      captureFidelity: "harness_transcript",
    },
    {
      kind: "tool_result",
      localEventId: "u1:0",
      toolCallId: "t1",
      result: "contents",
      isError: false,
      harness: "claude-code",
      captureFidelity: "harness_transcript",
    },
  ]);
});
