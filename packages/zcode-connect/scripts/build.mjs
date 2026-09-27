#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, "../..");
const bridgeSource = path.join(repositoryRoot, "packages", "bridge", "src");
const dist = path.join(packageRoot, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  legalComments: "none",
  sourcemap: false,
  metafile: true,
};

const library = await build({
  ...shared,
  entryPoints: [path.join(bridgeSource, "zcode-connect.ts")],
  outfile: path.join(dist, "index.js"),
});
await build({
  entryPoints: [path.join(packageRoot, "src", "zcode-connect.ts")],
  outfile: path.join(dist, "zcode-connect.js"),
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node24",
  legalComments: "none",
  sourcemap: false,
});

for (const result of [library]) {
  for (const output of Object.values(result.metafile.outputs)) {
    const unexpected = output.imports.filter(({ path: importPath }) => !importPath.startsWith("node:"));
    if (unexpected.length > 0) {
      throw new Error(`Connector bundle has unresolved runtime imports: ${unexpected.map(({ path: importPath }) => importPath).join(", ")}`);
    }
  }
}
