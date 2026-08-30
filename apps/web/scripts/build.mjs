import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const index = await readFile(resolve(root, "index.html"), "utf8");

for (const required of ["src/main.js", "src/styles.css"]) {
  if (!index.includes(`./${required}`)) throw new Error(`index.html must reference ${required}`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "index.html"), resolve(dist, "index.html"));
await cp(resolve(root, "src"), resolve(dist, "src"), { recursive: true });
await cp(resolve(root, "brand"), resolve(dist, "brand"), { recursive: true });
await build({
  entryPoints: {
    markdown: resolve(root, "src/markdown.js"),
    styles: resolve(root, "src/styles.css"),
  },
  outdir: resolve(dist, "src"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["safari15", "chrome100", "firefox100"],
  assetNames: "fonts/[name]-[hash]",
  loader: {
    ".ttf": "file",
    ".woff": "file",
    ".woff2": "file",
  },
  minify: true,
  sourcemap: false,
});
for (const asset of [
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "site.webmanifest",
]) {
  await cp(resolve(root, asset), resolve(dist, asset));
}
console.log(`Built GatherThread to ${dist}`);
