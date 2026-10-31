#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { AVATAR_CATALOG, robotImage } from "../apps/web/src/avatars.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = path.join(root, "packages/dsh-host");
const outputDirectory = path.join(packageRoot, "dist/bundle");

await mkdir(outputDirectory, { recursive: true });
// Inline the approved asset without a second hand-maintained SVG or a remote
// image request. DSH serves client bundles, not arbitrary package asset paths.
const clientPath = path.join(packageRoot, "client/client.js");
const client = await readFile(clientPath, "utf8");
const mark = await readFile(path.join(root, "logo/svg/mark-color-transparent-light.svg"));
const updatedClient = client.replace(/^const WORKSPACE_AVATARS = .*;$/m,
  `const WORKSPACE_AVATARS = ${JSON.stringify(Object.fromEntries([...AVATAR_CATALOG.map(a => [a.id, a.image]), ["agent", robotImage]]))};`).replace(/^const WORKSPACE_MARK = .*;$/m,
  `const WORKSPACE_MARK = ${JSON.stringify(`data:image/svg+xml;base64,${mark.toString("base64")}`)};`);
if (updatedClient !== client) await writeFile(clientPath, updatedClient);
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
