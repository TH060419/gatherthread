#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILES = ["claude-connect.js", "index.js", "mcp.js", "package.json", "LICENSE", "NOTICE"];
const MESSAGE = "Prepare the matching reviewed Claude plugin with node plugins/gatherthread-claude/scripts/prepare-source-plugin.mjs; no registry fallback is used.";

function bytes(file, maximum = 16 * 1024 * 1024) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum
    || realpathSync(file) !== path.resolve(file)) throw new Error(MESSAGE);
  return readFileSync(file);
}

export function resolveMcpLauncherInvocation(pluginRoot = ROOT) {
  try {
    if (Number(process.versions.node.split(".")[0]) < 24 || !path.isAbsolute(pluginRoot)
      || realpathSync(pluginRoot) !== path.resolve(pluginRoot)) throw new Error();
    const connector = path.join(pluginRoot, "connector"), stat = lstatSync(connector);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const binding = JSON.parse(bytes(path.join(pluginRoot, ".source-connector.json"), 32768));
    if (binding.schema_version !== 1 || Object.keys(binding.files ?? {}).sort().join("\n") !== [...FILES].sort().join("\n")) throw new Error();
    for (const file of FILES) {
      if (!/^[a-f0-9]{64}$/u.test(binding.files[file]) || createHash("sha256").update(bytes(path.join(connector, file))).digest("hex") !== binding.files[file]) throw new Error();
    }
    if (JSON.parse(bytes(path.join(connector, "package.json"), 32768)).type !== "module") throw new Error();
    return { command: process.execPath, args: [path.join(connector, "claude-connect.js"), "mcp"] };
  } catch { throw new Error(MESSAGE); }
}

export async function runMcpLauncher() {
  const invocation = resolveMcpLauncherInvocation();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GATHERTHREAD_")));
  const child = spawn(invocation.command, invocation.args, { env, shell: false, stdio: "inherit", windowsHide: true });
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0) process.exitCode = typeof code === "number" ? code : 1;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMcpLauncher().catch(() => {
  process.stderr.write(`gatherthread-claude-mcp: ${MESSAGE}\n`); process.exitCode = 1;
});
