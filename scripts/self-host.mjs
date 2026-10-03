#!/usr/bin/env node
import { spawn } from "node:child_process";
import { ensureLocalOwnerHostEnvironment } from "./local-env.mjs";

const mode = process.argv[2] ?? "start";
const forwardedArguments = process.argv.slice(3);
if (!new Set(["start", "init", "registration"]).has(mode)) {
  process.stderr.write("Usage: node scripts/self-host.mjs [start|init|registration] [CLI options]\n");
  process.exit(2);
}

if (mode !== "start") {
  const localEnvironment = await ensureLocalOwnerHostEnvironment();
  if (localEnvironment.generated) {
    process.stdout.write("Created private .env with a generated GatherThread authentication pepper.\n");
  }
  if (mode === "init") {
    if (forwardedArguments.length) throw new Error("init accepts no account arguments");
    process.stdout.write("Private configuration ready. Configure email delivery and Turnstile before enabling registration; no account was created.\n");
    process.exit(0);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

const buildTarget = mode === "start" ? "build" : "build:ts";
const npmCli = process.env.npm_execpath?.trim();
const built = npmCli
  ? await run(process.execPath, [npmCli, "run", buildTarget])
  : process.platform === "win32"
    ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm.cmd run ${buildTarget}`])
    : await run("npm", ["run", buildTarget]);
if (built.signal) {
  process.kill(process.pid, built.signal);
} else if (built.code !== 0) {
  process.exitCode = built.code;
} else {
  const command = mode;
  const result = await run(process.execPath, ["apps/server/dist/src/cli.js", command, ...forwardedArguments]);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
}
