import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubProjectStatusSchema, githubCodeSyncRequestKinds } from "@gatherthread/protocol";
import { CollaborationDatabase, type DatabaseOptions } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { startCollaborationServer } from "../src/server.js";
import { ApiError } from "../src/errors.js";

const PEPPER = "github-sync-tests-not-a-credential";
const input = { repository: "example/project", base_branch: "main", enabled: true, expected_revision: null };
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
function fixture(options: DatabaseOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-github-test-"));
  const path = join(directory, "state.sqlite");
  const database = new CollaborationDatabase(path, { authTokenPepper: PEPPER, ...options });
  const service = new CollaborationService(database);
  const owner = database.bootstrapIdentity({ display_name: "Owner", device_name: "Owner" }).actor;
  const member = database.createIdentity({ display_name: "Member", device_name: "Member" }).actor;
  const outsider = database.createIdentity({ display_name: "Outsider", device_name: "Outsider" }).actor;
  const project = service.createProject(owner, { title: "GitHub", idempotency_key: "github-project" });
  const invitation = service.createProjectInvitation(owner, project.id, { role: "participant", ttl: "1h" });
  service.claimInvitationForActor(member, invitation.invite_token);
  const { session } = service.createSession(owner, { project_id: project.id, mode: "multi", title: "Work", idempotency_key: "github-session" });
  return { directory, path, database, service, owner, member, outsider, project, session,
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("GitHub metadata enforces project ACL and CAS, persists stable personal branches and cascades deletion", () => {
  const f = fixture();
  try {
    const initial = GitHubProjectStatusSchema.parse(f.service.getProjectGitHub(f.owner, f.project.id));
    assert.equal(initial.connection, null);
    assert.equal(initial.can_configure, true);
    assert.notEqual(initial.branch, f.service.getProjectGitHub(f.member, f.project.id).branch);
    assert.throws(() => f.service.getProjectGitHub(f.outsider, f.project.id), hasCode("not_found"));
    assert.throws(() => f.service.setProjectGitHub(f.member, f.project.id, input), hasCode("forbidden"));
    const configured = f.service.setProjectGitHub(f.owner, f.project.id, input);
    assert.equal(configured.branch, initial.branch);
    assert.deepEqual(f.service.setProjectGitHub(f.owner, f.project.id, input), configured);
    assert.throws(() => f.service.setProjectGitHub(f.owner, f.project.id, { ...input, repository: "other/repo" }), hasCode("conflict"));
    const paused = f.service.setProjectGitHub(f.owner, f.project.id, { ...input, enabled: false, expected_revision: configured.connection!.revision });
    assert.notEqual(paused.connection!.revision, configured.connection!.revision);
    assert.throws(() => f.service.setProjectGitHub(f.owner, f.project.id, { ...input, expected_revision: configured.connection!.revision }), hasCode("conflict"));
    const otherDevice = f.database.createDevice(f.owner.user_id, "Other device");
    assert.equal(f.service.getProjectGitHub(f.database.authenticate(otherDevice.token), f.project.id).branch, initial.branch);
    const reopened = new CollaborationDatabase(f.path, { authTokenPepper: PEPPER });
    try { assert.deepEqual(reopened.getProjectGitHub(f.owner, f.project.id), paused); } finally { reopened.close(); }
    f.service.setProjectMembership(f.owner, f.project.id, f.member.user_id, "viewer");
    assert.equal(f.service.getProjectGitHub(f.member, f.project.id).can_write, false);
    assert.throws(() => f.service.setProjectGitHub(f.member, f.project.id, input), hasCode("forbidden"));
    f.service.removeProjectMembership(f.owner, f.project.id, f.member.user_id);
    assert.throws(() => f.service.getProjectGitHub(f.member, f.project.id), hasCode("not_found"));
    f.service.deleteProject(f.owner, f.project.id);
    assert.equal((f.database.sqlite.prepare("SELECT count(*) AS count FROM project_github_connections").get() as { count: number }).count, 0);
  } finally { f.close(); }
});

test("GitHub controls require exact same-user execution and live ACL, independently of cloud code", () => {
  const f = fixture();
  try {
    const register = (harness: string, purpose: "execution" | "snapshot_connector" = "execution", actor = f.member) => f.service.registerRuntime(actor, {
      session_id: f.session.id, device_id: actor.device_id, harness, provider: "test", model: "test",
      local_session_id: `${harness}-${purpose}`, capture_fidelity: "harness_transcript", purpose,
    });
    const codex = register("codex");
    const dsh = register("deepseek-harness");
    const snapshot = register("codex", "snapshot_connector");
    const otherUser = register("codex", "execution", f.owner);
    const unsupported = register("unsupported");
    const create = (kind: typeof githubCodeSyncRequestKinds[number], runtime = codex.id) => f.service.createSnapshotRequest(f.member, f.session.id, kind, runtime);
    assert.throws(() => create("github_code_upload"), hasCode("conflict"));
    for (const target of [undefined, snapshot.id, otherUser.id, unsupported.id]) {
      assert.throws(() => f.service.createSnapshotRequest(f.member, f.session.id, "github_code_sync_status", target), hasCode("conflict"));
    }
    let configured = f.service.setProjectGitHub(f.owner, f.project.id, input);
    for (const kind of githubCodeSyncRequestKinds) {
      const selected = kind === "github_auth_connect" ? codex.id : dsh.id;
      if (kind === "github_auth_connect") assert.throws(() => create(kind, dsh.id), hasCode("conflict"));
      const job = create(kind, selected);
      assert.throws(() => f.service.claimSnapshotRequest(f.member, job.id, selected === codex.id ? dsh.id : codex.id), hasCode("forbidden"));
      assert.throws(() => f.service.claimSnapshotRequest(f.owner, job.id, otherUser.id), hasCode("not_found"));
      f.service.claimSnapshotRequest(f.member, job.id, selected);
      f.service.completeSnapshotRequest(f.member, job.id, selected, { ok: true });
    }
    // No cloud repository exists; its controls remain independently disabled.
    assert.throws(() => f.service.createSnapshotRequest(f.member, f.session.id, "code_upload", codex.id), hasCode("conflict"));
    assert.equal((f.database.sqlite.prepare("SELECT count(*) AS count FROM code_repositories").get() as { count: number }).count, 0);
    const pending = create("github_code_upload");
    const claimed = create("github_code_download");
    f.service.claimSnapshotRequest(f.member, claimed.id, codex.id);
    configured = f.service.setProjectGitHub(f.owner, f.project.id, { ...input, enabled: false, expected_revision: configured.connection!.revision });
    assert.throws(() => create("github_code_recover"), hasCode("conflict"));
    assert.throws(() => f.service.claimSnapshotRequest(f.member, pending.id, codex.id), hasCode("conflict"));
    assert.throws(() => f.service.completeSnapshotRequest(f.member, claimed.id, codex.id, {}), hasCode("conflict"));
    assert.throws(() => f.service.failSnapshotRequest(f.member, claimed.id, codex.id, { code: "failed", message: "failed" }), hasCode("conflict"));
    for (const kind of ["github_code_sync_status", "github_code_auto_upload_disable"] as const) {
      const job = create(kind);
      f.service.claimSnapshotRequest(f.member, job.id, codex.id);
      f.service.completeSnapshotRequest(f.member, job.id, codex.id, {});
    }
    f.service.setProjectGitHub(f.owner, f.project.id, { ...input, expected_revision: configured.connection!.revision });
    const second = f.database.createDevice(f.member.user_id, "Other");
    assert.throws(() => f.service.completeSnapshotRequest(f.database.authenticate(second.token), claimed.id, codex.id, {}), hasCode("forbidden"));
    const solo = f.service.createSession(f.owner, { project_id: f.project.id, mode: "solo", title: "Private writer", idempotency_key: "github-solo" }).session;
    assert.throws(() => f.service.createSnapshotRequest(f.member, solo.id, "github_code_sync_status", codex.id), hasCode("forbidden"));
    f.service.setProjectMembership(f.owner, f.project.id, f.member.user_id, "viewer");
    assert.throws(() => create("github_code_sync_status"), hasCode("forbidden"));
    assert.throws(() => f.service.claimSnapshotRequest(f.member, pending.id, codex.id), hasCode("forbidden"));
    assert.throws(() => f.service.completeSnapshotRequest(f.member, claimed.id, codex.id, {}), hasCode("forbidden"));
  } finally { f.close(); }
});

test("migration keeps existing cloud jobs and adds GitHub metadata without changing storage accounting", () => {
  const f = fixture();
  try {
    const runtime = f.service.registerRuntime(f.owner, { session_id: f.session.id, device_id: f.owner.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "migration", capture_fidelity: "harness_transcript", purpose: "execution" });
    const job = f.service.createSnapshotRequest(f.owner, f.session.id, "code_sync_status", runtime.id);
    const sql = (f.database.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='snapshot_requests'").get() as { sql: string }).sql;
    f.database.sqlite.exec("ALTER TABLE snapshot_requests RENAME TO snapshot_requests_old");
    f.database.sqlite.exec(sql.replace(/, '(?:github_code_[^']+|github_auth_connect)'/gu, ""));
    f.database.sqlite.exec("INSERT INTO snapshot_requests SELECT * FROM snapshot_requests_old; DROP TABLE snapshot_requests_old; DROP TABLE project_github_connections");
    const reopened = new CollaborationDatabase(f.path, { authTokenPepper: PEPPER });
    try {
      assert.deepEqual(reopened.getSnapshotRequest(f.owner, job.id), job);
      assert.equal(reopened.getProjectGitHub(f.owner, f.project.id).connection, null);
      assert.equal(reopened.createSnapshotRequest(f.owner, f.session.id, "github_code_sync_status", runtime.id).target_runtime_id, runtime.id);
      assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("effective GitHub configuration changes atomically invalidate old active jobs only", () => {
  const f = fixture();
  try {
    const runtime = f.service.registerRuntime(f.member, { session_id: f.session.id, device_id: f.member.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "switch-target", capture_fidelity: "harness_transcript", purpose: "execution" });
    let configured = f.service.setProjectGitHub(f.owner, f.project.id, input);
    const create = (kind: typeof githubCodeSyncRequestKinds[number]) => f.service.createSnapshotRequest(f.member, f.session.id, kind, runtime.id);
    const completed = create("github_code_sync_status");
    f.service.claimSnapshotRequest(f.member, completed.id, runtime.id);
    const terminal = f.service.completeSnapshotRequest(f.member, completed.id, runtime.id, { ok: true });
    const failed = create("github_code_download");
    f.service.claimSnapshotRequest(f.member, failed.id, runtime.id);
    const terminalFailure = f.service.failSnapshotRequest(f.member, failed.id, runtime.id, { code: "code_sync_empty", message: "Empty source" });
    const pending = create("github_code_upload");
    const claimed = create("github_code_update");
    f.service.claimSnapshotRequest(f.member, claimed.id, runtime.id);
    const cloud = f.service.createSnapshotRequest(f.member, f.session.id, "code_sync_status", runtime.id);
    const immutable = f.service.createSnapshotRequest(f.member, f.session.id, "immutable");
    const secondProject = f.service.createProject(f.owner, { title: "Other", idempotency_key: "other-github-project" });
    const otherSession = f.service.createSession(f.owner, { project_id: secondProject.id, mode: "multi", title: "Other", idempotency_key: "other-github-session" }).session;
    const otherRuntime = f.service.registerRuntime(f.owner, { session_id: otherSession.id, device_id: f.owner.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "other-target", capture_fidelity: "harness_transcript", purpose: "execution" });
    const otherJob = f.service.createSnapshotRequest(f.owner, otherSession.id, "github_code_sync_status", otherRuntime.id);
    assert.deepEqual(f.service.setProjectGitHub(f.owner, f.project.id, input), configured);
    assert.equal(f.service.getSnapshotRequest(f.member, pending.id).status, "pending");
    assert.throws(() => f.service.setProjectGitHub(f.owner, f.project.id, { ...input, repository: "other/target" }), hasCode("conflict"));
    assert.equal(f.service.getSnapshotRequest(f.member, claimed.id).status, "claimed");
    const before = (f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage").get() as { bytes: number }).bytes;
    configured = f.service.setProjectGitHub(f.owner, f.project.id, { ...input, repository: "other/target", expected_revision: configured.connection!.revision });
    for (const job of [pending, claimed]) {
      const invalidated = f.service.getSnapshotRequest(f.member, job.id);
      assert.equal(invalidated.status, "failed");
      assert.equal(invalidated.failure?.code, "code_sync_binding");
      assert.ok(invalidated.failed_at);
      assert.throws(() => f.service.claimSnapshotRequest(f.member, job.id, runtime.id), hasCode("conflict"));
      assert.throws(() => f.service.completeSnapshotRequest(f.member, job.id, runtime.id, {}), hasCode("conflict"));
    }
    assert.deepEqual(f.service.getSnapshotRequest(f.member, completed.id), terminal);
    assert.deepEqual(f.service.getSnapshotRequest(f.member, failed.id), terminalFailure);
    assert.deepEqual(f.service.getSnapshotRequest(f.member, cloud.id), cloud);
    assert.deepEqual(f.service.getSnapshotRequest(f.member, immutable.id), immutable);
    assert.deepEqual(f.service.getSnapshotRequest(f.owner, otherJob.id), otherJob);
    const charged = (f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage").get() as { bytes: number }).bytes;
    assert.ok(charged > before);
    assert.equal(charged, (f.database.sqlite.prepare("SELECT SUM(storage_bytes) AS bytes FROM snapshot_requests").get() as { bytes: number }).bytes);
    f.service.setProjectGitHub(f.owner, f.project.id, { ...input, expected_revision: configured.connection!.revision });
    assert.equal(f.service.getSnapshotRequest(f.member, pending.id).status, "failed");
    assert.equal((f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage").get() as { bytes: number }).bytes, charged);
    assert.doesNotThrow(() => create("github_code_upload"));
  } finally { f.close(); }
});

test("full job storage does not block GitHub pause and its fixed cancellation marker stays accounted", () => {
  const f = fixture({ maxSnapshotResultBytes: 1024, maxUserSnapshotBytes: 1024, maxSessionSnapshotBytes: 1024, maxTotalSnapshotBytes: 1024 });
  try {
    const runtime = f.service.registerRuntime(f.owner, { session_id: f.session.id, device_id: f.owner.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "quota-cancel", capture_fidelity: "harness_transcript", purpose: "execution" });
    const configured = f.service.setProjectGitHub(f.owner, f.project.id, input);
    const job = f.service.createSnapshotRequest(f.owner, f.session.id, "github_code_upload", runtime.id);
    f.service.setProjectGitHub(f.owner, f.project.id, { ...input, enabled: false, expected_revision: configured.connection!.revision });
    assert.equal(f.service.getSnapshotRequest(f.owner, job.id).failure?.code, "code_sync_binding");
    const bytes = (f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage").get() as { bytes: number }).bytes;
    assert.ok(bytes > 1024 && bytes < 1280);
    assert.equal(bytes, (f.database.sqlite.prepare("SELECT SUM(storage_bytes) AS bytes FROM snapshot_requests").get() as { bytes: number }).bytes);
    assert.throws(() => f.service.createSnapshotRequest(f.owner, f.session.id, "github_code_sync_status", runtime.id), hasCode("storage_quota_exceeded"));
  } finally { f.close(); }
});

test("HTTP GitHub routes validate metadata, reject secrets and enforce owner-only writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-github-http-"));
  const running = await startCollaborationServer({ databasePath: join(directory, "state.sqlite"), authTokenPepper: PEPPER }, 0);
  try {
    const owner = running.database.bootstrapIdentity({ display_name: "Owner", device_name: "Owner" });
    const member = running.database.createIdentity({ display_name: "Member", device_name: "Member" });
    const project = running.service.createProject(owner.actor, { title: "HTTP GitHub", idempotency_key: "github-http" });
    const invitation = running.service.createProjectInvitation(owner.actor, project.id, { role: "participant", ttl: "1h" });
    running.service.claimInvitationForActor(member.actor, invitation.invite_token);
    const path = `/v1/projects/${project.id}/github`;
    const request = (token?: string, method = "GET", body?: unknown) => fetch(`${running.origin}${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await request()).status, 401);
    assert.equal((await request(member.token, "PUT", input)).status, 403);
    assert.equal((await request(owner.token, "PUT", { ...input, token: "unapproved-field" })).status, 400);
    assert.equal((await request(owner.token, "PUT", { ...input, repository: "https://github.com/example/project" })).status, 400);
    assert.equal((await request(owner.token, "PUT", { ...input, base_branch: "gatherthread/other" })).status, 400);
    const response = await request(owner.token, "PUT", input);
    assert.equal(response.status, 200);
    const configured = GitHubProjectStatusSchema.parse((await response.json() as { data: unknown }).data);
    assert.equal(configured.connection!.repository, input.repository);
    assert.equal((await request(owner.token, "PUT", { ...input, base_branch: "other" })).status, 409);
    const read = GitHubProjectStatusSchema.parse((await (await request(member.token)).json() as { data: unknown }).data);
    assert.equal(read.can_configure, false);
    assert.equal(read.can_write, true);
    const { session } = running.service.createSession(owner.actor, { project_id: project.id, mode: "multi", title: "Jobs", idempotency_key: "github-http-jobs" });
    const runtime = running.service.registerRuntime(member.actor, { session_id: session.id, device_id: member.actor.device_id,
      harness: "deepseek-harness", provider: "test", model: "test", local_session_id: "github-http", capture_fidelity: "harness_transcript", purpose: "execution" });
    const postJob = (path: string, body: unknown) => fetch(`${running.origin}${path}`, { method: "POST",
      headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const jobs = `/v1/sessions/${session.id}/snapshot-requests`;
    assert.equal((await postJob(jobs, { kind: "github_code_update" })).status, 409);
    const created = await postJob(jobs, { kind: "github_code_update", target_runtime_id: runtime.id });
    assert.equal(created.status, 201);
    const job = (await created.json() as { data: { snapshot_request: { id: string } } }).data.snapshot_request;
    assert.equal((await postJob(`/v1/snapshot-requests/${job.id}/claim`, { runtime_id: runtime.id })).status, 200);
    assert.equal((await postJob(`/v1/snapshot-requests/${job.id}/complete`, { runtime_id: runtime.id, result: { updated: true } })).status, 200);
    assert.equal((await request(owner.token, "PUT", { ...input, enabled: false, expected_revision: configured.connection!.revision })).status, 200);
    assert.equal((await postJob(jobs, { kind: "github_code_upload", target_runtime_id: runtime.id })).status, 409);
    assert.equal((await postJob(jobs, { kind: "github_code_auto_upload_disable", target_runtime_id: runtime.id })).status, 201);
    running.service.setProjectMembership(owner.actor, project.id, member.actor.user_id, "viewer");
    assert.equal((await postJob(jobs, { kind: "github_code_sync_status", target_runtime_id: runtime.id })).status, 403);
    running.database.revokeDevice(owner.actor, owner.actor.device_id);
    assert.equal((await request(owner.token, "PUT", input)).status, 401);
  } finally { await running.close(); rmSync(directory, { recursive: true, force: true }); }
});
