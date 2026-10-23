#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { prepareSourcePlugin } from "../../../plugins/gatherthread-claude/scripts/prepare-source-plugin.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(packageRoot, "../..");
const dist = path.join(packageRoot, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const shared = { bundle: true, format: "esm", platform: "node", target: "node24", legalComments: "none",
  sourcemap: false, metafile: true, alias: {
    "@gatherthread/bridge": path.join(root, "packages/bridge/src/index.ts"),
    "@gatherthread/adapters": path.join(root, "packages/adapters/src/index.ts"),
    "@gatherthread/protocol": path.join(root, "packages/protocol/src/index.ts"),
  } };
for (const [input, output] of [["packages/bridge/src/claude-connect.ts", "index.js"],
  ["packages/claude-connect/src/mcp.ts", "mcp.js"]]) {
  const result = await build({ ...shared, entryPoints: [path.join(root, input)], outfile: path.join(dist, output) });
  for (const file of Object.values(result.metafile.outputs)) {
    if (file.imports.some(({ path: imported }) => !imported.startsWith("node:"))) throw new Error("Claude connector has an unresolved runtime dependency");
  }
}
await build({ entryPoints: [path.join(packageRoot, "src/claude-connect.ts")], outfile: path.join(dist, "claude-connect.js"),
  bundle: false, format: "esm", platform: "node", target: "node24", legalComments: "none" });
await chmod(path.join(dist, "claude-connect.js"), 0o755);
for (const file of ["LICENSE", "NOTICE"]) await writeFile(path.join(dist, file), await readFile(path.join(packageRoot, file)), { flag: "wx" });
await prepareSourcePlugin(root, { destination: path.join(dist, "plugin-marketplace") });
process.stdout.write(`Built standalone Claude Code connector in ${dist}\n`);
