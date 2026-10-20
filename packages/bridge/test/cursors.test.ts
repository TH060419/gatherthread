import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileCursorStore } from "../src/index.js";

test("file cursor store persists atomically in a private file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gatherthread-cursor-"));
  const cursorPath = path.join(root, "state", "cursor.json");
  const store = new FileCursorStore(cursorPath);
  await store.save({
    server: { "session-1": 42 },
    local: { transcript: { path: "/authorized/transcript.jsonl", offset: 100 } },
  });
  assert.deepEqual(await new FileCursorStore(cursorPath).load(), {
    server: { "session-1": 42 },
    local: { transcript: { path: "/authorized/transcript.jsonl", offset: 100 } },
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(cursorPath)).mode & 0o777, 0o600);
  }
});

test("native stop receipts persist only exact metadata and reject malformed attempts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gt-stop-receipt-"));
  const store = new FileCursorStore(path.join(root, "cursor.json"));
  const state = { server: {}, local: {}, stoppedExecutions: [{ sessionId: "session-1", requestId: "request-1", runtimeId: "runtime-1", claimAttempt: 3 }] };
  await store.save(state); assert.deepEqual(await store.load(), state);
  await store.save({ ...state, stoppedExecutions: [{ ...state.stoppedExecutions[0]!, claimAttempt: 0 }] });
  await assert.rejects(store.load(), /stop receipts/);
});
