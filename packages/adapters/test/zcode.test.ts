import assert from "node:assert/strict";
import test from "node:test";
import { parseZcodeProtocolEvent, ZcodeStreamAdapter } from "../src/index.js";

test("ZCode protocol parsing keeps reviewed text and tool blocks only", () => {
  const events = [
    { type: "turn.started", turnNumber: 1, input: "do the thing" },
    {
      type: "message.upserted",
      messageId: "msg-1",
      content: "working on it",
      toolCalls: [
        {
          toolCallId: "t1",
          toolName: "Read",
          arguments: { file_path: "a.ts" },
          result: "contents",
          isError: false,
        },
        { toolCallId: "t2", toolName: "Edit", arguments: { file_path: "b.ts" } },
      ],
      // Unknown fields stay local by construction.
      privateProviderTraffic: { secret: "value" },
    },
    { type: "message.upserted", messageId: "msg-2", content: "done" },
    { type: "turn.completed", response: "done", tokenCount: 5, toolCallCount: 2 },
  ].map((payload) => parseZcodeProtocolEvent({
    deliveryKind: "desktop-continuous",
    eventId: "e",
    type: payload.type,
    payload,
  })).flatMap((record) => record.events);

  assert.deepEqual(events.map((item) => item.kind), [
    "assistant", "tool_call", "tool_result", "tool_call", "assistant",
  ]);
  assert.equal(events[0]?.content, "working on it");
  assert.deepEqual(events[1]?.arguments, { file_path: "a.ts" });
  assert.equal(events[1]?.toolName, "Read");
  assert.equal(events[2]?.toolCallId, "t1");
  assert.equal(events[2]?.result, "contents");
  assert.equal(events.at(-1)?.content, "done");
  assert.ok(events.every((item) => item.harness === "zcode"));
  assert.ok(events.every((item) => item.captureFidelity === "harness_transcript"));
});

test("ZCode protocol parsing reports turn completion and failure without sharing content", () => {
  const completed = parseZcodeProtocolEvent({
    type: "turn.completed",
    payload: { response: "final answer", tokenCount: 3 },
  });
  assert.equal(completed.eventType, "turn.completed");
  assert.equal(completed.finalResponse, "final answer");
  assert.deepEqual(completed.events, []);

  const failed = parseZcodeProtocolEvent({
    type: "turn.failed",
    turnId: "turn_1",
    payload: {
      error: { type: "unknown_error", code: "CONFIGURATION_ERROR", message: "Select a model before continuing" },
    },
  });
  assert.equal(failed.eventType, "turn.failed");
  assert.equal(failed.errorCode, "CONFIGURATION_ERROR");
  assert.equal(failed.errorMessage, "Select a model before continuing");
  assert.deepEqual(failed.events, []);
});

test("ZCode protocol parsing skips unknown event types and malformed deliveries", () => {
  assert.deepEqual(parseZcodeProtocolEvent({ type: "model.streaming", payload: { chunk: "x" } }).events, []);
  assert.deepEqual(parseZcodeProtocolEvent({ payload: { noType: true } }).events, []);
  assert.deepEqual(parseZcodeProtocolEvent("not-an-object").events, []);
  assert.deepEqual(parseZcodeProtocolEvent(null).events, []);
});

test("ZCode adapter exposes the zcode harness for registry consumers", () => {
  const adapter = new ZcodeStreamAdapter();
  assert.equal(adapter.harness, "zcode");
  const events = adapter.parseLine(JSON.stringify({
    type: "message.upserted",
    payload: { messageId: "m1", content: "hello" },
  }));
  assert.deepEqual(events.map((event) => event.kind), ["assistant"]);
  assert.deepEqual(adapter.parseLine("not json"), []);
});
