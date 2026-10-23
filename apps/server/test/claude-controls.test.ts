import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";

test("Claude supports implemented local controls but never claims Codex history import", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-claude-controls-"));
  const database = new CollaborationDatabase(join(directory, "test.sqlite"), { authTokenPepper: "synthetic-claude-control-pepper" });
  const service = new CollaborationService(database);
  try {
    const owner = database.bootstrapIdentity({ user_id: "claude-owner", display_name: "Owner", device_id: "claude-device", device_name: "Computer" }).actor;
    const foreign = database.createIdentity({ user_id: "claude-other", display_name: "Other", device_id: "other-device", device_name: "Other" }).actor;
    const { session } = service.createSession(owner, { session_id: "claude-session", mode: "multi", title: "Claude", idempotency_key: "create-claude-session" });
    const runtime = service.registerRuntime(owner, { session_id: session.id, device_id: owner.device_id, harness: "claude-code", provider: "anthropic",
      model: "claude-sonnet-test", local_session_id: "claude-owned-session", capture_fidelity: "canonical_history", context_deletion_version: 1 });
    for (const kind of ["local_sync_status", "local_auto_upload_enable", "local_auto_upload_disable", "local_turn_upload", "code_sync_status", "github_auth_connect"] as const) {
      const job = service.createSnapshotRequest(owner, session.id, kind, runtime.id);
      assert.equal(job.target_runtime_id, runtime.id);
      assert.throws(() => service.claimSnapshotRequest(foreign, job.id, runtime.id));
      assert.equal(service.claimSnapshotRequest(owner, job.id, runtime.id).status, "claimed");
    }
    assert.throws(() => service.createSnapshotRequest(owner, session.id, "visible_history_replace", runtime.id));
    database.revokeDevice(owner, owner.device_id);
    assert.throws(() => service.createSnapshotRequest(owner, session.id, "local_sync_status", runtime.id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
