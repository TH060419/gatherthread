#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const VERSION = "0.1.0-alpha.7";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(root, "release-artifacts", "npm");
const cacheRoot = await mkdtemp(path.join(tmpdir(), "gatherthread-npm-publish-dry-run-"));

try {
  await run(process.execPath, [path.join(root, "scripts", "pack-npm-release.mjs")], root);
  for (const archive of [
    `gatherthread-codex-connect-${VERSION}.tgz`,
    `gatherthread-dsh-host-${VERSION}.tgz`,
    `gatherthread-zcode-connect-${VERSION}.tgz`,
  ]) {
    await runNpm([
      "--cache", cacheRoot,
      "publish", "--dry-run",
      "--access", "public",
      "--tag", "alpha",
      path.join(output, archive),
    ], root);
  }
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}

process.stdout.write("Both npm candidates passed publish --dry-run with the alpha dist-tag.\n");

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd);
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], cwd);
  }
  return run("npm", args, cwd);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${signal ?? code}`)));
  });
}
