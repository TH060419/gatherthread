import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertPersistentCredentialPepper,
  ConfigurationError,
  loadServerConfig,
  prepareDatabaseDirectory,
} from "../src/config.js";

const productionEnvironment = {
  NODE_ENV: "production",
  GATHERTHREAD_PUBLIC_BASE_URL: "https://owner.example.ts.net",
  GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "true",
  GATHERTHREAD_AUTH_TOKEN_PEPPER: "0123456789abcdef0123456789abcdef",
} satisfies NodeJS.ProcessEnv;

test("development configuration uses a loopback-only, same-origin baseline", () => {
  const config = loadServerConfig({}, "/srv/gatherthread");

  assert.equal(config.environment, "development");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.databasePath, resolve("/srv/gatherthread", ".local/collaboration.sqlite"));
  assert.equal(config.staticDirectory, resolve("/srv/gatherthread", "apps/web/dist"));
  assert.equal(config.publicBaseUrl, "http://127.0.0.1:8787");
  assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1:8787"]);
  assert.equal(config.allowHttpBootstrap, false);
  assert.equal(config.secureTransport, false);
  assert.equal(config.maxEventBytes, 262_144);
  assert.equal(config.maxUserEventBytes, 268_435_456);
  assert.equal(config.maxSessionEventBytes, 536_870_912);
  assert.equal(config.maxTotalEventBytes, 2_147_483_648);
  assert.equal(config.maxUserSessions, 512);
  assert.equal(config.maxProjectSessions, 2_048);
  assert.equal(config.maxTotalSessions, 8_192);
  assert.throws(() => assertPersistentCredentialPepper(config), /credentials remain valid/);
});

test("owner-host credentials require a stable pepper even outside production", () => {
  const config = loadServerConfig({
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "development-pepper-0123456789abc",
  }, "/srv/gatherthread");
  assert.doesNotThrow(() => assertPersistentCredentialPepper(config));
});

test("canonical GatherThread variables are parsed without falling back to generic HOST or PORT", () => {
  const config = loadServerConfig({
    HOST: "0.0.0.0",
    PORT: "9999",
    GATHERTHREAD_SERVER_HOST: "::1",
    GATHERTHREAD_SERVER_PORT: "9000",
    GATHERTHREAD_ALLOWED_ORIGINS: "http://127.0.0.1:9000,http://localhost:9000,http://127.0.0.1:9000",
  }, "/srv/gatherthread");

  assert.equal(config.host, "::1");
  assert.equal(config.port, 9000);
  assert.deepEqual(config.allowedOrigins, [
    "http://127.0.0.1:9000",
    "http://localhost:9000",
  ]);
});

test("unsafe bind hosts, malformed booleans, ports, and origins are rejected", () => {
  for (const environment of [
    { GATHERTHREAD_SERVER_HOST: "0.0.0.0" },
    { GATHERTHREAD_SERVER_PORT: "0" },
    { GATHERTHREAD_SERVER_PORT: "8787.5" },
    { GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "TRUE" },
    { GATHERTHREAD_ALLOWED_ORIGINS: "http://localhost:8787/path" },
    { GATHERTHREAD_ALLOWED_ORIGINS: "http://localhost:8787," },
    { GATHERTHREAD_MAX_EVENT_BYTES: "0" },
    { GATHERTHREAD_MAX_USER_EVENT_BYTES: "1048576.5" },
    { GATHERTHREAD_MAX_SESSION_EVENT_BYTES: "9007199254740992" },
    { GATHERTHREAD_MAX_TOTAL_EVENT_BYTES: "999999", GATHERTHREAD_MAX_USER_EVENT_BYTES: "1048576", GATHERTHREAD_MAX_SESSION_EVENT_BYTES: "1048576" },
    { GATHERTHREAD_MAX_USER_SESSIONS: "0" },
    { GATHERTHREAD_MAX_PROJECT_SESSIONS: "1.5" },
    { GATHERTHREAD_MAX_TOTAL_SESSIONS: "2", GATHERTHREAD_MAX_USER_SESSIONS: "3" },
  ]) {
    assert.throws(() => loadServerConfig(environment, "/srv/gatherthread"), ConfigurationError);
  }
});

