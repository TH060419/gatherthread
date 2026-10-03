import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { TestGateStore, TEST_GATE_COOKIE } from "../src/test-gate.js";
import { startCollaborationServer } from "../src/server.js";
import { loadServerConfig } from "../src/config.js";
import { containsCodeSyncSecret, TestGateExchangeInputSchema } from "@gatherthread/protocol";
import type { Actor, CollaborationDatabase } from "../src/database.js";

const pepper = () => randomBytes(32).toString("hex");
async function fixtureIdentity(database: CollaborationDatabase): Promise<{ actor: Actor; token: string }> {
  if (!Reflect.has(database, "registration")) return database.bootstrapIdentity({ display_name: "Fixture", device_name: "Fixture" });
  // Dependency-aware test fixture only: use PR62's own account methods when available.
  let code = "";
  const registration = { enabled: true, origin: "https://test.gatherthread.cn", siteKey: "fixture",
    challenge: { async verify() { return true; } }, mailer: { async send(mail: { code: string }) { code = mail.code; } } };
  const extended = database as unknown as {
    registration: { send(input: unknown, browser: string, ip: string, options: unknown): Promise<{ registration_id: string }> };
    verifyPublicRegistration(input: unknown, browser: string, ip: string, options: unknown): Promise<{ actor: Actor }>;
  };
  const sent = await extended.registration.send({ email: "fixture@example.invalid", locale: "en", challenge_token: pepper(), idempotency_key: pepper() }, "fixture-browser", "fixture-ip", registration);
  const result = await extended.verifyPublicRegistration({ registration_id: sent.registration_id, code, display_name: "Fixture", device_name: "Fixture", password: "fixture account password", remember_device: true, privacy_acknowledged: true }, "fixture-browser", "fixture-ip", registration);
  const native = database.createDevice(result.actor.user_id, "Fixture native");
  return { actor: result.actor, token: native.token };
}
test("admission digest store supports independent batches, expiry, revocation, session scope and durable budgets", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-admission-")));
  const options = { databasePath: join(directory, "gate.sqlite"), pepper: pepper(), origin: "https://test.gatherthread.cn" };
  let store = new TestGateStore(options);
  try {
    const grants = store.issue(2, 1);
    assert.equal(new Set(grants.map(grant => grant.admission_code)).size, 2);
    const session = store.exchange(grants[0]!.admission_code);
    assert.equal(store.admitted(session.token), true);
    assert.equal(store.admitted(grants[0]!.admission_code), false);
    assert.equal(store.admitted(session.token, Date.now() + 3600001), false);
    assert.throws(() => store.exchange(grants[0]!.admission_code, Date.now() + 3600001));
    store.revoke(grants[0]!.grant_id);
    assert.equal(store.admitted(session.token), false);
    assert.throws(() => store.exchange(grants[0]!.admission_code));
    for (let i = 0; i < 20; i++) store.attempt("same-peer");
    store.close(); store = new TestGateStore(options);
    assert.throws(() => store.attempt("same-peer"), /Too many/);
    store.attempt("same-peer", Date.now() + 60001);
    const other = new TestGateStore({ ...options, databasePath: ":memory:", pepper: pepper() });
    try { assert.equal(other.admitted(session.token), false); assert.throws(() => other.exchange(grants[1]!.admission_code)); } finally { other.close(); }
    for (const grant of grants) assert.equal(containsCodeSyncSecret(grant.admission_code), true);
    assert.equal(containsCodeSyncSecret(session.token), true);
    assert.equal(TestGateExchangeInputSchema.safeParse({ admission_code: grants[0]!.admission_code, password: "x" }).success, false);
    store.close();
    for (const value of [session.token, ...grants.map(grant => grant.admission_code)]) assert.equal(readFileSync(options.databasePath).includes(value), false);
    store = new TestGateStore(options);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("production default stays unchanged and isolated test configuration fails closed", () => {
  assert.equal(loadServerConfig({}).testGate, undefined);
  const env = { GATHERTHREAD_DEPLOYMENT_ENVIRONMENT: "test", GATHERTHREAD_TEST_GATE_ENABLED: "true", GATHERTHREAD_TEST_GATE_DATABASE_PATH: "/private/tmp/admission/gate.sqlite", GATHERTHREAD_TEST_GATE_PEPPER: pepper(), GATHERTHREAD_AUTH_TOKEN_PEPPER: pepper(), GATHERTHREAD_PUBLIC_BASE_URL: "https://test.gatherthread.cn", GATHERTHREAD_ALLOWED_ORIGINS: "https://test.gatherthread.cn", GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "true" };
  assert.ok(loadServerConfig(env).testGate);
  for (const change of [
    { GATHERTHREAD_DEPLOYMENT_ENVIRONMENT: "production" }, { GATHERTHREAD_TEST_GATE_ENABLED: "false" },
    { GATHERTHREAD_TEST_GATE_PEPPER: env.GATHERTHREAD_AUTH_TOKEN_PEPPER },
    { GATHERTHREAD_PUBLIC_BASE_URL: "https://gatherthread.cn" }, { GATHERTHREAD_ALLOWED_ORIGINS: "https://gatherthread.cn" },
    { GATHERTHREAD_TEST_GATE_DATABASE_PATH: ".local/gate.sqlite" }, { GATHERTHREAD_TLS_TERMINATED_BY_PROXY: "false" },
    { GATHERTHREAD_DATABASE_PATH: env.GATHERTHREAD_TEST_GATE_DATABASE_PATH },
  ]) assert.throws(() => loadServerConfig({ ...env, ...change }));
});

async function hostFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, init, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const headers = new Headers(); for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers }));
      });
    }); request.on("error", reject); request.end(init.body);
  });
}

