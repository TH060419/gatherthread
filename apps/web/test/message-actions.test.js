import assert from "node:assert/strict";
import test from "node:test";
import { mentionQuery, insertMention, reconcileMentions, messageExcerpt, agentWorkStatus } from "../src/message-actions.js";

test("busy and thinking belong only to a started, unfinished exact runtime request", () => {
  const request = { id: "r", type: "agent_request" };
  const started = { type: "agent_progress", replyTo: "r", provenance: { runtimeId: "native" }, payload: { status: "started" } };
  assert.equal(agentWorkStatus([request], "native"), null);
  assert.equal(agentWorkStatus([request, started], "native"), "Agent busy");
  assert.equal(agentWorkStatus([request, { ...started, payload: { status: "thinking" } }], "native"), "Agent thinking");
  assert.equal(agentWorkStatus([request, started], "other"), null);
  assert.equal(agentWorkStatus([request, started, { type: "agent_response", replyTo: "r" }], "native"), null);
});

test("mention picking supports names with spaces and preserves offsets through edits", () => {
  assert.deepEqual(mentionQuery("Hi @Ma", 6), { start: 3, end: 6, query: "Ma" });
  assert.equal(mentionQuery("mail@example.org", 8), null);
  const result = insertMention("Hi @Ma", { start: 3, end: 6 }, { userId: "maya", username: "Maya Chen" });
  assert.equal(result.text, "Hi @Maya Chen ");
  assert.deepEqual(result.mention, { user_id: "maya", start: 3, end: 13 });
  assert.deepEqual(reconcileMentions(result.text, `Oh ${result.text}`, [result.mention]), [{ user_id: "maya", start: 6, end: 16 }]);
  assert.deepEqual(reconcileMentions(result.text, "Hi @Maya Ch", [result.mention]), []);
});

test("copy and quote previews contain only message text, never identity or time", () => {
  assert.equal(messageExcerpt({ payload: { content: "message" }, actor: { username: "sender" }, createdAt: "date" }), "message");
  assert.equal(messageExcerpt({ payload: { text: "a".repeat(300) } }).length, 181);
});
