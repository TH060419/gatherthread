// Real cached public CLI installation in a disposable home. No model or server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.ok(process.env.GATHERTHREAD_DSH_NPM_ROOT, "Provide an already-installed, verified DSH root; this check never downloads DSH");
const dshRoot = await realpath(process.env.GATHERTHREAD_DSH_NPM_ROOT);
const dsh = JSON.parse(await readFile(join(dshRoot, "package.json"), "utf8"));
assert.equal(dsh.name, "@deepseek-ai/dsh");
assert.equal(dsh.version, "0.1.2-rc.1");
assert.equal(dsh.bin.dsh, "lib/bin.js");
const directory = await realpath(await mkdtemp(join(tmpdir(), "gt-local-install-")));
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|PASSWORD|SECRET|COOKIE/i.test(name))),
  DSH_HOME: join(directory, "dsh-home"), DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1",
  npm_config_cache: join(directory, "npm-cache"), npm_config_offline: "true",
  npm_config_store_dir: join(directory, "pnpm-store"), PNPM_CONFIG_OFFLINE: "true" };
const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : "npm";
const npmArguments = args => npmCli ? [npmCli, ...args] : args;
function run(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { env: environment, cwd: resolve("."), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.once("error", error => { clearTimeout(timer); fail(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? done(stdout) : fail(new Error(`Isolated CLI failed (${code}): ${stderr}`)); });
  });
}
async function pack(workspace) {
  const output = await run(npm, npmArguments(["pack", "--ignore-scripts", "--json", "--workspace", workspace, "--pack-destination", directory]));
  return join(directory, JSON.parse(output)[0].filename);
}
try {
  const dshTarball = await pack("@gatherthread/dsh-host");
  for (let attempt = 0; attempt < 2; attempt++) {
    await run(process.execPath, [join(dshRoot, dsh.bin.dsh), "plugin", "--profile", "web", "add", "--offline", dshTarball]);
  }
  const profile = JSON.parse(await readFile(join(environment.DSH_HOME, "profiles/web/package.json"), "utf8"));
  assert.match(profile.dependencies["@gatherthread/dsh-host"], /^file:/);
  assert.equal(profile.dsh.profile.bundles.filter(name => name === "@gatherthread/dsh-host").length, 1);
  console.log("PASS: cached DSH 0.1.2-rc.1 public CLI accepts local TGZ twice, one profile layer, no model calls");
  const codexTarball = await pack("@gatherthread/codex-connect");
  const help = await run(npm, npmArguments(["exec", "--offline", "--yes", "--package", codexTarball, "--", "gatherthread-codex-connect", "--help"]));
  assert.match(help, /--project/); assert.match(help, /--plugin-hooks/);
  console.log("PASS: npm exec accepts local Codex connector TGZ and runs its real --help, no authorization or provider calls");
} finally { await rm(directory, { recursive: true, force: true }); }
