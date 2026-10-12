import test from "node:test";
import assert from "node:assert/strict";
import { rememberGithubReturn, consumeGithubReturn } from "../src/github-return-context.js";

function storage() {
  const entries = new Map();
  return { entries, setItem: (key, value) => entries.set(key, value), getItem: key => entries.get(key), removeItem: key => entries.delete(key) };
}
const context = { userId: "user-fixture", projectId: "project-fixture", sessionId: "session-fixture" };

test("a new project without a conversation can return to its own setup", () => {
  const saved = storage(); rememberGithubReturn(saved, { ...context, sessionId: null }, 1000);
  assert.deepEqual(consumeGithubReturn(saved, context.userId, 2000), { projectId: context.projectId, sessionId: null });
});

test("GitHub return hints contain only bounded navigation data and are consumed once", () => {
  const saved = storage();
  rememberGithubReturn(saved, { ...context, password: "fixture", token: "fixture" }, 1000);
  assert.deepEqual(JSON.parse([...saved.entries.values()][0]), {
    user_id: context.userId, project_id: context.projectId, session_id: context.sessionId, created_at: 1000,
  });
  assert.deepEqual(consumeGithubReturn(saved, context.userId, 2000), { projectId: context.projectId, sessionId: context.sessionId });
  assert.equal(consumeGithubReturn(saved, context.userId, 2000), null);
});

test("GitHub return hints refuse stale, future, malformed and other-account navigation", () => {
  for (const [actor, now] of [["other-user", 2000], [context.userId, 602000], [context.userId, 999]]) {
    const saved = storage(); rememberGithubReturn(saved, context, 1000);
    assert.equal(consumeGithubReturn(saved, actor, now), null);
    assert.equal(saved.entries.size, 0);
  }
  for (const value of ["https://evil.invalid", "x".repeat(129), ""]) {
    const saved = storage(); rememberGithubReturn(saved, { ...context, projectId: value }, 1000);
    assert.equal(saved.entries.size, 0);
  }
  const unavailable = { getItem() { throw Error("Unavailable"); }, setItem() { throw Error("Unavailable"); }, removeItem() { throw Error("Unavailable"); } };
  assert.doesNotThrow(() => rememberGithubReturn(unavailable, context, 1000));
  assert.equal(consumeGithubReturn(unavailable, context.userId, 2000), null);
});
