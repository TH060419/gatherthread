#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const VERSION = "0.1.0-alpha.7";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const temporaryRoot = await mkdtemp(path.join(temporaryBase, "gtdshp-"));
const packDirectory = path.join(temporaryRoot, "pack");
const installDirectory = path.join(temporaryRoot, "install");
const npmCache = path.join(temporaryRoot, "cache");

try {
  await mkdir(packDirectory);
  await runNpm([
    "--cache", npmCache,
    "pack", "--workspace", "@gatherthread/dsh-host",
    "--pack-destination", packDirectory,
  ], { cwd: root });
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  assert.deepEqual(tarballs, [`gatherthread-dsh-host-${VERSION}.tgz`]);
  await runNpm([
    "--cache", npmCache,
    "install", "--ignore-scripts", "--prefix", installDirectory,
    path.join(packDirectory, tarballs[0]),
  ]);
  await assert.rejects(access(path.join(installDirectory, ".git")));

  const packageRoot = path.join(installDirectory, "node_modules", "@gatherthread", "dsh-host");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.publishConfig, { access: "public", tag: "alpha" });
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const plugin = await import(pathToFileURL(path.join(packageRoot, "dist", "bundle", "native-plugin.js")).href);
  assert.equal(plugin.name, "gatherthread-dsh-native");
  assert.equal(typeof plugin.apply, "function");
  for (const relativePath of [
    "README.md",
    "LICENSE",
    "cordis.patch.yml",
    "bundle/manifest.json",
    "client/client.js",
    "types/native-plugin.d.ts",
    "dist/bundle/native-plugin.js",
    "dist/bundle/plugin.js",
  ]) await access(path.join(packageRoot, relativePath));
  process.stdout.write("Git-less DSH plugin tarball install, import, manifest, and file checks passed.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli) return run(process.execPath, [npmCli, ...args], options);
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options);
  }
  return run("npm", args, options);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: output, stderr: errors });
      else reject(new Error(`${command} exited ${signal ?? code}: ${errors || output}`));
    });
  });
}
