import test from "node:test";
import assert from "node:assert/strict";
import { repositoryParts, repositoryFromFields, newRepositoryUrl } from "../src/github-setup.js";
import { githubRepositoryAllowed } from "../src/github-code-sync.js";

test("separate account and repository fields preserve the existing wire contract", () => {
  assert.deepEqual(repositoryParts("team/project"), { owner: "team", name: "project" });
  assert.equal(repositoryFromFields(" team ", " project "), "team/project");
  assert.equal(githubRepositoryAllowed(repositoryFromFields("team", "project")), true);
  for (const name of ["../escape", "repo.git", ".", "", "a/b"]) assert.equal(githubRepositoryAllowed(repositoryFromFields("team", name)), false);
});
test("new-repository links cannot include credentials or change destination", () => {
  const url = new URL(newRepositoryUrl("my-project"));
  assert.equal(url.origin, "https://github.com"); assert.equal(url.pathname, "/new");
  assert.equal(url.searchParams.get("name"), "my-project");
  for (const value of ["https://evil.invalid", "token=private", "../escape"]) assert.equal(newRepositoryUrl(value), "https://github.com/new");
});
