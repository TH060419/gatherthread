import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("local bootstrap creates the first owner and emits its credential exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-cli-"));
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    GATHERTHREAD_DATABASE_PATH: join(directory, "owner.sqlite"),
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "test-only-pepper-not-for-production",
  };
  const argumentsList = [
    cliPath,
    "bootstrap",
    "--user-id", "owner",
    "--display-name", "Owner",
    "--device-id", "owner-device",
    "--device-name", "Owner laptop",
  ];
  try {
    const first = spawnSync(process.execPath, argumentsList, { env: environment, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const credential = JSON.parse(first.stdout) as { access_token: string };
    assert.match(credential.access_token, /^gta_/);
    assert.equal(first.stdout.split(credential.access_token).length - 1, 1);
    assert.doesNotMatch(first.stderr, new RegExp(credential.access_token));

    const repeated = spawnSync(process.execPath, argumentsList, { env: environment, encoding: "utf8" });
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /Bootstrap is available only for an empty database/);
    assert.doesNotMatch(repeated.stdout, /gta_/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap rejects incomplete and unknown command-line options before opening SQLite", () => {
  const incomplete = spawnSync(process.execPath, [cliPath, "bootstrap", "--display-name", "Owner"], {
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
  });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /--device-name is required/);

  const unknown = spawnSync(process.execPath, [cliPath, "bootstrap", "--unknown", "value"], {
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown bootstrap option/);
});
