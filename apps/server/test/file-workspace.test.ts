import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLOUD_CODE_SYNC_LIMITS, FileBranchesResultSchema, FileChangesResultSchema, FileContentResultSchema, FileHistoryResultSchema,
  FileMutationResultSchema, FileTreeResultSchema, type FileMutationInput, type FileOperation } from "@gatherthread/protocol";
import { CodeRepository } from "../src/code-repository.js";
import { CollaborationDatabase, type Actor } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { FileWorkspace, applyFileOperations } from "../src/file-workspace.js";
import { CollaborationService } from "../src/service.js";

const encoded = (text: string) => Buffer.from(text).toString("base64");
const write = (path: string, text: string): FileOperation => ({ type: "write", path, content_base64: encoded(text) });
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-files-test-"));
  const path = join(directory, "state.sqlite");
  const database = new CollaborationDatabase(path, { authTokenPepper: "file-workspace-test-pepper-not-a-credential" });
  const service = new CollaborationService(database);
  const owner = database.bootstrapIdentity({ display_name: "Owner", device_name: "Owner" }).actor;
  const member = database.createIdentity({ display_name: "Member", device_name: "Member" }).actor;
  const viewer = database.createIdentity({ display_name: "Viewer", device_name: "Viewer" }).actor;
  const outsider = database.createIdentity({ display_name: "Outside", device_name: "Outside" }).actor;
  const project = service.createProject(owner, { title: "Files", idempotency_key: "files-project-1" });
  for (const [actor, role] of [[member, "participant"], [viewer, "viewer"]] as const) {
    const invitation = service.createProjectInvitation(owner, project.id, { role, ttl: "1h" });
    service.claimInvitationForActor(actor, invitation.invite_token);
  }
  const repository = new CodeRepository(database, join(directory, "code"));
  const workspace = new FileWorkspace(database, repository);
  const initial = repository.enable(owner, project.id, { idempotency_key: "files-enable-1" }).commit;
  const mutate = (actor: Actor, branch: string, base: string, operations: FileOperation[], key: string) =>
    FileMutationResultSchema.parse(workspace.mutate(actor, project.id, {
      provider: "gt-cloud", branch_id: branch, base_commit: base, operations, message: "File change", idempotency_key: key,
    }));
  return { directory, path, database, service, owner, member, viewer, outsider, project, repository, workspace, initial, mutate,
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("file workspace lists readable member branches and creates only the writer's personal branch", () => {
  const f = fixture();
  try {
    const branches = FileBranchesResultSchema.parse(f.workspace.branches(f.member, f.project.id, { provider: "gt-cloud" }));
    assert.equal(branches.default_branch_id, "own");
    assert.equal(branches.branches.find((branch) => branch.id === "own")?.can_write, true);
    const first = f.mutate(f.member, "own", f.initial, [write("src/index.ts", "let value = 1;\n")], "files-first-edit");
    assert.match(first.branch_id, /^branch-/u);
    const read = FileTreeResultSchema.parse(f.workspace.tree(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id }));
    assert.equal(read.can_write, false);
    assert.deepEqual(read.entries.map((entry) => entry.path), ["src/index.ts"]);
    assert.equal(FileTreeResultSchema.parse(f.workspace.tree(f.owner, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id })).can_write, false);
    const viewers = FileBranchesResultSchema.parse(f.workspace.branches(f.viewer, f.project.id, { provider: "gt-cloud" }));
    assert.equal(viewers.default_branch_id, "main");
    assert.equal(viewers.branches.some((branch) => branch.can_write), false);
    assert.throws(() => f.mutate(f.viewer, first.branch_id, first.commit, [write("src/index.ts", "bad")], "viewer-edit-1"), hasCode("forbidden"));
    assert.throws(() => f.mutate(f.owner, first.branch_id, first.commit, [write("src/index.ts", "bad")], "owner-other-edit"), hasCode("forbidden"));
    assert.throws(() => f.mutate(f.owner, "main", f.initial, [write("src/index.ts", "bad")], "owner-main-edit"), hasCode("forbidden"));
    assert.throws(() => f.workspace.tree(f.outsider, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id }), hasCode("not_found"));
    assert.throws(() => f.mutate(f.member, first.branch_id, f.initial, [write("src/index.ts", "stale")], "stale-file-edit"), hasCode("code_stale_head"));
    f.service.revokeDevice(f.member, f.member.device_id);
    assert.throws(() => f.workspace.content(f.member, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, path: "src/index.ts" }), hasCode("unauthorized"));
  } finally { f.close(); }
});

