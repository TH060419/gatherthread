import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeFilesSchema, CodeMutationResultSchema, CodeSnapshotResultSchema, CodeStatusSchema, type CodeFile } from "@gatherthread/protocol";
import { CodeRepository } from "../src/code-repository.js";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { ApiError } from "../src/errors.js";
import { startCollaborationServer } from "../src/server.js";

class CountingCodeRepository extends CodeRepository {
  commands: string[] = [];
  blobSizes(projectId: string): number[] {
    return this.git(projectId, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)"])
      .toString().trim().split("\n").filter((entry) => entry.startsWith("blob ")).map((entry) => Number(entry.slice(5)));
  }
  protected override git(projectId: string, args: string[], input?: string | Buffer, extraEnv?: Record<string, string>, allowConflict = false): Buffer {
    this.commands.push(args[0]!);
    return super.git(projectId, args, input, extraEnv, allowConflict);
  }
}

const PEPPER = "code-repository-test-pepper-not-a-credential";
const file = (path: string, text: string, executable = false): CodeFile => ({ path, content_base64: Buffer.from(text).toString("base64"), executable });
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-code-test-"));
  const path = join(directory, "state.sqlite");
  const database = new CollaborationDatabase(path, { authTokenPepper: PEPPER });
  const service = new CollaborationService(database);
  const owner = database.bootstrapIdentity({ display_name: "Owner", device_name: "Owner" }).actor;
  const member = database.createIdentity({ display_name: "Member", device_name: "Member" }).actor;
  const outsider = database.createIdentity({ display_name: "Outsider", device_name: "Outsider" }).actor;
  const project = service.createProject(owner, { title: "Code collaboration", idempotency_key: "project-create-1" });
  const invitation = service.createProjectInvitation(owner, project.id, { role: "participant", ttl: "1h" });
  service.claimInvitationForActor(member, invitation.invite_token);
  const repository = new CodeRepository(database, join(directory, "code"));
  return { directory, path, database, service, owner, member, outsider, project, repository,
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("project code branches have real Git snapshots, durable retry receipts, independent ACLs, and stale-device CAS", () => {
  const f = fixture();
  try {
    assert.deepEqual(CodeStatusSchema.parse(f.repository.status(f.owner, f.project.id)), { repository: { enabled: false, main_commit: null }, branches: [], own_branch_id: null });
    assert.throws(() => f.repository.enable(f.member, f.project.id, { idempotency_key: "enable-member" }), hasCode("forbidden"));
    assert.throws(() => f.repository.status(f.outsider, f.project.id), hasCode("not_found"));
    const enabled = f.repository.enable(f.owner, f.project.id, { idempotency_key: "enable-owner" });
    CodeMutationResultSchema.parse(enabled);
    const input = { base_commit: enabled.commit, files: [file("src/main.ts", "export const answer = 42;\n"), file("bin/start", "exit 0\n", true)], message: "First checkpoint", idempotency_key: "checkpoint-1" };
    const uploaded = f.repository.checkpoint(f.member, f.project.id, input);
    const branchId = uploaded.status.own_branch_id!;
    assert.notEqual(uploaded.commit, enabled.commit);
    assert.deepEqual(f.repository.checkpoint(f.member, f.project.id, input), uploaded);
    assert.throws(() => f.repository.checkpoint(f.member, f.project.id, { ...input, message: "Changed retry" }), hasCode("idempotency_conflict"));
    assert.throws(() => f.repository.checkpoint(f.member, f.project.id, { ...input, idempotency_key: "stale-device" }), hasCode("code_stale_head"));
    assert.throws(() => f.repository.checkpoint(f.owner, f.project.id, input), hasCode("idempotency_conflict"));
    const snapshot = CodeSnapshotResultSchema.parse(f.repository.snapshot(f.owner, f.project.id, branchId));
    assert.deepEqual(snapshot.snapshot.files, [...input.files].sort((a, b) => a.path.localeCompare(b.path)));
    assert.equal(snapshot.snapshot.commit, uploaded.commit);
    // Another member can read this branch, but cannot upload into its identity.
    const ownerUpload = f.repository.checkpoint(f.owner, f.project.id, { ...input, files: [file("README.md", "Owner work")], idempotency_key: "owner-checkpoint" });
    assert.notEqual(ownerUpload.status.own_branch_id, branchId);
    const reopened = new CollaborationDatabase(f.path, { authTokenPepper: PEPPER });
    try {
      const recovered = new CodeRepository(reopened, join(f.directory, "code"));
      assert.deepEqual(recovered.checkpoint(f.member, f.project.id, input), uploaded);
      assert.deepEqual(recovered.snapshot(f.member, f.project.id, branchId), snapshot);
    } finally { reopened.close(); }
    f.service.setProjectMembership(f.owner, f.project.id, f.member.user_id, "viewer");
    assert.throws(() => f.repository.checkpoint(f.member, f.project.id, input), hasCode("forbidden"));
    assert.doesNotThrow(() => f.repository.snapshot(f.member, f.project.id, branchId));
    f.service.removeProjectMembership(f.owner, f.project.id, f.member.user_id);
    assert.throws(() => f.repository.snapshot(f.member, f.project.id, branchId), hasCode("not_found"));
    f.service.deleteProject(f.owner, f.project.id);
    assert.equal((f.database.sqlite.prepare("SELECT count(*) AS count FROM code_branches").get() as { count: number }).count, 0);
  } finally { f.close(); }
});

test("owner can pause and resume code transfers without deleting cloud branches", () => {
  const f = fixture();
  try {
    const enabled = f.repository.enable(f.owner, f.project.id, { idempotency_key: "enable-pause-test" });
    const uploaded = f.repository.checkpoint(f.member, f.project.id, {
      base_commit: enabled.commit, files: [file("README.md", "retained")],
      message: "Member checkpoint", idempotency_key: "checkpoint-pause-test",
    });
    assert.throws(() => f.repository.disable(f.member, f.project.id, { idempotency_key: "member-disable" }), hasCode("forbidden"));
    const paused = f.repository.disable(f.owner, f.project.id, { idempotency_key: "owner-disable" });
    assert.equal(paused.status.repository.enabled, false);
    assert.equal(paused.status.repository.main_commit, enabled.commit);
    assert.equal(paused.status.branches[0]?.head_commit, uploaded.commit);
    assert.deepEqual(f.repository.disable(f.owner, f.project.id, { idempotency_key: "owner-disable" }), paused);
    assert.throws(() => f.repository.checkpoint(f.member, f.project.id, {
      base_commit: uploaded.commit, files: [file("README.md", "blocked")],
      message: "Blocked", idempotency_key: "checkpoint-paused",
    }), hasCode("code_not_enabled"));
    assert.throws(() => f.repository.snapshot(f.member, f.project.id, uploaded.status.own_branch_id!), hasCode("code_not_enabled"));
    const resumed = f.repository.enable(f.owner, f.project.id, { idempotency_key: "owner-resume" });
    assert.equal(resumed.status.repository.enabled, true);
    assert.equal(resumed.status.branches[0]?.head_commit, uploaded.commit);
    assert.equal(f.repository.snapshot(f.member, f.project.id, uploaded.status.own_branch_id!).snapshot.files[0]?.path, "README.md");
  } finally { f.close(); }
});

test("pre-pause code repository rows migrate as enabled without losing their heads", () => {
  const f = fixture();
  try {
    const enabled = f.repository.enable(f.owner, f.project.id, { idempotency_key: "legacy-enable" });
    const uploaded = f.repository.checkpoint(f.member, f.project.id, {
      base_commit: enabled.commit, files: [file("source.txt", "preserved")],
      message: "Keep source", idempotency_key: "legacy-checkpoint",
    });
    // Simulate the persisted schema from before the pause toggle existed.
    f.database.sqlite.exec("ALTER TABLE code_repositories DROP COLUMN enabled");
    const reopened = new CollaborationDatabase(f.path, { authTokenPepper: PEPPER });
    try {
      const migrated = new CodeRepository(reopened, join(f.directory, "code"));
      assert.equal(migrated.status(f.owner, f.project.id).repository.enabled, true);
      assert.equal(migrated.status(f.owner, f.project.id).branches[0]?.head_commit, uploaded.commit);
      assert.equal(migrated.snapshot(f.member, f.project.id, uploaded.status.own_branch_id!).snapshot.files[0]?.path, "source.txt");
      assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("reviews require exact current heads and real three-way merge preserves unrelated work and refuses conflicts", () => {
  const f = fixture();
  try {
    const initial = f.repository.enable(f.owner, f.project.id, { idempotency_key: "enable-project" });
    const a = f.repository.checkpoint(f.owner, f.project.id, { base_commit: initial.commit, files: [file("owner.txt", "owner")], message: "Owner", idempotency_key: "owner-initial" });
    const b = f.repository.checkpoint(f.member, f.project.id, { base_commit: initial.commit, files: [file("member.txt", "member")], message: "Member", idempotency_key: "member-initial" });
    const mergeA = { branch_id: a.status.own_branch_id!, expected_main_commit: initial.commit, expected_head_commit: a.commit, idempotency_key: "merge-owner" };
    assert.throws(() => f.repository.merge(f.owner, f.project.id, mergeA), hasCode("code_review_required"));
    f.repository.review(f.owner, f.project.id, { head_commit: a.commit, idempotency_key: "review-owner" });
    const mergedA = f.repository.merge(f.owner, f.project.id, mergeA);
    assert.throws(() => f.repository.merge(f.member, f.project.id, mergeA), hasCode("forbidden"));
    f.repository.review(f.member, f.project.id, { head_commit: b.commit, idempotency_key: "review-member" });
    const mergedB = f.repository.merge(f.owner, f.project.id, { branch_id: b.status.own_branch_id!, expected_main_commit: mergedA.commit, expected_head_commit: b.commit, idempotency_key: "merge-member" });
    assert.deepEqual(f.repository.snapshot(f.member, f.project.id, "main").snapshot.files.map((item) => item.path), ["member.txt", "owner.txt"]);
    const updateA = f.repository.update(f.owner, f.project.id, { base_commit: a.commit, expected_main_commit: mergedB.commit, idempotency_key: "update-owner" });
    const updateB = f.repository.update(f.member, f.project.id, { base_commit: b.commit, expected_main_commit: mergedB.commit, idempotency_key: "update-member" });
    const commonFiles = f.repository.snapshot(f.owner, f.project.id, "main").snapshot.files;
    const c = f.repository.checkpoint(f.owner, f.project.id, { base_commit: updateA.commit, files: [...commonFiles, file("shared.txt", "owner version")], message: "Owner conflict", idempotency_key: "owner-conflict" });
    const d = f.repository.checkpoint(f.member, f.project.id, { base_commit: updateB.commit, files: [...commonFiles, file("shared.txt", "member version")], message: "Member conflict", idempotency_key: "member-conflict" });
    f.repository.review(f.owner, f.project.id, { head_commit: c.commit, idempotency_key: "review-owner-2" });
    const mergedC = f.repository.merge(f.owner, f.project.id, { branch_id: c.status.own_branch_id!, expected_main_commit: mergedB.commit, expected_head_commit: c.commit, idempotency_key: "merge-owner-2" });
    f.repository.review(f.member, f.project.id, { head_commit: d.commit, idempotency_key: "review-member-2" });
    const before = f.repository.status(f.owner, f.project.id);
    assert.throws(() => f.repository.merge(f.owner, f.project.id, { branch_id: d.status.own_branch_id!, expected_main_commit: mergedC.commit, expected_head_commit: d.commit, idempotency_key: "merge-conflict" }), hasCode("code_merge_conflict"));
    assert.deepEqual(f.repository.status(f.owner, f.project.id), before);
  } finally { f.close(); }
});

test("untrusted Git attributes cannot amplify merge conflict objects beyond the bounded inputs", () => {
  const f = fixture();
  try {
    const repo = new CountingCodeRepository(f.database, join(f.directory, "code"));
    const initial = repo.enable(f.owner, f.project.id, { idempotency_key: "enable-project" });
    const attributes = file(".gitattributes", "*.txt conflict-marker-size=65536\n");
    const left = repo.checkpoint(f.owner, f.project.id, {
      base_commit: initial.commit, files: [attributes, file("shared.txt", "owner\n")], message: "Owner work", idempotency_key: "owner-attributes",
    });
    const right = repo.checkpoint(f.member, f.project.id, {
      base_commit: initial.commit, files: [attributes, file("shared.txt", "member\n")], message: "Member work", idempotency_key: "member-attributes",
    });
    repo.review(f.owner, f.project.id, { head_commit: left.commit, idempotency_key: "owner-review" });
    const merged = repo.merge(f.owner, f.project.id, {
      branch_id: left.status.own_branch_id!, expected_main_commit: initial.commit, expected_head_commit: left.commit, idempotency_key: "owner-merge",
    });
    const before = repo.status(f.member, f.project.id);
    assert.throws(() => repo.update(f.member, f.project.id, {
      base_commit: right.commit, expected_main_commit: merged.commit, idempotency_key: "member-conflict",
    }), hasCode("code_merge_conflict"));
    assert.deepEqual(repo.status(f.member, f.project.id), before);
    assert.ok(Math.max(...repo.blobSizes(f.project.id)) < 1024, "conflict marker size must be server-controlled");
    assert.equal(repo.snapshot(f.owner, f.project.id, "main").snapshot.files.find((entry) => entry.path === ".gitattributes")?.content_base64, attributes.content_base64);
  } finally { f.close(); }
});

test("portable snapshots reject path traversal, private state, secrets, duplicates and budgets before changing heads", () => {
  const f = fixture();
  try {
    const enabled = f.repository.enable(f.owner, f.project.id, { idempotency_key: "enable-project" });
    for (const path of ["../escape", "a/../../x", "/tmp/x", "a\\x", "A/.GIT/config", ".gatherthread/state", ".env", "a/.codex/auth.json", "x.key", "aux.txt", "a/CON", "a.", "a:stream", "a".repeat(256), "汉".repeat(86), ...["<", ">", '"', "|", "?", "*"].map((symbol) => `src/a${symbol}b.ts`)]) {
      assert.equal(CodeFilesSchema.safeParse([file(path, "x")]).success, false, path);
    }
    assert.equal(CodeFilesSchema.safeParse([file("a".repeat(255), "x"), file(`src/${"汉".repeat(85)}`, "x")]).success, true);
    for (const files of [[file("a", "x"), file("A", "x")], [file("a", "x"), file("a/x", "x")], [file("x", "x".repeat(2 * 1024 * 1024 + 1))]]) {
      assert.equal(CodeFilesSchema.safeParse(files).success, false);
    }
    assert.equal(CodeFilesSchema.safeParse([file(".env.example", "API_KEY=your-key")]).success, true);
    assert.throws(() => f.repository.checkpoint(f.owner, f.project.id, { base_commit: enabled.commit, files: [file("config.txt", ["-----BEGIN", "PRIVATE KEY-----"].join(" "))], message: "Not allowed", idempotency_key: "secret-checkpoint" }), hasCode("code_secret_detected"));
    assert.equal(f.repository.status(f.owner, f.project.id).branches.length, 0);
    f.database.sqlite.prepare("UPDATE code_repositories SET charged_bytes=?").run(256 * 1024 * 1024);
    assert.throws(() => f.repository.checkpoint(f.owner, f.project.id, { base_commit: enabled.commit, files: [file("ok.ts", "yes")], message: "Quota", idempotency_key: "quota-checkpoint" }), hasCode("code_storage_quota_exceeded"));
  } finally { f.close(); }
});

test("code checkpoints reject recognizable credentials before writing Git objects or charging storage", () => {
  const f = fixture();
  try {
    const repo = new CountingCodeRepository(f.database, join(f.directory, "code"));
    const enabled = repo.enable(f.owner, f.project.id, { idempotency_key: "enable-project" });
    const before = repo.status(f.owner, f.project.id);
    const charged = () => f.database.sqlite.prepare("SELECT charged_bytes FROM code_repositories WHERE project_id=?").get(f.project.id);
    const previousCharge = charged();
    for (const prefix of ["gta_", "gtb_", "gti_", "gtd_", "gtp_", "acp_", "acpi_", "acpd_", "sk-", "glpat-", "xoxb-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      repo.commands = [];
      const syntheticCredential = `${prefix}${"fixture".repeat(5)}`;
      assert.throws(() => repo.checkpoint(f.owner, f.project.id, {
        base_commit: enabled.commit, files: [file("src/config.ts", `export const credential = "${syntheticCredential}";`)],
        message: "Rejected credential fixture", idempotency_key: `credential-${prefix}`,
      }), hasCode("code_secret_detected"), prefix);
      assert.deepEqual(repo.commands, [], "credential rejection must precede Git writes");
      assert.deepEqual(repo.status(f.owner, f.project.id), before);
      assert.deepEqual(charged(), previousCharge);
    }
  } finally { f.close(); }
});

test("checkpoint filenames cannot collide after replacement of malformed Unicode by UTF-8", () => {
  const f = fixture();
  try {
    const enabled = f.repository.enable(f.owner, f.project.id, { idempotency_key: "enable-project" });
    const files = [file("src/\ud800.ts", "first"), file("src/\ufffd.ts", "second")];
    assert.throws(() => f.repository.checkpoint(f.owner, f.project.id, {
      base_commit: enabled.commit, files, message: "Reject lossy filenames", idempotency_key: "lossy-path-checkpoint",
    }));
    assert.equal(f.repository.status(f.owner, f.project.id).branches.length, 0);
    assert.equal(CodeFilesSchema.safeParse([file("src/\udc00.ts", "bad")]).success, false);
    assert.equal(CodeFilesSchema.safeParse([file("src/\ud83d\ude80.ts", "valid supplementary character")]).success, true);
  } finally { f.close(); }
});

test("code jobs require exact own execution target for Codex or DSH; role and project checks remain live", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, { project_id: f.project.id, mode: "multi", title: "Work", idempotency_key: "session-create" });
    const register = (harness: string, purpose: "execution" | "snapshot_connector" = "execution") => f.service.registerRuntime(f.member, {
      session_id: session.id, device_id: f.member.device_id, harness, provider: "test", model: "test", local_session_id: `${harness}-${purpose}`, capture_fidelity: "harness_transcript", purpose,
    });
    const codex = register("codex");
    const dsh = register("deepseek-harness");
    const snapshot = register("codex", "snapshot_connector");
    const disabledStatus = f.service.createSnapshotRequest(f.member, session.id, "code_sync_status", dsh.id);
    assert.throws(() => f.service.createSnapshotRequest(f.member, session.id, "code_upload", dsh.id), hasCode("conflict"));
    assert.throws(() => f.service.createSnapshotRequest(f.member, session.id, "code_sync_status"), hasCode("conflict"));
    assert.throws(() => f.service.createSnapshotRequest(f.member, session.id, "code_sync_status", snapshot.id), hasCode("conflict"));
    assert.throws(() => f.service.claimSnapshotRequest(f.member, disabledStatus.id, codex.id), hasCode("forbidden"));
    f.service.claimSnapshotRequest(f.member, disabledStatus.id, dsh.id);
    f.service.completeSnapshotRequest(f.member, disabledStatus.id, dsh.id, { enabled: false });
    f.repository.enable(f.owner, f.project.id, { idempotency_key: "enable-project" });
    const upload = f.service.createSnapshotRequest(f.member, session.id, "code_upload", codex.id);
    f.service.claimSnapshotRequest(f.member, upload.id, codex.id);
    f.repository.disable(f.owner, f.project.id, { idempotency_key: "pause-code-jobs" });
    assert.throws(() => f.service.createSnapshotRequest(f.member, session.id, "code_upload", codex.id), hasCode("conflict"));
    assert.throws(() => f.service.completeSnapshotRequest(f.member, upload.id, codex.id, { uploaded: true }), hasCode("conflict"));
    const turnOffAutoUpload = f.service.createSnapshotRequest(f.member, session.id, "code_auto_upload_disable", dsh.id);
    f.service.claimSnapshotRequest(f.member, turnOffAutoUpload.id, dsh.id);
    f.service.completeSnapshotRequest(f.member, turnOffAutoUpload.id, dsh.id, { auto_upload: false });
    f.repository.enable(f.owner, f.project.id, { idempotency_key: "resume-code-jobs" });
    const secondDevice = f.database.createDevice(f.member.user_id, "Other");
    const otherActor = f.database.authenticate(secondDevice.token);
    assert.throws(() => f.service.completeSnapshotRequest(otherActor, upload.id, codex.id, { uploaded: true }), hasCode("forbidden"));
    f.service.setProjectMembership(f.owner, f.project.id, f.member.user_id, "viewer");
    assert.throws(() => f.service.completeSnapshotRequest(f.member, upload.id, codex.id, { uploaded: true }), hasCode("forbidden"));
    assert.throws(() => f.service.createSnapshotRequest(f.member, session.id, "code_sync_status", dsh.id), hasCode("forbidden"));
  } finally { f.close(); }
});

test("HTTP code boundary returns schema-valid snapshots and has a route-scoped larger body allowance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-code-http-"));
  const running = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"), authTokenPepper: PEPPER });
  try {
    const identity = running.database.bootstrapIdentity({ display_name: "Owner", device_name: "Owner" });
    const project = running.service.createProject(identity.actor, { title: "HTTP", idempotency_key: "project-http" });
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${running.origin}${path}`, { method, headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as { data: unknown; error?: { code: string } } };
    };
    const path = `/v1/projects/${project.id}/code`;
    assert.equal(CodeStatusSchema.parse((await request(path)).body.data).repository.enabled, false);
    const enabled = CodeMutationResultSchema.parse((await request(`${path}/enable`, "POST", { idempotency_key: "http-enable" })).body.data);
    const upload = await request(`${path}/checkpoints`, "POST", { base_commit: enabled.commit, files: [file("large.txt", "a".repeat(300_000))], message: "Large bounded file", idempotency_key: "http-checkpoint" });
    assert.equal(upload.status, 200);
    const result = CodeMutationResultSchema.parse(upload.body.data);
    const downloaded = await request(`${path}/snapshot?branch_id=${result.status.own_branch_id}`);
    assert.equal(CodeSnapshotResultSchema.parse(downloaded.body.data).snapshot.commit, result.commit);
    const paused = await request(`${path}/disable`, "POST", { idempotency_key: "http-disable" });
    assert.equal(paused.status, 200);
    assert.equal(CodeMutationResultSchema.parse(paused.body.data).status.repository.enabled, false);
    assert.equal((await request(`${path}/snapshot?branch_id=${result.status.own_branch_id}`)).status, 409);
    assert.equal((await request(`${path}/enable`, "POST", { idempotency_key: "http-reenable" })).status, 200);
    assert.equal(CodeSnapshotResultSchema.parse((await request(`${path}/snapshot?branch_id=${result.status.own_branch_id}`)).body.data).snapshot.commit, result.commit);
    const bad = await request(`${path}/checkpoints`, "POST", { base_commit: result.commit, files: [file("../escape", "bad")], message: "Bad", idempotency_key: "http-bad-path" });
    assert.equal(bad.status, 400);
    const ordinary = await request(`/v1/projects`, "POST", { title: "a".repeat(300_000), idempotency_key: "ordinary-limit" });
    assert.equal(ordinary.status, 413);
  } finally { await running.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP code mutations retain cookie CSRF checks and revoked devices cannot read or retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-code-auth-"));
  const browserOrigin = "https://code-client.test";
  const running = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"), authTokenPepper: PEPPER, allowedOrigins: [browserOrigin] });
  try {
    const identity = running.database.bootstrapIdentity({ display_name: "Owner", device_name: "Owner" });
    const project = running.service.createProject(identity.actor, { title: "Code auth", idempotency_key: "project-http-auth" });
    const path = `/v1/projects/${project.id}/code`;
    const opened = await fetch(`${running.origin}/v1/browser-sessions`, {
      method: "POST", headers: { authorization: `Bearer ${identity.token}`, origin: browserOrigin, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(opened.status, 201);
    const cookie = opened.headers.get("set-cookie")!.split(";", 1)[0]!;
    const input = { idempotency_key: "cookie-code-enable" };
    const enable = async (headers: Record<string, string>) => {
      const response = await fetch(`${running.origin}${path}/enable`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() as { error?: { code: string } } };
    };
    const missingOrigin = await enable({ cookie });
    assert.equal(missingOrigin.status, 403);
    assert.equal(missingOrigin.body.error?.code, "csrf_origin_required");
    assert.equal((await enable({ cookie, origin: "https://other-client.test" })).status, 403);
    assert.equal((running.database.sqlite.prepare("SELECT count(*) AS count FROM code_repositories").get() as { count: number }).count, 0);
    assert.equal((await enable({ cookie, origin: browserOrigin })).status, 200);
    running.service.revokeDevice(identity.actor, identity.actor.device_id);
    assert.equal((await enable({ cookie, origin: browserOrigin })).status, 401);
    assert.equal((await enable({ authorization: `Bearer ${identity.token}` })).status, 401);
    assert.equal((await fetch(`${running.origin}${path}/snapshot`, { headers: { authorization: `Bearer ${identity.token}` } })).status, 401);
    assert.equal((running.database.sqlite.prepare("SELECT count(*) AS count FROM code_mutations").get() as { count: number }).count, 1);
  } finally { await running.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the maximum 1000-file snapshot uses batch Git processes rather than per-file subprocesses", () => {
  const f = fixture();
  try {
    const repo = new CountingCodeRepository(f.database, join(f.directory, "code"));
    const enabled = repo.enable(f.owner, f.project.id, { idempotency_key: "enable-project" });
    const files = Array.from({ length: 1000 }, (_, index) => file(`src/file-${index.toString().padStart(4, "0")}.ts`, `export const value = ${index};\n`));
    repo.commands = [];
    const uploaded = repo.checkpoint(f.owner, f.project.id, { base_commit: enabled.commit, files, message: "Batch files", idempotency_key: "batch-checkpoint" });
    assert.ok(repo.commands.length <= 8, JSON.stringify(repo.commands));
    assert.equal(repo.commands.filter((command) => command === "hash-object").length, 1);
    repo.commands = [];
    assert.deepEqual(repo.snapshot(f.owner, f.project.id, uploaded.status.own_branch_id!).snapshot.files, files);
    assert.deepEqual(repo.commands, ["ls-tree", "cat-file"]);
  } finally { f.close(); }
});

test("snapshot control migration preserves existing exact-target jobs and code storage survives restart", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, { project_id: f.project.id, mode: "multi", title: "Work", idempotency_key: "session-create" });
    const runtime = f.service.registerRuntime(f.owner, { session_id: session.id, device_id: f.owner.device_id, harness: "codex", provider: "test", model: "test", local_session_id: "migration", capture_fidelity: "harness_transcript", purpose: "execution" });
    const job = f.service.createSnapshotRequest(f.owner, session.id, "local_sync_status", runtime.id);
    const currentSql = (f.database.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='snapshot_requests'").get() as { sql: string }).sql;
    const legacySql = currentSql.replace(/, 'code_[^']+'/gu, "");
    f.database.sqlite.exec("ALTER TABLE snapshot_requests RENAME TO snapshot_requests_old");
    f.database.sqlite.exec(legacySql);
    f.database.sqlite.exec("INSERT INTO snapshot_requests SELECT * FROM snapshot_requests_old; DROP TABLE snapshot_requests_old");
    const reopened = new CollaborationDatabase(f.path, { authTokenPepper: PEPPER });
    try {
      const restored = reopened.getSnapshotRequest(f.owner, job.id);
      assert.equal(restored.target_runtime_id, runtime.id);
      assert.equal(restored.kind, "local_sync_status");
      assert.equal(reopened.createSnapshotRequest(f.owner, session.id, "code_sync_status", runtime.id).target_runtime_id, runtime.id);
      assert.deepEqual(reopened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});
