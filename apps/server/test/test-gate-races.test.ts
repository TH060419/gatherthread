import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { startCollaborationServer } from "../src/server.js";
import { TestGateStore, TEST_GATE_COOKIE } from "../src/test-gate.js";
import type { RegistrationOptions } from "../src/registration.js";

const origin = "https://test.gatherthread.cn";
const password = "fixture account password";
const email = "race-fixture@example.invalid";
const pepper = () => randomBytes(32).toString("hex");
const deferred = <T>() => Promise.withResolvers<T>();

async function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-admission-race-")));
  const gate = { databasePath: join(directory, "admission.sqlite"), pepper: pepper(), origin };
  const admin = new TestGateStore(gate);
  const gateSql = new DatabaseSync(gate.databasePath);
  const mails: { code: string }[] = [];
  const notices: unknown[] = [];
  const registration: RegistrationOptions = { enabled: true, recoveryEnabled: true, siteKey: "fixture", origin,
    challenge: { async verify() { return true; } },
    mailer: { async send(mail) { mails.push(mail); }, async notifyPasswordChanged(mail) { notices.push(mail); } } };
  const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: pepper(),
    publicBaseUrl: origin, allowedOrigins: [origin], secureTransport: true, testGate: gate, registration });
  t.after(async () => { await server.close(); gateSql.close(); admin.close(); rmSync(directory, { recursive: true, force: true }); });
  const admission = () => {
    const grant = admin.issue(1, 1)[0]!;
    const session = admin.exchange(grant.admission_code);
    return { grant, token: session.token, cookie: `${TEST_GATE_COOKIE}=${session.token}` };
  };
  const registrationBrowser = `grc_${randomBytes(32).toString("base64url")}`;
  const registrationCookie = `__Host-gatherthread_registration=${registrationBrowser}`;
  const call = (path: string, body: unknown, cookie: string): Promise<Response> => new Promise((resolve, reject) => {
    const req = httpRequest(server.origin + path, { method: "POST", headers: { host: new URL(origin).host,
      origin, cookie: `${cookie}; ${registrationCookie}`, "content-type": "application/json" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode! })));
    }); req.on("error", reject); req.end(JSON.stringify(body));
  });
  const identity = async () => {
    const sent = await server.database.registration.send({ email, locale: "en", challenge_token: pepper(), idempotency_key: randomUUID() }, registrationBrowser, "fixture-ip", registration);
    return server.database.verifyPublicRegistration({ registration_id: sent.registration_id, code: mails.at(-1)!.code,
      display_name: "Fixture", device_name: "Fixture web", password, remember_device: true, privacy_acknowledged: true }, registrationBrowser, "fixture-ip", registration);
  };
  const count = (table: string) => (server.database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { admin, gateSql, server, registration, registrationBrowser, mails, notices, admission, call, identity, count };
}

