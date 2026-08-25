import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, MockCollaborationApi } from "../src/api.js";

test("mock authentication derives the user from a token", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  await assert.rejects(() => api.authenticate("wrong"), (error) => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal((await api.authenticate("demo-token")).username, "Avery Chen");
});

test("append is idempotent and chat never fabricates an agent response", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const before = await api.replayEvents("session-orbit", { afterSequence: 0 });
  const input = { content: "One durable message", idempotencyKey: "same-key" };
  const first = await api.appendHumanChat("session-orbit", input);
  const repeated = await api.appendHumanChat("session-orbit", input);
  const after = await api.replayEvents("session-orbit", { afterSequence: 0 });

  assert.equal(first.id, repeated.id);
  assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.events.at(-1).type, "human_chat");
});

test("solo viewers cannot append", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  await assert.rejects(
    () => api.appendHumanChat("session-notes", { content: "should fail", idempotencyKey: "forbidden" }),
    (error) => error.status === 403 && error.code === "forbidden",
  );
});

test("created sessions retain explicit solo or multi mode", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const created = await api.createSession({ name: "New multi", mode: "multi" });
  const detail = await api.getSession(created.id);
  assert.equal(detail.mode, "multi");
  assert.equal(detail.members[0].role, "owner");
});
