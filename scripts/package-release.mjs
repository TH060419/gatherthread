#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0-beta.1";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (trackedChanges) {
  throw new Error("Refusing to package a release with uncommitted tracked changes");
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== VERSION) throw new Error(`Expected package version ${VERSION}`);

const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const outputDirectory = join(root, "release-artifacts");
const archiveName = `gatherthread-${VERSION}-${commit}.tar.gz`;
const archivePath = join(outputDirectory, archiveName);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
execFileSync("git", [
  "archive",
  "--format=tar.gz",
  `--prefix=gatherthread-${VERSION}/`,
  `--output=${archivePath}`,
  "HEAD",
], { cwd: root, stdio: "inherit" });

const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`, { mode: 0o600 });
process.stdout.write(`${archivePath}\n${archivePath}.sha256\n`);
