import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
const apiPath = fileURLToPath(new URL("../src/api.js", import.meta.url));

test("snapshot connector runtimes never enable execution controls", async () => {
  const [main, api] = await Promise.all([readFile(mainPath, "utf8"), readFile(apiPath, "utf8")]);
  assert.match(api, /purpose: member\.runtime\.purpose \?\? null/);
  assert.match(main, /isExecutionRuntime\(member\.runtime\)/);
  assert.match(main, /snapshot_connector/);
});

test("snapshot jobs are kept in memory and only active jobs are polled", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /snapshotRequests: \[\]/);
  assert.match(main, /new Set\(\["queued", "claimed", "importing", "compacting"\]\)/);
  assert.match(main, /state\.snapshotRequests = \[request, \.\.\.state\.snapshotRequests\]/);
  assert.doesNotMatch(main, /(?:local|session)Storage/);
});

test("entering a read-only session restores server jobs and resumes active polling generation-safely", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /async function restoreSnapshotRequests\(sessionId, generation\)[\s\S]*?api\.listSnapshotRequests\(\{ sessionId, limit: 40 \}\)/);
  assert.match(main, /generation !== selectedSessionGeneration/);
  assert.match(main, /state\.snapshotRequests = \[[\s\S]*?\.\.\.requests/);
  assert.match(main, /startSnapshotPolling\(\)/);
  assert.match(main, /async function selectSession\(sessionId\)[\s\S]*?restoreSnapshotRequests\(sessionId, generation\)/);
});

test("project selection checks its generation after every asynchronous boundary", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /const selection = projectSelectionGuard\.begin\(projectId\)/);
  assert.match(main, /api\.getProject\(projectId\)[\s\S]*?projectSelectionGuard\.isCurrent\(selection\)/);
  assert.match(main, /Promise\.all\([\s\S]*?listProjectSessions[\s\S]*?listProjectMembers[\s\S]*?projectSelectionGuard\.isCurrent\(selection\)/);
  assert.match(main, /renderInvitationControls\(selection\)[\s\S]*?projectSelectionGuard\.isCurrent\(selection\)/);
});
