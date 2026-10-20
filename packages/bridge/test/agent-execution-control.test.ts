import assert from "node:assert/strict";
import test from "node:test";
import { CollaborationHttpError, createAgentExecutionWatch } from "../src/index.js";

test("native authority transport uncertainty and rate limiting never impersonate cancellation", async () => {
  const controller = new AbortController();
  let state: { active: boolean } | Error = { active: true };
  const watch = createAgentExecutionWatch({ controller, required: true, read: async () => {
    if (state instanceof Error) throw state; return state;
  } });
  try {
    await watch.check(); watch.assertReady();
    for (const transient of [new TypeError("fictional offline"), new CollaborationHttpError(503, "unavailable"), new CollaborationHttpError(429, "slow down")]) {
      state = transient; await watch.check(); assert.equal(controller.signal.aborted, false);
    }
    state = { active: false }; await watch.check();
    assert.equal(controller.signal.aborted, true);
    assert.equal((controller.signal.reason as CollaborationHttpError).code, "agent_execution_cancelled");
  } finally { await watch.close(); }
});

test("older ordinary servers may lack the read surface; native Teams must fail closed", async () => {
  for (const team of [false, true]) {
    const controller = new AbortController();
    const watch = createAgentExecutionWatch({ controller, required: team,
      read: async () => { throw new CollaborationHttpError(404, "unsupported"); } });
    try {
      await watch.check(); assert.equal(controller.signal.aborted, team);
      if (!team) { watch.assertReady(); assert.equal(watch.supported(), false); }
    } finally { await watch.close(); }
  }
});

test("a disappeared execution resource retains observed control support and cancels its native owner", async () => {
  for (const required of [false, true]) {
    const controller = new AbortController();
    let removed = false;
    const watch = createAgentExecutionWatch({ controller, required, read: async () => {
      if (removed) throw new CollaborationHttpError(404, "session removed");
      return { active: true };
    } });
    try {
      await watch.check(); watch.assertReady();
      removed = true; await watch.check();
      assert.equal(controller.signal.aborted, true, "resource removal must stop the native owner");
      assert.equal(watch.supported(), true, "a lost resource cannot erase previously observed ACK support");
    } finally { await watch.close(); }
  }
});
