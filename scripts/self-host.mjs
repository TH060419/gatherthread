#!/usr/bin/env node
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "start";
const forwardedArguments = process.argv.slice(3);
if (!new Set(["start", "init", "bootstrap"]).has(mode)) {
  process.stderr.write("Usage: node scripts/self-host.mjs [start|init|bootstrap] [CLI options]\n");
  process.exit(2);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

const buildTarget = mode === "start" ? "build" : "build:ts";
const built = await run(npmCommand, ["run", buildTarget]);
if (built.signal) {
  process.kill(process.pid, built.signal);
} else if (built.code !== 0) {
  process.exitCode = built.code;
} else {
  const command = mode === "start" ? "start" : "bootstrap";
  const result = await run(process.execPath, ["apps/server/dist/src/cli.js", command, ...forwardedArguments]);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
}
