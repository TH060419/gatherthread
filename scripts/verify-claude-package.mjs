#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const temporary = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "gt-claude-pack-"));
const output = path.join(temporary, "pack"), install = path.join(temporary, "install"), cache = path.join(temporary, "cache");
try {
  await mkdir(output);
  await npm(["--cache", cache, "pack", "--workspace", "@gatherthread/claude-connect", "--pack-destination", output], root);
  const archives = (await readdir(output)).filter(file => file.endsWith(".tgz")); assert.equal(archives.length, 1);
  await npm(["--cache", cache, "install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", path.join(output, archives[0])], root);
  const packageRoot = path.join(install, "node_modules/@gatherthread/claude-connect");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const entry = path.join(packageRoot, "dist/claude-connect.js");
  assert.match((await run(process.execPath, [entry, "--help"], install)).stdout, /--model.*exact-model-id/u);
  const pluginPath = (await run(process.execPath, [entry, "plugin-path"], install)).stdout.trim();
  assert.equal(pluginPath, path.join(packageRoot, "dist/plugin-marketplace/"));
  const plugin = path.join(pluginPath, "plugins/gatherthread");
  const nativeManifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(nativeManifest.version, manifest.version);
  const frames = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" }].map(JSON.stringify).join("\n") + "\n";
  const mcp = await run(process.execPath, [path.join(plugin, "scripts/mcp-launcher.mjs")], install, {
    input: frames, env: { ...process.env, GATHERTHREAD_TOKEN: "gta_synthetic_private", GATHERTHREAD_MCP_TOOL_PROFILE: "runtime", GATHERTHREAD_MCP_TRANSPORT: "server-env" } });
  const replies = mcp.stdout.trim().split("\n").map(JSON.parse), names = replies[1].result.tools.map(tool => tool.name);
  assert.ok(names.includes("collaboration_read_context")); assert.ok(!names.includes("collaboration_register_runtime"));
  assert.ok(!names.includes("collaboration_import_codex_history")); assert.doesNotMatch(mcp.stdout + mcp.stderr, /gta_synthetic_private/u);
  assert.equal((await readFile(path.join(plugin, "connector/LICENSE"), "utf8")), await readFile(path.join(root, "LICENSE"), "utf8"));
  if (process.platform !== "win32") {
    const fake = path.join(temporary, "fake-claude.mjs");
    await copyFile(path.join(root, "scripts/test/fixtures/fake-claude.mjs"), fake); await chmod(fake, 0o755);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/me") response.end(JSON.stringify({ data: { id: "user-1", username: "Synthetic User", device_id: "device-1" } }));
      else if (request.url === "/v1/projects") response.end(JSON.stringify({ data: { projects: [{ id: "project-1", title: "Synthetic project", role: "owner", state: "active", session_count: 0 }] } }));
      else { response.statusCode = 404; response.end(JSON.stringify({ error: { code: "unexpected_preflight_write", message: "No writes allowed" } })); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const check = await run(process.execPath, [entry, "--url", `http://127.0.0.1:${address.port}`, "--project", "project-1",
        "--model", "claude-sonnet-fixture", "--workspace", install, "--claude-command", fake, "--preflight-only"], install,
      { env: { ...process.env, HOME: temporary, USERPROFILE: temporary, GATHERTHREAD_TOKEN: "gta_synthetic_private" } });
      assert.match(check.stdout, /no session runtime was registered.*no model was called/u);
      assert.doesNotMatch(check.stdout + check.stderr, /gta_synthetic_private/u);
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
  process.stdout.write("Git-less Claude tarball, embedded plugin, private user-only MCP and no-model preflight passed.\n");
} finally { await rm(temporary, { recursive: true, force: true }); }
function npm(args, cwd) {
  const executable = process.env.npm_execpath;
  if (executable) return run(process.execPath, [executable, ...args], cwd);
  return process.platform === "win32" ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], cwd) : run("npm", args, cwd);
}
function run(command, args, cwd, { env = process.env, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(output); else reject(new Error(`Local package check exited ${signal ?? code}: ${output.stderr || output.stdout}`)); });
    child.stdin.end(input);
  });
}
