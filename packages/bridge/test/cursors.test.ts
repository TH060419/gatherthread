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