test("session count limits accept deliberate consistent overrides", () => {
  const config = loadServerConfig({
    GATHERTHREAD_MAX_USER_SESSIONS: "10",
    GATHERTHREAD_MAX_PROJECT_SESSIONS: "20",
    GATHERTHREAD_MAX_TOTAL_SESSIONS: "30",
  }, "/srv/gatherthread");
  assert.equal(config.maxUserSessions, 10);
  assert.equal(config.maxProjectSessions, 20);
  assert.equal(config.maxTotalSessions, 30);
});

test("event storage limits accept deliberate overrides and reject inconsistent ceilings", () => {
  const config = loadServerConfig({
    GATHERTHREAD_MAX_EVENT_BYTES: "65536",
    GATHERTHREAD_MAX_USER_EVENT_BYTES: "2097152",
    GATHERTHREAD_MAX_SESSION_EVENT_BYTES: "3145728",
    GATHERTHREAD_MAX_TOTAL_EVENT_BYTES: "4194304",
  }, "/srv/gatherthread");
  assert.equal(config.maxEventBytes, 65_536);
  assert.equal(config.maxTotalEventBytes, 4_194_304);
  assert.throws(() => loadServerConfig({
    GATHERTHREAD_MAX_EVENT_BYTES: "2097152",
    GATHERTHREAD_MAX_USER_EVENT_BYTES: "1048576",
  }, "/srv/gatherthread"), /must fit/);
});

test("production fails closed unless HTTPS proxying and a strong pepper are configured", () => {
  assert.throws(
    () => loadServerConfig({ NODE_ENV: "production" }, "/srv/gatherthread"),
    ConfigurationError,
  );
  assert.throws(
    () => loadServerConfig({
      ...productionEnvironment,
      GATHERTHREAD_AUTH_TOKEN_PEPPER: "replace-with-a-long-production-secret-value",
    }, "/srv/gatherthread"),
    /non-placeholder secret/,
  );
  assert.throws(
    () => loadServerConfig({
      ...productionEnvironment,
      GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP: "true",
    }, "/srv/gatherthread"),
    /local bootstrap command/,
  );
  assert.throws(
    () => loadServerConfig({ ...productionEnvironment, GATHERTHREAD_DATABASE_PATH: ":memory:" }, "/srv/gatherthread"),
    /must be durable/,
  );
  assert.throws(
    () => loadServerConfig({ ...productionEnvironment, GATHERTHREAD_AUTH_TOKEN_PEPPER: ` ${productionEnvironment.GATHERTHREAD_AUTH_TOKEN_PEPPER}` }, "/srv/gatherthread"),
    /whitespace/,
  );

  const config = loadServerConfig({
    ...productionEnvironment,
    GATHERTHREAD_ALLOWED_ORIGINS: "https://second.example.ts.net",
  }, "/srv/gatherthread");
  assert.deepEqual(config.allowedOrigins, [
    "https://owner.example.ts.net",
    "https://second.example.ts.net",
  ]);
  assert.equal(config.secureTransport, true);
});

test("database storage cannot be placed under the public static directory", () => {
  assert.throws(() => loadServerConfig({
    GATHERTHREAD_STATIC_DIRECTORY: "public",
    GATHERTHREAD_DATABASE_PATH: "public/private.sqlite",
  }, "/srv/gatherthread"), /must not be inside/);
});

test("database directory preparation creates private storage and rejects loose production permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-config-"));
  try {
    const development = loadServerConfig({ GATHERTHREAD_DATABASE_PATH: "private/db.sqlite" }, directory);
    prepareDatabaseDirectory(development);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(directory, "private")).mode & 0o777, 0o700);
    }

    chmodSync(join(directory, "private"), 0o755);
    const production = loadServerConfig({
      ...productionEnvironment,
      GATHERTHREAD_DATABASE_PATH: "private/db.sqlite",
    }, directory);
    if (process.platform === "win32") {
      assert.doesNotThrow(() => prepareDatabaseDirectory(production));
    } else {
      assert.throws(() => prepareDatabaseDirectory(production), /mode 0700/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
