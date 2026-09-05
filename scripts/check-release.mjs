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
  "packages/dsh-host/package.json",
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
for (const path of ["", "apps/server", "apps/web", "packages/adapters", "packages/bridge", "packages/dsh-host", "packages/mcp", "packages/protocol"]) {
  assert.equal(lock.packages?.[path]?.version, EXPECTED_VERSION, `package-lock.json package ${path || "root"} is stale`);
}

const dshBundle = await json("packages/dsh-host/bundle/manifest.json");
const dshPackage = await json("packages/dsh-host/package.json");
assert.equal(dshBundle.defaultEnabled, false, "DSH bundle must remain disabled by default");
assert.equal(dshBundle.hostEntry, "@gatherthread/dsh-host");
assert.equal(dshBundle.clientEntry, "@gatherthread/dsh-host/client");
assert.deepEqual(dshBundle.deepseekHarness?.primary, {
  distribution: "npm",
  package: "@deepseek-ai/dsh",
  version: "0.1.2-rc.1",
  profile: "web",
  persistenceProbe: "list",
});
assert.deepEqual(dshBundle.deepseekHarness?.sourceFallback, {
  distribution: "source",
  tag: "dsh-v0.1.3-alpha.1",
  version: "0.1.3-alpha.1",
  commit: "d347e703908d0406b7a7ef80e3a0e594d86b2215",
  verifiedProfiles: ["headless", "web"],
  persistenceProbe: "stat",
});
assert.deepEqual(dshBundle.runtimeDependencies, [], "GatherThread installation must not acquire a DSH runtime dependency");
assert.equal(dshPackage.private, undefined, "DSH plugin package must remain publishable through the official profile installer");
assert.equal(dshPackage.publishConfig?.access, "public");
assert.equal(dshPackage.engines?.node, ">=24");
assert.equal(
  Object.keys(dshPackage.dependencies ?? {}).some((name) => name.startsWith("@deepseek-ai/")),
  false,
  "DSH Host package must consume services from the Host instead of installing DSH",
);
assert.equal(dshPackage.exports?.["."]?.default, "./dist/bundle/native-plugin.js");
assert.equal(dshPackage.exports?.["."]?.types, "./types/native-plugin.d.ts");
assert.equal(dshPackage.exports?.["./plugin"]?.default, "./dist/bundle/plugin.js");
assert.equal(dshPackage.exports?.["./client"]?.default, "./client/client.js");
assert.deepEqual(dshPackage.dsh?.client, {
  inject: ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-settings"],
  platform: "web",
});
assert.equal(
  await readFile(join(root, "packages/dsh-host/LICENSE"), "utf8"),
  await readFile(join(root, "LICENSE"), "utf8"),
  "published DSH plugin must carry the repository Apache-2.0 license text",
);

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
  "packages/dsh-host/bundle/disabled.cordis.patch.yml",
  "packages/dsh-host/bundle/enabled.example.cordis.patch.yml",
  "packages/dsh-host/bundle/project.example.cordis.patch.yml",
  "packages/dsh-host/client/client.js",
  "packages/dsh-host/dist/bundle/native-plugin.js",
  "packages/dsh-host/dist/bundle/plugin.js",
  "packages/dsh-host/integration/loader-control/index.mjs",
  "packages/dsh-host/integration/loader-control/package.json",
  "packages/dsh-host/LICENSE",
  "packages/dsh-host/src/connect-cli.ts",
  "packages/dsh-host/src/plugin.ts",
  "packages/dsh-host/src/status.ts",
  "packages/dsh-host/types/native-plugin.d.ts",
  "scripts/test-dsh-connect-real.mjs",
  "scripts/test-dsh-host-real.mjs",
  "scripts/test-dsh-npm-plugin-real.mjs",
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
