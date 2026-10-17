import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mobileCodeStage, mobileRepositoryLink } from "../src/mobile-code-view.js";

test("mobile code stage follows the existing cloud controller's visible page", () => {
  assert.equal(mobileCodeStage(), "unavailable");
  assert.equal(mobileCodeStage({ controlsHidden: false, accountHidden: false }), "account");
  assert.equal(mobileCodeStage({ controlsHidden: false, repositoryHidden: false }), "repository");
  assert.equal(mobileCodeStage({ controlsHidden: false, homeHidden: false }), "ready");
  assert.equal(mobileCodeStage({ controlsHidden: false }), "loading");
  assert.equal(mobileCodeStage({ controlsHidden: true, homeHidden: false }), "unavailable");
});

test("repository cards create only canonical GitHub repository links", () => {
  assert.deepEqual(mobileRepositoryLink(" example-user/a-project "), {
    repository: "example-user/a-project", href: "https://github.com/example-user/a-project",
  });
  for (const input of ["", null, {}, "https://github.com/a/b", "a/b/c", "a/..", "a/.",
    "a/b?token=private", "a/b#fragment", "a/b%2fc", "a/b\nother", "../b", "a/你好"]) {
    assert.equal(mobileRepositoryLink(input), null, String(input));
  }
});

test("mobile code view does not duplicate API actions or alter current form state", async () => {
  const source = await readFile(new URL("../src/mobile-code-view.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|\.click\(|dispatchEvent\(|\.value\s*=/u);
  assert.doesNotMatch(source, /el\([^\n]+\)\.hidden\s*=/u, "controller-owned visibility is untouched");
  assert.match(source, /data-mobile-workspace/u);
  assert.match(source, /removeEventListener/u);
});

test("mobile code styles stay behind explicit mobile presentation and hide native transfers", async () => {
  const css = await readFile(new URL("../src/mobile-code-view.css", import.meta.url), "utf8");
  for (const id of ["github-code-section", "code-device-view", "code-branches-view", "cloud-github-pr-form"]) {
    assert.match(css, new RegExp(`html\\[data-mobile-workspace="true"\\] #project-code-dialog #${id}`));
  }
  assert.doesNotMatch(css, /@media\s*\(max-width/u, "mode choice, not viewport width, owns this view");
});
