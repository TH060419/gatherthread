#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryBase = process.platform === "darwin" ? "/private/tmp"
  : process.platform === "win32" ? tmpdir()
    : "/tmp";
const temporaryRoot = await mkdtemp(path.join(temporaryBase, "gtz-"));
const packDirectory = path.join(temporaryRoot, "p");
const installDirectory = path.join(temporaryRoot, "i");
const npmCache = path.join(temporaryRoot, "c");

try {
  await mkdir(packDirectory);
  await runNpm([
    "--cache", npmCache,
    "pack", "--workspace", "@gatherthread/zcode-connect",
    "--pack-destination", packDirectory,
  ], { cwd: root });
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  assert.deepEqual(tarballs, ["gatherthread-zcode-connect-0.1.0-alpha.5.tgz"]);
  const tarball = path.join(packDirectory, tarballs[0]);
  await runNpm(["--cache", npmCache, "install", "--prefix", installDirectory, tarball]);
  await assert.rejects(access(path.join(installDirectory, ".git")));
  await runNpm(["--cache", npmCache, "--prefix", installDirectory, "ls", "--all"]);

  const packageRoot = path.join(installDirectory, "node_modules", "@gatherthread", "zcode-connect");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.1.0-alpha.5");
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const executable = path.join(installDirectory, "node_modules", ".bin", "gatherthread-zcode-connect");
  const help = await runExecutable(executable, ["--help"]);
  assert.match(help.stdout, /@gatherthread\/zcode-connect@0\.1\.0-alpha\.5/);
  assert.match(help.stdout, /--share-tool-events/);

  await verifyPreflight(executable, installDirectory);

  process.stdout.write("Git-less ZCode tarball install, help, dependency, and no-real-credential preflight checks passed.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * Runs the connector's --preflight-only path end to end against a fake
 * GatherThread server and a fake ZCode CLI: the packaged bundle must resolve
 * the command spec, parse --version/--help, speak the ZCode Protocol
 * handshake, and refuse to echo the device token — without a real
 * credential, server, or ZCode installation.
 */
async function verifyPreflight(executable, directory) {
  const fakeZcode = path.join(directory, "fake-zcode.cjs");
  await writeFile(fakeZcode, `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("zcode 9.9.9 (verify-fake)\\n");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write("Usage: zcode [command] [options]\\n  app-server Run the ZCode Protocol stdio app server\\n  -p, --prompt <text>\\n  --resume <sessionId>\\n");
  process.exit(0);
}
if (args[0] === "app-server") {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === "session/requestRuntimePreferences") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } }) + "\\n");
        continue;
      }
      if (message.method === "session/list") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { sessions: [] } }) + "\\n");
        continue;
      }
      process.exit(1);
    }
  });
}
if (args[0] !== "app-server") process.exit(1);
`);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/me") {
      response.end(JSON.stringify({ data: { id: "user-1", username: "Test User", device_id: "device-1" } }));
      return;
    }
    if (request.url === "/v1/projects") {
      response.end(JSON.stringify({ data: { projects: [{
        id: "project-1", title: "Test Project", role: "owner", state: "active", session_count: 0,
      }] } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const fakeToken = "gta_test-only-not-a-real-credential";
    const result = await runExecutable(executable, [
      "--url", `http://127.0.0.1:${address.port}`,
      "--project", "project-1",
      "--workspace", directory,
      "--zcode-command", fakeZcode,
      "--preflight-only",
    ], {
      cwd: directory,
      env: { ...process.env, HOME: directory, GATHERTHREAD_TOKEN: fakeToken },
    });
    assert.match(result.stdout, /preflight succeeded/);
    assert.match(result.stdout, /ZCode Protocol: ZCode Protocol version 1/);
    assert.match(result.stdout, /Tool sharing: final answer only/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(fakeToken));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function access(target) {
  return import("node:fs/promises").then((module) => module.access(target));
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli) return run(process.execPath, [npmCli, ...args], options);
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options);
  }
  return run("npm", args, options);
}

function runExecutable(executable, args, options = {}) {
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${executable}.cmd`, ...args], options);
  }
  return run(executable, args, options);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} exited ${signal ?? code}: ${result.stderr || result.stdout}`));
    });
    child.stdin.end(options.input ?? "");
  });
}
