#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = path.join(root, "packages/dsh-host");
const outputDirectory = path.join(packageRoot, "dist/bundle");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: {
    "native-plugin": path.join(packageRoot, "dist/src/native-plugin.js"),
    plugin: path.join(packageRoot, "dist/src/plugin.js"),
  },
  outdir: outputDirectory,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  treeShaking: true,
  sourcemap: false,
  legalComments: "none",
  external: ["@deepseek-ai/*"],
  logLevel: "warning",
});