for (const invalidation of ["revoke", "logout", "expiry"] as const) {
  test(`HTTP write waiting for its body rejects admission ${invalidation} without creating a project`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const identity = await f.identity();
    const entry = f.admission();
    const started = deferred<void>();
    const authenticate = f.server.database.authenticateBrowserSession.bind(f.server.database);
    t.mock.method(f.server.database, "authenticateBrowserSession", (...args: Parameters<typeof authenticate>) => {
      const result = authenticate(...args); started.resolve(); return result;
    });
    const body = JSON.stringify({ title: "Must not persist", idempotency_key: randomUUID() });
    const reply = deferred<Response>();
    const req = httpRequest(f.server.origin + "/v1/projects", { method: "POST", headers: { host: new URL(origin).host, origin,
      cookie: `${entry.cookie}; __Host-gatherthread_session=${identity.browser_session.token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => reply.resolve(new Response(Buffer.concat(chunks), { status: res.statusCode! })));
    });
    req.on("error", reply.reject); t.after(() => req.destroy());
    req.write(body.slice(0, 1));
    await Promise.race([started.promise, reply.promise.then(response => { throw new Error(`Body was not awaited: HTTP ${response.status}`); })]);
    if (invalidation === "revoke") f.admin.revoke(entry.grant.grant_id);
    if (invalidation === "logout") f.admin.logout(entry.token);
    if (invalidation === "expiry") f.gateSql.prepare("UPDATE grants SET expires=? WHERE id=?").run(Date.now() - 1, entry.grant.grant_id);
    req.end(body.slice(1));
    const response = await reply.promise;
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "test_admission_required");
    assert.equal(f.count("projects"), 0);
    assert.equal(f.admin.admitted(entry.token), false);
  });
}

for (const purpose of ["registration", "password-reset"] as const) {
  test(`${purpose} challenge completing after revocation cannot send mail or reserve a delivery`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const entry = f.admission();
    const started = deferred<void>(), challenge = deferred<boolean>();
    t.mock.method(f.registration.challenge!, "verify", async () => { started.resolve(); return challenge.promise; });
    const response = f.call(`/v1/${purpose}/send`, { email, locale: "en", challenge_token: pepper(), idempotency_key: randomUUID() }, entry.cookie);
    await Promise.race([started.promise, response.then(reply => { throw new Error(`Challenge was not awaited: HTTP ${reply.status}`); })]);
    f.admin.revoke(entry.grant.grant_id); challenge.resolve(true);
    assert.equal((await response).status, 403);
    assert.equal(f.mails.length, 0);
    assert.equal(f.count(purpose === "registration" ? "registration_pending" : "password_reset_pending"), 0);
    assert.equal(f.count("public_registration_accounts"), 0);
  });
}

test("registration delivery finishing after revocation is never accepted for account verification", { timeout: 10_000 }, async t => {
  const f = await fixture(t), entry = f.admission();
  const started = deferred<void>(), delivery = deferred<void>();
  t.mock.method(f.registration.mailer!, "send", async () => { started.resolve(); await delivery.promise; });
  const response = f.call("/v1/registration/send", { email, locale: "en", challenge_token: pepper(), idempotency_key: randomUUID() }, entry.cookie);
  await Promise.race([started.promise, response.then(reply => { throw new Error(`Delivery was not awaited: HTTP ${reply.status}`); })]);
  f.admin.revoke(entry.grant.grant_id); delivery.resolve();
  assert.equal((await response).status, 403);
  assert.equal(f.count("public_registration_accounts"), 0);
  assert.equal((f.server.database.sqlite.prepare("SELECT count(*) AS n FROM registration_pending WHERE state='ready' OR code_digest!=''").get() as { n: number }).n, 0);
});

for (const action of ["register", "login", "reset"] as const) {
  test(`admission revoked while ${action} hashes a password prevents account/session/password mutation`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), entry = f.admission();
    if (action !== "register") await f.identity();
    const before = { accounts: f.count("public_registration_accounts"), devices: f.count("devices"), sessions: f.count("browser_sessions"),
      passwords: f.server.database.sqlite.prepare("SELECT password_hash FROM public_registration_accounts").all(),
      revoked: f.server.database.sqlite.prepare("SELECT id,revoked_at FROM devices").all() };
    let path: string, input: unknown;
    if (action === "login") {
      path = "/v1/email-login";
      input = { email, password, device_name: "Must not rename", remember_device: true };
      const original = f.server.database.registration.passwordLoginAttempt.bind(f.server.database.registration);
      t.mock.method(f.server.database.registration, "passwordLoginAttempt", (...args: Parameters<typeof original>) => {
        const result = original(...args); queueMicrotask(() => f.admin.revoke(entry.grant.grant_id)); return result;
      });
    } else {
      const purpose = action === "register" ? "registration" : "password-reset";
      const sent = await f.server.database.registration.send({ email, locale: "en", challenge_token: pepper(), idempotency_key: randomUUID() }, f.registrationBrowser, "fixture-ip", f.registration, purpose);
      path = `/v1/${purpose}/verify`;
      if (action === "register") {
        input = { registration_id: sent.registration_id, code: f.mails.at(-1)!.code, password, display_name: "Must not exist", device_name: "Fixture", remember_device: true, privacy_acknowledged: true };
        const original = f.server.database.registration.prepareVerification.bind(f.server.database.registration);
        t.mock.method(f.server.database.registration, "prepareVerification", (...args: Parameters<typeof original>) => {
          const result = original(...args); queueMicrotask(() => f.admin.revoke(entry.grant.grant_id)); return result;
        });
      } else {
        input = { reset_id: sent.registration_id, email, code: f.mails.at(-1)!.code, password: "new fixture password", password_confirmation: "new fixture password", locale: "en" };
        const original = f.server.database.registration.preparePasswordReset.bind(f.server.database.registration);
        t.mock.method(f.server.database.registration, "preparePasswordReset", (...args: Parameters<typeof original>) => {
          const result = original(...args); queueMicrotask(() => f.admin.revoke(entry.grant.grant_id)); return result;
        });
      }
    }
    assert.equal((await f.call(path, input, entry.cookie)).status, 403);
    assert.deepEqual({ accounts: f.count("public_registration_accounts"), devices: f.count("devices"), sessions: f.count("browser_sessions"),
      passwords: f.server.database.sqlite.prepare("SELECT password_hash FROM public_registration_accounts").all(),
      revoked: f.server.database.sqlite.prepare("SELECT id,revoked_at FROM devices").all() }, before);
    assert.equal(f.notices.length, 0);
  });
}
