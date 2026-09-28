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

test("operator can issue and revoke a single-use test qualification without printing it in diagnostics", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-test-access-cli-"));
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    GATHERTHREAD_DATABASE_PATH: join(directory, "owner.sqlite"),
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "test-only-pepper-not-for-production",
  };
  try {
    const beforeBootstrap = spawnSync(process.execPath, [cliPath, "issue-test-access"], {
      env: environment, encoding: "utf8",
    });
    assert.equal(beforeBootstrap.status, 1);
    assert.match(beforeBootstrap.stderr, /Bootstrap the first owner/);
    const bootstrap = spawnSync(process.execPath, [
      cliPath, "bootstrap", "--display-name", "Owner", "--device-name", "Owner laptop",
    ], { env: environment, encoding: "utf8" });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const issued = spawnSync(process.execPath, [cliPath, "issue-test-access", "--ttl", "24h"], {
      env: environment, encoding: "utf8",
    });
    assert.equal(issued.status, 0, issued.stderr);
    const grant = JSON.parse(issued.stdout) as { grant_id: string; access_token: string; created_at: string; expires_at: string };
    assert.match(grant.access_token, /^gtq_/);
    assert.ok(grant.grant_id);
    assert.ok(grant.expires_at);
    assert.equal(Date.parse(grant.expires_at) - Date.parse(grant.created_at), 86_400_000);
    assert.equal(issued.stdout.split(grant.access_token).length - 1, 1);
    assert.doesNotMatch(issued.stderr, new RegExp(grant.access_token));
    const revoked = spawnSync(process.execPath, [cliPath, "revoke-test-access", "--grant-id", grant.grant_id], {
      env: environment, encoding: "utf8",
    });
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.doesNotMatch(revoked.stdout + revoked.stderr, new RegExp(grant.access_token));

    const batch = spawnSync(process.execPath, [cliPath, "issue-test-access", "--count", "3", "--ttl", "1h", "--format", "share"], {
      env: environment, encoding: "utf8",
    });
    assert.equal(batch.status, 0, batch.stderr);
    const codes = [...batch.stdout.matchAll(/测试资格码：(gtq_[^\n]+)/gu)].map((match) => match[1]!);
    assert.equal(codes.length, 3);
    assert.equal(new Set(codes).size, 3);
    assert.equal((batch.stdout.match(/初次登录请使用上述资格码激活账号/g) ?? []).length, 3);
    assert.equal((batch.stdout.match(/有效期：.+至.+（北京时间）/g) ?? []).length, 3);
    assert.equal((batch.stderr.match(/Revoke ID \d\/3:/g) ?? []).length, 3);
    for (const code of codes) {
      assert.equal(batch.stdout.split(code).length - 1, 1);
      assert.doesNotMatch(batch.stderr, new RegExp(code));
    }

    const jsonBatch = spawnSync(process.execPath, [cliPath, "issue-test-access", "--count", "2"], {
      env: environment, encoding: "utf8",
    });
    assert.equal(jsonBatch.status, 0, jsonBatch.stderr);
    const jsonGrants = JSON.parse(jsonBatch.stdout) as { grant_id: string; access_token: string }[];
    assert.equal(jsonGrants.length, 2);
    assert.equal(new Set(jsonGrants.map((item) => item.grant_id)).size, 2);

    for (const args of [["--count", "0"], ["--count", "51"], ["--count", "1.5"], ["--count", "2", "--count", "3"], ["--format", "unknown"]]) {
      const invalid = spawnSync(process.execPath, [cliPath, "issue-test-access", ...args], {
        env: environment, encoding: "utf8",
      });
      assert.equal(invalid.status, 1, invalid.stderr);
      assert.doesNotMatch(invalid.stdout + invalid.stderr, /gtq_/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
