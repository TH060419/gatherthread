#!/usr/bin/env node
import { runCodexConnectMain } from "./index.js";
import { runMcpCli } from "./mcp.js";

const [subcommand] = process.argv.slice(2);

if (subcommand === "mcp") {
  const userMcpEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.toUpperCase().startsWith("GATHERTHREAD_"),
  ));
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith("GATHERTHREAD_")) delete process.env[name];
  }
  await runMcpCli({
    ...userMcpEnvironment,
    // The plugin entry is permanently user-scoped. Internal runtime MCP tools
    // remain available only through the separate workspace package/CLI and
    // cannot be enabled by ambient Desktop environment variables.
    GATHERTHREAD_MCP_TOOL_PROFILE: "user",
    GATHERTHREAD_MCP_TRANSPORT: "connector",
  }).catch(() => {
    // stdout is reserved for MCP JSON-RPC frames.
    process.stderr.write("gatherthread-mcp: startup or transport failure\n");
    process.exitCode = 1;
  });
} else {
  await runCodexConnectMain();
}
