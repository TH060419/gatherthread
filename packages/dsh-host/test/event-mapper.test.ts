import assert from "node:assert/strict";
import test from "node:test";
import {
  finalVisibleAssistant,
  mapDshSessionEvent,
  mapDshSessionEvents,
} from "../src/event-mapper.js";

const time = Date.parse("2026-09-05T00:00:00.000Z");

test("assistant mapping allowlists visible text and cannot upload reasoning or replay internals", () => {
  const mapped = mapDshSessionEvent({
    type: "assistant/message",
    seq: 12,
    time,
    data: {
      turn: 1,
      step: 1,
      stream: [{ chunk: { type: "reasoning-delta", text: "PRIVATE_STREAM_MARKER" } }],
      usage: { hidden: "PRIVATE_USAGE_MARKER" },
      message: {
        source: { replayState: { hidden: "PRIVATE_REPLAY_MARKER" } },
        content: [
          { type: "reasoning", text: "PRIVATE_REASONING_MARKER" },
          { type: "text", text: "Public answer" },
          { type: "image", attachment: { path: "/private/file" } },
        ],
      },
    },
  });

  assert.deepEqual(mapped, {
    kind: "assistant",
    localEventId: "dsh-assistant-12",
    sequence: 12,
    timestamp: "2026-09-05T00:00:00.000Z",
    content: "Public answer",
  });
  assert.doesNotMatch(JSON.stringify(mapped), /PRIVATE_|replayState|reasoning|stream|usage/);
});

test("tool mapping redacts, bounds, and ignores private metadata", () => {
  const call = mapDshSessionEvent({
    type: "tool/call",
    seq: 13,
    time,
    data: {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "shell",
      arguments: JSON.stringify({
        cmd: "do work",
        api_key: "top-secret",
        output: "x".repeat(5_000),
      }),
      reasoning: "PRIVATE_TOOL_REASONING",
    },
  }, { maxToolBytes: 1_024 });
  assert.equal(call?.kind, "tool_call");
  assert.match(JSON.stringify(call), /\[REDACTED\]/);
  assert.match(JSON.stringify(call), /TRUNCATED/);
  assert.ok(Buffer.byteLength(JSON.stringify(call), "utf8") < 2_000);
  assert.doesNotMatch(JSON.stringify(call), /top-secret|PRIVATE_TOOL_REASONING/);

  const result = mapDshSessionEvent({
    type: "tool/result",
    seq: 14,
    time,
    data: {
      message: {
        source: { kind: "tool", callId: "PRIVATE_SOURCE_CALL_ID" },
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          isError: true,
          content: [
            { type: "reasoning", text: "PRIVATE_RESULT_REASONING" },
            { type: "text", text: "password=hunter2 visible failure" },
          ],
        }],
      },
      error: { name: "PrivateErrorName", code: "E_SAFE", stack: "PRIVATE_STACK" },
      meta: { raw: "PRIVATE_META" },
    },
  });
  assert.deepEqual(result, {
    kind: "tool_result",
    localEventId: "dsh-tool-result-14",
    sequence: 14,
    timestamp: "2026-09-05T00:00:00.000Z",
    toolCallId: "call-1",
    result: "password=[REDACTED] visible failure",
    isError: true,
    errorCode: "E_SAFE",
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|hunter2|PrivateErrorName/);
});

test("unknown and private DSH events are excluded, while duplicate durable IDs are suppressed", () => {
  const events = mapDshSessionEvents([
    { type: "request/header", seq: 1, time, data: { token: "PRIVATE_HEADER" } },
    { type: "assistant/attempt", seq: 2, time, data: { stream: "PRIVATE_ATTEMPT" } },
    { type: "assistant/message", seq: 3, time, data: { message: { content: [{ type: "text", text: "done" }] } } },
    { type: "assistant/message", seq: 3, time, data: { message: { content: [{ type: "text", text: "duplicate" }] } } },
  ]);
  assert.equal(events.length, 1);
  assert.equal(finalVisibleAssistant(events)?.content, "done");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|duplicate/);
});
