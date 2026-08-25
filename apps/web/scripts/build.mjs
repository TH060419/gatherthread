import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
console.log(`Built Relayroom to ${dist}`);
