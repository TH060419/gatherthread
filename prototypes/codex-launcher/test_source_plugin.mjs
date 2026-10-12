import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveMcpLauncherInvocation } from "../../plugins/gatherthread/scripts/mcp-launcher.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const plugin = path.join(root, "plugins/gatherthread");
const launcher = path.join(plugin, "scripts/mcp-launcher.mjs");
const helper = path.join(plugin, "scripts/prepare-source-plugin.mjs");
const bundleFiles = ["codex-connect.js", "codex-hook.js", "index.js", "mcp.js"];
const pluginFiles = [".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json",
  "scripts/mcp-launcher.mjs", "scripts/hook-forwarder.mjs", "skills/gatherthread/SKILL.md"];
const temporaryRoots = [];
async function temporaryDirectory(prefix) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryRoots.push(directory);
  return directory;
}
after(async () => { for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true }); });

test("unbound source MCP refuses instead of selecting an immutable npm package on every platform", () => {
  for (const [platform, env] of [["linux", {}], ["win32", { ComSpec: "cmd.exe" }],
    ["win32", { npm_execpath: "C:/fixture/npm-cli.js" }]]) {
    assert.throws(() => resolveMcpLauncherInvocation(platform, env), /local|source|built|绑定/i);
  }
});

test("unbound MCP CLI fails with fixed upgrade guidance without running npm", async () => {
  const temp = await temporaryDirectory("gt-source-unbound-");
  const fakeNpm = path.join(temp, "npm.mjs");
  await writeFile(fakeNpm, 'process.stdout.write("STALE_NPM_STARTED");\n');
  const result = spawnSync(process.execPath, [launcher], { encoding: "utf8", timeout: 5000,
    cwd: temp, input: "", env: { ...process.env, npm_execpath: fakeNpm } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /prepare-source-plugin\.mjs/);
  assert.doesNotMatch(result.stderr, /npm\.mjs|gta_|Bearer|password|cookie/i);
});

async function sourceFixture() {
  const directory = await temporaryDirectory("gt-source-plugin-");
  for (const relative of pluginFiles) {
    const destination = path.join(directory, "plugins/gatherthread", relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(plugin, relative), destination);
  }
  await mkdir(path.join(directory, "packages/codex-connect/dist"), { recursive: true });
  for (const file of bundleFiles) await copyFile(path.join(root, "packages/codex-connect/dist", file),
    path.join(directory, "packages/codex-connect/dist", file));
  await copyFile(path.join(root, "packages/codex-connect/package.json"), path.join(directory, "packages/codex-connect/package.json"));
  await writeFile(path.join(directory, "plugins/gatherthread/.private-fixture"), "MUST_NOT_BE_COPIED");
  return directory;
}

const prepare = async (directory) => (await import(pathToFileURL(helper).href)).prepareSourcePlugin(directory);

test("source preparation creates fresh ignored same-source MCP bindings without overwriting source or user configuration", async () => {
  const directory = await sourceFixture();
  const original = await readFile(path.join(directory, "plugins/gatherthread/.mcp.json"), "utf8");
  await mkdir(path.join(directory, ".local"));
  await writeFile(path.join(directory, ".local/user-note"), "USER_OWNED");
  const first = await prepare(directory), second = await prepare(directory);
  assert.notEqual(first, second);
  assert.ok(first.startsWith(path.join(directory, ".local/codex-source-plugin") + path.sep));
  const market = JSON.parse(await readFile(path.join(first, ".agents/plugins/marketplace.json"), "utf8"));
  assert.equal(market.name, "gatherthread-source");
  assert.deepEqual(market.plugins[0].source, { source: "local", path: "./plugins/gatherthread" });
  const stagedPlugin = path.join(first, "plugins/gatherthread");
  const config = JSON.parse(await readFile(path.join(stagedPlugin, ".mcp.json"), "utf8"));
  assert.equal(config.mcpServers.gatherthread.command, process.execPath);
  assert.deepEqual(config.mcpServers.gatherthread.args, ["${PLUGIN_ROOT}/scripts/mcp-launcher.mjs"]);
  const invocation = resolveMcpLauncherInvocation(process.platform, { npm_execpath: "/ignored/npm.js" }, stagedPlugin);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [path.join(stagedPlugin, "connector/codex-connect.js"), "mcp"]);
  const binding = JSON.parse(await readFile(path.join(stagedPlugin, ".source-connector.json"), "utf8"));
  for (const file of bundleFiles) {
    const source = await readFile(path.join(directory, "packages/codex-connect/dist", file));
    assert.deepEqual(await readFile(path.join(stagedPlugin, "connector", file)), source);
    assert.equal(binding.files[file], createHash("sha256").update(source).digest("hex"));
  }
  assert.equal(await readFile(path.join(directory, "plugins/gatherthread/.mcp.json"), "utf8"), original);
  assert.equal(await readFile(path.join(directory, ".local/user-note"), "utf8"), "USER_OWNED");
  await assert.rejects(readFile(path.join(stagedPlugin, ".private-fixture")), /ENOENT/);
});

test("staged MCP really starts the current stdio CLI and exposes captured revision requests", async () => {
  const directory = await sourceFixture(), stage = await prepare(directory);
  const script = path.join(stage, "plugins/gatherthread/scripts/mcp-launcher.mjs");
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000, cwd: directory,
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n"
      + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    env: { ...process.env, GATHERTHREAD_MCP_TOOL_PROFILE: "runtime", GATHERTHREAD_MCP_TRANSPORT: "server-env",
      GATHERTHREAD_TOKEN: "fixture-must-not-reach-mcp" } });
  assert.equal(result.status, 0, result.stderr);
  const frames = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames[0].result.serverInfo.name, "gatherthread");
  const tools = frames[1].result.tools;
  const request = tools.find((tool) => tool.name === "collaboration_request_agent");
  assert.equal(request.inputSchema.properties.content_revision.type, "integer");
  assert.equal(request.inputSchema.properties.content_revision.minimum, 0);
  assert.ok(!tools.some((tool) => /register_runtime|claim_agent/.test(tool.name)), "MCP must keep the credential-free user profile");
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-must-not-reach-mcp/);
});

test("local MCP binding refuses modified connector bytes and symlinked receipt or entry files", async () => {
  for (const damaged of ["bytes", "receipt-link", "entry-link"]) {
    const directory = await sourceFixture(), stage = await prepare(directory), stagedPlugin = path.join(stage, "plugins/gatherthread");
    const entry = path.join(stagedPlugin, "connector/codex-connect.js");
    if (damaged === "bytes") await writeFile(entry, "// changed\n");
    else {
      const target = damaged === "receipt-link" ? path.join(stagedPlugin, ".source-connector.json") : entry;
      const value = await readFile(target);
      const external = path.join(directory, "unrelated-file"); await writeFile(external, value);
      const { unlink } = await import("node:fs/promises"); await unlink(target); await symlink(external, target);
    }
    assert.throws(() => resolveMcpLauncherInvocation(process.platform, {}, stagedPlugin), /local|source|built|绑定/i);
  }
});

test("source preparation refuses symlinked output parents and malformed or stale input bundles", async () => {
  const directory = await sourceFixture(), elsewhere = await temporaryDirectory("gt-source-outside-");
  await symlink(elsewhere, path.join(directory, ".local"), "dir");
  await assert.rejects(prepare(directory), /symlink|directory|owned/i);
  const other = await sourceFixture();
  await writeFile(path.join(other, "packages/codex-connect/dist/mcp.js"), 'export const stale = true;\n');
  await assert.rejects(prepare(other), /MCP|revision|build/i);
});
