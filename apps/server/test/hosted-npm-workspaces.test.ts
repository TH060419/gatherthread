import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodeFile } from "@gatherthread/protocol";
import { HostedNpmProxy } from "../src/hosted-npm-proxy.js";
import { ApiError } from "../src/errors.js";

const file = (path: string, data: unknown): CodeFile => ({ path, content_base64: Buffer.from(JSON.stringify(data)).toString("base64"), executable: false });
function sources(patch: { root?: unknown; lock?: unknown; workspace?: unknown } = {}) {
  return [file("package.json", patch.root ?? { name: "root", workspaces: ["packages/*"] }),
    file("package-lock.json", { lockfileVersion: 3, packages: patch.lock ?? { "": {}, "packages/lib": { version: "1.0.0" },
      "node_modules/lib": { link: true, resolved: "packages/lib" } } }),
    file("packages/lib/package.json", patch.workspace ?? { name: "lib", version: "1.0.0" })];
}
test("npm workspace locks accept declared source and refuse forged local or remote dependencies", () => {
  assert.doesNotThrow(() => new HostedNpmProxy(sources()));
  assert.doesNotThrow(() => new HostedNpmProxy(sources({ root: { workspaces: { packages: ["packages/*"] } },
    workspace: { name: "@fixture/lib" }, lock: { "": {}, "packages/lib": {}, "node_modules/@fixture/lib": { link: true, resolved: "packages/lib" } } })));
  for (const resolved of ["../packages/lib", "/packages/lib", "file:packages/lib", "packages/missing"]) {
    assert.throws(() => new HostedNpmProxy(sources({ lock: { "": {}, "packages/lib": { version: "1.0.0" }, "node_modules/lib": { link: true, resolved } } })), ApiError);
  }
  for (const key of ["../node_modules/lib", "/node_modules/lib", "fakenode_modules/lib", "file:node_modules/lib", "x//node_modules/lib"]) {
    assert.throws(() => new HostedNpmProxy(sources({ lock: { "": {}, "packages/lib": { version: "1.0.0" }, [key]: { link: true, resolved: "packages/lib" } } })), ApiError);
  }
  for (const patch of [{ root: {} }, { root: { workspaces: ["else/*"] } }, { root: { workspaces: ["../*"] } },
    { workspace: { name: "other", version: "1.0.0" } }, { workspace: { name: "lib", version: "2.0.0" } },
    { lock: { "packages/lib": { version: "1.0.0" } } },
    { lock: { "packages/lib": { version: "1.0.0", resolved: "https://attacker.invalid/lib" } } },
    { lock: { "packages/lib": { version: "1.0.0", integrity: "sha512-YQ==" } } },
    { lock: { "node_modules/lib": { resolved: "file:packages/lib" } } }]) assert.throws(() => new HostedNpmProxy(sources(patch)), ApiError);
});

test("a real offline npm workspace lock installs local packages with npm ci", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-local-workspace-"));
  try {
    mkdirSync(join(directory, "packages/lib"), { recursive: true });
    const root = { name: "fixture-root", private: true, workspaces: ["packages/*"] };
    const workspace = { name: "@fixture/lib", version: "1.0.0", main: "index.cjs" };
    writeFileSync(join(directory, "package.json"), JSON.stringify(root));
    writeFileSync(join(directory, "packages/lib/package.json"), JSON.stringify(workspace));
    writeFileSync(join(directory, "packages/lib/index.cjs"), "module.exports = 7;\n");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const run = (args: string[]) => { const result = spawnSync(npm, [...args, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--cache", join(directory, "cache")],
      { cwd: directory, encoding: "utf8", timeout: 30_000, shell: process.platform === "win32" }); assert.equal(result.status, 0, result.stderr); };
    run(["install", "--package-lock-only"]);
    const lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["packages/lib"].version, "1.0.0");
    if (lock.packages["packages/lib"].name !== undefined) assert.equal(lock.packages["packages/lib"].name, workspace.name);
    new HostedNpmProxy(sources({ root, lock: lock.packages, workspace }));
    run(["ci"]);
    const check = spawnSync(process.execPath, ["-e", "require('node:assert/strict').equal(require('@fixture/lib'), 7)"], { cwd: directory, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
