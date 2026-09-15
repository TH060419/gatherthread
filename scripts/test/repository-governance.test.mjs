import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("repository governance gives Agents one canonical instruction surface", async () => {
  const [agents, compatibilityPointer, contributing, contracts] = await Promise.all([
    read("AGENTS.md"),
    read("AGENT.md"),
    read("CONTRIBUTING.md"),
    read("docs/INTERFACE_CONTRACTS.md"),
  ]);

  assert.match(compatibilityPointer, /standard, automatically discovered \[`AGENTS\.md`\]/);
  for (const requiredLink of [
    "docs/ARCHITECTURE.md",
    "docs/PRODUCT_SPEC.md",
    "docs/SECURITY.md",
    "docs/INTERFACE_CONTRACTS.md",
    "CONTRIBUTING.md",
  ]) {
    assert.match(agents, new RegExp(escaped(requiredLink)));
  }
  assert.match(contributing, /canonical history first/i);
  assert.match(contracts, /schemas and tests named below remain the executable source of truth/i);
});

test("release governance requires project-lead review and forbids autonomous publication", async () => {
  const [agents, contributing, codeowners, template] = await Promise.all([
    read("AGENTS.md"),
    read("CONTRIBUTING.md"),
    read(".github/CODEOWNERS"),
    read(".github/pull_request_template.md"),
  ]);

  assert.match(agents, /Every version update is proposed through a PR and reviewed by the project lead/);
  assert.match(agents, /must not merge a release PR, create or move a release tag, publish an npm package, create a GitHub Release, or deploy a server/);
  assert.match(contributing, /Only the project lead may give final approval/);
  assert.match(contributing, /CODEOWNERS.*does not enforce branch protection/s);
  assert.equal(codeowners.trim().split("\n").at(-1), "* @TH060419");
  assert.match(template, /Project lead \/ Code Owner review is requested/);
  assert.match(template, /No merge, tag, npm publication, GitHub Release, deployment, or source-branch deletion/);
});

test("interface map preserves the canonical wire and safety invariants", async () => {
  const contracts = await read("docs/INTERFACE_CONTRACTS.md");

  for (const source of [
    "packages/protocol/src/index.ts",
    "apps/server/src/server.ts",
    "apps/server/src/service.ts",
    "packages/bridge/src/types.ts",
    "packages/mcp/src/service.ts",
    "packages/dsh-host/src/native-plugin.ts",
    "apps/web/index.html",
  ]) {
    assert.match(contracts, new RegExp(escaped(source)));
  }
  assert.match(contracts, /`snake_case`/);
  assert.match(contracts, /`current_sequence` is the public session-head field/);
  assert.match(contracts, /`gatherthread-v1` and `gatherthread-ticket\.<ticket>`/);
  assert.match(contracts, /manual Codex history import creates and verifies a new (?:writable )?local task/i);
  assert.match(contracts, /Realtime context injection remains independent/);
  assert.match(contracts, /Hidden reasoning is excluded/i);
});