async function websocketStatus(origin: string, ticket: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/v1/ws", ["gatherthread-v1", `gatherthread-ticket.${ticket}`], { headers });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("WebSocket timeout")); }, 2000);
    socket.on("open", () => { clearTimeout(timer); socket.close(); resolve(101); });
    socket.on("unexpected-response", (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode!); });
    socket.on("error", () => { /* unexpected response closes transport */ });
  });
}

test("HTTP gate protects account/restoration APIs; native credentials and WS keep their own boundaries", async () => {
  const publicOrigin = "https://test.gatherthread.cn", host = "test.gatherthread.cn";
  const gate = { databasePath: ":memory:", pepper: pepper(), origin: publicOrigin };
  // Shared gate file is needed for live admin revocation during a running process.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-admission-http-")));
  gate.databasePath = join(directory, "gate.sqlite");
  const admin = new TestGateStore(gate), grant = admin.issue(1, 1)[0]!;
  const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: pepper(), secureTransport: true, testGate: gate, allowedOrigins: [publicOrigin], heartbeatIntervalMs: 50 });
  const production = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: pepper(), secureTransport: true, allowedOrigins: ["https://gatherthread.cn"] });
  const request = (path: string, body?: unknown, cookie?: string, token?: string, requestOrigin: string | null = publicOrigin) => hostFetch(server.origin + path, {
    method: body === undefined ? "GET" : "POST", headers: { host, ...(requestOrigin ? { origin: requestOrigin } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    for (const path of ["/v1/registration", "/v1/registration/send", "/v1/registration/verify", "/v1/password-reset", "/v1/password-reset/send", "/v1/password-reset/verify", "/v1/email-login", "/v1/browser-sessions", "/v1/me", "/v1/projects", "/%76%31/projects", "/v1/dsh-pairings/approve", "/v1/device-authorizations"]) {
      const response = await request(path, path.endsWith("/me") || path.endsWith("/registration") || path.endsWith("/password-reset") ? undefined : {});
      assert.equal(response.status, 403, path); assert.equal(((await response.json()) as {error: {code: string}}).error.code, "test_admission_required");
    }
    const wrong = await request("/v1/test-gate", { admission_code: "bad" });
    assert.equal(wrong.status, 403);
    assert.equal((await request("/v1/test-gate", { admission_code: grant.admission_code }, undefined, undefined, "https://gatherthread.cn")).status, 403);
    const exchange = await request("/v1/test-gate", { admission_code: grant.admission_code });
    assert.equal(exchange.status, 200);
    const setCookie = exchange.headers.get("set-cookie")!;
    assert.match(setCookie, /^__Host-gatherthread_test_gate=/); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/); assert.doesNotMatch(setCookie, /Domain=/i);
    const cookie = setCookie.split(";")[0]!;
    assert.equal((await request("/v1/me", undefined, cookie)).status, 401, "admission is not login");
    assert.equal((await request("/v1/browser-sessions", {}, cookie)).status, 410, "retired login remains retired");
    assert.equal((await request("/%76%31/remembered-accounts/fixture/activate", {}, cookie)).status, 410, "encoded retired routes cannot bypass retirement");
    const identity = await fixtureIdentity(server.database);
    const other = await fixtureIdentity(production.database);
    const browser = server.database.createBrowserSession(identity.actor, true);
    const sessionCookie = `__Host-gatherthread_session=${browser.token}`;
    assert.equal((await request("/v1/me", undefined, sessionCookie)).status, 403);
    assert.equal((await request("/v1/me", undefined, `${cookie}; ${sessionCookie}`)).status, 200);
    assert.equal((await request("/v1/me", undefined, undefined, other.token, null)).status, 401);
    assert.equal((await fetch(production.origin + "/v1/me", { headers: { authorization: `Bearer ${identity.token}` } })).status, 401);
    assert.equal((await fetch(production.origin + "/v1/me", { headers: { cookie: `${cookie}; ${sessionCookie}` } })).status, 401);
    // Caller cannot forge native exemption by adding a browser Origin.
    assert.equal((await request("/v1/me", undefined, undefined, identity.token)).status, 403);
    const native = await hostFetch(server.origin + "/v1/me", { headers: { host, authorization: `Bearer ${identity.token}` } });
    assert.equal(native.status, 200);
    const project = server.database.createProject(identity.actor, { title: "Fixture", idempotency_key: "fixture-project-key" });
    const session = server.database.createSession(identity.actor, { project_id: project.id, title: "Fixture", mode: "multi", idempotency_key: "fixture-session-key" });
    const ticketResponse = await request("/v1/realtime-ticket", { session_id: session.session.id }, `${cookie}; ${sessionCookie}`);
    const ticket = ((await ticketResponse.json()) as {data: {ticket: string}}).data.ticket;
    assert.equal(await websocketStatus(server.origin, ticket, { host, origin: publicOrigin }), 401);
    const goodResponse = await request("/v1/realtime-ticket", { session_id: session.session.id }, `${cookie}; ${sessionCookie}`);
    assert.equal(await websocketStatus(server.origin, ((await goodResponse.json()) as {data: {ticket: string}}).data.ticket, { host, origin: publicOrigin, cookie }), 101);
    const nativeTicket = await request("/v1/realtime-ticket", { session_id: session.session.id }, undefined, identity.token, null);
    assert.equal(nativeTicket.status, 201);
    assert.equal(await websocketStatus(server.origin, ((await nativeTicket.json()) as {data: {ticket: string}}).data.ticket, { host }), 101, "native device ticket works without browser admission");
    const newNativeTicket = async () => {
      const response = await request("/v1/realtime-ticket", { session_id: session.session.id }, undefined, identity.token, null);
      assert.equal(response.status, 201);
      return ((await response.json()) as { data: { ticket: string } }).data.ticket;
    };
    const revokedGrant = admin.issue(1, 1)[0]!;
    const revokedToken = admin.exchange(revokedGrant.admission_code).token;
    admin.revoke(revokedGrant.grant_id);
    for (const invalidCookie of [undefined, `${TEST_GATE_COOKIE}=gteg_${randomBytes(32).toString("base64url")}`, `${TEST_GATE_COOKIE}=${revokedToken}`]) {
      assert.equal(await websocketStatus(server.origin, await newNativeTicket(), { host, origin: publicOrigin, ...(invalidCookie ? { cookie: invalidCookie } : {}) }), 401,
        "native ticket does not exempt a browser-Origin handshake from admission");
    }
    const nativeBrowserSocket = new WebSocket(server.origin.replace("http:", "ws:") + "/v1/ws", ["gatherthread-v1", `gatherthread-ticket.${await newNativeTicket()}`], { headers: { host, origin: publicOrigin, cookie } });
    await once(nativeBrowserSocket, "open");
    const realNativeSocket = new WebSocket(server.origin.replace("http:", "ws:") + "/v1/ws", ["gatherthread-v1", `gatherthread-ticket.${await newNativeTicket()}`], { headers: { host } });
    await once(realNativeSocket, "open");
    const liveTicket = await request("/v1/realtime-ticket", { session_id: session.session.id }, `${cookie}; ${sessionCookie}`);
    const liveSocket = new WebSocket(server.origin.replace("http:", "ws:") + "/v1/ws", ["gatherthread-v1", `gatherthread-ticket.${((await liveTicket.json()) as {data: {ticket: string}}).data.ticket}`], { headers: { host, origin: publicOrigin, cookie } });
    await once(liveSocket, "open");
    const closed = once(liveSocket, "close");
    const nativeBrowserClosed = once(nativeBrowserSocket, "close");
    admin.revoke(grant.grant_id);
    assert.equal((await closed)[0], 1008, "revocation closes an already connected browser socket");
    assert.equal((await nativeBrowserClosed)[0], 1008, "native ticket with browser Origin retains browser admission checks after upgrade");
    assert.equal(realNativeSocket.readyState, WebSocket.OPEN, "genuine native device remains independent of browser admission");
    const nativeClosed = once(realNativeSocket, "close");
    server.database.revokeDevice(identity.actor, server.database.authenticate(identity.token).device_id);
    assert.equal((await nativeClosed)[0], 1008, "independent device revocation still closes the genuine native socket");
    assert.equal((await request("/v1/me", undefined, `${cookie}; ${sessionCookie}`)).status, 403);
    assert.equal((await request("/v1/test-gate", { admission_code: grant.admission_code })).status, 403);
    assert.equal((await fetch(production.origin + "/v1/me", { headers: { authorization: `Bearer ${other.token}` } })).status, 200);
    assert.equal((await request("/v1/test-gate", undefined, `${cookie}; ${cookie}`)).status, 200);
  } finally { await server.close(); await production.close(); admin.close(); rmSync(directory, { recursive: true, force: true }); }
});
