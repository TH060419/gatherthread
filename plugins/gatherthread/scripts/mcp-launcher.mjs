#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUNDLE_FILES = ["codex-connect.js", "codex-hook.js", "index.js", "mcp.js", "package.json"];
const UPGRADE_MESSAGE = "GatherThread source MCP requires a verified current local build. Run node plugins/gatherthread/scripts/prepare-source-plugin.mjs and install its printed marketplace directory; no older npm package is used.";

function regularFileBytes(file, maximumBytes) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error(UPGRADE_MESSAGE);
  return readFileSync(file);
}

export function resolveMcpLauncherInvocation(
  _platform = process.platform,
  _env = process.env,
  pluginRoot = PLUGIN_ROOT,
) {
  try {
    if (Number(process.versions.node.split(".")[0]) < 24 || !path.isAbsolute(pluginRoot)) throw new Error(UPGRADE_MESSAGE);
    const directory = path.join(pluginRoot, "connector");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(UPGRADE_MESSAGE);
    const binding = JSON.parse(regularFileBytes(path.join(pluginRoot, ".source-connector.json"), 32_768).toString("utf8"));
    if (binding.schema_version !== 1 || !binding.files || typeof binding.files !== "object"
      || Object.keys(binding.files).sort().join("\n") !== [...BUNDLE_FILES].sort().join("\n")) throw new Error(UPGRADE_MESSAGE);
    for (const file of BUNDLE_FILES) {
      if (!/^[a-f0-9]{64}$/.test(binding.files[file])
        || createHash("sha256").update(regularFileBytes(path.join(directory, file), 16 * 1024 * 1024)).digest("hex") !== binding.files[file]) {
        throw new Error(UPGRADE_MESSAGE);
      }
    }
    if (JSON.parse(regularFileBytes(path.join(directory, "package.json"), 32_768)).type !== "module") throw new Error(UPGRADE_MESSAGE);
    return {
      command: process.execPath,
      args: [path.join(directory, "codex-connect.js"), "mcp"],
    };
  } catch {
    throw new Error(UPGRADE_MESSAGE);
  }
}

export async function runMcpLauncher(env = process.env) {
  const invocation = resolveMcpLauncherInvocation(process.platform, env);
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GATHERTHREAD_")),
  );
  const child = spawn(invocation.command, invocation.args, {
    env: childEnv,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const forward = (signal) => {
    try { child.kill(signal); } catch { /* The child may already have exited. */ }
  };
  const forwardInterrupt = () => forward("SIGINT");
  const forwardTerminate = () => forward("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTerminate);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) process.kill(process.pid, result.signal);
    else if (result.code !== 0) process.exitCode = result.code ?? 1;
  } finally {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTerminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpLauncher().catch(() => {
    process.stderr.write(`gatherthread-mcp-launcher: ${UPGRADE_MESSAGE}\n`);
    process.exitCode = 1;
  });
}
