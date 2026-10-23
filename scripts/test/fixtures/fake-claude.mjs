#!/usr/bin/env node
// Metadata-only native fixture. Any model/execution attempt fails the check.
const args = process.argv.slice(2);
if (Object.keys(process.env).some(name => name.toUpperCase().startsWith("GATHERTHREAD_"))) {
  process.stderr.write("Fixture received a forbidden connector environment\n"); process.exit(2);
}
if (args.includes("--version")) console.log("2.1.306 (Claude Code)");
else if (args.includes("--help")) console.log("--print --output-format --include-partial-messages --session-id --model --tools --allowedTools --permission-mode --permission-prompts --restricted --safe-mode --strict-mcp-config --mcp-config --setting-sources --settings --effort");
else if (args[0] === "auth" && args[1] === "status") console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }));
else { process.stderr.write("A metadata-only preflight attempted an execution\n"); process.exitCode = 3; }
