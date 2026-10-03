import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("retired account and qualification commands cannot issue credentials or open SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-retired-cli-"));
  const dbPath = join(directory, "owner.sqlite");
  const env = { ...process.env, NODE_ENV: "test", GATHERTHREAD_DATABASE_PATH: dbPath,
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "test-only-pepper-not-for-production" };
  try {
    for (const command of ["bootstrap", "init", "issue-test-access", "revoke-test-access"]) {
      const result = spawnSync(process.execPath, [cliPath, command], { env, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unknown command/);
      assert.doesNotMatch(result.stdout + result.stderr, /gt[aq]_/);
      assert.equal(existsSync(dbPath), false);
    }
    const help = spawnSync(process.execPath, [cliPath, "--help"], { env, encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /verified email/);
    assert.doesNotMatch(help.stdout, /issue-test-access|bootstrap/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local registration pause survives subsequent CLI runs and resume does not enable missing providers", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-registration-cli-"));
  const env = { ...process.env, NODE_ENV: "test", GATHERTHREAD_DATABASE_PATH: join(directory, "test.sqlite"),
    GATHERTHREAD_PUBLIC_REGISTRATION: "false", GATHERTHREAD_AUTH_TOKEN_PEPPER: "test-only-pepper-not-for-production" };
  try {
    for (const [action, paused] of [["pause", true], ["status", true], ["resume", false], ["cleanup", false]] as const) {
      const result = spawnSync(process.execPath, [cliPath, "registration", action], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { enabled: false, paused });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
