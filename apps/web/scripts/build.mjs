import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(root, "../..");
const productRoot = resolve(repositoryRoot, "site");
const dist = resolve(root, "dist");
const applicationDist = resolve(dist, "app");
const index = await readFile(resolve(root, "index.html"), "utf8");
const productIndex = await readFile(resolve(productRoot, "index.html"), "utf8");

for (const required of ["src/main.js", "src/styles.css"]) {
  if (!index.includes(`./${required}`)) throw new Error(`index.html must reference ${required}`);
}
for (const required of ["boot.js", "app.js", "styles.css", "./app/"]) {
  if (!productIndex.includes(required)) throw new Error(`product index must reference ${required}`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(applicationDist, { recursive: true });
await cp(resolve(productRoot, "index.html"), resolve(dist, "index.html"));
await cp(resolve(productRoot, "boot.js"), resolve(dist, "boot.js"));
await cp(resolve(productRoot, "app.js"), resolve(dist, "app.js"));
await cp(resolve(productRoot, "styles.css"), resolve(dist, "styles.css"));
await cp(resolve(productRoot, "assets"), resolve(dist, "assets"), { recursive: true });
await cp(resolve(root, "index.html"), resolve(applicationDist, "index.html"));
await cp(resolve(root, "src"), resolve(applicationDist, "src"), { recursive: true });
await cp(resolve(root, "brand"), resolve(applicationDist, "brand"), { recursive: true });
await build({
  entryPoints: {
    markdown: resolve(root, "src/markdown.js"),
    "history-summary-policy": resolve(root, "src/history-summary-policy.js"),
    styles: resolve(root, "src/styles.css"),
  },
  outdir: resolve(applicationDist, "src"),
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
  await cp(resolve(root, asset), resolve(applicationDist, asset));
}
console.log(`Built GatherThread to ${dist}`);
