import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scannerPath = fileURLToPath(new URL("../check-secrets.mjs", import.meta.url));

test("secret scan ignores private Git-ignored env files but scans every Git-visible file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gatherthread-secret-scan-"));
  try {
    git(directory, ["init", "--quiet"]);
    await writeFile(join(directory, ".gitignore"), ".env\n");
    await writeFile(join(directory, "safe.txt"), "safe fixture\n");
    await writeFile(
      join(directory, ".env"),
      `GATHERTHREAD_AUTH_TOKEN_PEPPER=${"a".repeat(64)}\n`,
      { mode: 0o600 },
    );

    const ignored = scan(directory);
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.match(ignored.stdout, /Secret pattern check passed/);

    await writeFile(join(directory, "leak.txt"), `SERVICE_ACCESS_TOKEN=${"b".repeat(24)}\n`);
    const visibleLeak = scan(directory);
    assert.equal(visibleLeak.status, 1);
    assert.match(visibleLeak.stderr, /leak\.txt:1: possible environment secret/);
    await rm(join(directory, "leak.txt"));

    git(directory, ["add", "--force", ".env"]);
    const trackedEnv = scan(directory);
    assert.equal(trackedEnv.status, 1);
    assert.match(trackedEnv.stderr, /\.env:1: possible environment secret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("secret scan checks a source archive without requiring Git metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gatherthread-secret-archive-"));
  try {
    await writeFile(join(directory, "safe.txt"), "safe archive fixture\n");
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "node_modules", "ignored.txt"), `SERVICE_ACCESS_TOKEN=${"a".repeat(24)}\n`);

    const safe = scan(directory);
    assert.equal(safe.status, 0, safe.stderr);
    assert.match(safe.stdout, /Secret pattern check passed/);

    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "leak.env"), `SERVICE_ACCESS_TOKEN=${"b".repeat(24)}\n`);
    const leaked = scan(directory);
    assert.equal(leaked.status, 1);
    assert.match(leaked.stderr, /nested\/leak\.env:1: possible environment secret/);

    await rm(join(directory, "nested", "leak.env"));
    await writeFile(join(directory, "nested", "binary-looking.ts"), Buffer.from([
      ...Buffer.from("const value = ", "utf8"),
      0,
      ...Buffer.from(";\n", "utf8"),
    ]));
    const controlByte = scan(directory);
    assert.equal(controlByte.status, 1);
    assert.match(controlByte.stderr, /nested\/binary-looking\.ts: unexpected control byte in text source/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function scan(cwd) {
  return spawnSync(process.execPath, [scannerPath], { cwd, encoding: "utf8" });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
