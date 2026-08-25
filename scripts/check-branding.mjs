#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const root = process.cwd();
const excludedDirectories = new Set([
  ".git", ".local", "coverage", "dist", "node_modules", "playwright-report", "test-results",
]);
const excludedFiles = new Set([
  ".codex/hooks.json",
  "scripts/check-branding.mjs",
]);
const textExtensions = new Set([
  "", ".cjs", ".css", ".env", ".example", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
  ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const checks = [
  ["old product name", /\bRelayroom\b(?![-_])/i],
  ["old project name", /\bAgent Cooperation Project\b/i],
  ["old package scope", /@agent-cooperation\//],
  ["old repository slug", /\bagent-cooperation-project\b/],
  ["old WebSocket protocol", /\brelayroom-(?:v1|ticket)\b/i],
  ["old environment prefix", /\b(?:ACP|RELAYROOM)_[A-Z0-9_]+\b/],
  ["old credential prefix", /\bacp(?:i|d)?_[A-Za-z0-9_-]{20,}\b/i],
];
const allowedLegacyChecks = new Map([
  ["docs/adr/0004-adopt-gatherthread-project-name.md", new Set(["old product name", "old project name"])],
  ["apps/server/test/server.test.ts", new Set(["old WebSocket protocol"])],
  ["apps/server/test/redaction.test.ts", new Set(["old credential prefix"])],
  ["packages/adapters/test/adapters.test.ts", new Set(["old credential prefix"])],
  ["packages/bridge/src/executor.ts", new Set(["old environment prefix"])],
  ["packages/bridge/test/executor.test.ts", new Set(["old environment prefix"])],
]);
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const name = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.isFile() || excludedFiles.has(name) || !textExtensions.has(extname(entry.name))) continue;
    if ((await stat(absolute)).size > 1_000_000) continue;
    const lines = (await readFile(absolute, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      for (const [kind, pattern] of checks) {
        if (pattern.test(line) && !allowedLegacyChecks.get(name)?.has(kind)) {
          findings.push(`${name}:${index + 1}: ${kind}`);
        }
      }
    }
  }
}

await walk(root);
for (const finding of findings) process.stderr.write(`ERROR branding: ${finding}\n`);
if (findings.length) process.exitCode = 1;
else process.stdout.write("GatherThread branding check passed\n");
