import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SendRegistrationInput, VerifyRegistrationInput, VerifyPasswordResetInput } from "@gatherthread/protocol";
import { ApiError } from "./errors.js";

export interface RegistrationMailer {
  send(message: { email: string; code: string; locale: "en" | "zh-CN"; deliveryId: string; purpose?: "registration" | "password-reset" }): Promise<void>;
  notifyPasswordChanged?(message: { email: string; locale: "en" | "zh-CN"; deliveryId: string }): Promise<void>;
}
export interface RegistrationChallenge {
  verify(token: string, binding: string, purpose?: "registration" | "password-reset"): Promise<boolean>;
}
export interface RegistrationOptions {
  enabled: boolean;
  recoveryEnabled?: boolean;
  siteKey?: string | undefined;
  mailer?: RegistrationMailer | undefined;
  challenge?: RegistrationChallenge | undefined;
  // Must be an independently configured exact origin; never derived from Host.
  origin?: string | undefined;
  trustedProxy?: string | undefined;
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const unavailable = () => new ApiError(503, "registration_unavailable", "Email registration is temporarily unavailable.");
const invalid = () => new ApiError(400, "registration_invalid", "The code is incorrect or unavailable. Request a new code.");
const limited = () => new ApiError(429, "registration_limited", "Too many registration attempts. Please try later.");

export const REGISTRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS registration_control (
  id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
) STRICT;
INSERT INTO registration_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public_registration_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_digest TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, verified_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS email_login_devices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  browser_digest TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,browser_digest)
) STRICT;
CREATE TABLE IF NOT EXISTS registration_pending (
  id TEXT PRIMARY KEY, email_digest TEXT NOT NULL, browser_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL, code_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('sending','ready','verifying','failed','consumed'))
) STRICT;
CREATE INDEX IF NOT EXISTS registration_pending_expiry ON registration_pending(expires_at);
CREATE TABLE IF NOT EXISTS password_reset_pending (
  id TEXT PRIMARY KEY, email_digest TEXT NOT NULL, browser_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL, code_digest TEXT NOT NULL,
  account_version TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('sending','ready','verifying','failed','consumed'))
) STRICT;
CREATE INDEX IF NOT EXISTS password_reset_pending_expiry ON password_reset_pending(expires_at);
CREATE TABLE IF NOT EXISTS registration_budgets (
  key TEXT NOT NULL, bucket INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL, PRIMARY KEY(key,bucket)
) STRICT;
CREATE INDEX IF NOT EXISTS registration_budgets_expiry ON registration_budgets(expires_at);
CREATE TABLE IF NOT EXISTS registration_deleted_emails (
  email_digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
) STRICT;
`;

interface Pending {
  id: string; email_digest: string; browser_digest: string; request_digest: string; request_fingerprint: string;
  code_digest: string; created_at: number; expires_at: number; attempts: number;
  state: "sending" | "ready" | "verifying" | "failed" | "consumed";
}

/** Shares the identity database and its write transaction. No plaintext email/OTP is persisted. */
export class RegistrationStore {
  constructor(
    readonly sqlite: DatabaseSync,
    private readonly digest: (value: string) => string,
    private readonly clock: () => Date,
  ) {}

  binding(browser: string, purpose = "registration"): string { return this.digest(`${purpose}-browser:${browser}`).slice(0, 32); }
  paused(): boolean {
    return (this.sqlite.prepare("SELECT paused FROM registration_control WHERE id=1").get() as { paused: number }).paused === 1;
  }
  pause(paused: boolean): void { this.sqlite.prepare("UPDATE registration_control SET paused=? WHERE id=1").run(paused ? 1 : 0); }
  ready(options: RegistrationOptions | undefined): boolean {
    return options?.enabled === true && !!options.siteKey && !!options.mailer && !!options.challenge && !!options.origin && !this.paused();
  }
  recoveryReady(options: RegistrationOptions | undefined): boolean {
    return options?.recoveryEnabled === true && !!options.siteKey && !!options.mailer?.notifyPasswordChanged
      && !!options.challenge && !!options.origin && !this.paused();
  }
  private transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.sqlite.exec("COMMIT"); return value; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  cleanup(): void {
    const now = this.clock().getTime();
    this.sqlite.prepare("DELETE FROM registration_pending WHERE expires_at<=?").run(now);
    this.sqlite.prepare("DELETE FROM password_reset_pending WHERE expires_at<=?").run(now);
    this.sqlite.prepare("DELETE FROM registration_budgets WHERE expires_at<=?").run(now);
    this.sqlite.prepare("DELETE FROM registration_deleted_emails WHERE expires_at<=?").run(now);
  }
  // Called inside a write transaction. Rejected multi-budget reservations roll back together.
  consume(scope: string, value: string, window: number, limit: number): void {
    const now = this.clock().getTime();
    const bucket = Math.floor(now / window) * window;
    const key = this.digest(`registration-budget:${scope}:${window}:${value}`);
    const row = this.sqlite.prepare("SELECT used FROM registration_budgets WHERE key=? AND bucket=?").get(key, bucket) as { used: number } | undefined;
    if ((row?.used ?? 0) >= limit) throw limited();
    if (!row && (this.sqlite.prepare("SELECT count(*) AS n FROM registration_budgets").get() as { n: number }).n >= 50_000) throw unavailable();
    this.sqlite.prepare(`INSERT INTO registration_budgets(key,bucket,expires_at,used) VALUES(?,?,?,1)
      ON CONFLICT(key,bucket) DO UPDATE SET used=used+1`).run(key, bucket, bucket + window);
  }
  private requestDigest(input: SendRegistrationInput, browser: string, purpose: string): string {
    return this.digest(`${purpose}-request:${browser}:${input.idempotency_key}`);
  }
  async send(input: SendRegistrationInput, browser: string, ip: string, options: RegistrationOptions, purpose: "registration" | "password-reset" = "registration", assertRequestCurrent?: () => void): Promise<{ registration_id: string; expires_in_seconds: 600; resend_after_seconds: 60 }> {
    const table = purpose === "registration" ? "registration_pending" : "password_reset_pending";
    const ready = () => purpose === "registration" ? this.ready(options) : this.recoveryReady(options);
    if (!ready()) throw unavailable();
    const requestDigest = this.requestDigest(input, browser, purpose);
    const fingerprint = this.digest(`registration-payload:${input.email}:${input.locale}`);
    const reply = (id: string) => ({ registration_id: id, expires_in_seconds: 600 as const, resend_after_seconds: 60 as const });
    const retry = this.sqlite.prepare(`SELECT * FROM ${table} WHERE request_digest=? AND expires_at>?`)
      .get(requestDigest, this.clock().getTime()) as Pending | undefined;
    if (retry) {
      if (retry.request_fingerprint !== fingerprint) throw new ApiError(409, "idempotency_conflict", "Registration retry does not match");
      if (retry.state === "ready") return reply(retry.id);
      throw unavailable(); // Do not redeliver a failed/uncertain send.
    }
    // Persisted cheap gates BEFORE the outbound challenge request; no restart bypass.
    this.transaction(() => {
      this.cleanup();
      this.consume("challenge-ip", ip, HOUR, 120);
      this.consume("challenge-browser", browser, HOUR, 30);
      this.consume("challenge-global", "all", HOUR, 2000);
      this.consume("challenge-token", input.challenge_token, HOUR, 1);
    });
    let validChallenge = false;
    try { validChallenge = await options.challenge!.verify(input.challenge_token, this.binding(browser, purpose), purpose); } catch { /* fail closed */ }
    assertRequestCurrent?.();
    if (!validChallenge) throw new ApiError(400, "registration_challenge", "Complete the security check and try again.");
    if (!ready()) throw unavailable();
    const id = randomUUID();
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    const reserved = this.transaction(() => {
      if (!ready()) throw unavailable();
      this.cleanup();
      const raced = this.sqlite.prepare(`SELECT * FROM ${table} WHERE request_digest=?`).get(requestDigest) as Pending | undefined;
      if (raced) {
        if (raced.request_fingerprint !== fingerprint) throw new ApiError(409, "idempotency_conflict", "Registration retry does not match");
        return raced;
      }
      const emailDigest = this.digest(`registration-email:${input.email}`);
      const prior = this.sqlite.prepare(`SELECT * FROM ${table} WHERE email_digest=? ORDER BY created_at DESC LIMIT 1`).get(emailDigest) as Pending | undefined;
      if (prior && this.clock().getTime() - prior.created_at < 60_000) throw limited();
      if ((this.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n >= 1000) throw unavailable();
      this.consume("send-ip", ip, HOUR, 20); // Shared NAT gets a larger budget than one browser/email.
      this.consume("send-ip", ip, DAY, 50);
      this.consume("send-email", input.email, HOUR, 3);
      this.consume("send-email", input.email, DAY, 5);
      this.consume("send-browser", browser, HOUR, 5);
      this.consume("send-browser", browser, DAY, 10);
      this.consume("send-global", "all", HOUR, 20);
      this.consume("send-global", "all", DAY, 80);
      this.consume("send-global", "all", 31 * DAY, 2000); // Conservative fixed 31-day block.
      if (prior) this.sqlite.prepare(`UPDATE ${table} SET state='failed',code_digest='' WHERE email_digest=?`).run(emailDigest);
      const now = this.clock().getTime();
      const account = this.sqlite.prepare("SELECT password_hash FROM public_registration_accounts WHERE email_digest=?").get(emailDigest) as { password_hash: string } | undefined;
      this.sqlite.prepare(`INSERT INTO ${table}(id,email_digest,browser_digest,request_digest,request_fingerprint,code_digest,created_at,expires_at,state${purpose === "password-reset" ? ",account_version" : ""})
        VALUES(?,?,?,?,?,?,?,?,'sending'${purpose === "password-reset" ? ",?" : ""})`).run(id, emailDigest, this.digest(`registration-browser:${browser}`), requestDigest, fingerprint,
        this.digest(`${purpose}-code:${id}:${code}`), now, now + 600_000,
        ...(purpose === "password-reset" ? [account ? this.digest(account.password_hash) : ""] : []));
      return undefined;
    });
    if (reserved) {
      if (reserved.state === "ready") return reply(reserved.id);
      throw unavailable();
    }
    const assertDeliveryCurrent = () => {
      try { assertRequestCurrent?.(); }
      catch (error) {
        this.sqlite.prepare(`UPDATE ${table} SET state='failed',code_digest='' WHERE id=? AND state='sending'`).run(id);
        throw error;
      }
    };
    assertDeliveryCurrent();
    try {
      if (!ready()) throw unavailable();
      // Existing-email requests use identical mail and response paths, with no account disclosure.
      await options.mailer!.send({ email: input.email, code, locale: input.locale, deliveryId: id, purpose });
    } catch {
      this.sqlite.prepare(`UPDATE ${table} SET state='failed',code_digest='' WHERE id=? AND state='sending'`).run(id);
      throw new ApiError(503, "registration_delivery", "The email could not be sent. Wait a minute and try again.");
    }
    assertDeliveryCurrent();
    const updated = this.sqlite.prepare(`UPDATE ${table} SET state='ready' WHERE id=? AND state='sending'`).run(id);
    if (!updated.changes || !ready()) throw unavailable();
    return reply(id);
  }

  prepareVerification(input: VerifyRegistrationInput, browser: string, ip: string, options: RegistrationOptions): string {
    if (!this.ready(options)) throw unavailable();
    const result = this.transaction(() => {
      this.cleanup();
      this.consume("verify-ip", ip, HOUR, 100);
      this.consume("verify-browser", browser, HOUR, 30);
      this.consume("verify-global", "all", HOUR, 2000);
      const row = this.sqlite.prepare("SELECT * FROM registration_pending WHERE id=?").get(input.registration_id) as Pending | undefined;
      const given = Buffer.from(this.digest(`registration-code:${input.registration_id}:${input.code}`), "hex");
      const expected = Buffer.from(row?.code_digest || this.digest("registration-invalid"), "hex");
      const matches = given.length === expected.length && timingSafeEqual(given, expected);
      if (!row || row.state !== "ready" || row.browser_digest !== this.digest(`registration-browser:${browser}`) || row.attempts >= 5) return { error: invalid() };
      this.sqlite.prepare("UPDATE registration_pending SET attempts=attempts+1 WHERE id=?").run(row.id);
      if (!matches || this.sqlite.prepare("SELECT 1 FROM public_registration_accounts WHERE email_digest=?").get(row.email_digest)
        || this.sqlite.prepare("SELECT 1 FROM registration_deleted_emails WHERE email_digest=?").get(row.email_digest)) return { error: invalid() };
      const proof = randomUUID();
      this.sqlite.prepare("UPDATE registration_pending SET state='verifying',code_digest=? WHERE id=?").run(this.digest(proof), row.id);
      return { proof };
    });
    if (result.error) throw result.error;
    return result.proof!;
  }

  completeVerification<T extends { actor: { user_id: string; device_id: string } }>(id: string, proof: string, browser: string, ip: string,
    passwordHash: string, options: RegistrationOptions, create: () => T): T {
    if (!this.ready(options)) throw unavailable();
    return this.transaction(() => {
      if (!this.ready(options)) throw unavailable();
      this.cleanup();
      const row = this.sqlite.prepare("SELECT * FROM registration_pending WHERE id=? AND state='verifying' AND code_digest=?")
        .get(id, this.digest(proof)) as Pending | undefined;
      if (!row || row.browser_digest !== this.digest(`registration-browser:${browser}`)) throw invalid();
      if (this.sqlite.prepare("SELECT 1 FROM public_registration_accounts WHERE email_digest=?").get(row.email_digest)
        || this.sqlite.prepare("SELECT 1 FROM registration_deleted_emails WHERE email_digest=?").get(row.email_digest)) throw invalid();
      if ((this.sqlite.prepare("SELECT count(*) AS n FROM public_registration_accounts").get() as { n: number }).n >= 1000) throw unavailable();
      this.consume("account-ip", ip, DAY, 5);
      this.consume("account-browser", browser, DAY, 2);
      this.consume("account-global", "all", HOUR, 10);
      this.consume("account-global", "all", DAY, 50);
      const value = create();
      this.sqlite.prepare("INSERT INTO public_registration_accounts(user_id,email_digest,password_hash,verified_at) VALUES(?,?,?,?)")
        .run(value.actor.user_id, row.email_digest, passwordHash, this.clock().getTime());
      this.sqlite.prepare("INSERT INTO email_login_devices(user_id,browser_digest,device_id) VALUES(?,?,?)")
        .run(value.actor.user_id, this.digest(`registration-browser:${browser}`), value.actor.device_id);
      this.sqlite.prepare("UPDATE registration_pending SET state='consumed',code_digest='' WHERE id=?").run(row.id);
      return value;
    });
  }
  failVerification(id: string, proof: string): void {
    this.sqlite.prepare("UPDATE registration_pending SET state='failed',code_digest='' WHERE id=? AND state='verifying' AND code_digest=?")
      .run(id, this.digest(proof));
  }
  preparePasswordReset(input: VerifyPasswordResetInput, browser: string, ip: string, options: RegistrationOptions): string {
    if (!this.recoveryReady(options)) throw unavailable();
    const result = this.transaction(() => {
      this.cleanup();
      this.consume("reset-verify-ip", ip, HOUR, 100);
      this.consume("reset-verify-browser", browser, HOUR, 30);
      this.consume("reset-verify-global", "all", HOUR, 2000);
      const row = this.sqlite.prepare("SELECT * FROM password_reset_pending WHERE id=?").get(input.reset_id) as (Pending & { account_version: string }) | undefined;
      const given = Buffer.from(this.digest(`password-reset-code:${input.reset_id}:${input.code}`), "hex");
      const expected = Buffer.from(row?.code_digest || this.digest("password-reset-invalid"), "hex");
      const matches = given.length === expected.length && timingSafeEqual(given, expected);
      if (!row || row.state !== "ready" || row.browser_digest !== this.digest(`registration-browser:${browser}`) || row.attempts >= 5) return { error: invalid() };
      this.sqlite.prepare("UPDATE password_reset_pending SET attempts=attempts+1 WHERE id=?").run(row.id);
      const account = this.sqlite.prepare("SELECT password_hash FROM public_registration_accounts WHERE email_digest=?").get(row.email_digest) as { password_hash: string } | undefined;
      if (!matches || row.email_digest !== this.digest(`registration-email:${input.email}`)
        || !account || row.account_version !== this.digest(account.password_hash)) return { error: invalid() };
      // Count the success notification against the SAME provider-wide caps, before hashing or changing credentials.
      this.consume("send-global", "all", HOUR, 20);
      this.consume("send-global", "all", DAY, 80);
      this.consume("send-global", "all", 31 * DAY, 2000);
      this.consume("reset-complete-email", input.email, DAY, 3);
      const proof = randomUUID();
      this.sqlite.prepare("UPDATE password_reset_pending SET state='verifying',code_digest=? WHERE id=?").run(this.digest(proof), row.id);
      return { proof };
    });
    if (result.error) throw result.error;
    return result.proof!;
  }
  completePasswordReset(id: string, proof: string, browser: string, passwordHash: string, options: RegistrationOptions, revoke: (userId: string) => void): string {
    if (!this.recoveryReady(options)) throw unavailable();
    return this.transaction(() => {
      if (!this.recoveryReady(options)) throw unavailable();
      this.cleanup();
      const row = this.sqlite.prepare("SELECT * FROM password_reset_pending WHERE id=? AND state='verifying' AND code_digest=?")
        .get(id, this.digest(proof)) as (Pending & { account_version: string }) | undefined;
      if (!row || row.browser_digest !== this.digest(`registration-browser:${browser}`)) throw invalid();
      const account = this.sqlite.prepare("SELECT user_id,password_hash FROM public_registration_accounts WHERE email_digest=?")
        .get(row.email_digest) as { user_id: string; password_hash: string } | undefined;
      if (!account || row.account_version !== this.digest(account.password_hash)) throw invalid();
      this.sqlite.prepare("UPDATE public_registration_accounts SET password_hash=? WHERE user_id=?").run(passwordHash, account.user_id);
      revoke(account.user_id);
      this.sqlite.prepare("UPDATE password_reset_pending SET state='failed',code_digest='' WHERE email_digest=?").run(row.email_digest);
      this.sqlite.prepare("UPDATE password_reset_pending SET state='consumed' WHERE id=?").run(row.id);
      return account.user_id;
    });
  }
  failPasswordReset(id: string, proof: string): void {
    this.sqlite.prepare("UPDATE password_reset_pending SET state='failed',code_digest='' WHERE id=? AND state='verifying' AND code_digest=?")
      .run(id, this.digest(proof));
  }
  passwordLoginAttempt(email: string, browser: string, ip: string): { user_id: string; password_hash: string } | undefined {
    this.transaction(() => {
      this.cleanup();
      this.consume("login-ip", ip, HOUR, 50);
      this.consume("login-ip", ip, DAY, 300);
      this.consume("login-browser", browser, HOUR, 20);
      this.consume("login-email", email, HOUR, 10);
      this.consume("login-global", "all", HOUR, 1000);
    });
    return this.sqlite.prepare("SELECT user_id,password_hash FROM public_registration_accounts WHERE email_digest=?")
      .get(this.digest(`registration-email:${email}`)) as { user_id: string; password_hash: string } | undefined;
  }
  browserDevice(userId: string, browser: string): string | undefined {
    return (this.sqlite.prepare(`SELECT e.device_id FROM email_login_devices e JOIN devices d ON d.id=e.device_id
      WHERE e.user_id=? AND e.browser_digest=? AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>?)`)
      .get(userId, this.digest(`registration-browser:${browser}`), this.clock().toISOString()) as { device_id: string } | undefined)?.device_id;
  }
  bindBrowserDevice(userId: string, browser: string, deviceId: string): void {
    this.sqlite.prepare(`INSERT INTO email_login_devices(user_id,browser_digest,device_id) VALUES(?,?,?)
      ON CONFLICT(user_id,browser_digest) DO UPDATE SET device_id=excluded.device_id`)
      .run(userId, this.digest(`registration-browser:${browser}`), deviceId);
  }
  hasAccount(userId: string): boolean {
    return !!this.sqlite.prepare("SELECT 1 FROM public_registration_accounts WHERE user_id=?").get(userId);
  }
  beforeDelete(userId: string): void {
    const row = this.sqlite.prepare("SELECT email_digest FROM public_registration_accounts WHERE user_id=?").get(userId) as { email_digest: string } | undefined;
    if (row) {
      this.sqlite.prepare("INSERT INTO registration_deleted_emails(email_digest,expires_at) VALUES(?,?) ON CONFLICT(email_digest) DO UPDATE SET expires_at=excluded.expires_at")
        .run(row.email_digest, this.clock().getTime() + 30 * DAY);
      this.sqlite.prepare("DELETE FROM registration_pending WHERE email_digest=?").run(row.email_digest);
      this.sqlite.prepare("DELETE FROM password_reset_pending WHERE email_digest=?").run(row.email_digest);
    }
  }
}
