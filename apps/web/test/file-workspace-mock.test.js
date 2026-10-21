import assert from "node:assert/strict";
import test from "node:test";
import { FileBranchesResultSchema, FileTreeResultSchema, FileContentResultSchema, FileHistoryResultSchema,
  FileChangesResultSchema, FileMutationResultSchema } from "@gatherthread/protocol";
import { MockCollaborationApi } from "../src/api.js";
import { ExampleCollaborationApi } from "../src/example-api.js";
import { MockFileWorkspace } from "../src/file-workspace-mock.js";

const write = (path, text) => ({ type: "write", path, content_base64: btoa(text) });
const hasCode = (code) => (error) => error.code === code;
async function fixture() {
  const api = new MockCollaborationApi({ latency: 0 }), files = new MockFileWorkspace(api), projectId = api.projects[0].id;
  await api.mutateProjectCode(projectId, "enable", { idempotency_key: "mock-files-enable" });
  const branches = await files.branches(projectId, { provider: "gt-cloud" });
  return { api, files, projectId, initial: branches.branches[0].head_commit };
}
const edit = (f, branch, base, operations, key) => f.files.mutate(f.projectId, { provider: "gt-cloud", branch_id: branch,
  base_commit: base, operations, message: "Edit files", idempotency_key: key });

test("mock file APIs seed authored Example snapshots and preserve historical content after edits", async () => {
  const api = new ExampleCollaborationApi("zh-CN"), files = new MockFileWorkspace(api), projectId = api.projects[0].id;
  const branches = FileBranchesResultSchema.parse(await files.branches(projectId, { provider: "gt-cloud" }));
  assert.equal(branches.default_branch_id, "branch-example");
  const tree = FileTreeResultSchema.parse(await files.tree(projectId, { provider: "gt-cloud", branch_id: "branch-example" }));
  assert.equal(tree.entries.length, 6);
  const before = FileContentResultSchema.parse(await files.content(projectId, { provider: "gt-cloud", branch_id: "branch-example", path: "src/signup.js" }));
  assert.match(new TextDecoder().decode(Uint8Array.from(atob(before.content_base64), (character) => character.charCodeAt(0))), /报名成功/u);
  const saved = FileMutationResultSchema.parse(await files.mutate(projectId, { provider: "gt-cloud", branch_id: "branch-example", base_commit: tree.commit,
    operations: [write("src/signup.js", "// practice edit")], message: "Practice", idempotency_key: "example-file-edit" }));
  assert.notEqual(saved.commit, tree.commit);
  assert.equal((await files.content(projectId, { provider: "gt-cloud", branch_id: "branch-example", path: "src/signup.js" })).content_base64, btoa("// practice edit"));
  assert.equal((await files.content(projectId, { provider: "gt-cloud", branch_id: "branch-example", commit: tree.commit, path: "src/signup.js" })).content_base64, before.content_base64);
  assert.equal(api.codeRepositories.get(projectId).branches[0].head_commit, saved.commit);
  assert.equal(FileTreeResultSchema.parse(await files.tree(projectId, { provider: "gt-cloud", branch_id: "branch-maya" })).can_write, false);
});

test("example file API reads keep AbortSignal outside strict protocol validation", async () => {
  const api = new ExampleCollaborationApi(), project = "project-orbit", signal = new AbortController().signal;
  const branches = FileBranchesResultSchema.parse(await api.getFileBranches(project, { provider: "gt-cloud", signal }));
  assert.ok(branches.branches.some(branch => branch.id === "branch-maya"));
  const selection = { provider: "gt-cloud", branch_id: "branch-maya", signal };
  const tree = FileTreeResultSchema.parse(await api.getFileTree(project, selection)); assert.equal(tree.entries.length, 6);
  const content = FileContentResultSchema.parse(await api.getFileContent(project, { ...selection, path: "src/signup.js" }));
  assert.match(atob(content.content_base64), /addEventListener/u);
  assert.ok(FileHistoryResultSchema.parse(await api.getFileHistory(project, selection)).commits.length);
  assert.deepEqual(FileChangesResultSchema.parse(await api.getFileChanges(project, selection)).files,
    [{ path: "src/signup.js", status: "modified" }]);
  await assert.rejects(api.getFileBranches(project, { provider: "gt-cloud", signal, unknown_field: true }),
    error => error.issues?.some(issue => issue.code === "unrecognized_keys" && issue.keys.includes("unknown_field")));
});

