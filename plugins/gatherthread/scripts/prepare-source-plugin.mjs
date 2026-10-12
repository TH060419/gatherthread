#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUNDLE_FILES = ["codex-connect.js", "codex-hook.js", "index.js", "mcp.js"];
// Never package untracked files, local credentials or arbitrary plugin trees.
const PLUGIN_FILES = [".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json",
  "scripts/mcp-launcher.mjs", "scripts/hook-forwarder.mjs", "skills/gatherthread/SKILL.md"];
const BUILD_MESSAGE = "Build the current source first: npm run build:ts && npm run build:connector. The MCP must support captured content_revision.";

async function realDirectory(directory, create = false) {
  if (create) await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Source plugin staging requires an owned directory, not a symlink");
}

async function regularBytes(file, maximumBytes = 16 * 1024 * 1024) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error(BUILD_MESSAGE);
  return readFile(file);
}

function verifyMcpContract(entry, cwd) {
  // These two public metadata operations never access a connector registry,
  // project, user session or model. stdout is parsed, never forwarded.
  const input = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }].map((value) => JSON.stringify(value)).join("\n") + "\n";
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GATHERTHREAD_")));
  const result = spawnSync(process.execPath, [entry, "mcp"], { cwd, env, input, encoding: "utf8",
    timeout: 10_000, maxBuffer: 512 * 1024, shell: false, windowsHide: true });
  try {
    if (result.status !== 0 || result.error) throw new Error(BUILD_MESSAGE);
    const frames = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const initialized = frames.find((frame) => frame.id === 1)?.result;
    const tools = frames.find((frame) => frame.id === 2)?.result?.tools;
    const request = Array.isArray(tools) ? tools.find((tool) => tool.name === "collaboration_request_agent") : undefined;
    if (initialized?.serverInfo?.name !== "gatherthread"
      || request?.inputSchema?.properties?.content_revision?.type !== "integer"
      || request.inputSchema.properties.content_revision.minimum !== 0
      || request.inputSchema.additionalProperties !== false) throw new Error(BUILD_MESSAGE);
  } catch {
    throw new Error(BUILD_MESSAGE);
  }
}

export async function prepareSourcePlugin(repositoryRoot = ROOT) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Source plugin preparation requires Node 24 or newer");
  const root = await realpath(repositoryRoot);
  const sourcePlugin = path.join(root, "plugins/gatherthread"), sourceBundle = path.join(root, "packages/codex-connect/dist");
  for (const directory of [path.join(root, "plugins"), sourcePlugin, path.join(sourcePlugin, ".codex-plugin"),
    path.join(sourcePlugin, "scripts"), path.join(sourcePlugin, "hooks"), path.join(sourcePlugin, "skills"),
    path.join(sourcePlugin, "skills/gatherthread"), path.join(root, "packages"), path.join(root, "packages/codex-connect"), sourceBundle]) {
    await realDirectory(directory);
  }
  const manifest = JSON.parse(await regularBytes(path.join(sourcePlugin, ".codex-plugin/plugin.json"), 32_768));
  const packageInfo = JSON.parse(await regularBytes(path.join(root, "packages/codex-connect/package.json"), 32_768));
  if (manifest.name !== "gatherthread" || packageInfo.name !== "@gatherthread/codex-connect"
    || typeof manifest.version !== "string" || manifest.version !== packageInfo.version) throw new Error(BUILD_MESSAGE);
  const pluginBytes = new Map(), bundleBytes = new Map();
  for (const file of PLUGIN_FILES) pluginBytes.set(file, await regularBytes(path.join(sourcePlugin, file)));
  for (const file of BUNDLE_FILES) bundleBytes.set(file, await regularBytes(path.join(sourceBundle, file)));
  verifyMcpContract(path.join(sourceBundle, "codex-connect.js"), root);

  await realDirectory(path.join(root, ".local"), true);
  const parent = path.join(root, ".local/codex-source-plugin");
  await realDirectory(parent, true);
  // Each preparation is a new immutable installation candidate. No existing
  // staged package, tracked configuration or user Codex config is overwritten.
  const stage = await mkdtemp(path.join(parent, "source-")), owned = await lstat(stage);
  try {
    const plugin = path.join(stage, "plugins/gatherthread"), connector = path.join(plugin, "connector");
    for (const [file, bytes] of pluginBytes) {
      const target = path.join(plugin, file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (file !== ".mcp.json") await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    await mkdir(connector, { mode: 0o700 });
    const hashes = {};
    bundleBytes.set("package.json", Buffer.from('{"private":true,"type":"module"}\n'));
    for (const [file, bytes] of bundleBytes) {
      await writeFile(path.join(connector, file), bytes, { flag: "wx", mode: 0o600 });
      hashes[file] = createHash("sha256").update(bytes).digest("hex");
    }
    await writeFile(path.join(plugin, ".source-connector.json"), JSON.stringify({ schema_version: 1, files: hashes }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    await writeFile(path.join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { gatherthread: {
      command: process.execPath, args: ["${PLUGIN_ROOT}/scripts/mcp-launcher.mjs"],
    } } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const marketplace = path.join(stage, ".agents/plugins");
    await mkdir(marketplace, { recursive: true, mode: 0o700 });
    await writeFile(path.join(marketplace, "marketplace.json"), JSON.stringify({ name: "gatherthread-source",
      interface: { displayName: "共序 / GatherThread" }, plugins: [{ name: "gatherthread",
        source: { source: "local", path: "./plugins/gatherthread" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    verifyMcpContract(path.join(connector, "codex-connect.js"), stage);
    return stage;
  } catch (error) {
    const current = await lstat(stage).catch(() => undefined);
    if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) {
      await rm(stage, { recursive: true, force: true });
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareSourcePlugin().then((stage) => { process.stdout.write(`${stage}\n`); }).catch(() => {
    process.stderr.write(`gatherthread-source-plugin: preparation refused. ${BUILD_MESSAGE}\n`);
    process.exitCode = 1;
  });
}
