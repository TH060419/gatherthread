import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const revision = "20261018-tabs-2";
const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(root, "src");

test("the HTML, stylesheet and bootstrap use the integrated deletion cache revision", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const bootstrap = await readFile(path.join(sourceRoot, "bootstrap.js"), "utf8");
  assert.ok(html.includes(`./src/bootstrap.js?v=${revision}`));
  assert.ok(html.includes(`./src/styles.css?v=${revision}`));
  assert.ok(bootstrap.includes(`./main.js?v=${revision}`));
});

test("all affected dependency paths use one revision, including API, deletion, native, settings and examples", async () => {
  const files = (await readdir(sourceRoot)).filter(name => name.endsWith(".js"));
  const edges = [];
  for (const file of files) {
    const source = await readFile(path.join(sourceRoot, file), "utf8");
    const imports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.\.?\/[^"']+\.js(?:\?[^"']*)?)["']/g;
    for (const match of source.matchAll(imports)) {
      edges.push({ file, target: path.basename(match[1].split("?")[0]), specifier: match[1] });
    }
  }
  const affected = new Set([
    "agent-request-control.js", "api.js", "bootstrap.js", "cloud-github-view.js", "code-sync-view.js", "codex-launcher.js",
    "domain.js", "dsh.js", "github-code-sync-view.js", "github-return-context.js", "github-setup.js", "history-summaries.js",
    "history-summary-view.js", "i18n.js", "main.js", "message-actions.js", "message-deletion.js", "mobile-workspace.js", "onboarding-content.js",
    "personal-cloud-api.js", "realtime.js",
  ]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of edges) if (affected.has(edge.target) && !affected.has(edge.file)) {
      affected.add(edge.file); expanded = true;
    }
  }
  let checked = 0;
  for (const edge of edges) if (affected.has(edge.target)) {
    assert.equal(new URL(edge.specifier, "https://example.invalid/src/").searchParams.get("v"), revision,
      `${edge.file} must not load an older ${edge.target}`);
    checked++;
  }
  assert.ok(checked >= 48, "the whole affected import graph must be covered");
});
