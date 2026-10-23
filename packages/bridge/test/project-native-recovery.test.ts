import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runProjectConnector } from "../src/codex-connect.js";
import { FileCursorStore } from "../src/cursors.js";
import type { HttpCollaborationClient, ProjectHarnessAdapter } from "../src/index.js";

const receipt = { sessionId: "deleted-session", runtimeId: "old-runtime", requestId: "request-1", claimAttempt: 2 };
const key = createHash("sha256").update(receipt.sessionId).digest("hex").slice(0, 24);

for (const evidence of ["cursor", "journal", "unknown-journal", "lost-ack", "wrong-scope", "symlink"] as const) {
  test(`project startup recovers only exact proved native exits before deleted-session discovery: ${evidence}`, async t => {
    if (evidence === "symlink" && process.platform === "win32") { t.skip("Windows symlink creation requires an independent OS privilege"); return; }
    const stateRoot = await mkdtemp(path.join(tmpdir(), "gt-project-native-recovery-"));
    t.after(() => rm(stateRoot, { recursive: true, force: true }));
    const cursor = path.join(stateRoot, `${key}-cursor.json`), store = new FileCursorStore(cursor);
    const journal = path.join(stateRoot, `${key}-execution.json.native-execution.json`);
    if (["cursor", "lost-ack", "wrong-scope", "symlink"].includes(evidence)) await store.save({
      server: { [receipt.sessionId]: 8 }, local: {}, stoppedExecutions: [{ ...receipt,
        ...(evidence === "wrong-scope" ? { sessionId: "foreign-session" } : {}) }],
    });
    if (evidence === "symlink") { await rm(cursor); const target = path.join(stateRoot, "unrelated.json");
      await writeFile(target, JSON.stringify({ server: {}, local: {}, stoppedExecutions: [receipt] }), { mode: 0o600 }); await symlink(target, cursor); }
    if (evidence === "journal" || evidence === "unknown-journal") {
      const identity = createHash("sha256").update(JSON.stringify([receipt.sessionId, receipt.runtimeId, receipt.requestId, receipt.claimAttempt])).digest("hex");
      await writeFile(journal, JSON.stringify({ version: 1, entries: { [identity]: { ...receipt, fingerprint: "a".repeat(64),
        phase: evidence === "journal" ? "settled" : "started",
        ...(evidence === "journal" ? { failure: { code: "agent_cancelled", message: "Execution stopped" } } : { pid: 1 }),
      } } }), { mode: 0o600 });
    }
    const order: string[] = [];
    const api = { async acknowledgeAgentExecutionStopped(...identity: unknown[]) {
      assert.deepEqual(identity, [receipt.sessionId, receipt.requestId, receipt.runtimeId, receipt.claimAttempt]); order.push("exit-ack");
      if (evidence === "lost-ack") throw new Error("fixture lost exit ACK");
      // A concurrent independent cursor advance must survive this network wait.
      if (evidence === "cursor") await store.save({ ...(await store.load()), server: { [receipt.sessionId]: 12 } });
    }, async listProjects() { order.push("project-read"); return []; } } as unknown as HttpCollaborationClient;
    const harness = { descriptor: { harness: "codex", provider: "openai", model: "fixture", capabilities: [] },
      preflight() { throw Error("No native preflight is allowed during cleanup"); },
      createSessionBinding() { throw Error("No current session can supply this deleted session's proof"); },
    } as unknown as ProjectHarnessAdapter;
    await assert.rejects(runProjectConnector({ api, actorUserId: "owner", actorDeviceId: "device",
      project: { id: "project-1", name: "Deleted project", role: "owner", state: "active", sessionCount: 0 },
      stateRoot, harness, token: "gta_fixture", signal: new AbortController().signal, hookMode: "project",
      hookSocketPath: path.join(stateRoot, "hook.sock"), hookRegistryPath: path.join(stateRoot, "hooks.json"),
      hookSpoolPath: path.join(stateRoot, "spool"), hookWorkspacePath: stateRoot,
    }), /project access was revoked|lost exit ACK|scope mismatch|private native cleanup|ELOOP/);
    if (evidence === "cursor" || evidence === "journal") {
      assert.deepEqual(order, ["exit-ack", "project-read"]);
      assert.deepEqual((await store.load()).stoppedExecutions, []);
      if (evidence === "cursor") assert.equal((await store.load()).server[receipt.sessionId], 12);
      else assert.equal(Object.values(JSON.parse(await readFile(journal, "utf8")).entries as Record<string, any>)[0]!.exitAcknowledged, true);
    } else if (evidence === "unknown-journal") assert.deepEqual(order, ["project-read"], "a PID or uncertain journal is never exit proof");
    else if (evidence === "lost-ack") { assert.deepEqual(order, ["exit-ack"]); assert.equal((await store.load()).stoppedExecutions?.length, 1); }
    else assert.deepEqual(order, [], "bad scope or links must fail before any acknowledgment");
  });
}
