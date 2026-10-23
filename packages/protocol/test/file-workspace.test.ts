import assert from "node:assert/strict";
import test from "node:test";
import { FileBranchesInputSchema, FileChangesInputSchema, FileContentInputSchema, FileHistoryInputSchema,
  FileMutationInputSchema, FileTreeInputSchema } from "../src/file-workspace.js";

const commit = "a".repeat(40);
const write = (path: string, bytes: number) => ({ type: "write", path, content_base64: Buffer.alloc(bytes).toString("base64") });
const mutation = { provider: "gt-cloud", branch_id: "own", base_commit: commit,
  operations: [write("src/main.ts", 1)], message: "Edit", idempotency_key: "file-change-1" };

test("file workspace schemas accept provider selections and reject unknown fields and revision expressions", () => {
  assert.deepEqual(FileHistoryInputSchema.parse({ provider: "gt-cloud", branch_id: "own" }),
    { provider: "gt-cloud", branch_id: "own", limit: 30 });
  assert.equal(FileBranchesInputSchema.safeParse({ provider: "github", connection_revision: "project-revision" }).success, true);
  assert.equal(FileTreeInputSchema.safeParse({ provider: "github", branch_id: "feature/a", commit }).success, true);
  assert.equal(FileChangesInputSchema.safeParse({ provider: "gt-cloud", branch_id: "main", base_commit: commit }).success, true);
  for (const schema of [FileTreeInputSchema, FileHistoryInputSchema, FileChangesInputSchema]) {
    assert.equal(schema.safeParse({ provider: "gt-cloud", branch_id: "main", commit: "main~1" }).success, false);
    assert.equal(schema.safeParse({ provider: "gt-cloud", branch_id: "main", arbitrary: true }).success, false);
  }
  assert.equal(FileHistoryInputSchema.safeParse({ provider: "gt-cloud", branch_id: "main", limit: 101 }).success, false);
  assert.equal(FileHistoryInputSchema.safeParse({ provider: "gt-cloud", branch_id: "main", cursor: "HEAD" }).success, false);
  assert.equal(FileBranchesInputSchema.safeParse({ provider: "local" }).success, false);
  assert.equal(FileTreeInputSchema.safeParse({ provider: "gt-cloud", branch_id: "x".repeat(513) }).success, false);
});

test("file operations enforce safe paths, bounded batches and provider write limits", () => {
  assert.equal(FileMutationInputSchema.safeParse(mutation).success, true);
  assert.equal(FileMutationInputSchema.safeParse({ ...mutation, operations: [] }).success, false);
  assert.equal(FileMutationInputSchema.safeParse({ ...mutation, operations: Array(101).fill(write("file.txt", 0)) }).success, false);
  assert.equal(FileMutationInputSchema.safeParse({ ...mutation, operations: [{ ...write("file.txt", 0), overwrite: true }] }).success, false);
  for (const content_base64 of ["=AAA", "A===", "AA=", "AA!A", "===="]) {
    assert.equal(FileMutationInputSchema.safeParse({ ...mutation, operations: [{ type: "write", path: "file.bin", content_base64 }] }).success, false);
  }
  for (const path of ["../outside", "/absolute", ".git/config", ".env", "folder\\file", "NUL.txt", "foo/.ssh/id", "a/.co\u200ddex/state"]) {
    assert.equal(FileContentInputSchema.safeParse({ provider: "gt-cloud", branch_id: "main", path }).success, false, path);
    assert.equal(FileMutationInputSchema.safeParse({ ...mutation, operations: [write(path, 0)] }).success, false, path);
    assert.equal(FileMutationInputSchema.safeParse({ ...mutation, operations: [{ type: "move", path: "safe", destination: path }] }).success, false, path);
  }
  assert.equal(FileMutationInputSchema.safeParse({ ...mutation, operations: [write("file.bin", 2 * 1024 * 1024 + 1)] }).success, false);
  assert.equal(FileMutationInputSchema.safeParse({ ...mutation, provider: "github", operations: [write("file.bin", 8 * 1024 * 1024)] }).success, true);
  assert.equal(FileMutationInputSchema.safeParse({ ...mutation, provider: "github", operations: [write("file.bin", 8 * 1024 * 1024 + 1)] }).success, false);
  assert.equal(FileMutationInputSchema.safeParse({ ...mutation, provider: "github", operations: [write("one.bin", 5 * 1024 * 1024), write("two.bin", 4 * 1024 * 1024)] }).success, false);
});
