#!/usr/bin/env node
// Load only this process's configuration. Compare public reports, never another environment's secrets.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { loadServerConfig } from "../../apps/server/dist/src/config.js";

const config = loadServerConfig();
const digest = value => createHash("sha256").update(`gatherthread-isolation-v1:${value}`).digest("hex");
const canonical = path => { const full = resolve(path); let parent = full; while (!lstatSync(parent, { throwIfNoEntry: false })) parent = dirname(parent); if (realpathSync(parent) !== parent) throw new Error("Isolation paths must not use symlinks"); return full; };
const contains = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
if (!config.authTokenPepper || Buffer.byteLength(config.authTokenPepper) < 32) throw new Error("Independent credential pepper required");
const report = {
  schema: 1, environment: config.testGate ? "test" : "production", origin: config.publicBaseUrl,
  port: config.port, database: canonical(config.databasePath), code: canonical(config.databasePath + ".code"),
  backup: canonical(process.env.GATHERTHREAD_BACKUP_DIRECTORY ?? (config.testGate ? "/var/backups/gatherthread-test" : "/var/backups/gatherthread")),
  auth_key_fingerprint: digest(config.authTokenPepper),
  ...(config.testGate ? { admission_database: canonical(config.testGate.databasePath), admission_key_fingerprint: digest(config.testGate.pepper) } : {}),
};
const [command, path] = process.argv.slice(2);
if (process.argv.length !== 4 || !path) throw new Error("Usage: isolation-report.mjs write NEW_PRIVATE_REPORT | compare PRODUCTION_REPORT");
if (command === "write") {
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write("Public isolation report written; no credential values included.\n");
} else if (command === "compare") {
  const production = JSON.parse(readFileSync(path, "utf8"));
  if (!config.testGate || production.schema !== 1 || production.environment !== "production") throw new Error("Compare requires test configuration and a production report");
  if (typeof production.origin !== "string" || new URL(production.origin).origin !== production.origin || !production.origin.startsWith("https://")
    || !Number.isInteger(production.port) || production.port < 1 || production.port > 65535
    || typeof production.auth_key_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(production.auth_key_fingerprint)
    || [production.database, production.code, production.backup].some(value => typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value)) throw new Error("Production isolation report is incomplete or malformed");
  if (report.origin !== "https://test.gatherthread.cn" || report.port !== 28787 || report.origin === production.origin || report.port === production.port) throw new Error("Test origin/port isolation failed");
  if (report.auth_key_fingerprint === production.auth_key_fingerprint || report.admission_key_fingerprint === production.auth_key_fingerprint) throw new Error("Credential keys must be independent");
  for (const testPath of [report.database, report.code, report.backup, report.admission_database]) {
    for (const productionPath of [production.database, production.code, production.backup]) {
      if (typeof productionPath !== "string" || typeof testPath !== "string" || contains(testPath, productionPath)) throw new Error("Data/code/backup isolation failed");
    }
  }
  process.stdout.write("Origin, ports, data, Git objects, backups and key fingerprints are independent. Verify Unix permissions, cookies and provider callbacks separately.\n");
} else throw new Error("Unknown isolation report command");