test("copy, move and recursive delete replay their original receipt after the tree changes", () => {
  const f = fixture();
  try {
    const first = f.mutate(f.member, "own", f.initial, [write("folder/a.txt", "A"), write("folder/nested/b.txt", "B")], "operations-seed");
    const request: FileMutationInput = { provider: "gt-cloud", branch_id: first.branch_id, base_commit: first.commit,
      operations: [{ type: "copy", path: "folder", destination: "copy" }, { type: "move", path: "folder", destination: "renamed" },
        { type: "delete", path: "copy/nested" }], message: "Manage directories", idempotency_key: "original-operations" };
    const managed = FileMutationResultSchema.parse(f.workspace.mutate(f.member, f.project.id, request));
    assert.deepEqual(FileTreeResultSchema.parse(f.workspace.tree(f.owner, f.project.id, { provider: "gt-cloud", branch_id: managed.branch_id })).entries.map((file) => file.path),
      ["copy/a.txt", "renamed/a.txt", "renamed/nested/b.txt"]);
    const after = f.mutate(f.member, managed.branch_id, managed.commit, [{ type: "delete", path: "renamed" }, write("copy/a.txt", "new")], "after-manage-edit");
    assert.deepEqual(f.workspace.mutate(f.member, f.project.id, request), managed);
    assert.equal(f.repository.status(f.member, f.project.id).branches[0]?.head_commit, after.commit);
    assert.throws(() => f.workspace.mutate(f.member, f.project.id, { ...request, operations: [{ type: "delete", path: "copy" }] }), hasCode("idempotency_conflict"));
    const reopened = new CollaborationDatabase(f.path, { authTokenPepper: "file-workspace-test-pepper-not-a-credential" });
    try {
      assert.deepEqual(new FileWorkspace(reopened, new CodeRepository(reopened, join(f.directory, "code"))).mutate(f.member, f.project.id, request), managed);
    } finally { reopened.close(); }
    f.repository.clearBranch(f.member, f.project.id, { expected_head_commit: after.commit, idempotency_key: "clear-files-branch" });
    assert.throws(() => f.workspace.mutate(f.member, f.project.id, request), hasCode("code_data_cleared"));
  } finally { f.close(); }
});

test("file manager rejects overwrites and portable path aliases and rolls back failed operation batches", () => {
  const f = fixture();
  try {
    const first = f.mutate(f.member, "own", f.initial, [write("src/a.ts", "A"), write("dest/b.ts", "B")], "conflict-seed-1");
    const rejected: FileOperation[][] = [
      [{ type: "copy", path: "src", destination: "dest" }],
      [{ type: "move", path: "src/a.ts", destination: "src/a.ts" }],
      [{ type: "move", path: "src", destination: "SRC" }],
      [{ type: "copy", path: "src", destination: "src/inside" }],
      [write("SRC/a.ts", "alias")], [write("SRC/another.ts", "directory alias")],
      [write("src", "file directory overlap")],
      [write("new.txt", "rolled back"), { type: "move", path: "src/a.ts", destination: "dest/b.ts" }],
    ];
    for (const [index, operations] of rejected.entries()) {
      assert.throws(() => f.mutate(f.member, first.branch_id, first.commit, operations, `conflict-request-${index}`), hasCode("file_path_conflict"));
    }
    assert.throws(() => f.mutate(f.member, first.branch_id, first.commit, [{ type: "delete", path: "missing" }], "missing-delete-1"), hasCode("not_found"));
    assert.deepEqual(FileTreeResultSchema.parse(f.workspace.tree(f.member, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id })).entries.map((entry) => entry.path), ["dest/b.ts", "src/a.ts"]);
    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM code_mutations WHERE operation='file_workspace'").get() as { count: number }).count, 1);
  } finally { f.close(); }
});

