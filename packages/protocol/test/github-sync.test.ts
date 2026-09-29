import assert from "node:assert/strict";
import test from "node:test";
import { GitHubBranchSchema, GitHubConnectionSchema, GitHubConnectionInputSchema, GitHubRepositorySchema,
  CreateSnapshotRequestInputSchema, githubCodeSyncRequestKinds, isCodeSyncRequestKind, isGitHubCodeSyncRequestKind } from "../src/index.js";

test("GitHub metadata accepts only bounded slugs and safe refs, and rejects credentials and unknown fields", () => {
  for (const repository of ["owner/project", "org-name/my.repo_1"]) assert.equal(GitHubRepositorySchema.parse(repository), repository);
  for (const repository of ["https://github.com/owner/repo", "git@github.com:owner/repo", "owner/repo.git", "owner/repo/extra", "owner/..", "owner/repo;id", "owner/repo\n", "-owner/repo", "a/" + "x".repeat(101)]) {
    assert.equal(GitHubRepositorySchema.safeParse(repository).success, false, repository);
  }
  for (const branch of ["main", "release/v1.0", "my_branch"]) assert.equal(GitHubBranchSchema.parse(branch), branch);
  for (const branch of ["", "-main", "main..old", "a//b", ".main", "a/.b", "a.lock", "a./b", "a/", "a@{0}", "a;id", "a b", "a\n", "HEAD"]) {
    assert.equal(GitHubBranchSchema.safeParse(branch).success, false, branch);
  }
  const input = { repository: "owner/repo", base_branch: "main", enabled: true, expected_revision: null };
  assert.deepEqual(GitHubConnectionInputSchema.parse(input), input);
  for (const key of ["token", "access_token", "url", "branch", "files"]) {
    assert.equal(GitHubConnectionInputSchema.safeParse({ ...input, [key]: "unapproved" }).success, false);
  }
});

test("GitHub jobs are accepted without reclassifying cloud checkpoint kinds", () => {
  for (const kind of githubCodeSyncRequestKinds) {
    assert.equal(CreateSnapshotRequestInputSchema.parse({ kind }).kind, kind);
    assert.equal(isGitHubCodeSyncRequestKind(kind), true);
    assert.equal(isCodeSyncRequestKind(kind), false);
  }
  assert.equal(isGitHubCodeSyncRequestKind("code_upload"), false);
  assert.equal(isGitHubCodeSyncRequestKind("github_code_execute"), false);
});

test("GitHub connection base cannot enter the personal namespace, while generic refs remain valid", () => {
  const revision = "f2a3b4c5-6789-4abc-8def-0123456789ab";
  for (const base_branch of ["gatherthread/member", `gatherthread/${"a".repeat(24)}/${"b".repeat(24)}`]) {
    assert.equal(GitHubBranchSchema.safeParse(base_branch).success, true);
    const connection = { repository: "owner/repo", base_branch, enabled: true, revision };
    assert.equal(GitHubConnectionSchema.safeParse(connection).success, false);
    assert.equal(GitHubConnectionInputSchema.safeParse({ repository: connection.repository, base_branch, enabled: true, expected_revision: null }).success, false);
  }
  for (const base_branch of ["main", "release/gatherthread/v1", "gatherthread-main"]) {
    assert.equal(GitHubConnectionSchema.safeParse({ repository: "owner/repo", base_branch, enabled: true, revision }).success, true);
    assert.equal(GitHubConnectionInputSchema.safeParse({ repository: "owner/repo", base_branch, enabled: true, expected_revision: revision }).success, true);
  }
});
