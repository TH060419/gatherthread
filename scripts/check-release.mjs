#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "0.1.0-alpha.1";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPaths = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/adapters/package.json",
  "packages/bridge/package.json",
  "packages/codex-connect/package.json",
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
for (const path of ["", "apps/server", "apps/web", "packages/adapters", "packages/bridge", "packages/codex-connect", "packages/dsh-host", "packages/mcp", "packages/protocol"]) {
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
assert.deepEqual(dshPackage.publishConfig, { access: "public", tag: "alpha" });
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
  "docs/releases/0.1.0-alpha.1.md",
  "docs/CODEX_CONNECT.md",
  "docs/CODEX_CONNECT.zh-CN.md",
  "docs/DSH_CONNECT.md",
  "docs/DSH_CONNECT.zh-CN.md",
  "docs/adr/0018-unified-codex-plugin-and-connector.md",
  ".agents/plugins/marketplace.json",
  "packages/codex-connect/README.md",
  "plugins/gatherthread/.codex-plugin/plugin.json",
  "plugins/gatherthread/.mcp.json",
  "plugins/gatherthread/hooks/hooks.json",
  "plugins/gatherthread/scripts/hook-forwarder.mjs",
  "plugins/gatherthread/scripts/mcp-launcher.mjs",
  "plugins/gatherthread/skills/gatherthread/SKILL.md",
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
  "scripts/pack-npm-release.mjs",
  "scripts/dry-run-npm-release.mjs",
  "scripts/verify-codex-package.mjs",
  "scripts/verify-dsh-package.mjs",
];
await Promise.all(requiredFiles.map((path) => readFile(join(root, path), "utf8")));

const connector = await json("packages/codex-connect/package.json");
assert.equal(connector.name, "@gatherthread/codex-connect");
assert.equal(connector.private, undefined);
assert.deepEqual(connector.publishConfig, { access: "public", tag: "alpha" });
assert.deepEqual(connector.bin, { "gatherthread-codex-connect": "dist/codex-connect.js" });
assert.deepEqual(connector.dependencies ?? {}, {});

const plugin = await json("plugins/gatherthread/.codex-plugin/plugin.json");
assert.equal(plugin.version, EXPECTED_VERSION);
assert.equal(plugin.interface?.displayName, "共序 / GatherThread");
assert.equal(plugin.hooks, undefined, "hooks/hooks.json must use automatic discovery");
const pluginMcp = await json("plugins/gatherthread/.mcp.json");
assert.equal(pluginMcp.mcpServers?.gatherthread?.command, "node");
assert.deepEqual(pluginMcp.mcpServers?.gatherthread?.args, ["${PLUGIN_ROOT}/scripts/mcp-launcher.mjs"]);
assert.equal(pluginMcp.mcpServers?.gatherthread?.env, undefined);
assert.equal(pluginMcp.mcpServers?.gatherthread?.env_vars, undefined);
const pluginLauncher = await readFile(join(root, "plugins/gatherthread/scripts/mcp-launcher.mjs"), "utf8");
assert.match(pluginLauncher, new RegExp(`@gatherthread/codex-connect@${EXPECTED_VERSION.replaceAll(".", "\\.")}`));
assert.match(pluginLauncher, /"npx\.cmd"/);
assert.match(pluginLauncher, /!name\.startsWith\("GATHERTHREAD_"\)/);

const marketplace = await json(".agents/plugins/marketplace.json");
assert.equal(marketplace.interface?.displayName, "共序 / GatherThread");
assert.deepEqual(marketplace.plugins?.[0]?.source, { source: "local", path: "./plugins/gatherthread" });
const marketplaceCommand = `codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v${EXPECTED_VERSION} --sparse .agents/plugins --sparse plugins/gatherthread`;
const pluginInstallCommand = "codex plugin add gatherthread@gatherthread";
for (const path of ["apps/web/index.html", "README.md", "README.zh-CN.md", "docs/CODEX_CONNECT.md", "docs/CODEX_CONNECT.zh-CN.md", "docs/releases/0.1.0-alpha.1.md", "packages/codex-connect/README.md"]) {
  assert.match(await readFile(join(root, path), "utf8"), new RegExp(marketplaceCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(await readFile(join(root, path), "utf8"), new RegExp(pluginInstallCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.doesNotMatch(`${marketplaceCommand}\n${pluginInstallCommand}`, /gta_|Bearer|cookie|token=|password|client_secret/i);

const webDomain = await readFile(join(root, "apps/web/src/domain.js"), "utf8");
assert.match(webDomain, /@gatherthread\/codex-connect@0\.1\.0-alpha\.1/);

const installer = await readFile(join(root, "deploy/aliyun-ecs/install.sh"), "utf8");
assert.match(installer, /release_version="0\.1\.0-alpha\.1"/);
assert.match(installer, /GATHERTHREAD_SERVER_HOST=127\.0\.0\.1/);
assert.match(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=false/);
assert.match(installer, /GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true/);
assert.doesNotMatch(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=true/);

process.stdout.write(`GatherThread ${EXPECTED_VERSION} release metadata is consistent.\n`);