test("mock manager preserves original-operation receipts, CAS, metadata changes and branch history", async () => {
  const f = await fixture();
  const first = await edit(f, "own", f.initial, [write("folder/a.txt", "a"), write("folder/nested/b.txt", "b")], "mock-file-seed");
  const input = { provider: "gt-cloud", branch_id: first.branch_id, base_commit: first.commit,
    operations: [{ type: "copy", path: "folder", destination: "copy" }, { type: "move", path: "folder", destination: "moved" },
      { type: "delete", path: "copy/nested" }], message: "Manage folders", idempotency_key: "mock-file-manage" };
  const saved = await f.files.mutate(f.projectId, input);
  const next = await edit(f, saved.branch_id, saved.commit, [write("copy/a.txt", "changed")], "mock-file-next");
  assert.deepEqual(await f.files.mutate(f.projectId, input), saved);
  assert.equal((await f.files.tree(f.projectId, { provider: "gt-cloud", branch_id: saved.branch_id })).commit, next.commit);
  assert.deepEqual(FileChangesResultSchema.parse(await f.files.changes(f.projectId, { provider: "gt-cloud", branch_id: saved.branch_id })).files,
    [{ path: "copy/a.txt", status: "modified" }]);
  await assert.rejects(f.files.mutate(f.projectId, { ...input, operations: [{ type: "delete", path: "moved" }] }), hasCode("idempotency_conflict"));
  await assert.rejects(edit(f, saved.branch_id, first.commit, [write("stale.txt", "bad")], "mock-file-stale"), hasCode("code_stale_head"));
  const page = FileHistoryResultSchema.parse(await f.files.history(f.projectId, { provider: "gt-cloud", branch_id: saved.branch_id, limit: 1 }));
  assert.equal(page.commits[0].id, next.commit);
  const older = await f.files.history(f.projectId, { provider: "gt-cloud", branch_id: saved.branch_id, cursor: page.next_cursor, limit: 100 });
  assert.equal(older.commits[0].id, saved.commit);
  await assert.rejects(f.files.tree(f.projectId, { provider: "gt-cloud", branch_id: "main", commit: next.commit }), hasCode("not_found"));
  await f.api.clearOwnCodeBranch(f.projectId, { expected_head_commit: next.commit });
  await assert.rejects(f.files.mutate(f.projectId, input), hasCode("code_data_cleared"));
});

test("mock editing validates ownership, viewers, portable conflicts and atomic batches", async () => {
  const f = await fixture(), first = await edit(f, "own", f.initial, [write("folder/a.txt", "a")], "mock-safe-seed");
  await assert.rejects(edit(f, "main", f.initial, [write("main.txt", "bad")], "mock-write-main"), hasCode("forbidden"));
  await assert.rejects(edit(f, first.branch_id, first.commit, [write("temporary.txt", "rolled back"),
    { type: "move", path: "folder", destination: "FOLDER" }], "mock-alias-write"), hasCode("file_path_conflict"));
  assert.deepEqual((await f.files.tree(f.projectId, { provider: "gt-cloud", branch_id: first.branch_id })).entries.map((entry) => entry.path), ["folder/a.txt"]);
  await assert.rejects(edit(f, first.branch_id, first.commit, [write(".env", "secret")], "mock-private-file"));
  f.api.projects[0].role = "viewer";
  assert.equal((await f.files.tree(f.projectId, { provider: "gt-cloud", branch_id: first.branch_id })).can_write, false);
  await assert.rejects(edit(f, first.branch_id, first.commit, [write("folder/a.txt", "bad")], "mock-viewer-write"), hasCode("forbidden"));
});

test("GitHub mock stays unavailable until configured and fences exact connection revisions", async () => {
  const f = await fixture();
  await assert.rejects(f.files.branches(f.projectId, { provider: "github" }), hasCode("file_provider_unavailable"));
  f.api.githubConnections.set(f.projectId, { enabled: true, repository: "example/project", base_branch: "main", revision: "revision-one" });
  const branches = FileBranchesResultSchema.parse(await f.files.branches(f.projectId, { provider: "github" }));
  assert.equal(branches.connection_revision, "revision-one");
  await assert.rejects(f.files.tree(f.projectId, { provider: "github", branch_id: "main", connection_revision: "revision-old" }), hasCode("github_revision_conflict"));
  const own = await f.files.mutate(f.projectId, { provider: "github", branch_id: "own", connection_revision: "revision-one", base_commit: branches.branches[0].head_commit,
    operations: [write("github.txt", "example")], message: "GitHub preview", idempotency_key: "mock-github-edit" });
  assert.equal((await f.files.content(f.projectId, { provider: "github", branch_id: own.branch_id, path: "github.txt" })).content_base64, btoa("example"));
  f.api.githubConnections.get(f.projectId).revision = "revision-two";
  await assert.rejects(f.files.tree(f.projectId, { provider: "github", branch_id: own.branch_id, connection_revision: "revision-one" }), hasCode("github_revision_conflict"));
});
