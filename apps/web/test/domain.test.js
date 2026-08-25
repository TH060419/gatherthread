import test from "node:test";
import assert from "node:assert/strict";

import { canAppend, normalizeReplayPage, runtimeLabel } from "../src/domain.js";

const currentUser = { id: "u1", username: "User One" };
const onlineRuntime = { status: "online", harness: "Codex", provider: "OpenAI", model: "gpt-5" };

function session({ mode = "multi", role = "participant", runtime = onlineRuntime } = {}) {
  return { mode, members: [{ userId: "u1", role, runtime }] };
}

test("permissions distinguish chat from runtime-backed agent requests", () => {
  assert.equal(
    canAppend({ session: session({ runtime: null }), currentUser, connectionPhase: "live", kind: "human_chat" }).allowed,
    true,
  );
  const agent = canAppend({
    session: session({ runtime: null }),
    currentUser,
    connectionPhase: "live",
    kind: "agent_request",
  });
  assert.equal(agent.allowed, false);
  assert.match(agent.reason, /runtime/i);
});

test("viewer and incomplete-history states are read only", () => {
  const viewer = canAppend({
    session: session({ role: "viewer" }),
    currentUser,
    connectionPhase: "live",
    kind: "human_chat",
  });
  assert.equal(viewer.allowed, false);
  assert.match(viewer.reason, /read only/i);

  const recovering = canAppend({
    session: session(),
    currentUser,
    connectionPhase: "recovering",
    kind: "human_chat",
  });
  assert.equal(recovering.allowed, false);
  assert.match(recovering.reason, /synced/i);
});

test("replay pages normalize wire keys and sort by sequence", () => {
  const page = normalizeReplayPage({
    events: [{ sequence: 3 }, { sequence: 2 }],
    head_sequence: 4,
    next_after_sequence: 3,
    has_more: true,
  });
  assert.deepEqual(page.events.map((event) => event.sequence), [2, 3]);
  assert.equal(page.headSequence, 4);
  assert.equal(page.nextAfterSequence, 3);
  assert.equal(page.hasMore, true);
});

test("runtime labels preserve harness, provider, and model", () => {
  assert.equal(runtimeLabel(onlineRuntime), "Codex · OpenAI · gpt-5");
});
