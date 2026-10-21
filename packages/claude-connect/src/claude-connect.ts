#!/usr/bin/env node
import { runClaudeConnectMain } from "./index.js";
import { runClaudeMcp } from "./mcp.js";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "plugin-path") {
  process.stdout.write(fileURLToPath(new URL("./plugin-marketplace/", import.meta.url)) + "\n");
} else if (process.argv[2] === "mcp") {
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith("GATHERTHREAD_")) delete process.env[name];
  }
  await runClaudeMcp().catch(() => {
    process.stderr.write("gatherthread-claude-mcp: local connector transport unavailable\n");
    process.exitCode = 1;
  });
} else await runClaudeConnectMain();
