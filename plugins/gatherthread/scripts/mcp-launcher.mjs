#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PACKAGE_SPEC = "@gatherthread/codex-connect@0.1.0-alpha.5";

export function resolveMcpLauncherInvocation(
  platform = process.platform,
  env = process.env,
) {
  const npmCli = env.npm_execpath?.trim();
  if (npmCli) {
    return {
      command: process.execPath,
      args: [npmCli, "exec", "--yes", `--package=${PACKAGE_SPEC}`, "--", "gatherthread-codex-connect", "mcp"],
    };
  }
  if (platform === "win32") {
    return {
      command: env.ComSpec?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", "npx.cmd", "--yes", PACKAGE_SPEC, "mcp"],
    };
  }
  return { command: "npx", args: ["--yes", PACKAGE_SPEC, "mcp"] };
}

export async function runMcpLauncher(env = process.env) {
  const invocation = resolveMcpLauncherInvocation(process.platform, env);
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GATHERTHREAD_")),
  );
  const child = spawn(invocation.command, invocation.args, {
    env: childEnv,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const forward = (signal) => {
    try { child.kill(signal); } catch { /* The child may already have exited. */ }
  };
  const forwardInterrupt = () => forward("SIGINT");
  const forwardTerminate = () => forward("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTerminate);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) process.kill(process.pid, result.signal);
    else if (result.code !== 0) process.exitCode = result.code ?? 1;
  } finally {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTerminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpLauncher().catch(() => {
    process.stderr.write("gatherthread-mcp-launcher: could not start the fixed-version connector package\n");
    process.exitCode = 1;
  });
}
