import assert from "node:assert/strict";
import test from "node:test";
import { parseZcodeStreamLine, ZcodeStreamAdapter } from "../src/index.js";

test("ZCode stream import keeps visible text, tool calls, and tool results only", () => {
  const adapter = new ZcodeStreamAdapter();
  const events = [
    { type: "system", subtype: "init", session_id: "sess_1", model: "GLM-5.3-Flash" },
    {
      type: "assistant",
      uuid: "a1",
      session_id: "sess_1",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "working on it" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ] },
    },
    {
      type: "user",
      uuid: "u1",
      session_id: "sess_1",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "contents", is_error: false },
      ] },
    },
    {
      type: "assistant",
      uuid: "a2",
      session_id: "sess_1",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
    { type: "result", subtype: "success", session_id: "sess_1", result: "done" },
  ].map((record) => JSON.stringify(record)).flatMap((line) => adapter.parseLine(line));

  assert.deepEqual(events.map((item) => item.kind), [
    "assistant", "tool_call", "tool_result", "assistant",
  ]);
  assert.equal(events[0]?.content, "working on it");
  assert.deepEqual(events[1]?.arguments, { file_path: "a.ts" });
  assert.equal(events[1]?.toolName, "Read");
  assert.equal(events[2]?.toolCallId, "t1");
  assert.equal(events[2]?.result, "contents");
  assert.ok(events.every((item) => item.harness === "zcode"));
  assert.ok(events.every((item) => item.captureFidelity === "harness_transcript"));
});

test("ZCode stream metadata extraction reports session, model, and final result", () => {
  const init = parseZcodeStreamLine(JSON.stringify({
    type: "system", subtype: "init", session_id: "sess_abc", model: "GLM-5.3-Flash",
  }));
  assert.equal(init.sessionId, "sess_abc");
  assert.equal(init.model, "GLM-5.3-Flash");
  assert.deepEqual(init.events, []);

  const failure = parseZcodeStreamLine(JSON.stringify({
    type: "result", subtype: "error_during_execution", session_id: "sess_abc", result: "",
  }));
  assert.equal(failure.isError, true);
  assert.equal(failure.sessionId, "sess_abc");

  const success = parseZcodeStreamLine(JSON.stringify({
    type: "result", subtype: "success", session_id: "sess_abc", result: "final answer",
  }));
  assert.equal(success.isError, false);
  assert.equal(success.finalResultText, "final answer");
});

test("ZCode stream parser skips unknown record and block shapes instead of guessing", () => {
  const adapter = new ZcodeStreamAdapter();
  const events = [
    JSON.stringify({ type: "some_future_record", session_id: "sess_1", payload: { text: "leak" } }),
    JSON.stringify({
      type: "assistant",
      session_id: "sess_1",
      message: { role: "assistant", content: [
        { type: "unknown_block", text: "leak" },
        { type: "text", text: "visible" },
      ] },
    }),
    "not json at all",
    "",
  ].flatMap((line) => {
    try {
      return adapter.parseLine(line);
    } catch {
      // The connector's stream pump treats malformed lines as failures;
      // the adapter itself only skips non-object records.
      return [];
    }
  });
  assert.deepEqual(events.map((item) => item.kind), ["assistant"]);
  assert.equal(events[0]?.content, "visible");
});

test("ZCode stream parser derives a stable local id when the harness omits one", () => {
  const first = parseZcodeStreamLine(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  }));
  const second = parseZcodeStreamLine(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  }));
  assert.ok(first.events[0]?.localEventId.startsWith("zcode-"));
  assert.equal(first.events[0]?.localEventId, second.events[0]?.localEventId);
});
