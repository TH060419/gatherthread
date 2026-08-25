import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPersistentCredentialPepper,
  ConfigurationError,
  loadServerConfig,
  prepareDatabaseDirectory,
} from "../src/config.js";

const productionEnvironment = {
  NODE_ENV: "production",
  ACP_PUBLIC_BASE_URL: "https://owner.example.ts.net",
  ACP_TLS_TERMINATED_BY_PROXY: "true",
  ACP_AUTH_TOKEN_PEPPER: "0123456789abcdef0123456789abcdef",
} satisfies NodeJS.ProcessEnv;

test("development configuration uses a loopback-only, same-origin baseline", () => {
  const config = loadServerConfig({}, "/srv/relayroom");

  assert.equal(config.environment, "development");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.databasePath, "/srv/relayroom/.local/collaboration.sqlite");
  assert.equal(config.staticDirectory, "/srv/relayroom/apps/web/dist");
  assert.equal(config.publicBaseUrl, "http://127.0.0.1:8787");
  assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1:8787"]);
  assert.equal(config.allowHttpBootstrap, false);
  assert.equal(config.secureTransport, false);
  assert.equal(config.maxEventBytes, 262_144);
  assert.equal(config.maxUserEventBytes, 268_435_456);
  assert.equal(config.maxSessionEventBytes, 536_870_912);
  assert.equal(config.maxTotalEventBytes, 2_147_483_648);
  assert.throws(() => assertPersistentCredentialPepper(config), /credentials remain valid/);
});

test("owner-host credentials require a stable pepper even outside production", () => {
  const config = loadServerConfig({
    ACP_AUTH_TOKEN_PEPPER: "development-pepper-0123456789abc",
  }, "/srv/relayroom");
  assert.doesNotThrow(() => assertPersistentCredentialPepper(config));
});

test("canonical ACP variables are parsed without falling back to generic HOST or PORT", () => {
  const config = loadServerConfig({
    HOST: "0.0.0.0",
    PORT: "9999",
    ACP_SERVER_HOST: "::1",
    ACP_SERVER_PORT: "9000",
    ACP_ALLOWED_ORIGINS: "http://127.0.0.1:9000,http://localhost:9000,http://127.0.0.1:9000",
  }, "/srv/relayroom");

  assert.equal(config.host, "::1");
  assert.equal(config.port, 9000);
  assert.deepEqual(config.allowedOrigins, [
    "http://127.0.0.1:9000",
    "http://localhost:9000",
  ]);
});

test("unsafe bind hosts, malformed booleans, ports, and origins are rejected", () => {
  for (const environment of [
    { ACP_SERVER_HOST: "0.0.0.0" },
    { ACP_SERVER_PORT: "0" },
    { ACP_SERVER_PORT: "8787.5" },
    { ACP_TLS_TERMINATED_BY_PROXY: "TRUE" },
    { ACP_ALLOWED_ORIGINS: "http://localhost:8787/path" },
    { ACP_ALLOWED_ORIGINS: "http://localhost:8787," },
    { ACP_MAX_EVENT_BYTES: "0" },
    { ACP_MAX_USER_EVENT_BYTES: "1048576.5" },
    { ACP_MAX_SESSION_EVENT_BYTES: "9007199254740992" },
    { ACP_MAX_TOTAL_EVENT_BYTES: "999999", ACP_MAX_USER_EVENT_BYTES: "1048576", ACP_MAX_SESSION_EVENT_BYTES: "1048576" },
  ]) {
    assert.throws(() => loadServerConfig(environment, "/srv/relayroom"), ConfigurationError);
  }
});

test("event storage limits accept deliberate overrides and reject inconsistent ceilings", () => {
  const config = loadServerConfig({
    ACP_MAX_EVENT_BYTES: "65536",
    ACP_MAX_USER_EVENT_BYTES: "2097152",
    ACP_MAX_SESSION_EVENT_BYTES: "3145728",
    ACP_MAX_TOTAL_EVENT_BYTES: "4194304",
  }, "/srv/relayroom");
  assert.equal(config.maxEventBytes, 65_536);
  assert.equal(config.maxTotalEventBytes, 4_194_304);
  assert.throws(() => loadServerConfig({
    ACP_MAX_EVENT_BYTES: "2097152",
    ACP_MAX_USER_EVENT_BYTES: "1048576",
  }, "/srv/relayroom"), /must fit/);
});

test("production fails closed unless HTTPS proxying and a strong pepper are configured", () => {
  assert.throws(
    () => loadServerConfig({ NODE_ENV: "production" }, "/srv/relayroom"),
    ConfigurationError,
  );
  assert.throws(
    () => loadServerConfig({
      ...productionEnvironment,
      ACP_AUTH_TOKEN_PEPPER: "replace-with-a-long-production-secret-value",
    }, "/srv/relayroom"),
    /non-placeholder secret/,
  );
  assert.throws(
    () => loadServerConfig({
      ...productionEnvironment,
      ACP_ALLOW_HTTP_BOOTSTRAP: "true",
    }, "/srv/relayroom"),
    /local bootstrap command/,
  );
  assert.throws(
    () => loadServerConfig({ ...productionEnvironment, ACP_DATABASE_PATH: ":memory:" }, "/srv/relayroom"),
    /must be durable/,
  );
  assert.throws(
    () => loadServerConfig({ ...productionEnvironment, ACP_AUTH_TOKEN_PEPPER: ` ${productionEnvironment.ACP_AUTH_TOKEN_PEPPER}` }, "/srv/relayroom"),
    /whitespace/,
  );

  const config = loadServerConfig({
    ...productionEnvironment,
    ACP_ALLOWED_ORIGINS: "https://second.example.ts.net",
  }, "/srv/relayroom");
  assert.deepEqual(config.allowedOrigins, [
    "https://owner.example.ts.net",
    "https://second.example.ts.net",
  ]);
  assert.equal(config.secureTransport, true);
});

test("database storage cannot be placed under the public static directory", () => {
  assert.throws(() => loadServerConfig({
    ACP_STATIC_DIRECTORY: "public",
    ACP_DATABASE_PATH: "public/private.sqlite",
  }, "/srv/relayroom"), /must not be inside/);
});

test("database directory preparation creates private storage and rejects loose production permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-config-"));
  try {
    const development = loadServerConfig({ ACP_DATABASE_PATH: "private/db.sqlite" }, directory);
    prepareDatabaseDirectory(development);
    assert.equal(statSync(join(directory, "private")).mode & 0o777, 0o700);

    chmodSync(join(directory, "private"), 0o755);
    const production = loadServerConfig({
      ...productionEnvironment,
      ACP_DATABASE_PATH: "private/db.sqlite",
    }, directory);
    assert.throws(() => prepareDatabaseDirectory(production), /mode 0700/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