test("selected file reads preserve binary PDF bytes; history and changes admit only selected reachable commits", () => {
  const f = fixture();
  try {
    const pdf = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 254, 10]);
    const first = f.mutate(f.member, "own", f.initial, [
      { type: "write", path: "paper.pdf", content_base64: pdf.toString("base64") },
      { type: "write", path: "bin/start", content_base64: encoded("exit 0\n"), executable: true },
      write("deleted.txt", "old"),
    ], "binary-history-seed");
    const second = f.mutate(f.member, first.branch_id, first.commit, [write("added.txt", "new"), write("bin/start", "exit 1\n"),
      { type: "delete", path: "deleted.txt" }], "binary-history-second");
    const binary = FileContentResultSchema.parse(f.workspace.content(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, path: "paper.pdf" }));
    assert.deepEqual(Buffer.from(binary.content_base64, "base64"), pdf);
    assert.equal(binary.size, pdf.length);
    assert.equal(FileContentResultSchema.parse(f.workspace.content(f.member, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, path: "bin/start" })).executable, true);
    const page = FileHistoryResultSchema.parse(f.workspace.history(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, limit: 1 }));
    assert.equal(page.commits[0]?.id, second.commit);
    assert.equal(page.next_cursor, second.commit);
    const older = FileHistoryResultSchema.parse(f.workspace.history(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, cursor: page.next_cursor, limit: 2 }));
    assert.deepEqual(older.commits.map((entry) => entry.id), [first.commit, f.initial]);
    assert.equal(older.next_cursor, undefined);
    assert.deepEqual(FileHistoryResultSchema.parse(f.workspace.history(f.viewer, f.project.id,
      { provider: "gt-cloud", branch_id: first.branch_id, path: "paper.pdf" })).commits.map((entry) => entry.id), [first.commit]);
    assert.deepEqual(FileChangesResultSchema.parse(f.workspace.changes(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id })).files,
      [{ path: "added.txt", status: "added" }, { path: "bin/start", status: "modified" }, { path: "deleted.txt", status: "deleted" }]);
    assert.equal(FileTreeResultSchema.parse(f.workspace.tree(f.member, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, commit: first.commit })).can_write, false);
    const sibling = f.mutate(f.owner, "own", f.initial, [write("private-to-this-branch.txt", "visible only with selected branch")], "other-branch-seed");
    for (const method of ["tree", "content", "history", "changes"] as const) {
      assert.throws(() => f.workspace[method](f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id,
        commit: sibling.commit, ...(method === "content" ? { path: "private-to-this-branch.txt" } : {}) }), hasCode("not_found"));
    }
    assert.throws(() => f.workspace.history(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, cursor: sibling.commit }), hasCode("not_found"));
    assert.throws(() => f.workspace.changes(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, base_commit: sibling.commit }), hasCode("not_found"));
    assert.equal(FileContentResultSchema.parse(f.workspace.content(f.viewer, f.project.id, { provider: "gt-cloud", branch_id: sibling.branch_id, path: "private-to-this-branch.txt" })).size > 0, true);
    f.repository.clearBranch(f.member, f.project.id, { expected_head_commit: second.commit, idempotency_key: "history-clear-branch" });
    assert.throws(() => f.workspace.tree(f.member, f.project.id, { provider: "gt-cloud", branch_id: "own", commit: second.commit }), hasCode("not_found"));
    assert.throws(() => f.workspace.tree(f.owner, f.project.id, { provider: "gt-cloud", branch_id: "main", commit: "f".repeat(40) }), hasCode("not_found"));
  } finally { f.close(); }
});

