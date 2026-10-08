#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, copyFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryBase = process.platform === "darwin" ? "/private/tmp"
  : process.platform === "win32" ? tmpdir()
    : "/tmp";
const temporaryRoot = await mkdtemp(path.join(temporaryBase, "gtp-"));
const packDirectory = path.join(temporaryRoot, "p");
const installDirectory = path.join(temporaryRoot, "i");
const npmCache = path.join(temporaryRoot, "c");

try {
  await mkdir(packDirectory);
  await runNpm([
    "--cache", npmCache,
    "pack", "--workspace", "@gatherthread/codex-connect",
    "--pack-destination", packDirectory,
  ], { cwd: root });
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  assert.deepEqual(tarballs, ["gatherthread-codex-connect-0.1.0-beta.1.tgz"]);
  const tarball = path.join(packDirectory, tarballs[0]);
  await runNpm(["--cache", npmCache, "install", "--prefix", installDirectory, tarball]);
  await assert.rejects(access(path.join(installDirectory, ".git")));
  await runNpm(["--cache", npmCache, "--prefix", installDirectory, "ls", "--all"]);

  const packageRoot = path.join(installDirectory, "node_modules", "@gatherthread", "codex-connect");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.1.0-beta.1");
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const executable = path.join(installDirectory, "node_modules", ".bin", "gatherthread-codex-connect");
  const help = await runExecutable(executable, ["--help"]);
  assert.match(help.stdout, /@gatherthread\/codex-connect@0\.1\.0-beta\.1/);

  const initialized = await runExecutable(executable, ["mcp"], {
    input: [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ].join("\n") + "\n",
    cwd: installDirectory,
    env: {
      ...process.env,
      GATHERTHREAD_MCP_TOOL_PROFILE: "runtime",
      GATHERTHREAD_MCP_TRANSPORT: "server-env",
      GATHERTHREAD_TOKEN: "gta_hostile-ambient-test-only",
    },
  });
  const mcpResponses = initialized.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(mcpResponses[0].result.serverInfo.name, "gatherthread");
  const toolNames = mcpResponses[1].result.tools.map(({ name }) => name);
  assert.ok(toolNames.includes("collaboration_list_projects"));
  assert.ok(!toolNames.includes("collaboration_register_runtime"));

  if (process.platform !== "win32") {
    await verifyPackedMcpRelay(executable, installDirectory);
    const fakeCodex = path.join(installDirectory, "fake-codex.mjs");
    await copyFile(path.join(root, "scripts", "test", "fixtures", "fake-codex.mjs"), fakeCodex);
    await chmod(fakeCodex, 0o755);
    await verifyPreflight(executable, fakeCodex, installDirectory);
  }

  process.stdout.write("Git-less Codex tarball install, help, dependency, MCP, and no-real-credential preflight checks passed.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifyPreflight(executable, fakeCodex, directory) {
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
      "--codex-command", fakeCodex,
      "--preflight-only",
    ], {
      cwd: directory,
      env: { ...process.env, HOME: directory, GATHERTHREAD_TOKEN: fakeToken },
    });
    assert.match(result.stdout, /no session runtime was registered/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(fakeToken));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function verifyPackedMcpRelay(executable, directory) {
  const workspacePath = path.join(directory, "project-workspace");
  const pluginCwd = path.join(directory, "plugin-cache-cwd");
  const canonicalWorkspace = await realpath(await mkdir(workspacePath, { recursive: true }).then(() => workspacePath));
  await mkdir(pluginCwd);
  const endpointId = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 24);
  const endpointDirectory = path.join(directory, ".gatherthread", "codex", "ipc", endpointId);
  const activeDirectory = path.join(directory, ".gatherthread", "codex", "ipc", "active");
  await Promise.all([
    mkdir(endpointDirectory, { recursive: true, mode: 0o700 }),
    mkdir(activeDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const endpoint = path.join(endpointDirectory, "user-api.sock");
  const capability = randomBytes(32).toString("base64url");
  await writeFile(`${endpoint}.capability`, capability, { mode: 0o600 });
  const instanceId = randomUUID();
  await writeFile(path.join(activeDirectory, `${instanceId}.json`), JSON.stringify({
    version: 1,
    instanceId,
    endpoint,
    projectId: "packed-project",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), { mode: 0o600 });
  const relay = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8").trim());
      assert.equal(request.method, "listProjects");
      assert.equal(request.capability, capability);
      socket.end(`${JSON.stringify({ id: request.id, result: [{
        id: "packed-project", name: "Packed project", role: "owner", state: "active", sessionCount: 0,
      }] })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(endpoint, resolve);
  });
  try {
    const response = await runExecutable(executable, ["mcp"], {
      cwd: pluginCwd,
      env: { ...process.env, HOME: directory },
      input: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "collaboration_list_projects", arguments: {} },
      })}\n`,
    });
    const parsed = JSON.parse(response.stdout.trim());
    assert.equal(parsed.id, 3);
    assert.match(parsed.result.content[0].text, /Packed project/);
  } finally {
    await new Promise((resolve, reject) => relay.close((error) => error ? reject(error) : resolve()));
  }
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
