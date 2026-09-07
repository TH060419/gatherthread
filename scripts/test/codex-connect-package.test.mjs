import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageRoot = path.join(root, "packages", "codex-connect");
const packageJsonPath = path.join(packageRoot, "package.json");
const temporaryBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();

test("Codex connector package exposes one standalone fixed-version npm entry", async () => {
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  assert.equal(manifest.name, "@gatherthread/codex-connect");
  assert.equal(manifest.version, "0.1.0-alpha.2");
  assert.equal(manifest.author, "Yuhan He and contributors");
  assert.equal(manifest.license, "Apache-2.0");
  assert.deepEqual(manifest.publishConfig, { access: "public", tag: "alpha" });
  assert.deepEqual(manifest.engines, { node: ">=24" });
  assert.deepEqual(manifest.bin, { "gatherthread-codex-connect": "dist/codex-connect.js" });
  assert.equal(manifest.exports?.["."], "./dist/index.js");
  assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE", "NOTICE"]);
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("packed Codex connector contains only standalone runtime and documentation files", async () => {
  const packed = JSON.parse(execNpmSync(["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.join(tmpdir(), "gatherthread-npm-test-cache") },
  }));
  assert.equal(packed.length, 1);
  const files = packed[0].files.map(({ path: packagePath }) => packagePath).sort();
  assert.deepEqual(files, [
    "LICENSE",
    "NOTICE",
    "README.md",
    "dist/codex-connect.js",
    "dist/codex-hook.js",
    "dist/index.js",
    "dist/mcp.js",
    "package.json",
  ]);
  const bundle = await readFile(path.join(packageRoot, "dist", "index.js"), "utf8");
  assert.doesNotMatch(bundle, /@gatherthread\/(?:adapters|bridge)|packages[\\/]bridge/);
});

test("published entry is importable and its executable provides help without credentials", async () => {
  const api = await import(pathToFileURL(path.join(packageRoot, "dist", "index.js")).href);
  assert.equal(typeof api.runCodexConnectCli, "function");
  assert.equal(typeof api.parseCodexConnectArgs, "function");

  const result = spawnSync(process.execPath, [path.join(packageRoot, "dist", "codex-connect.js"), "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npx --yes @gatherthread\/codex-connect@0\.1\.0-alpha\.2/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /gta_|Bearer|cookie|password/i);
});

test("standalone executable completes a local preflight without a real credential", async (t) => {
  if (process.platform === "win32") {
    t.skip("The fake Codex executable is POSIX-only; native Windows App Server preflight remains a release smoke gate");
    return;
  }
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
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.diagnostic("Loopback listen is blocked by the current test sandbox");
      return;
    }
    throw error;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const directory = await mkdtemp(path.join(temporaryBase, "gtp-"));
    const workspacePath = path.join(directory, "workspace");
    await mkdir(workspacePath);
    const requestedWorkspacePath = process.platform === "win32"
      ? workspacePath
      : path.join(directory, "workspace-link");
    if (process.platform !== "win32") await symlink(workspacePath, requestedWorkspacePath, "dir");
    const executable = path.join(packageRoot, "dist", "codex-connect.js");
    const fakeCodex = path.join(root, "scripts", "test", "fixtures", "fake-codex.mjs");
    const child = spawn(process.execPath, [
      executable,
      "--url", `http://127.0.0.1:${address.port}`,
      "--project", "project-1",
      "--workspace", requestedWorkspacePath,
      "--codex-command", fakeCodex,
      "--preflight-only",
    ], {
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        GATHERTHREAD_TOKEN: "gta_test-only-not-a-real-credential",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const output = Buffer.concat(stdout).toString("utf8");
    const errors = Buffer.concat(stderr).toString("utf8");
    assert.equal(code, 0, errors);
    assert.match(output, /Codex App Server ready: fake-codex 0\.1; Logged in for isolated preflight/);
    assert.match(output, new RegExp(`Workspace: ${escapeRegExp(workspacePath)}`));
    assert.match(output, /no session runtime was registered/);
    assert.doesNotMatch(`${output}\n${errors}`, /gta_test-only-not-a-real-credential/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function execNpmSync(args, options) {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli) return execFileSync(process.execPath, [npmCli, ...args], options);
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options);
  }
  return execFileSync("npm", args, options);
}
