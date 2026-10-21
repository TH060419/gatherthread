import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { prepareSourcePlugin } from "../../plugins/gatherthread-claude/scripts/prepare-source-plugin.mjs";
import { resolveMcpLauncherInvocation } from "../../plugins/gatherthread-claude/scripts/mcp-launcher.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const packageRoot = path.join(root, "packages/claude-connect");
const plugin = path.join(root, "plugins/gatherthread-claude");

test("Claude connector is a standalone user-scoped npm package", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@gatherthread/claude-connect");
  assert.deepEqual(manifest.bin, { "gatherthread-claude-connect": "dist/claude-connect.js" });
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.publishConfig, { access: "public", tag: "beta" });
  assert.equal(manifest.engines.node, ">=24");
});

test("Claude plugin has separate native manifest, local MCP and reviewed hooks", async () => {
  const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "gatherthread");
  assert.equal(manifest.icon, "./.claude-plugin/icon.png");
  assert.deepEqual(await readFile(path.join(plugin, ".claude-plugin/icon.png")),
    await readFile(path.join(root, "prototypes/codex-launcher/assets/gatherthread.png")));
  assert.equal(manifest.interface, undefined);
  const mcp = JSON.parse(await readFile(path.join(plugin, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.gatherthread.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launcher.mjs"]);
  assert.doesNotMatch(JSON.stringify(mcp), /gta_|password|Bearer|token|npx/iu);
  const hooks = JSON.parse(await readFile(path.join(plugin, "hooks/hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
  assert.match(JSON.stringify(hooks), /CLAUDE_PLUGIN_ROOT/u);
  assert.doesNotMatch(JSON.stringify(hooks), /transcript|dangerously|npx/iu);
});

test("unprepared Claude plugin refuses an old or downloaded connector", () => {
  const result = spawnSync(process.execPath, [path.join(plugin, "scripts/mcp-launcher.mjs")], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, GATHERTHREAD_TOKEN: "synthetic-private-value" },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /prepare-source-plugin/u);
  assert.doesNotMatch(result.stderr, /synthetic-private-value/u);
});

test("Claude package help and MCP never inherit runtime tools or credentials", () => {
  const entry = path.join(packageRoot, "dist/claude-connect.js");
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--claude-command/u);
  assert.match(help.stdout, /--model/u);
  assert.match(help.stdout, /--plugin-hooks/u);
  const result = spawnSync(process.execPath, [entry, "mcp"], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GATHERTHREAD_MCP_TOOL_PROFILE: "runtime", GATHERTHREAD_MCP_TRANSPORT: "server-env",
      GATHERTHREAD_TOKEN: "gta_synthetic-private-value" }, input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map(JSON.stringify).join("\n") + "\n" });
  assert.equal(result.status, 0, result.stderr);
  const frames = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(frames[0].result.serverInfo.name, "gatherthread");
  const names = frames[1].result.tools.map(({ name }) => name);
  assert.ok(names.includes("collaboration_read_context"));
  assert.ok(names.includes("collaboration_set_local_auto_upload"));
  assert.ok(names.includes("collaboration_get_code_sync_status"));
  assert.ok(!names.includes("collaboration_import_codex_history"));
  assert.ok(!names.includes("collaboration_register_runtime"));
  assert.doesNotMatch(result.stdout + result.stderr, /gta_synthetic-private-value/u);
});

test("matching local Claude plugin refuses bundle tampering and output replacement", async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "gc-stage-")));
  const destination = path.join(temporary, "marketplace");
  assert.equal(await prepareSourcePlugin(root, { destination }), destination);
  const prepared = path.join(destination, "plugins/gatherthread");
  assert.deepEqual(resolveMcpLauncherInvocation(prepared), { command: process.execPath,
    args: [path.join(prepared, "connector/claude-connect.js"), "mcp"] });
  await assert.rejects(prepareSourcePlugin(root, { destination }), /EEXIST/u);
  await writeFile(path.join(prepared, "connector/index.js"), "// synthetic tampered bundle\n");
  assert.throws(() => resolveMcpLauncherInvocation(prepared), /prepare-source-plugin/u);
});

test("Claude hook forwarder is offline fail-open without capturing secrets or scanning transcripts", async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "gc-offline-")));
  const workspace = path.join(temporary, "w"); await mkdir(workspace);
  const result = spawnSync(process.execPath, [path.join(plugin, "scripts/hook-forwarder.mjs")], {
    env: { ...process.env, HOME: temporary, USERPROFILE: temporary }, encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "9c6aa2f3-ff19-4bee-9d56-26b59abdb0de", cwd: workspace,
      last_assistant_message: "SYNTHETIC_PRIVATE_ANSWER", transcript_path: "/private/NEVER_READ" }),
  });
  assert.equal(result.status, 0); assert.equal(result.stdout, "{}\n");
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_ANSWER|NEVER_READ/u);
});
