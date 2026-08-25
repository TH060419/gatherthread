#!/usr/bin/env node
import { runCodexHookForwarder } from "./codex-hooks.js";

const args = process.argv.slice(2);
const socketPath = option(args, "--socket");
const spoolPath = option(args, "--spool");
const registryPath = option(args, "--registry");

runCodexHookForwarder({ socketPath, spoolPath, registryPath }).catch((error: unknown) => {
  process.stderr.write(`gatherthread-codex-hook: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
});

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
