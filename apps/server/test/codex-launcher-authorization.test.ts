import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { CollaborationDatabase, type Actor } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { startCollaborationServer } from "../src/server.js";
import { TestGateStore, TEST_GATE_COOKIE, nativeAdmissionCapability } from "../src/test-gate.js";
import type { RegistrationOptions } from "../src/registration.js";

const pepper = "launcher-isolated-test-pepper-at-least-32-bytes";
const email = "launcher@example.invalid";
const password = "fixture8";
const invalid = (error: unknown) => error instanceof ApiError && error.code === "launcher_authorization_invalid";

async function register(db: CollaborationDatabase, marker = "browser1", mailbox = email) {
  let code = "";
  const options: RegistrationOptions = { enabled: true, origin: "https://test.gatherthread.cn", siteKey: "fixture",
    challenge: { async verify() { return true; } }, mailer: { async send(mail) { code = mail.code; } } };
  const sent = await db.registration.send({ email: mailbox, locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, marker, marker, options);
  return db.verifyPublicRegistration({ registration_id: sent.registration_id, code, display_name: "Fixture", device_name: marker,
    remember_device: true, privacy_acknowledged: true, password }, marker, marker, options);
}

async function fixture(t: TestContext) {
  let now = Date.UTC(2026, 9, 12, 8);
  const db = new CollaborationDatabase(":memory:", { authTokenPepper: pepper, clock: () => new Date(now) });
  t.after(() => db.close());
  const identity = await register(db);
  const project = db.createProject(identity.actor, { title: "Launcher project", idempotency_key: randomUUID() });
  const grant = () => db.createCodexLauncherAuthorization(identity.actor, { project_id: project.id, email });
  const claim = (authorization_id: string, overrides: Record<string, unknown> = {}) => db.claimCodexLauncherAuthorization({
    authorization_id, project_id: project.id, email, password, device_name: "Fixture Agent", ...overrides,
  }, "fixture-native-ip");
  const count = (table: string) => Number(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return { db, identity, project, grant, claim, count, advance: (ms: number) => { now += ms; } };
}

test("Launcher password authorization creates independent devices without replacing browser sessions or old native grants", async t => {
  const f = await fixture(t);
  const phone = await f.db.loginWithEmail({ email, password, device_name: "Phone", remember_device: true }, "phone", "phone-ip");
  const oldGrant = f.db.createDeviceAuthorization(f.identity.actor);
  const first = f.grant();
  assert.equal(first.email, email);
  assert.equal("authorization_token" in first, false);
  assert.equal(JSON.stringify(first).includes("gtd_"), false);
  assert.equal(JSON.stringify(first).includes("gta_"), false);
  const native = await f.claim(first.authorization.id);
  const next = await f.claim(f.grant().authorization.id, { device_name: "Second Agent" });
  assert.equal(native.actor.user_id, f.identity.actor.user_id);
  assert.equal(new Set([native.actor.device_id, next.actor.device_id, phone.actor.device_id, f.identity.actor.device_id]).size, 4);
  assert.equal(f.db.authenticate(native.token).device_id, native.actor.device_id);
  assert.equal(f.db.authenticateBrowserSession(phone.browser_session.token).actor.user_id, native.actor.user_id);
  assert.equal(f.db.authenticateBrowserSession(f.identity.browser_session.token).actor.user_id, native.actor.user_id);
  assert.equal(f.db.claimDeviceAuthorization({ authorization_token: oldGrant.authorization_token, device_name: "Old compatible connector" }).actor.user_id, native.actor.user_id);
  await assert.rejects(f.claim(first.authorization.id), invalid);
  const rows = JSON.stringify(["device_authorizations", "codex_launcher_authorizations", "devices"].map(table => f.db.sqlite.prepare(`SELECT * FROM ${table}`).all()));
  assert.equal(rows.includes(password), false);
  assert.equal(rows.includes(email), false);
  assert.equal(rows.includes(native.token), false);
});

test("Launcher grant creation checks active authorizer, verified account email and project membership before writing", async t => {
  const f = await fixture(t);
  const before = f.count("device_authorizations");
  assert.throws(() => f.db.createCodexLauncherAuthorization(f.identity.actor, { project_id: f.project.id, email: "wrong@example.invalid" }), invalid);
  assert.throws(() => f.db.createCodexLauncherAuthorization(f.identity.actor, { project_id: randomUUID(), email }));
  const stranger = f.db.createIdentity({ display_name: "Stranger", device_name: "Stranger" });
  assert.throws(() => f.db.createCodexLauncherAuthorization(stranger.actor, { project_id: f.project.id, email }), invalid);
  assert.equal(f.count("device_authorizations"), before);
  f.db.revokeDevice(f.identity.actor, f.identity.actor.device_id);
  assert.throws(() => f.grant());
  assert.equal(f.count("device_authorizations"), before);
});

test("Wrong account, password, project, unbound old grant and replay create no Launcher device", async t => {
  const f = await fixture(t), grant = f.grant();
  const other = await register(f.db, "other-browser", "other@example.invalid");
  assert.notEqual(other.actor.user_id, f.identity.actor.user_id);
  const before = f.count("devices");
  for (const overrides of [{ email: "other@example.invalid" }, { email: "missing@example.invalid" }, { password: "wrong-pass" }, { project_id: randomUUID() }]) {
    await assert.rejects(f.claim(grant.authorization.id, overrides), invalid);
    assert.equal(f.count("devices"), before);
  }
  const old = f.db.createDeviceAuthorization(f.identity.actor);
  await assert.rejects(f.claim(old.authorization.id), invalid);
  assert.equal(f.count("devices"), before);
  const accepted = await f.claim(grant.authorization.id);
  await assert.rejects(f.claim(grant.authorization.id), invalid);
  assert.equal(f.count("devices"), before + 1);
  assert.equal(f.db.authenticate(accepted.token).user_id, f.identity.actor.user_id);
});

for (const change of ["revoke-grant", "expiry", "revoke-device", "device-expiry", "membership", "password", "project-archive", "project-delete", "account-delete"] as const) {
  test(`Launcher claim rechecks ${change} after asynchronous password work`, async t => {
    const f = await fixture(t), grant = f.grant(), before = f.count("devices");
    const original = f.db.registration.passwordLoginAttempt.bind(f.db.registration);
    t.mock.method(f.db.registration, "passwordLoginAttempt", (...args: Parameters<typeof original>) => {
      const result = original(...args);
      queueMicrotask(() => {
        if (change === "revoke-grant") f.db.revokeDeviceAuthorization(f.identity.actor, grant.authorization.id);
        if (change === "expiry") f.advance(600_001);
        if (change === "revoke-device") f.db.revokeDevice(f.identity.actor, f.identity.actor.device_id);
        if (change === "device-expiry") f.db.sqlite.prepare("UPDATE devices SET expires_at=? WHERE id=?").run(new Date(Date.UTC(2026, 9, 12, 8)).toISOString(), f.identity.actor.device_id);
        if (change === "membership") f.db.sqlite.prepare("DELETE FROM project_memberships WHERE project_id=? AND user_id=?").run(f.project.id, f.identity.actor.user_id);
        if (change === "password") f.db.sqlite.prepare("UPDATE public_registration_accounts SET password_hash='changed' WHERE user_id=?").run(f.identity.actor.user_id);
        if (change === "project-archive") f.db.sqlite.prepare("UPDATE projects SET state='archived' WHERE id=?").run(f.project.id);
        if (change === "project-delete") f.db.deleteProject(f.identity.actor, f.project.id);
        if (change === "account-delete") { f.db.deleteProject(f.identity.actor, f.project.id); f.db.deleteAccount(f.identity.actor); }
      });
      return result;
    });
    await assert.rejects(f.claim(grant.authorization.id), invalid);
    assert.equal(f.count("devices"), change === "account-delete" ? 0 : before);
  });
}

test("Native Launcher claims share durable login email budgets and unknown-account password work", async t => {
  const f = await fixture(t), grant = f.grant();
  // Changing the public request ID cannot evade the shared account/IP budget.
  for (let n = 0; n < 10; n++) await assert.rejects(f.claim(grant.authorization.id, { authorization_id: randomUUID(), email: "missing@example.invalid" }), invalid);
  await assert.rejects(f.claim(grant.authorization.id, { email: "missing@example.invalid" }), (error: unknown) => error instanceof ApiError && error.code === "registration_limited");
  assert.equal(f.count("devices"), 1);
});

test("Concurrent Launcher claims cannot create two native devices from one connection request", async t => {
  const f = await fixture(t), grant = f.grant(), before = f.count("devices");
  const results = await Promise.allSettled([f.claim(grant.authorization.id), f.claim(grant.authorization.id)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.count("devices"), before + 1);
  await assert.rejects(f.claim(grant.authorization.id), invalid);
});

test("Launcher binding migration preserves existing devices and manual authorization grants", async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-launcher-migration-")));
  const path = join(directory, "identity.sqlite");
  let db = new CollaborationDatabase(path, { authTokenPepper: pepper });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const identity = await register(db);
  const project = db.createProject(identity.actor, { title: "Existing project", idempotency_key: randomUUID() });
  const oldGrant = db.createDeviceAuthorization(identity.actor);
  // Model an existing database without the additive project-binding table.
  db.sqlite.exec("DROP TABLE codex_launcher_authorizations");
  db.close(); db = new CollaborationDatabase(path, { authTokenPepper: pepper });
  assert.equal(db.authenticateBrowserSession(identity.browser_session.token).actor.user_id, identity.actor.user_id);
  assert.equal(db.claimDeviceAuthorization({ authorization_token: oldGrant.authorization_token, device_name: "Legacy connector" }).actor.user_id, identity.actor.user_id);
  const grant = db.createCodexLauncherAuthorization(identity.actor, { project_id: project.id, email });
  assert.equal((await db.claimCodexLauncherAuthorization({ authorization_id: grant.authorization.id, project_id: project.id, email, password,
    device_name: "Updated Launcher" }, "fixture-ip")).actor.user_id, identity.actor.user_id);
  assert.equal(db.listProjects(identity.actor.user_id)[0]!.id, project.id);
});

function call(origin: string, path: string, body: unknown, headers: Record<string, string> = {}, method = "POST"): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, { method, headers: { "content-type": "application/json", ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => { const responseHeaders = new Headers(); for (let n = 0; n < res.rawHeaders.length; n += 2) responseHeaders.append(res.rawHeaders[n]!, res.rawHeaders[n + 1]!);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: responseHeaders })); });
    }); req.on("error", reject); req.end(JSON.stringify(body));
  });
}