test("unsafe uploads, secret content, provider confusion and quota violations leave the head unchanged", () => {
  const f = fixture();
  try {
    const first = f.mutate(f.member, "own", f.initial, [write("safe.txt", "safe")], "validation-seed-1");
    assert.throws(() => f.mutate(f.member, first.branch_id, first.commit, [write(".env", "unsafe")], "private-path-edit"));
    assert.throws(() => f.mutate(f.member, first.branch_id, first.commit, [write("secret.txt", ["-----BEGIN", "PRIVATE KEY-----"].join(" "))], "secret-file-edit"), hasCode("code_secret_detected"));
    assert.throws(() => f.mutate(f.member, first.branch_id, first.commit, [{ type: "write", path: "huge.bin", content_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") }], "too-large-file-edit"));
    assert.throws(() => f.workspace.tree(f.member, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id, connection_revision: "github-revision" }), hasCode("file_provider_mismatch"));
    assert.throws(() => f.workspace.branches(f.member, f.project.id, { provider: "github" }), hasCode("file_provider_unavailable"));
    f.database.sqlite.prepare("UPDATE code_repositories SET charged_bytes=? WHERE project_id=?")
      .run(256 * 1024 * 1024, f.project.id);
    assert.throws(() => f.mutate(f.member, first.branch_id, first.commit, [write("safe.txt", "edited")], "quota-file-edit"), hasCode("code_storage_quota_exceeded"));
    assert.equal(f.repository.status(f.member, f.project.id).branches[0]?.head_commit, first.commit);
  } finally { f.close(); }
});

test("pure file operations preserve executable bytes and reject HFS aliases", () => {
  const original = [{ path: "a.ts", content_base64: encoded("original"), executable: true }];
  const copied = applyFileOperations(original, [{ type: "copy", path: "a.ts", destination: "b.ts" }]);
  assert.equal(copied[1]?.executable, true);
  assert.equal(original.length, 1);
  assert.throws(() => applyFileOperations(original, [write("a\u200c.ts", "alias")]), hasCode("file_path_conflict"));
});

test("cloud operations reject expanding intermediate trees even when later deletes would fit", () => {
  const f = fixture();
  try {
    const first = f.mutate(f.member, "own", f.initial, [write("a/x", "x")], "expansion-seed");
    const operations: FileOperation[] = [];
    for (let index = 0; index < 13; index++) {
      operations.push({ type: "copy", path: "a", destination: `b${index}` },
        { type: "copy", path: `b${index}`, destination: `a/n${index}` });
    }
    operations.push({ type: "delete", path: "a" });
    for (let index = 0; index < 13; index++) operations.push({ type: "delete", path: `b${index}` });
    assert.throws(() => f.mutate(f.member, first.branch_id, first.commit, operations, "expanding-cloud-tree"), hasCode("code_storage_quota_exceeded"));
    assert.equal(f.repository.status(f.member, f.project.id).branches[0]?.head_commit, first.commit);
    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM code_mutations WHERE idempotency_key='expanding-cloud-tree'").get() as { count: number }).count, 0);
    assert.deepEqual(FileTreeResultSchema.parse(f.workspace.tree(f.member, f.project.id, { provider: "gt-cloud", branch_id: first.branch_id })).entries.map(file => file.path), ["a/x"]);
  } finally { f.close(); }
});

test("cloud copy budgets count decoded bytes and allow the exact snapshot boundary", () => {
  const original = [{ path: "source/file.bin", content_base64: Buffer.alloc(CLOUD_CODE_SYNC_LIMITS.maxFileBytes).toString("base64"), executable: false }];
  const copies: FileOperation[] = ["one", "two", "three"].map(destination => ({ type: "copy", path: "source", destination }));
  assert.equal(applyFileOperations(original, copies).length, 4);
  assert.throws(() => applyFileOperations(original, [...copies,
    { type: "copy", path: "source", destination: "four" }, { type: "delete", path: "four" }]), hasCode("code_storage_quota_exceeded"));
  const moveAfterDelete: FileOperation[] = [...copies, { type: "delete", path: "one" }, { type: "move", path: "source", destination: "moved" },
    { type: "copy", path: "moved", destination: "replacement" }];
  assert.equal(applyFileOperations(original, moveAfterDelete).length, 4);
});

test("cloud copy and move validate expanded descendant paths before later operations", () => {
  const original = [{ path: `source/${"n".repeat(240)}/${"f".repeat(240)}`, content_base64: encoded("source"), executable: false }];
  const destination = "renamed-directory-with-a-long-prefix";
  for (const type of ["copy", "move"] as const) {
    assert.throws(() => applyFileOperations(original, [{ type, path: "source", destination }, { type: "delete", path: destination }]));
  }
});
