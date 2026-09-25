import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pluginRoot = path.join(root, "plugins", "gatherthread");
const PACKAGE_SPEC = "@gatherthread/codex-connect@0.1.0-alpha.7";

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(pluginRoot, relativePath), "utf8"));
}

test("GatherThread plugin manifest has valid local components and bilingual brand", async () => {
  const manifest = await json(".codex-plugin/plugin.json");
  assert.equal(manifest.name, "gatherthread");
  assert.equal(manifest.version, "0.1.0-alpha.7");
  assert.equal(manifest.interface.displayName, "共序 / GatherThread");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.apps, undefined);
  await Promise.all([
    readFile(path.join(pluginRoot, "skills", "gatherthread", "SKILL.md"), "utf8"),
    readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
  ]);
});

test("plugin stdio MCP uses the fixed package without embedding credentials", async () => {
  const config = await json(".mcp.json");
  const server = config.mcpServers.gatherthread;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${PLUGIN_ROOT}/scripts/mcp-launcher.mjs"]);
  assert.equal(server.env_vars, undefined);
  assert.equal(server.env, undefined);
  assert.doesNotMatch(JSON.stringify(config), /gta_|Bearer|cookie|password|client_secret/i);

  const launcherPath = path.join(pluginRoot, "scripts", "mcp-launcher.mjs");
  const launcher = await import(pathToFileURL(launcherPath).href);
  assert.deepEqual(launcher.resolveMcpLauncherInvocation("linux", {}), {
    command: "npx",
    args: ["--yes", PACKAGE_SPEC, "mcp"],
  });
  const windows = launcher.resolveMcpLauncherInvocation("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(windows.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(windows.args, ["/d", "/s", "/c", "npx.cmd", "--yes", PACKAGE_SPEC, "mcp"]);
  assert.notEqual(windows.command, "npx");
  const npmCli = launcher.resolveMcpLauncherInvocation("win32", { npm_execpath: "C:\\npm\\npm-cli.js" });
  assert.equal(npmCli.command, process.execPath);
  assert.deepEqual(npmCli.args, [
    "C:\\npm\\npm-cli.js", "exec", "--yes", `--package=${PACKAGE_SPEC}`, "--", "gatherthread-codex-connect", "mcp",
  ]);
  const launcherSource = await readFile(launcherPath, "utf8");
  assert.match(launcherSource, /!name\.startsWith\("GATHERTHREAD_"\)/);
  assert.doesNotMatch(launcherSource, /GATHERTHREAD_TOKEN\s*[:=]/);
});

test("repo marketplace exposes the real plugin and all install surfaces pin one release ref", async () => {
  const marketplace = JSON.parse(await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "gatherthread");
  assert.equal(marketplace.interface.displayName, "共序 / GatherThread");
  assert.deepEqual(marketplace.plugins, [{
    name: "gatherthread",
    source: { source: "local", path: "./plugins/gatherthread" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  }]);
  const fixedCommand = "codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.7 --sparse .agents/plugins --sparse plugins/gatherthread";
  const [html, english, chinese, rootEnglish, rootChinese, packageReadme, release, translations] = await Promise.all([
    readFile(path.join(root, "apps", "web", "index.html"), "utf8"),
    readFile(path.join(root, "docs", "CODEX_CONNECT.md"), "utf8"),
    readFile(path.join(root, "docs", "CODEX_CONNECT.zh-CN.md"), "utf8"),
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "README.zh-CN.md"), "utf8"),
    readFile(path.join(root, "packages", "codex-connect", "README.md"), "utf8"),
    readFile(path.join(root, "docs", "releases", "0.1.0-alpha.7.md"), "utf8"),
    readFile(path.join(root, "apps", "web", "src", "i18n.js"), "utf8"),
  ]);
  const installCommand = "codex plugin add gatherthread@gatherthread";
  for (const surface of [html, english, chinese, rootEnglish, rootChinese, packageReadme, release]) {
    assert.match(surface, new RegExp(fixedCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(surface, new RegExp(installCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const guide of [html, english, chinese, rootEnglish, rootChinese]) {
    assert.match(guide, /npm install -g @openai\/codex/);
    assert.match(guide, /codex plugin --help/);
  }
  assert.match(html, />1<\/span>[\s\S]*<h3>Install once<\/h3>[\s\S]*>2<\/span>[\s\S]*<h3>Connect this project<\/h3>[\s\S]*>3<\/span>[\s\S]*<h3>Confirm in Codex<\/h3>/);
  assert.match(translations, /"Install once": "仅需安装一次"/);
  assert.match(translations, /"Connect this project": "连接当前项目"/);
  assert.match(translations, /"Confirm in Codex": "在 Codex 中确认"/);
  assert.doesNotMatch(`${fixedCommand}\n${installCommand}`, /gta_|Bearer|cookie|token=|password|client_secret/i);
});

test("plugin hooks use only reviewed prompt and stop events with no secret or config mutation", async () => {
  const config = await json("hooks/hooks.json");
  assert.deepEqual(Object.keys(config.hooks).sort(), ["Stop", "UserPromptSubmit"]);
  for (const [event, entries] of Object.entries(config.hooks)) {
    assert.equal(entries.length, 1);
    assert.equal(entries[0].hooks.length, 1);
    const hook = entries[0].hooks[0];
    assert.equal(hook.type, "command");
    assert.equal(hook.command, 'node "${PLUGIN_ROOT}/scripts/hook-forwarder.mjs"');
    assert.equal(hook.timeout, 5);
    if (event === "UserPromptSubmit") assert.equal(hook.additionalContextLimit, 2500);
    else assert.equal(hook.additionalContextLimit, undefined);
  }
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /GATHERTHREAD_TOKEN|gta_|config\.toml|danger-full-access|sudo/i);
  assert.doesNotMatch(serialized, /npx|npm/);
});

test("plugin hook forwarder is self-contained and fails closed without a connector", async () => {
  const scriptPath = path.join(pluginRoot, "scripts", "hook-forwarder.mjs");
  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /node:net/);
  assert.doesNotMatch(script, /@gatherthread|GATHERTHREAD_TOKEN|child_process|exec|spawn/);
  const result = spawnSync(process.execPath, [scriptPath], { input: "{}", encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{}\n");
  assert.doesNotMatch(result.stderr, /token|credential|Bearer|gta_/i);
});

test("plugin hook forwarder resolves a descendant cwd through the connector root registry", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX plugin relay fixture; Windows path derivation is covered by bridge tests");
    return;
  }
  const directory = await mkdtemp("/tmp/gtp-");
  const homeDirectory = path.join(directory, "h");
  const workspacePath = path.join(directory, "w");
  const nestedPath = path.join(workspacePath, "src", "nested");
  await mkdir(nestedPath, { recursive: true });
  const canonicalWorkspacePath = await realpath(workspacePath);
  const linkedWorkspacePath = path.join(directory, "workspace-link");
  await symlink(workspacePath, linkedWorkspacePath, "dir");
  const id = createHash("sha256").update(canonicalWorkspacePath).digest("hex").slice(0, 24);
  const stateRoot = path.join(homeDirectory, ".gatherthread", "codex", "hooks", id);
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path.join(stateRoot, "hook-registry.json"), JSON.stringify({
    version: 1,
    workspacePath: canonicalWorkspacePath,
    threads: { "desktop-thread": "execution" },
    hookSource: "plugin",
  }));
  const endpoint = path.join(stateRoot, "hook-relay.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end('{"additionalContext":"Cloud delta"}'));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.diagnostic("Unix sockets are blocked by the current test sandbox");
      return;
    }
    throw error;
  }
  try {
    const child = spawn(process.execPath, [path.join(pluginRoot, "scripts", "hook-forwarder.mjs")], {
      env: { ...process.env, HOME: homeDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "desktop-thread",
      turn_id: "turn-1",
      cwd: path.join(linkedWorkspacePath, "src", "nested"),
      model: "gpt-5.6-sol",
      prompt: "hello",
    }));
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString("utf8")), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Cloud delta" },
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("plugin skill documents the two modes and the no-wakeup boundary", async () => {
  const skill = await readFile(path.join(pluginRoot, "skills", "gatherthread", "SKILL.md"), "utf8");
  assert.match(skill, /basic mode/i);
  assert.match(skill, /full mode/i);
  assert.match(skill, /cannot wake|cannot start a new turn/i);
  assert.match(skill, /OAuth 2\.1|PKCE/);
  assert.match(skill, /private local IPC/i);
  assert.match(skill, /developer preview/i);
  assert.match(skill, /register_runtime|claim.*complete/is);
  assert.doesNotMatch(skill, /\[TODO:/);
});
