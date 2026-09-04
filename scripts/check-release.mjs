#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "0.1.0-beta.1";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPaths = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/adapters/package.json",
  "packages/bridge/package.json",
  "packages/mcp/package.json",
  "packages/protocol/package.json",
];

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

for (const path of manifestPaths) {
  const manifest = await json(path);
  assert.equal(manifest.version, EXPECTED_VERSION, `${path} must declare ${EXPECTED_VERSION}`);
}

const lock = await json("package-lock.json");
assert.equal(lock.version, EXPECTED_VERSION, "package-lock.json must declare the candidate version");
for (const path of ["", "apps/server", "apps/web", "packages/adapters", "packages/bridge", "packages/mcp", "packages/protocol"]) {
  assert.equal(lock.packages?.[path]?.version, EXPECTED_VERSION, `package-lock.json package ${path || "root"} is stale`);
}

assert.equal((await readFile(join(root, ".node-version"), "utf8")).trim(), "24.16.0");

const requiredFiles = [
  "CHANGELOG.md",
  "docs/ALIYUN_ECS.md",
  "docs/ALIYUN_ECS.zh-CN.md",
  "docs/releases/0.1.0-beta.1.md",
  "deploy/aliyun-ecs/Caddyfile.in",
  "deploy/aliyun-ecs/create-owner.sh",
  "deploy/aliyun-ecs/gatherthread.service.in",
  "deploy/aliyun-ecs/gatherthread-backup.service.in",
  "deploy/aliyun-ecs/gatherthread-backup.timer",
  "deploy/aliyun-ecs/install.sh",
  "deploy/aliyun-ecs/preflight.sh",
  "scripts/package-release.mjs",
];
await Promise.all(requiredFiles.map((path) => readFile(join(root, path), "utf8")));

const installer = await readFile(join(root, "deploy/aliyun-ecs/install.sh"), "utf8");
assert.match(installer, /release_version="0\.1\.0-beta\.1"/);
assert.match(installer, /GATHERTHREAD_SERVER_HOST=127\.0\.0\.1/);
assert.match(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=false/);
assert.match(installer, /GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true/);
assert.doesNotMatch(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=true/);

process.stdout.write(`GatherThread ${EXPECTED_VERSION} release metadata is consistent.\n`);
