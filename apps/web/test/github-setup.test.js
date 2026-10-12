import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repositoryParts, repositoryFromFields, newRepositoryUrl } from "../src/github-setup.js";
import { githubRepositoryAllowed } from "../src/github-code-sync.js";

test("separate account and repository fields preserve the existing wire contract", () => {
  assert.deepEqual(repositoryParts("team/project"), { owner: "team", name: "project" });
  assert.equal(repositoryFromFields(" team ", " project "), "team/project");
  assert.equal(githubRepositoryAllowed(repositoryFromFields("team", "project")), true);
  for (const name of ["../escape", "repo.git", ".", "", "a/b"]) assert.equal(githubRepositoryAllowed(repositoryFromFields("team", name)), false);
});

test("file setup starts with recommended storage and keeps computer actions below account setup", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /class="github-mode-picker"/);
  assert.match(html, /id="code-provider-github"[^>]+aria-pressed="true"/);
  assert.match(html, /id="code-gt-cloud-panel" hidden/);
  assert.match(html, /id="cloud-github-authorize"[^>]*>Connect your GitHub account/);
  assert.ok(html.indexOf('id="github-mode-local"') > html.indexOf('id="cloud-github-authorize"'));
  assert.match(html, /id="github-mode-local"[^>]*>Sync files from my computer/);
  assert.doesNotMatch(html, /id="cloud-github-title">Use GitHub with Cloud Agent/);
});
test("new-repository links cannot include credentials or change destination", () => {
  const url = new URL(newRepositoryUrl("my-project"));
  assert.equal(url.origin, "https://github.com"); assert.equal(url.pathname, "/new");
  assert.equal(url.searchParams.get("name"), "my-project");
  for (const value of ["https://evil.invalid", "token=private", "../escape"]) assert.equal(newRepositoryUrl(value), "https://github.com/new");
});
