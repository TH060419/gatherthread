import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureLocalOwnerHostEnvironment } from "../local-env.mjs";

const template = "NODE_ENV=development\nGATHERTHREAD_AUTH_TOKEN_PEPPER=\n";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gatherthread-local-env-"));
  await writeFile(join(directory, ".env.example"), template);
  return directory;
}

test("owner-host init creates a private ignored environment with a generated pepper", async () => {
  const directory = await fixture();
  const env = {};
  try {
    const result = await ensureLocalOwnerHostEnvironment({ cwd: directory, env });
    assert.equal(result.generated, true);
    assert.match(env.GATHERTHREAD_AUTH_TOKEN_PEPPER, /^[a-f0-9]{64}$/);
    assert.match(await readFile(join(directory, ".env"), "utf8"), /^GATHERTHREAD_AUTH_TOKEN_PEPPER=[a-f0-9]{64}$/m);
    assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner-host init fills an empty pepper without replacing other local settings", async () => {
  const directory = await fixture();
  const env = {};
  try {
    await writeFile(join(directory, ".env"), `${template}GATHERTHREAD_SERVER_PORT=9999\n`, { mode: 0o644 });
    await ensureLocalOwnerHostEnvironment({ cwd: directory, env });
    const contents = await readFile(join(directory, ".env"), "utf8");
    assert.match(contents, /GATHERTHREAD_SERVER_PORT=9999/);
    assert.match(contents, /^GATHERTHREAD_AUTH_TOKEN_PEPPER=[a-f0-9]{64}$/m);
    assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner-host init preserves an existing pepper", async () => {
  const directory = await fixture();
  const existing = "existing-pepper-value-with-at-least-thirty-two-bytes";
  const env = {};
  try {
    await writeFile(join(directory, ".env"), `GATHERTHREAD_AUTH_TOKEN_PEPPER=${existing}\n`, { mode: 0o600 });
    const result = await ensureLocalOwnerHostEnvironment({ cwd: directory, env });
    assert.equal(result.generated, false);
    assert.equal(env.GATHERTHREAD_AUTH_TOKEN_PEPPER, existing);
    assert.equal(await readFile(join(directory, ".env"), "utf8"), `GATHERTHREAD_AUTH_TOKEN_PEPPER=${existing}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an externally supplied pepper is never persisted automatically", async () => {
  const directory = await fixture();
  const external = "external-pepper-value-with-at-least-thirty-two-bytes";
  try {
    const result = await ensureLocalOwnerHostEnvironment({
      cwd: directory,
      env: { GATHERTHREAD_AUTH_TOKEN_PEPPER: external },
    });
    assert.deepEqual(result, { generated: false, source: "environment" });
    await assert.rejects(readFile(join(directory, ".env"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
