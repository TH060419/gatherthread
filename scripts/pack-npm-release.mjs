#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const VERSION = "0.1.0-alpha.7";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(root, "release-artifacts", "npm");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.equal(manifest.version, VERSION);
await mkdir(output, { recursive: true, mode: 0o700 });
const cacheRoot = await mkdtemp(path.join(tmpdir(), "gatherthread-npm-pack-"));

try {
  for (const workspace of ["@gatherthread/codex-connect", "@gatherthread/dsh-host", "@gatherthread/zcode-connect"]) {
    await runNpm(["--cache", cacheRoot, "pack", "--workspace", workspace, "--pack-destination", output], root);
  }
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}

process.stdout.write(`${output}\n`);

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath?.trim();
  const command = npmCli ? process.execPath : process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const commandArgs = npmCli ? [npmCli, ...args]
    : process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...args]
      : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, env: process.env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${signal ?? code}`)));
  });
}
