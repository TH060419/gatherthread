import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationDatabase } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { checkPassword, hashPassword, PasswordCapacityError } from "../src/password.js";
import { normalizeRegistrationIp, registrationClientIp, registrationFromEnvironment, ResendRegistrationMailer, TurnstileRegistrationChallenge } from "../src/registration-providers.js";
import type { RegistrationOptions } from "../src/registration.js";
import { startCollaborationServer } from "../src/server.js";

const pepper = "isolated-registration-test-pepper-more-than-32-bytes";
const password = "fixture8"; // The new minimum must work through hashing, registration and login.
const rejectCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
function fixture() {
  let now = Date.UTC(2026, 8, 30, 8);
  const directory = mkdtempSync(join(tmpdir(), "gt-register-"));
  const path = join(directory, "test.sqlite");
  const open = () => new CollaborationDatabase(path, { authTokenPepper: pepper, clock: () => new Date(now) });
  const db = open();
  const mails: Array<{ email: string; code: string }> = [];
  const options: RegistrationOptions = { enabled: true, origin: "https://test.invalid", siteKey: "test-site-key",
    mailer: { async send(mail) { mails.push(mail); } }, challenge: { async verify() { return true; } } };
  const send = (email = "new@example.invalid", browser = "browser1", ip = "ip1") => db.registration.send({
    email, locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID(),
  }, browser, ip, options);
  const input = (id: string, code = mails.at(-1)!.code) => ({ registration_id: id, code, display_name: "New user", device_name: "Browser", remember_device: false, privacy_acknowledged: true as const, password });
  return { db, options, mails, send, input, open, time: () => now, advance: (ms: number) => { now += ms; }, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("verified email creates ordinary qualified identity; password sign-in is independent per browser; deletion cascades", async () => {
  const f = fixture();
  try {
    const old = f.db.bootstrapIdentity({ display_name: "Owner", device_name: "Owner browser" });
    const { registration_id: id } = await f.send();
    const account = await f.db.verifyPublicRegistration(f.input(id), "browser1", "ip1", f.options);
    assert.equal(f.db.canCreateProjects(account.actor.user_id), true);
    // No special project/session quota: the fourth project works like qualification activation.
    for (let n = 0; n < 4; n++) f.db.createProject(account.actor, { title: `P${n}`, idempotency_key: `project-${n}` });
    const auth = { email: "new@example.invalid", password, device_name: "Other browser", remember_device: true };
    const other = await f.db.loginWithEmail(auth, "browser2", "ip2");
    assert.notEqual(other.actor.device_id, account.actor.device_id);
    assert.equal(other.actor.user_id, account.actor.user_id);
    assert.equal(f.db.authenticateBrowserSession(account.browser_session.token).actor.user_id, account.actor.user_id);
    const again = await f.db.loginWithEmail(auth, "browser2", "ip2");
    assert.equal(again.actor.device_id, other.actor.device_id);
    assert.throws(() => f.db.authenticateBrowserSession(other.browser_session.token));
    f.db.revokeDevice(account.actor, other.actor.device_id);
    assert.throws(() => f.db.authenticateBrowserSession(again.browser_session.token));
    assert.equal(f.db.authenticate(old.token).user_id, old.actor.user_id);
    await assert.rejects(f.db.verifyPublicRegistration(f.input(id), "browser1", "ip1", f.options), rejectCode("registration_invalid"));
    const tables = ["public_registration_accounts", "registration_pending", "registration_budgets"];
    const content = JSON.stringify(tables.map((table) => f.db.sqlite.prepare(`SELECT * FROM ${table}`).all()));
    assert.equal(content.includes(password), false); assert.equal(content.includes("new@example.invalid"), false);
    assert.equal(content.includes(f.mails[0]!.code), false);
    for (const p of f.db.listProjects(account.actor.user_id)) f.db.deleteProject(account.actor, p.id);
    f.db.deleteAccount(account.actor);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM public_registration_accounts").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM email_login_devices").get()!.n, 0);
    f.advance(61_000);
    const againSent = await f.send();
    await assert.rejects(f.db.verifyPublicRegistration(f.input(againSent.registration_id), "browser1", "ip1", f.options), rejectCode("registration_invalid"));
  } finally { f.close(); }
});

