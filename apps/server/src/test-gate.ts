import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import { ApiError } from "./errors.js";

export interface TestGateOptions { databasePath: string; pepper: string; origin: string }
export interface AdmissionGrant { grant_id: string; expires_at: string; admission_code: string }
export const TEST_GATE_COOKIE = "__Host-gatherthread_test_gate";
const SESSION_MS = 24 * 60 * 60 * 1000;

/** Separate, bounded admission store; no account identity or plaintext credentials. */
export class TestGateStore {
  readonly #db: DatabaseSync;
  readonly #options: TestGateOptions;
  constructor(options: TestGateOptions) {
    if (Buffer.byteLength(options.pepper) < 32 || new URL(options.origin).origin !== options.origin) throw new Error("Invalid test gate configuration");
    this.#options = options;
    if (options.databasePath !== ":memory:") {
      const parent = dirname(resolve(options.databasePath));
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (realpathSync(parent) !== parent || (process.platform !== "win32" && (lstatSync(parent).mode & 0o077))) throw new Error("Test gate directory must be private and contain no symlinks");
      const file = lstatSync(options.databasePath, { throwIfNoEntry: false });
      if (file && (!file.isFile() || file.nlink !== 1 || (process.platform !== "win32" && (file.mode & 0o077)))) throw new Error("Test gate database must be a private regular file");
    }
    this.#db = new DatabaseSync(options.databasePath);
    if (options.databasePath !== ":memory:" && process.platform !== "win32") chmodSync(options.databasePath, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS namespace(digest TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_grant ON sessions(grant_id);`);
    const namespace = this.#digest("namespace", "admission-v1");
    this.#db.prepare("INSERT INTO namespace(digest) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM namespace)").run(namespace);
    if (!(this.#db.prepare("SELECT 1 FROM namespace WHERE digest=?").get(namespace))) { this.#db.close(); throw new Error("Admission store belongs to a different environment or key"); }
  }
  #digest(kind: string, value: string): string {
    return createHmac("sha256", this.#options.pepper).update(`${this.#options.origin}\n${kind}\n${value}`).digest("hex");
  }
  issue(count = 1, hours = 168, now = Date.now()): AdmissionGrant[] {
    if (!Number.isInteger(count) || count < 1 || count > 50 || !Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error("Use count 1..50 and hours 1..720");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.cleanup(now);
      const active = this.#db.prepare("SELECT count(*) AS n FROM grants").get() as { n: number };
      if (active.n + count > 1000) throw new Error("Test admission grant capacity reached");
      const expires = now + hours * 3600000;
      const grants = Array.from({ length: count }, () => {
        const code = `gte_${randomBytes(32).toString("base64url")}`;
        const id = randomUUID();
        this.#db.prepare("INSERT INTO grants(id,digest,expires) VALUES(?,?,?)").run(id, this.#digest("code", code), expires);
        return { grant_id: id, expires_at: new Date(expires).toISOString(), admission_code: code };
      });
      this.#db.exec("COMMIT"); return grants;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  revoke(id: string): void { this.#db.prepare("UPDATE grants SET revoked=1 WHERE id=?").run(id); }
  list(): unknown[] { return this.#db.prepare("SELECT id AS grant_id, expires AS expires_at_ms, revoked FROM grants ORDER BY expires").all(); }
  cleanup(now = Date.now()): void {
    this.#db.prepare("DELETE FROM sessions WHERE expires<=?").run(now);
    this.#db.prepare("DELETE FROM grants WHERE expires<=? OR revoked=1").run(now);
    this.#db.prepare("DELETE FROM attempts WHERE reset<=?").run(now);
  }
  /** Durable global + peer budgets; never trust browser-supplied forwarding headers. */
  attempt(peer: string, now = Date.now()): void {
    this.#db.exec("BEGIN IMMEDIATE");
    let blocked = false;
    try {
      this.cleanup(now);
      for (const [key, limit] of [["global", 300], [this.#digest("peer", peer), 20]] as const) {
        this.#db.prepare("INSERT INTO attempts(key,count,reset) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1").run(key, now + 60000);
        const row = this.#db.prepare("SELECT count FROM attempts WHERE key=?").get(key) as { count: number };
        if (row.count > limit) { blocked = true; break; }
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    if (blocked) throw new ApiError(429, "rate_limited", "Too many admission attempts. Try again later.");
  }
  exchange(code: string, now = Date.now()): { token: string; expires: number } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.cleanup(now);
      const grant = this.#db.prepare("SELECT id,expires FROM grants WHERE digest=? AND revoked=0 AND expires>?").get(this.#digest("code", code), now) as { id: string; expires: number } | undefined;
      if (!grant) throw new ApiError(403, "test_admission_invalid", "The test admission code is unavailable.");
      const row = this.#db.prepare("SELECT count(*) AS n FROM sessions WHERE grant_id=?").get(grant.id) as { n: number };
      if (row.n >= 32) throw new ApiError(403, "test_admission_invalid", "The test admission code is unavailable.");
      const token = `gteg_${randomBytes(32).toString("base64url")}`;
      const expires = Math.min(now + SESSION_MS, grant.expires);
      this.#db.prepare("INSERT INTO sessions(digest,grant_id,expires) VALUES(?,?,?)").run(this.#digest("session", token), grant.id, expires);
      this.#db.exec("COMMIT"); return { token, expires };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  admitted(token: string | null, now = Date.now()): boolean {
    if (!token || !/^gteg_[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return !!this.#db.prepare(`SELECT 1 FROM sessions s JOIN grants g ON g.id=s.grant_id
      WHERE s.digest=? AND s.expires>? AND g.expires>? AND g.revoked=0`).get(this.#digest("session", token), now, now);
  }
  logout(token: string | null): void { if (token) this.#db.prepare("DELETE FROM sessions WHERE digest=?").run(this.#digest("session", token)); }
  close(): void { this.#db.close(); }
}

export function testGateToken(request: IncomingMessage, secure: boolean): string | null {
  const name = secure ? TEST_GATE_COOKIE : "gatherthread_test_gate";
  const matches = (request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}
export function testGateCookie(token: string, expires: number, secure: boolean): string {
  return `${secure ? TEST_GATE_COOKIE : "gatherthread_test_gate"}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}${secure ? "; Secure" : ""}`;
}
/** These native capability routes still run their existing scope/expiry/one-use checks. */
export function nativeAdmissionCapability(path: string, method: string, hasOrigin: boolean): boolean {
  return !hasOrigin && method === "POST" && (path === "/v1/dsh-pairings"
    || /^\/v1\/dsh-pairings\/[^/]+\/poll$/.test(path) || path === "/v1/device-authorizations/claim");
}
export function nativeAdmissionDeviceRoute(path: string, hasOrigin: boolean): boolean {
  return !hasOrigin && /^\/v1\/(?:me|projects(?:\/.*)?|sessions(?:\/.*)?|runtimes(?:\/.*)?|snapshot-requests(?:\/.*)?|code-storage(?:\/.*)?|realtime-ticket)$/.test(path);
}
