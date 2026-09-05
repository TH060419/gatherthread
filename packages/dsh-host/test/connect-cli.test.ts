import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  dshChildEnvironment,
  parseDshConnectArgs,
  pipeRedacted,
  runDshConnectCli,
} from "../src/connect-cli.js";
import {
  createDshConnectionPlan,
  installDshConnection,
} from "../src/connection-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

async function installedFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-cli-")));
  const dshHome = path.join(root, "dsh-home");
  const profile = path.join(dshHome, "profiles", "web");
  const workspace = path.join(root, "workspace");
  const dshSource = path.join(root, "pinned-dsh");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(dshSource, { mode: 0o700 });
  await writeFile(path.join(profile, "package.json"), "{\"private\":true}\n", { mode: 0o600 });
  const plan = createDshConnectionPlan({
    dshSource,
    dshHome,
    packageRoot,
    profile: "web",
    apiUrl: "https://gatherthread.example/v1",
    projectId: "project-1",
    projectName: "Project One",
    deviceId: "device-1",
    workspacePath: workspace,
    provider: "deepseek-official",
    model: "DeepSeek-CustomCase",
  });
  await installDshConnection(plan);
  return { root, dshHome, dshSource, plan };
}

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: process.stdin,
      stdout: { isTTY: false, write(value: string | Uint8Array) { stdout += String(value); return true; } },
      stderr: { isTTY: false, write(value: string | Uint8Array) { stderr += String(value); return true; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("parser has no credential option and only runtime commands require a DSH checkout", () => {
  const common = ["--dsh-home", "/tmp/dsh-home"];
  for (const command of ["status", "remove", "restore"] as const) {
    const parsed = parseDshConnectArgs([command, ...common], {});
    if (parsed === "help") throw new Error("unexpected help result");
    assert.equal(parsed.command, command);
  }
  assert.throws(() => parseDshConnectArgs(["start", ...common], {}), /requires --dsh-source/);
  assert.throws(
    () => parseDshConnectArgs(["status", ...common, "--token", "forbidden-secret"], {}),
    /Tokens are forbidden/,
  );
  const planned = parseDshConnectArgs([
    "plan",
    "--dsh-source", "/tmp/pinned-dsh",
    "--url", "https://gatherthread.example/v1",
    "--project", "project-1",
    "--project-name", "Project One",
    "--device", "device-1",
    "--model", "DeepSeek-CustomCase",
  ], { DSH_HOME: "" });
  if (planned === "help") throw new Error("unexpected help result");
  assert.equal(planned.dshHome, path.join(homedir(), ".dsh"));
  assert.equal(planned.model, "DeepSeek-CustomCase");
});

test("status, remove, and restore remain usable after the pinned DSH checkout moves", async () => {
  const fixture = await installedFixture();
  await rename(fixture.dshSource, `${fixture.dshSource}-moved`);
  const output = captureIo();
  const common = ["--dsh-home", fixture.dshHome, "--connection", fixture.plan.connectionId];
  await runDshConnectCli(["status", ...common], {}, output.io);
  assert.match(output.stdout(), /connection .*: installed/);
  assert.match(output.stdout(), /Credential persisted: no/);
  await runDshConnectCli(["remove", ...common], {}, output.io);
  assert.match(output.stdout(), /: removed/);
  await runDshConnectCli(["status", ...common], {}, output.io);
  assert.match(output.stdout(), /connection .*: removed/);
  await runDshConnectCli(["restore", ...common], {}, output.io);
  assert.match(output.stdout(), /: restored/);
  assert.equal(output.stderr(), "");
});

test("launch credentials exist only in child environment and stream output is split-safe redacted", async () => {
  const { plan } = await installedFixture();
  const secret = "gta_split_secret_value";
  const child = dshChildEnvironment({
    PATH: process.env.PATH,
    GATHERTHREAD_TOKEN: secret,
  }, plan, secret);
  assert.equal(child.GATHERTHREAD_TOKEN, undefined);
  assert.equal(child.GATHERTHREAD_DSH_TOKEN, secret);
  assert.equal(child.DSH_HOME, plan.dshHome);

  const stream = new PassThrough();
  let output = "";
  pipeRedacted(stream, { write(value: string | Uint8Array) { output += String(value); return true; } }, secret);
  const ended = once(stream, "end");
  stream.write(`before ${secret.slice(0, 7)}`);
  stream.write(`${secret.slice(7)} after\n`);
  stream.end();
  await ended;
  assert.equal(output, "before [REDACTED] after\n");
  assert.equal(output.includes(secret), false);

  const ordinary = new PassThrough();
  let immediate = "";
  pipeRedacted(ordinary, { write(value: string | Uint8Array) { immediate += String(value); return true; } }, secret);
  ordinary.write("dsh web: http://127.0.0.1:3000/?token=browser-launch-value\n");
  assert.match(immediate, /browser-launch-value/, "non-secret readiness output must not remain buffered");
  ordinary.end();
});
