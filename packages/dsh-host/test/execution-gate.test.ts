import assert from "node:assert/strict";
import test from "node:test";
import { BoundedDshExecutionGate } from "../src/execution-gate.js";

test("a pending per-connector permit aborts immediately without consuming capacity", async () => {
  const gate = new BoundedDshExecutionGate(1);
  let releaseFirst: (() => void) | undefined;
  const first = gate.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
  await waitFor(() => gate.activeCount === 1);
  let secondRan = false;
  const abort = new AbortController();
  const second = gate.run(async () => { secondRan = true; }, abort.signal);
  assert.equal(gate.pendingCount, 1);
  abort.abort(new Error("connector permission revoked"));
  await assert.rejects(bounded(second, 100), /permission revoked/);
  assert.equal(gate.pendingCount, 0);
  assert.equal(gate.activeCount, 1);
  assert.equal(secondRan, false);
  releaseFirst?.();
  await first;
  assert.equal(gate.activeCount, 0);

  let thirdRan = false;
  await gate.run(async () => { thirdRan = true; });
  assert.equal(thirdRan, true, "an aborted waiter must not consume the next slot");
  gate.close();
});

test("closing a gate rejects every waiter exactly once", async () => {
  const gate = new BoundedDshExecutionGate(1);
  let release: (() => void) | undefined;
  const active = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await waitFor(() => gate.activeCount === 1);
  const abort = new AbortController();
  let rejections = 0;
  const pending = gate.run(async () => undefined, abort.signal).catch((error: unknown) => {
    rejections += 1;
    throw error;
  });
  gate.close(new Error("owner unloaded"));
  abort.abort(new Error("late abort"));
  await assert.rejects(pending, /owner unloaded/);
  assert.equal(rejections, 1);
  assert.equal(gate.pendingCount, 0);
  release?.();
  await active;
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for gate state");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function bounded<T>(value: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("gate operation exceeded its time bound")), milliseconds).unref?.();
    }),
  ]);
}