test("Launcher admission exemption is only the exact native POST claim", () => {
  const path = "/v1/codex-launcher-authorizations/claim";
  assert.equal(nativeAdmissionCapability(path, "POST", false), true);
  for (const [target, method, origin, metadata] of [
    [path, "GET", false, false], [path, "POST", true, false], [path, "POST", false, true],
    ["/v1/codex-launcher-authorizations", "POST", false, false], [`${path}/`, "POST", false, false],
  ] as const) assert.equal(nativeAdmissionCapability(target, method, origin, metadata), false);
});

test("HTTP Launcher flow is admitted-browser creation and bounded native-only one-use password claim", async t => {
  const publicOrigin = "https://test.gatherthread.cn";
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-launcher-gate-")));
  const testGate = { databasePath: join(directory, "gate.sqlite"), pepper: `${pepper}-separate-gate`, origin: publicOrigin };
  const gate = new TestGateStore(testGate);
  const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: pepper, publicBaseUrl: publicOrigin,
    allowedOrigins: [publicOrigin], secureTransport: true, testGate });
  t.after(async () => { await server.close(); gate.close(); rmSync(directory, { recursive: true, force: true }); });
  const identity = await register(server.database);
  const project = server.database.createProject(identity.actor, { title: "HTTP launcher", idempotency_key: randomUUID() });
  const admission = gate.exchange(gate.issue(1, 1)[0]!.admission_code);
  const browserHeaders = { host: new URL(publicOrigin).host, origin: publicOrigin,
    cookie: `${TEST_GATE_COOKIE}=${admission.token}; __Host-gatherthread_session=${identity.browser_session.token}` };
  const createInput = { project_id: project.id, email };
  const path = "/v1/codex-launcher-authorizations";
  assert.equal((await call(server.origin, path, createInput, { ...browserHeaders, cookie: `__Host-gatherthread_session=${identity.browser_session.token}` })).status, 403);
  assert.equal((await call(server.origin, path, { ...createInput, password }, browserHeaders)).status, 400);
  const priorNative = server.database.createDevice(identity.actor.user_id, "Old independent Agent");
  assert.equal((await call(server.origin, path, createInput, { ...browserHeaders, authorization: `Bearer ${priorNative.token}` })).status, 403);
  assert.equal((await call(server.origin, `${path}?email=x`, createInput, browserHeaders)).status, 400);
  const created = await call(server.origin, path, createInput, browserHeaders);
  assert.equal(created.status, 201);
  const result = await created.json() as { data: { authorization: { id: string }; email: string } };
  assert.equal(result.data.email, email);
  assert.equal(JSON.stringify(result).includes("token"), false);
  const input = { authorization_id: result.data.authorization.id, project_id: project.id, email, password, device_name: "HTTP native Agent" };
  const nativeHeaders = { host: new URL(publicOrigin).host };
  for (const headers of [{ origin: publicOrigin }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-mode": "cors" }, { "sec-fetch-dest": "empty" }, { cookie: browserHeaders.cookie }, { authorization: "Bearer invalid" }]) {
    assert.equal((await call(server.origin, `${path}/claim`, input, { ...nativeHeaders, ...headers })).status, 403);
  }
  assert.equal((await call(server.origin, `${path}/claim?email=x`, input, nativeHeaders)).status, 400);
  assert.equal((await call(server.origin, `${path}/claim`, input, { ...nativeHeaders, "content-type": "text/plain" })).status, 415);
  assert.equal((await call(server.origin, `${path}/claim`, { ...input, password: "a".repeat(9000) }, nativeHeaders)).status, 413);
  const accepted = await call(server.origin, `${path}/claim`, input, nativeHeaders);
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers.get("set-cookie"), null);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.equal(accepted.headers.get("location"), null);
  const native = await accepted.json() as { data: { actor: Actor; token: string } };
  assert.equal(native.data.actor.user_id, identity.actor.user_id);
  assert.equal(server.database.authenticate(native.data.token).device_id, native.data.actor.device_id);
  assert.equal(server.database.authenticateBrowserSession(identity.browser_session.token).actor.device_id, identity.actor.device_id);
  assert.equal((await call(server.origin, `${path}/claim`, input, nativeHeaders)).status, 401);
});
