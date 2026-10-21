import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

for (const required of ["src/bootstrap.js", "src/styles.css"]) {
  if (!index.includes(`./${required}`)) throw new Error(`index.html must reference ${required}`);
}
for (const required of ["boot.js", "app.js", "styles.css", "./app/"]) {
  if (!productIndex.includes(required)) throw new Error(`product index must reference ${required}`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(applicationDist, { recursive: true });
await cp(resolve(root, "test-gate"), resolve(dist, "test-gate"), { recursive: true });
await cp(resolve(productRoot, "index.html"), resolve(dist, "index.html"));
await cp(resolve(productRoot, "boot.js"), resolve(dist, "boot.js"));
await cp(resolve(productRoot, "app.js"), resolve(dist, "app.js"));
await cp(resolve(productRoot, "styles.css"), resolve(dist, "styles.css"));
await cp(resolve(productRoot, "privacy"), resolve(dist, "privacy"), { recursive: true });
await cp(resolve(productRoot, "assets"), resolve(dist, "assets"), { recursive: true });
await cp(resolve(root, "index.html"), resolve(applicationDist, "index.html"));
await cp(resolve(root, "src"), resolve(applicationDist, "src"), { recursive: true });
await cp(resolve(root, "brand"), resolve(applicationDist, "brand"), { recursive: true });
const webBuild = await build({
  entryPoints: {
    api: resolve(root, "src/api.js"),
    markdown: resolve(root, "src/markdown.js"),
    onboarding: resolve(root, "src/onboarding.js"),
    "history-summary-policy": resolve(root, "src/history-summary-policy.js"),
    "file-editor": resolve(root, "src/file-editor.js"),
    "file-pdf": resolve(root, "src/file-pdf.js"),
    styles: resolve(root, "src/styles.css"),
  },
  outdir: resolve(applicationDist, "src"),
  bundle: true,
  alias: { "@gatherthread/protocol": resolve(repositoryRoot, "packages/protocol/src/index.ts") },
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
  metafile: true,
});
// A self-contained classic bundle avoids WebKit's opaque-origin 'self' asset
// restriction. The only script is authored build output; no backend is reachable.
const exampleScript = await build({ entryPoints: [resolve(root, "src/example-entry.js")], outfile: "example.js", write: false,
  alias: { "@gatherthread/protocol": resolve(repositoryRoot, "packages/protocol/src/index.ts") },
  bundle: true, format: "iife", platform: "browser", target: ["safari15", "chrome100", "firefox100"], minify: true });
const exampleStyle = await build({ entryPoints: [resolve(root, "src/styles.css")], outfile: "example.css", write: false,
  bundle: true, minify: true, loader: { ".ttf": "dataurl", ".woff": "dataurl", ".woff2": "dataurl" } });
const policy = "default-src 'none'; script-src 'nonce-gatherthread-example-v1'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
let exampleHtml = index.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`)
  .replace(/<link[^>]+rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/gu, '')
  .replace(/<link[^>]+rel="stylesheet"[^>]*>/u, () => `<style>${exampleStyle.outputFiles[0].text}</style>`)
  .replace(/<script type="module" src="\.\/src\/bootstrap\.js[^" ]*"><\/script>/u,
    () => `<script nonce="gatherthread-example-v1">${exampleScript.outputFiles[0].text.replace(/<\/script/giu, '<\\/script')}</script>`);
for (const path of new Set([...exampleHtml.matchAll(/src="(\.\/(?:brand\/[^" ]+|favicon-32x32\.png))"/gu)].map((match) => match[1]))) {
  const svg = await readFile(resolve(root, path.slice(2)));
  exampleHtml = exampleHtml.replaceAll(path, `data:${path.endsWith('.png') ? 'image/png' : 'image/svg+xml'};base64,${svg.toString('base64')}`);
}
await writeFile(resolve(applicationDist, "example.html"), exampleHtml);
await mkdir(resolve(applicationDist, "licenses"), { recursive: true });
await cp(resolve(repositoryRoot, "node_modules/driver.js/license"), resolve(applicationDist, "licenses/driver.js.txt"));
const pdfRoot = resolve(repositoryRoot, "node_modules/pdfjs-dist");
const pdfAssets = resolve(applicationDist, "src/pdfjs");
await mkdir(pdfAssets, { recursive: true });
await cp(resolve(pdfRoot, "legacy/build/pdf.worker.min.mjs"), resolve(pdfAssets, "pdf.worker.min.mjs"));
for (const directory of ["cmaps", "standard_fonts"]) await cp(resolve(pdfRoot, directory), resolve(pdfAssets, directory), { recursive: true });
for (const [name, license] of [["codemirror", "LICENSE"], ["@codemirror/merge", "LICENSE"], ["pdfjs-dist", "LICENSE"]]) {
  await cp(resolve(repositoryRoot, "node_modules", name, license), resolve(applicationDist, "licenses", `${name.replaceAll("/", "-")}.txt`));
}
// Include the actual bundled parsers' copyright/license notices as well as the
// top-level editor/PDF licenses. These files never contain project source.
const bundledPackages = new Set(Object.keys(webBuild.metafile.inputs).flatMap(path => {
  if (!path.includes("node_modules/")) return [];
  const parts = path.split("node_modules/").at(-1).split("/");
  return [parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]];
}));
for (const name of bundledPackages) {
  const directory = resolve(repositoryRoot, "node_modules", name);
  const notices = (await readdir(directory)).filter(file => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(file));
  for (const notice of notices) await cp(resolve(directory, notice), resolve(applicationDist, "licenses", `${name.replaceAll("/", "-")}-${notice}`), { recursive: true });
}
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