test("wrong code budget survives restart, resend invalidates old OTP and expiry is enforced", async () => {
  const f = fixture();
  try {
    const sent = await f.send(); const correct = f.mails[0]!.code;
    const wrong = correct === "00000000" ? "11111111" : "00000000";
    for (let n = 0; n < 5; n++) await assert.rejects(f.db.verifyPublicRegistration(f.input(sent.registration_id, wrong), "browser1", "ip1", f.options), rejectCode("registration_invalid"));
    const second = f.open();
    await assert.rejects(second.verifyPublicRegistration(f.input(sent.registration_id, correct), "browser1", "ip1", f.options), rejectCode("registration_invalid")); second.close();
    await assert.rejects(f.send(), rejectCode("registration_limited"));
    f.advance(61_000); const resend = await f.send();
    await assert.rejects(f.db.verifyPublicRegistration(f.input(sent.registration_id, correct), "browser1", "ip1", f.options), rejectCode("registration_invalid"));
    await assert.rejects(f.db.verifyPublicRegistration(f.input(resend.registration_id), "other-browser", "ip1", f.options), rejectCode("registration_invalid"));
    f.advance(600_001);
    await assert.rejects(f.db.verifyPublicRegistration(f.input(resend.registration_id), "browser1", "ip1", f.options), rejectCode("registration_invalid"));
  } finally { f.close(); }
});

test("send idempotency, challenge replay, disabled/missing config, delivery failure and persistent pause", async () => {
  const f = fixture();
  try {
    const input = { email: "a@example.invalid", locale: "en" as const, challenge_token: randomUUID(), idempotency_key: randomUUID() };
    const sent = await f.db.registration.send(input, "browser1", "ip1", f.options);
    assert.deepEqual(await f.db.registration.send(input, "browser1", "ip1", f.options), sent); assert.equal(f.mails.length, 1);
    await assert.rejects(f.db.registration.send({ ...input, email: "b@example.invalid" }, "browser1", "ip1", f.options), rejectCode("idempotency_conflict"));
    await assert.rejects(f.db.registration.send({ ...input, idempotency_key: randomUUID() }, "browser1", "ip1", f.options), rejectCode("registration_limited"));
    for (const options of [{ enabled: false }, { ...f.options, mailer: undefined }, { ...f.options, challenge: undefined }]) {
      await assert.rejects(f.db.registration.send(input, "browser1", "ip1", options), rejectCode("registration_unavailable"));
    }
    f.options.mailer = { async send() { throw new Error("private provider error"); } };
    await assert.rejects(f.send("failed@example.invalid"), rejectCode("registration_delivery"));
    const row = f.db.sqlite.prepare("SELECT * FROM registration_pending WHERE state='failed'").get()!;
    assert.equal(row.code_digest, "");
    f.db.registration.pause(true); const second = f.open(); assert.equal(second.registration.paused(), true); second.close();
    await assert.rejects(f.send(), rejectCode("registration_unavailable"));
    assert.equal(f.db.registration.ready(f.options), false);
  } finally { f.close(); }
});

