#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const PLUGIN_FILES = [".claude-plugin/plugin.json", ".claude-plugin/icon.png", ".mcp.json", "hooks/hooks.json", "scripts/mcp-launcher.mjs",
  "scripts/hook-forwarder.mjs", "skills/gatherthread/SKILL.md", ...["connect", "projects", "sessions", "history", "chat", "request", "status", "sync", "files"].map(name => `commands/${name}.md`)];
const BUNDLES = ["claude-connect.js", "index.js", "mcp.js"];
const MESSAGE = "Build the matching Claude connector first with npm run build:claude; use a new absolute output directory.";
async function bytes(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16777216
    || await realpath(file) !== path.resolve(file)) throw new Error(MESSAGE);
  return readFile(file);
}
function verify(entry, cwd) {
  const result = spawnSync(process.execPath, [entry, "mcp"], { cwd, shell: false, windowsHide: true, encoding: "utf8", timeout: 10000,
    maxBuffer: 524288, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GATHERTHREAD_"))),
    input: [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" }].map(JSON.stringify).join("\n") + "\n" });
  if (result.status !== 0 || result.error) throw new Error(MESSAGE);
  const frames = result.stdout.trim().split("\n").map(JSON.parse), tools = frames.find(frame => frame.id === 2)?.result?.tools;
  if (frames.find(frame => frame.id === 1)?.result?.serverInfo?.name !== "gatherthread" || !Array.isArray(tools)
    || !tools.some(tool => tool.name === "collaboration_read_context")
    || tools.some(tool => ["collaboration_register_runtime", "collaboration_import_codex_history"].includes(tool.name))) throw new Error(MESSAGE);
}
export async function prepareSourcePlugin(repositoryRoot = ROOT, { destination } = {}) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error(MESSAGE);
  const root = await realpath(repositoryRoot), pluginRoot = path.join(root, "plugins/gatherthread-claude"), bundle = path.join(root, "packages/claude-connect/dist");
  for (const directory of [pluginRoot, path.join(pluginRoot, ".claude-plugin"), path.join(pluginRoot, "scripts"), bundle]) {
    const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(MESSAGE);
  }
  const manifest = JSON.parse(await bytes(path.join(pluginRoot, ".claude-plugin/plugin.json")));
  const packageInfo = JSON.parse(await bytes(path.join(root, "packages/claude-connect/package.json")));
  if (manifest.name !== "gatherthread" || packageInfo.name !== "@gatherthread/claude-connect" || packageInfo.version !== manifest.version) throw new Error(MESSAGE);
  const source = new Map(), built = new Map();
  for (const file of PLUGIN_FILES) source.set(file, await bytes(path.join(pluginRoot, file)));
  for (const file of BUNDLES) built.set(file, await bytes(path.join(bundle, file)));
  for (const file of ["LICENSE", "NOTICE"]) built.set(file, await bytes(path.join(root, "packages/claude-connect", file)));
  verify(path.join(bundle, "claude-connect.js"), root);
  let stage;
  if (destination !== undefined) {
    if (typeof destination !== "string" || !path.isAbsolute(destination)) throw new Error(MESSAGE);
    const parent = await realpath(path.dirname(destination));
    if (path.dirname(destination) !== parent) throw new Error("Output parent must be a canonical directory");
    stage = path.join(parent, path.basename(destination)); await mkdir(stage, { mode: 0o700 });
  } else {
    const local = path.join(root, ".local"); await mkdir(local, { recursive: true, mode: 0o700 });
    const stat = await lstat(local); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(MESSAGE);
    stage = await mkdtemp(path.join(local, "claude-source-plugin-"));
  }
  const plugin = path.join(stage, "plugins/gatherthread");
  for (const [file, content] of source) {
    await mkdir(path.dirname(path.join(plugin, file)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(plugin, file), content, { flag: "wx", mode: 0o600 });
  }
  const connector = path.join(plugin, "connector"); await mkdir(connector, { mode: 0o700 });
  built.set("package.json", Buffer.from('{"private":true,"type":"module"}\n'));
  const hashes = {};
  for (const [file, content] of built) {
    await writeFile(path.join(connector, file), content, { flag: "wx", mode: 0o600 });
    hashes[file] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(path.join(plugin, ".source-connector.json"), JSON.stringify({ schema_version: 1, files: hashes }) + "\n", { flag: "wx", mode: 0o600 });
  await mkdir(path.join(stage, ".claude-plugin"), { mode: 0o700 });
  await writeFile(path.join(stage, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "gatherthread-claude",
    owner: { name: "Yuhan He and contributors" }, plugins: [{ name: "gatherthread", source: "./plugins/gatherthread", description: manifest.description, version: manifest.version }] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  verify(path.join(connector, "claude-connect.js"), stage);
  return stage;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = args.length === 0 ? {} : args.length === 2 && args[0] === "--output" ? { destination: args[1] } : undefined;
  if (!options) { process.stderr.write("Usage: prepare-source-plugin.mjs [--output NEW_ABSOLUTE_DIRECTORY]\n"); process.exitCode = 1; }
  else prepareSourcePlugin(ROOT, options).then(stage => process.stdout.write(`${stage}\n`)).catch(() => { process.stderr.write(`gatherthread-claude-plugin: ${MESSAGE}\n`); process.exitCode = 1; });
}
