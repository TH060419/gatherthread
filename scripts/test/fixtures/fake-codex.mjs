#!/usr/bin/env node

if (Object.keys(process.env).some((name) => name.toUpperCase().startsWith("GATHERTHREAD_"))) {
  process.stderr.write("fake-codex: connector credential environment was not isolated\n");
  process.exit(97);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("fake-codex 0.1\n");
} else if (args.length === 2 && args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in for isolated preflight\n");
} else if (args.includes("app-server") && args.includes("--stdio")) {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      if (request.id !== undefined) {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    }
  });
} else {
  process.stderr.write("fake-codex: unsupported arguments\n");
  process.exitCode = 2;
}