test("concurrent OTP verification yields one account and no transaction across async hashing", async () => {
  const f = fixture();
  try {
    const sent = await f.send();
    const results = await Promise.allSettled([f.db.verifyPublicRegistration(f.input(sent.registration_id), "browser1", "ip1", f.options), f.db.verifyPublicRegistration(f.input(sent.registration_id), "browser1", "ip1", f.options)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM public_registration_accounts").get()!.n, 1);
    f.advance(61_000); const existing = await f.send();
    await assert.rejects(f.db.verifyPublicRegistration(f.input(existing.registration_id), "browser1", "ip1", f.options), rejectCode("registration_invalid"));
    const old = f.db.createIdentity({ display_name: "Invite-only", device_name: "Guest" });
    assert.equal(f.db.canCreateProjects(old.actor.user_id), false);
    assert.throws(() => f.db.createProject(old.actor, { title: "Forbidden", idempotency_key: "guest" }));
  } finally { f.close(); }
});

test("email login failures are uniform and bounded; hashing is salted and capacity bounded", async () => {
  const f = fixture();
  try {
    const sent = await f.send(); await f.db.verifyPublicRegistration(f.input(sent.registration_id), "browser1", "ip1", f.options);
    const login = (email: string) => f.db.loginWithEmail({ email, password: "wrong password long enough", device_name: "B", remember_device: false }, "browser1", "ip1");
    await assert.rejects(login("new@example.invalid"), rejectCode("email_login_invalid"));
    await assert.rejects(login("missing@example.invalid"), rejectCode("email_login_invalid"));
    for (let n = 0; n < 9; n++) await assert.rejects(login("missing@example.invalid"), rejectCode("email_login_invalid"));
    await assert.rejects(login("missing@example.invalid"), rejectCode("registration_limited"));
    const hash = await hashPassword(password); const hash2 = await hashPassword(password); assert.notEqual(hash, hash2);
    assert.equal(await checkPassword(password, hash), true); assert.equal(await checkPassword("wrong", hash), false);
    const first = hashPassword(password); await assert.rejects(hashPassword(password), PasswordCapacityError); await first;
  } finally { f.close(); }
});

test("hard global mail budgets are reserved before delivery and persist across database instances", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 20; n++) await f.send(`email${n}@example.invalid`, `browser${n}`, `ip${n}`);
    const second = f.open();
    await assert.rejects(second.registration.send({ email: "over@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, "over", "over", f.options), rejectCode("registration_limited")); second.close();
    assert.equal(f.mails.length, 20);
  } finally { f.close(); }
});

test("provider configuration and verification bind action, hostname, cdata; errors are not exposed", async () => {
  assert.equal(registrationFromEnvironment({}, "https://test.invalid").enabled, false);
  assert.equal(registrationFromEnvironment({ GATHERTHREAD_PUBLIC_REGISTRATION: "true" }, "https://test.invalid").enabled, false);
  assert.equal(registrationFromEnvironment({ GATHERTHREAD_PUBLIC_REGISTRATION: "false", GATHERTHREAD_REGISTRATION_TRUSTED_PROXY: "127.0.0.1" }, "https://test.invalid").trustedProxy, "127.0.0.1");
  assert.throws(() => registrationFromEnvironment({ GATHERTHREAD_PUBLIC_REGISTRATION: "yes" }, "https://test.invalid"));
  assert.equal(registrationClientIp("1.2.3.4", "forged", undefined), "1.2.3.4");
  assert.equal(registrationClientIp("127.0.0.1", "8.8.8.8", "127.0.0.1"), "8.8.8.8");
  assert.equal(registrationClientIp("127.0.0.1", "8.8.8.8, 1.2.3.4", "127.0.0.1"), "trusted-proxy-unknown");
  assert.equal(normalizeRegistrationIp("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(normalizeRegistrationIp("2001:db8:1:2::abcd"), normalizeRegistrationIp("2001:0db8:0001:0002:ffff::1"));
  assert.notEqual(normalizeRegistrationIp("2001:db8:1:2::1"), normalizeRegistrationIp("2001:db8:1:3::1"));
  assert.equal(normalizeRegistrationIp("::1"), "0:0:0:0::/64");
  for (const fields of [{}, { action: "login" }, { hostname: "evil.invalid" }, { cdata: "other" }]) {
    const transport = (async () => new Response(JSON.stringify({ success: true, hostname: "test.invalid", action: "gt_register", cdata: "bound", ...fields }))) as typeof fetch;
    const result = await new TurnstileRegistrationChallenge("secret", "test.invalid", transport).verify("token", "bound");
    assert.equal(result, Object.keys(fields).length === 0);
  }
  const mailer = new ResendRegistrationMailer("private-key", "sender@example.invalid", (async (_url, options) => {
    const body = JSON.parse(String(options?.body)); assert.equal(body.to[0], "recipient@example.invalid"); assert.equal("html" in body, false);
    return new Response("private-provider-error", { status: 429 });
  }) as typeof fetch);
  await assert.rejects(mailer.send({ email: "recipient@example.invalid", code: "12345678", locale: "en", deliveryId: randomUUID() }), /Registration mail delivery failed/);
});

test("midnight hour/day budgets remain independent and failed reservations do not erase daily mail usage", async () => {
  const f = fixture();
  try {
    const hour = 3_600_000;
    f.advance(16 * hour); // Exactly midnight UTC: hour and day have the same bucket start.
    for (let block = 0; block < 4; block++) {
      for (let n = 0; n < 20; n++) await f.send(`daily-${block}-${n}@example.invalid`, `b-${block}-${n}`, `ip-${block}-${n}`);
      if (block < 3) f.advance(hour);
    }
    f.advance(hour);
    const second = f.open();
    await assert.rejects(second.registration.send({ email: "over-day@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, "new-browser", "new-ip", f.options), rejectCode("registration_limited"));
    second.close(); assert.equal(f.mails.length, 80);
    f.advance(20 * hour); // Next midnight resets the day without a server restart.
    await f.send("next-day@example.invalid", "next-browser", "next-ip");
    assert.equal(f.mails.length, 81);
  } finally { f.close(); }
});

test("the fixed 31-day email budget stops delivery and cleanup removes expired pending state", async () => {
  const f = fixture();
  try {
    const day = 86_400_000;
    const blockStart = Math.floor(f.time() / (31 * day)) * 31 * day;
    f.advance(blockStart + 31 * day - f.time());
    for (let d = 0; d < 25; d++) {
      if (d > 0) f.advance(21 * 3_600_000);
      for (let h = 0; h < 4; h++) {
        if (h > 0) f.advance(3_600_000);
        for (let n = 0; n < 20; n++) await f.send(`month-${d}-${h}-${n}@example.invalid`, `b-${d}-${h}-${n}`, `ip-${d}-${h}-${n}`);
      }
    }
    f.advance(21 * 3_600_000);
    await assert.rejects(f.send("over-month@example.invalid", "over", "over"), rejectCode("registration_limited"));
    assert.equal(f.mails.length, 2000);
    f.db.registration.cleanup();
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM registration_pending").get()!.n, 0);
  } finally { f.close(); }
});

test("pause and expiry during password work prevent account creation and leave no partial identity", async () => {
  const f = fixture();
  try {
    let sent = await f.send();
    const pending = f.db.verifyPublicRegistration(f.input(sent.registration_id), "browser1", "ip1", f.options);
    f.db.registration.pause(true);
    await assert.rejects(pending, rejectCode("registration_unavailable"));
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM users").get()!.n, 0);
    f.db.registration.pause(false); f.advance(61_000);
    sent = await f.send();
    const expiring = f.db.verifyPublicRegistration(f.input(sent.registration_id), "browser1", "ip1", f.options);
    f.advance(600_001);
    await assert.rejects(expiring, rejectCode("registration_invalid"));
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM users").get()!.n, 0);
  } finally { f.close(); }
});

test("account creation caps persist while accepted accounts keep ordinary Alpha permissions", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 10; n++) {
      const browser = `b-${n}`, ip = `ip-${n}`;
      const sent = await f.send(`account-${n}@example.invalid`, browser, ip);
      await f.db.verifyPublicRegistration(f.input(sent.registration_id), browser, ip, f.options);
    }
    const sent = await f.send("over-account@example.invalid", "over", "over");
    const second = f.open();
    await assert.rejects(second.verifyPublicRegistration(f.input(sent.registration_id), "over", "over", f.options), rejectCode("registration_limited"));
    second.close();
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM users").get()!.n, 10);
    f.advance(3_600_000);
    const reset = await f.send("next-hour@example.invalid", "next", "next");
    await f.db.verifyPublicRegistration(f.input(reset.registration_id), "next", "next", f.options);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM users").get()!.n, 11);
  } finally { f.close(); }
});

// HTTP integration uses a mock delivery sink, never a real recipient or provider.
test("HTTP registration/login fail closed, enforce Origin/cookie, and never return tokens or password", async () => {
  const mails: Array<{ code: string }> = [];
  const registration: RegistrationOptions = { enabled: true, siteKey: "test", origin: "https://test.invalid", mailer: { async send(mail) { mails.push(mail); } }, challenge: { async verify() { return true; } } };
  const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: pepper, allowedOrigins: [registration.origin!], publicBaseUrl: registration.origin!, secureTransport: true, registration });
  try {
    const status = await fetch(`${server.origin}/v1/registration`); const cookie = status.headers.getSetCookie()[0]!.split(";")[0]!;
    assert.match(status.headers.getSetCookie()[0]!, /HttpOnly; SameSite=Strict/); assert.match(cookie, /^__Host-/);
    const app = await fetch(`${server.origin}/app/`);
    assert.match(app.headers.get("content-security-policy")!, /frame-src 'self' https:\/\/challenges.cloudflare.com/);
    assert.equal(status.headers.get("content-security-policy")!.includes("challenges.cloudflare.com"), false);
    const input = { email: "http@example.invalid", challenge_token: randomUUID(), idempotency_key: randomUUID(), locale: "en" };
    const post = async (path: string, body: unknown, origin = registration.origin!, credentials = cookie) => fetch(`${server.origin}${path}`, { method: "POST", headers: { origin, cookie: credentials, "content-type": "application/json", "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify(body) });
    assert.equal((await post("/v1/registration/send", input, "")).status, 403);
    assert.equal((await post("/v1/registration/send", input, "https://evil.invalid")).status, 403);
    const sent = await post("/v1/registration/send", input); assert.equal(sent.status, 202);
    const { data } = await sent.json() as { data: { registration_id: string } };
    assert.equal((await post("/v1/registration/verify", { registration_id: data.registration_id, code: mails[0]!.code,
      display_name: "New", device_name: "Web", password: "short12", privacy_acknowledged: true })).status, 400);
    const verified = await post("/v1/registration/verify", { registration_id: data.registration_id, code: mails[0]!.code, display_name: "New", device_name: "Web", password, privacy_acknowledged: true, remember_device: true });
    assert.equal(verified.status, 201);
    const content = await verified.text(); assert.equal(content.includes(password), false); assert.equal(content.includes("gta_"), false); assert.equal(content.includes("gtb_"), false);
    const session = verified.headers.getSetCookie()[0]!; assert.match(session, /Secure/); assert.match(session, /Max-Age=2592000/);
    server.database.registration.pause(true);
    assert.equal((await post("/v1/registration/send", input)).status, 503);
    assert.equal((await post("/v1/email-login", { email: input.email, password: "short12", device_name: "Web" })).status, 400);
    const login = await post("/v1/email-login", { email: input.email, password, device_name: "Web", remember_device: false });
    assert.equal(login.status, 201); assert.equal((await login.text()).includes("token"), false);
    assert.equal(login.headers.getSetCookie()[0]!.includes("Max-Age"), false);
    const sessionCookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const browser = await fetch(`${server.origin}/v1/me`, { headers: { cookie: sessionCookie } });
    const actor = (await browser.json() as { data: { id: string; device_id: string } }).data;
    const project = await post("/v1/projects", { title: "Normal Alpha project", idempotency_key: randomUUID() }, registration.origin!, sessionCookie);
    assert.equal(project.status, 201);
    const projectId = (await project.json() as { data: { project: { id: string } } }).data.project.id;
    const authorized = await post("/v1/device-authorizations", undefined, registration.origin!, sessionCookie);
    assert.equal(authorized.status, 201);
    const grant = (await authorized.json() as { data: { authorization_token: string } }).data;
    const claim = () => fetch(`${server.origin}/v1/device-authorizations/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization_token: grant.authorization_token, device_name: "Native agent" }) });
    const claimed = await claim(); assert.equal(claimed.status, 201);
    const device = (await claimed.json() as { data: { token: string; actor: { user_id: string; device_id: string } } }).data;
    assert.equal(device.actor.user_id, actor.id); assert.notEqual(device.actor.device_id, actor.device_id);
    assert.equal((await claim()).status, 401);
    assert.equal((await fetch(`${server.origin}/v1/projects/${projectId}`, { headers: { authorization: `Bearer ${device.token}` } })).status, 200);
    server.database.revokeDevice(server.database.authenticateBrowserSession(sessionCookie.split("=", 2)[1]!).actor, device.actor.device_id);
    assert.equal((await fetch(`${server.origin}/v1/me`, { headers: { authorization: `Bearer ${device.token}` } })).status, 401);
    assert.equal((await fetch(`${server.origin}/v1/me`, { headers: { cookie: sessionCookie } })).status, 200);

  } finally { await server.close(); }
});

test("send deduplicates for ten minutes, then same UUID starts a budgeted attempt with a fresh challenge", async () => {
  const f = fixture();
  try {
    const request = { email: "expiry@example.invalid", locale: "en" as const,
      challenge_token: randomUUID(), idempotency_key: randomUUID() };
    const first = await f.db.registration.send(request, "browser1", "ip1", f.options);
    f.advance(599_999);
    assert.deepEqual(await f.db.registration.send(request, "browser1", "ip1", f.options), first);
    assert.equal(f.mails.length, 1);
    f.advance(2); f.db.registration.cleanup();
    const second = await f.db.registration.send({ ...request, challenge_token: randomUUID() }, "browser1", "ip1", f.options);
    assert.notEqual(second.registration_id, first.registration_id); assert.equal(f.mails.length, 2);
    f.advance(600_001);
    await f.db.registration.send({ ...request, challenge_token: randomUUID() }, "browser1", "ip1", f.options);
    f.advance(600_001);
    await assert.rejects(f.db.registration.send({ ...request, challenge_token: randomUUID() }, "browser1", "ip1", f.options), rejectCode("registration_limited"));
    assert.equal(f.mails.length, 3);
  } finally { f.close(); }
});

test("retired user routes cannot issue accounts or Cookies; old Cookies cannot log in while native devices remain valid", async () => {
  const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: pepper, allowHttpBootstrap: true });
  try {
    const old = server.database.bootstrapIdentity({ display_name: "Historical", device_name: "Historical browser" });
    const session = server.database.createBrowserSession(old.actor);
    for (const path of ["/v1/bootstrap", "/v1/browser-sessions", "/v1/invitations/claim", "/v1/test-access/claim", "/v1/remembered-accounts", "/v1/remembered-accounts/fixture/activate", "/v1/remembered-accounts/adopt-current-session"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await fetch(server.origin + path, { method });
        assert.equal(response.status, 410); assert.equal((await response.json() as { error: { code: string } }).error.code, "account_flow_retired");
        assert.equal(response.headers.getSetCookie().length, 0);
      }
    }
    assert.equal((await fetch(`${server.origin}/v1/me`, { headers: { cookie: `gatherthread_session=${session.token}` } })).status, 401);
    assert.equal((await fetch(`${server.origin}/v1/me`, { headers: { authorization: `Bearer ${old.token}` } })).status, 200);
    assert.equal(server.database.sqlite.prepare("SELECT COUNT(*) n FROM users").get()!.n, 1);
    assert.equal(server.database.sqlite.prepare("SELECT COUNT(*) n FROM public_registration_accounts").get()!.n, 0);
  } finally { await server.close(); }
});

function recoveryFixture() {
  const f = fixture();
  f.options.recoveryEnabled = true;
  f.options.mailer!.notifyPasswordChanged = async () => {};
  const request = (email = "new@example.invalid") => ({ email, locale: "en" as const, challenge_token: randomUUID(), idempotency_key: randomUUID() });
  const resetInput = (id: string, code = f.mails.at(-1)!.code, email = "new@example.invalid") => ({ reset_id: id, email, code,
    password: "isolated replacement password 82", password_confirmation: "isolated replacement password 82", locale: "en" as const });
  const enroll = async () => { const sent = await f.send(); return f.db.verifyPublicRegistration(f.input(sent.registration_id), "browser1", "ip1", f.options); };
  const sendReset = (email = "new@example.invalid", browser = "recovery-browser") => f.db.registration.send(request(email), browser, "recovery-ip", f.options, "password-reset");
  return { ...f, request, resetInput, enroll, sendReset };
}

test("recovery preserves identity/projects and atomically revokes all browsers, Agents and pending authorizations without auto-login", async () => {
  const f = recoveryFixture();
  try {
    const account = await f.enroll();
    const second = await f.db.loginWithEmail({ email: "new@example.invalid", password, device_name: "Second", remember_device: true }, "second", "ip2");
    const native = f.db.createDevice(account.actor.user_id, "Native Agent");
    const pending = f.db.createDeviceAuthorization(account.actor);
    const project = f.db.createProject(account.actor, { title: "Keep project", idempotency_key: "keep" });
    const sent = await f.sendReset(); const input = f.resetInput(sent.registration_id);
    assert.equal(await f.db.resetPassword(input, "recovery-browser", "recovery-ip", f.options), account.actor.user_id);
    for (const session of [account.browser_session, second.browser_session]) assert.throws(() => f.db.authenticateBrowserSession(session.token));
    assert.throws(() => f.db.authenticate(native.token));
    assert.throws(() => f.db.claimDeviceAuthorization({ authorization_token: pending.authorization_token, device_name: "Late Agent" }));
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM devices WHERE user_id=? AND revoked_at IS NULL").get(account.actor.user_id)!.n, 0);
    assert.deepEqual(f.db.listProjects(account.actor.user_id).map((p) => p.id), [project.id]);
    assert.equal(f.db.canCreateProjects(account.actor.user_id), true);
    await assert.rejects(f.db.loginWithEmail({ email: input.email, password, device_name: "B", remember_device: false }, "recovery-browser", "ip"), rejectCode("email_login_invalid"));
    const logged = await f.db.loginWithEmail({ email: input.email, password: input.password, device_name: "B", remember_device: false }, "recovery-browser", "ip");
    assert.equal(logged.actor.user_id, account.actor.user_id); assert.notEqual(logged.actor.device_id, account.actor.device_id);
    await assert.rejects(f.db.resetPassword(input, "recovery-browser", "recovery-ip", f.options), rejectCode("registration_invalid"));
    const persisted = JSON.stringify(f.db.sqlite.prepare("SELECT * FROM password_reset_pending").all());
    assert.equal(persisted.includes(input.email), false); assert.equal(persisted.includes(input.password), false); assert.equal(persisted.includes(input.code), false);
  } finally { f.close(); }
});

test("recovery send/response/mail path is uniform, idempotent, purpose-separated and works with signup closed", async () => {
  const f = recoveryFixture();
  try {
    await f.enroll();
    f.options.enabled = false;
    assert.equal(f.db.registration.ready(f.options), false); assert.equal(f.db.registration.recoveryReady(f.options), true);
    const request = f.request(); const sent = await f.db.registration.send(request, "recovery-browser", "ip", f.options, "password-reset");
    assert.deepEqual(await f.db.registration.send(request, "recovery-browser", "ip", f.options, "password-reset"), sent);
    const unknown = await f.sendReset("unknown@example.invalid");
    assert.deepEqual(Object.keys(unknown), Object.keys(sent)); assert.equal(unknown.expires_in_seconds, sent.expires_in_seconds);
    assert.equal(f.mails.length, 3); // Signup, known reset, unknown reset; duplicate did not send.
    await assert.rejects(f.db.resetPassword(f.resetInput(unknown.registration_id, f.mails.at(-1)!.code, "unknown@example.invalid"), "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    f.options.enabled = true;
    await assert.rejects(f.db.verifyPublicRegistration(f.input(sent.registration_id, f.mails[1]!.code), "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM users").get()!.n, 1);
    assert.notEqual(f.db.registration.binding("same"), f.db.registration.binding("same", "password-reset"));
    f.db.registration.pause(true); assert.equal(f.db.registration.recoveryReady(f.options), false);
    await assert.rejects(f.sendReset("blocked@example.invalid"), rejectCode("registration_unavailable"));
  } finally { f.close(); }
});

test("recovery wrong-attempt cap survives restart; resend, expiry and browser/mailbox binding are enforced", async () => {
  const f = recoveryFixture();
  try {
    await f.enroll(); const first = await f.sendReset(); const code = f.mails.at(-1)!.code;
    const wrong = code === "00000000" ? "11111111" : "00000000";
    await assert.rejects(f.db.resetPassword(f.resetInput(first.registration_id, code), "other-browser", "ip", f.options), rejectCode("registration_invalid"));
    await assert.rejects(f.db.resetPassword(f.resetInput(first.registration_id, code, "other@example.invalid"), "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    for (let n = 0; n < 4; n++) await assert.rejects(f.db.resetPassword(f.resetInput(first.registration_id, wrong), "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    const second = f.open();
    await assert.rejects(second.resetPassword(f.resetInput(first.registration_id, code), "recovery-browser", "ip", f.options), rejectCode("registration_invalid")); second.close();
    f.advance(61_000); const fresh = await f.sendReset();
    await assert.rejects(f.db.resetPassword(f.resetInput(first.registration_id, code), "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    f.advance(600_001);
    await assert.rejects(f.db.resetPassword(f.resetInput(fresh.registration_id), "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM password_reset_pending").get()!.n, 0);
  } finally { f.close(); }
});

test("recovery fences account changes, concurrent use, deletion and pause/expiry during password work", async () => {
  const f = recoveryFixture();
  try {
    const account = await f.enroll(); const sent = await f.sendReset(); const input = f.resetInput(sent.registration_id);
    const first = f.db.resetPassword(input, "recovery-browser", "ip", f.options);
    await assert.rejects(f.db.resetPassword(input, "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    f.db.registration.pause(true); await assert.rejects(first, rejectCode("registration_unavailable"));
    assert.equal(f.db.authenticateBrowserSession(account.browser_session.token).actor.user_id, account.actor.user_id);
    f.db.registration.pause(false); f.advance(61_000); const fresh = await f.sendReset();
    const expiring = f.db.resetPassword(f.resetInput(fresh.registration_id), "recovery-browser", "ip", f.options);
    f.advance(600_001); await assert.rejects(expiring, rejectCode("registration_invalid"));
    f.advance(3_600_000); const deleted = await f.sendReset();
    f.db.deleteAccount(account.actor);
    await assert.rejects(f.db.resetPassword(f.resetInput(deleted.registration_id), "recovery-browser", "ip", f.options), rejectCode("registration_invalid"));
    assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM password_reset_pending").get()!.n, 0);
  } finally { f.close(); }
});

test("recovery proof cannot reset a changed password version", async () => {
  const f = recoveryFixture();
  try {
    const account = await f.enroll(); const sent = await f.sendReset(); const input = f.resetInput(sent.registration_id);
    const proof = f.db.registration.preparePasswordReset(input, "recovery-browser", "ip", f.options);
    const original = f.db.sqlite.prepare("SELECT password_hash FROM public_registration_accounts").get()!.password_hash as string;
    f.db.sqlite.prepare("UPDATE public_registration_accounts SET password_hash=?").run("changed-password-version");
    assert.throws(() => f.db.registration.completePasswordReset(input.reset_id, proof, "recovery-browser", "new", f.options, () => assert.fail("must not revoke")), rejectCode("registration_invalid"));
    f.db.sqlite.prepare("UPDATE public_registration_accounts SET password_hash=?").run(original);
    f.advance(61_000); const next = await f.sendReset();
    assert.equal(await f.db.resetPassword(f.resetInput(next.registration_id), "recovery-browser", "ip", f.options), account.actor.user_id);
    const row = f.db.sqlite.prepare("SELECT password_hash FROM public_registration_accounts").get()!;
    assert.equal(await checkPassword(f.resetInput(next.registration_id).password, row.password_hash as string), true);
    assert.throws(() => f.db.authenticateBrowserSession(account.browser_session.token));
  } finally { f.close(); }
});

test("registration, recovery and reset notifications share durable hard provider caps", async () => {
  const f = recoveryFixture();
  try {
    await f.enroll();
    const sent = await f.sendReset(); const reset = f.resetInput(sent.registration_id);
    for (let n = 0; n < 18; n++) await f.send(`cap-${n}@example.invalid`, `cap-b-${n}`, `cap-ip-${n}`);
    const second = f.open();
    await assert.rejects(second.resetPassword(reset, "recovery-browser", "ip", f.options), rejectCode("registration_limited"));
    await assert.rejects(f.sendReset("over@example.invalid"), rejectCode("registration_limited"));
    second.close(); assert.equal(f.mails.length, 20);
  } finally { f.close(); }
});

test("recovery config and provider challenge bind their distinct purpose; notice emails contain no password/code", async () => {
  const env = { GATHERTHREAD_PASSWORD_RECOVERY: "true", GATHERTHREAD_PUBLIC_REGISTRATION: "false", GATHERTHREAD_TURNSTILE_SITE_KEY: "test-site-key", GATHERTHREAD_TURNSTILE_SECRET: "secret-for-isolated-tests-only", GATHERTHREAD_REGISTRATION_RESEND_KEY: "key-for-isolated-tests-only", GATHERTHREAD_REGISTRATION_FROM: "sender@example.invalid" };
  const options = registrationFromEnvironment(env, "https://test.invalid"); assert.equal(options.enabled, false); assert.equal(options.recoveryEnabled, true);
  assert.equal(registrationFromEnvironment({ ...env, GATHERTHREAD_TURNSTILE_SECRET: "" }, "https://test.invalid").recoveryEnabled, false);
  assert.throws(() => registrationFromEnvironment({ GATHERTHREAD_PASSWORD_RECOVERY: "yes" }, "https://test.invalid"));
  const transport = (async () => new Response(JSON.stringify({ success: true, hostname: "test.invalid", action: "gt_register", cdata: "bound" }))) as typeof fetch;
  assert.equal(await new TurnstileRegistrationChallenge("secret", "test.invalid", transport).verify("token", "bound", "password-reset"), false);
  const good = (async () => new Response(JSON.stringify({ success: true, hostname: "test.invalid", action: "gt_password_reset", cdata: "bound" }))) as typeof fetch;
  assert.equal(await new TurnstileRegistrationChallenge("secret", "test.invalid", good).verify("token", "bound", "password-reset"), true);
  const bodies: Array<{ subject: string; text: string }> = [];
  const mailer = new ResendRegistrationMailer("private-key", "sender@example.invalid", (async (_url, request) => { bodies.push(JSON.parse(String(request!.body))); return new Response(null, { status: 200 }); }) as typeof fetch);
  await mailer.send({ email: "recipient@example.invalid", code: "12345678", purpose: "password-reset", locale: "en", deliveryId: randomUUID() });
  await mailer.notifyPasswordChanged({ email: "recipient@example.invalid", locale: "zh-CN", deliveryId: randomUUID() });
  assert.match(bodies[0]!.subject, /password reset/); assert.match(bodies[1]!.text, /授权已撤销/);
  assert.doesNotMatch(bodies[1]!.text, /12345678|isolated replacement/);
});

test("HTTP recovery is origin/JSON/browser fenced and invalidates old cookies/native devices", async () => {
  const mails: Array<{ code: string }> = [];
  const registration: RegistrationOptions = { enabled: true, recoveryEnabled: true, siteKey: "isolated-site-key", origin: "https://test.invalid",
    challenge: { async verify() { return true; } }, mailer: { async send(message) { mails.push(message); }, async notifyPasswordChanged() {} } };
  const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: pepper, registration, allowedOrigins: [registration.origin!] });
  try {
    const sent = await server.database.registration.send({ email: "http@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, "enroll", "ip", registration);
    const account = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id, code: mails.at(-1)!.code, display_name: "HTTP", device_name: "B", remember_device: true, privacy_acknowledged: true, password }, "enroll", "ip", registration);
    const native = server.database.createDevice(account.actor.user_id, "Native");
    registration.enabled = false;
    const status = await fetch(server.origin + "/v1/password-reset"); const cookie = status.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    assert.equal((await status.json() as { data: { enabled: boolean } }).data.enabled, true);
    const sendInput = { email: "http@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(server.origin + path, { method: "POST", headers: { origin: registration.origin!, "content-type": "application/json", cookie, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post("/v1/password-reset/send", sendInput, { origin: "" })).status, 403);
    assert.equal((await post("/v1/password-reset/send", sendInput, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("/v1/password-reset/send", sendInput, { cookie: "" })).status, 400);
    const reset = await post("/v1/password-reset/send", sendInput); assert.equal(reset.status, 202);
    const resetId = (await reset.json() as { data: { reset_id: string } }).data.reset_id;
    const input = { reset_id: resetId, email: sendInput.email, code: mails.at(-1)!.code, password: "reset123", password_confirmation: "reset123", locale: "en" };
    assert.equal((await post("/v1/password-reset/verify", { ...input, password: "short12", password_confirmation: "short12" })).status, 400);
    const done = await post("/v1/password-reset/verify", input); assert.equal(done.status, 200); assert.deepEqual(await done.json(), { data: { reset: true } }); assert.equal(done.headers.getSetCookie().length, 0);
    assert.equal((await fetch(server.origin + "/v1/me", { headers: { cookie: `gatherthread_session=${account.browser_session.token}` } })).status, 401);
    assert.equal((await fetch(server.origin + "/v1/me", { headers: { authorization: `Bearer ${native.token}` } })).status, 401);
    assert.equal((await post("/v1/password-reset/verify", input)).status, 400);
  } finally { await server.close(); }
});
