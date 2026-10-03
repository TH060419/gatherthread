import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startCollaborationServer } from "../src/server.js";
import type { RegistrationOptions } from "../src/registration.js";

const initialPassword = "isolated initial password 47";
const replacementPassword = "isolated replacement password 82";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, notification: "success" | "delayed" | "failure" = "success") {
  const entered = gate(), release = gate();
  const mails: Array<{ code: string }> = [];
  let notices = 0;
  const origin = "https://isolated.invalid";
  const registration: RegistrationOptions = {
    enabled: true, recoveryEnabled: true, origin, siteKey: "isolated-site-key",
    challenge: { async verify() { return true; } },
    mailer: {
      async send(message) { mails.push(message); },
      async notifyPasswordChanged() {
        notices += 1; entered.resolve();
        if (notification === "delayed") await release.promise;
        if (notification === "failure") throw new Error("Isolated notification failure");
      },
    },
  };
  const server = await startCollaborationServer({ databasePath: ":memory:",
    authTokenPepper: "isolated-recovery-revocation-pepper-more-than-32-bytes", registration, allowedOrigins: [origin] });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    release.resolve();
    for (const socket of sockets) socket.terminate();
    await server.close();
  });
  const post = (path: string, body: unknown, cookie?: string) => fetch(server.origin + path, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie, origin } : {}) }, body: JSON.stringify(body),
  });
  const enrolled = await server.database.registration.send({ email: "fixture@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, "enroll", "ip", registration);
  const account = await server.database.verifyPublicRegistration({ registration_id: enrolled.registration_id,
    code: mails.at(-1)!.code, display_name: "Isolated account", device_name: "Isolated browser", password: initialPassword,
    privacy_acknowledged: true, remember_device: false }, "enroll", "ip", registration);
  const cookie = `gatherthread_session=${account.browser_session.token}`;
  const pair = async (browserCookie = cookie) => {
    const begun = await post("/v1/dsh-pairings", { device_name: "Isolated DSH" });
    assert.equal(begun.status, 201);
    const intent = (await begun.json() as { data: { pairing_id: string; poll_token: string; user_code: string } }).data;
    assert.equal((await post("/v1/dsh-pairings/approve", { user_code: intent.user_code }, browserCookie)).status, 200);
    return intent;
  };
  const poll = (intent: { pairing_id: string; poll_token: string }) => fetch(`${server.origin}/v1/dsh-pairings/${intent.pairing_id}/poll`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `DSH-Pairing ${intent.poll_token}` }, body: "{}",
  });
  const socket = (ticket: string) => {
    const value = new WebSocket(`${server.origin.replace("http", "ws")}/v1/ws`, ["gatherthread-v1", `gatherthread-ticket.${ticket}`], { origin });
    value.on("error", () => {}); sockets.push(value); return value;
  };
  return { server, registration, account, cookie, entered, release, mails, post, pair, poll, socket, notices: () => notices };
}

for (const notification of ["success", "delayed", "failure"] as const) {
  test(`service reset revokes every authorization before ${notification} notification`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t, notification);
    const project = f.server.database.createProject(f.account.actor, { title: "Retained project", idempotency_key: randomUUID() });
    const room = f.server.database.createSession(f.account.actor, { project_id: project.id, title: "Retained room", mode: "multi", idempotency_key: randomUUID() }).session;
    const projectsBefore = f.server.database.listProjects(f.account.actor.user_id);
    const native = f.server.database.createDevice(f.account.actor.user_id, "Isolated native Agent");
    const grantResponse = await f.post("/v1/device-authorizations", {}, f.cookie);
    assert.equal(grantResponse.status, 201);
    const grant = (await grantResponse.json() as { data: { authorization_token: string } }).data;
    const pendingPair = await f.pair();
    const ticket = async () => {
      const response = await f.post("/v1/realtime-ticket", { session_id: room.id }, f.cookie);
      assert.equal(response.status, 201);
      return (await response.json() as { data: { ticket: string } }).data.ticket;
    };
    const oldSocket = f.socket(await ticket());
    await new Promise<void>((resolve, reject) => { oldSocket.once("open", resolve); oldSocket.once("error", reject); });
    const close = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Old socket was not closed")), 5_000);
      oldSocket.once("close", (code, reason) => { clearTimeout(timeout); resolve({ code, reason: reason.toString() }); });
    });
    const unusedTicket = await ticket();
    const recoveryStatus = await fetch(f.server.origin + "/v1/password-reset");
    const marker = recoveryStatus.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const sentResponse = await f.post("/v1/password-reset/send", { email: "fixture@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() }, marker);
    assert.equal(sentResponse.status, 202);
    const resetId = (await sentResponse.json() as { data: { reset_id: string } }).data.reset_id;
    const input = { reset_id: resetId, email: "fixture@example.invalid", code: f.mails.at(-1)!.code,
      password: replacementPassword, password_confirmation: replacementPassword, locale: "en" };
    let completed = false;
    const reset = f.post("/v1/password-reset/verify", input, marker).then((response) => { completed = true; return response; });
    await f.entered.promise;
    if (notification === "delayed") assert.equal(completed, false);
    const deviceCount = f.server.database.sqlite.prepare("SELECT count(*) n FROM devices").get()!.n;
    assert.equal((await f.poll(pendingPair)).status, 401);
    assert.equal(f.server.database.sqlite.prepare("SELECT count(*) n FROM devices").get()!.n, deviceCount);
    assert.equal((await fetch(f.server.origin + "/v1/me", { headers: { cookie: f.cookie } })).status, 401);
    assert.equal((await fetch(f.server.origin + "/v1/me", { headers: { authorization: `Bearer ${native.token}` } })).status, 401);
    assert.equal((await f.post("/v1/device-authorizations/claim", { authorization_token: grant.authorization_token, device_name: "Late Agent" })).status, 401);
    assert.deepEqual(await close, { code: 1008, reason: "password_reset" });
    const rejected = f.socket(unusedTicket);
    const socketStatus = await new Promise<number>((resolve, reject) => {
      rejected.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
      rejected.once("open", () => resolve(101)); rejected.once("error", reject);
    });
    assert.equal(socketStatus, 401);
    assert.deepEqual(f.server.database.listProjects(f.account.actor.user_id), projectsBefore);
    assert.equal(f.server.database.canCreateProjects(f.account.actor.user_id), true);
    f.release.resolve();
    const response = await reset;
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { data: { reset: true } });
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal((await f.post("/v1/password-reset/verify", input, marker)).status, 400);
    assert.equal(f.notices(), 1); assert.equal(f.mails.length, 2);
    // A fresh password login may authorize a new DSH device, while the old pair remains unusable.
    const login = await f.post("/v1/email-login", { email: input.email, password: replacementPassword, device_name: "New browser", remember_device: false }, marker);
    assert.equal(login.status, 201);
    const newCookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const newPair = await f.pair(newCookie); const pairedResponse = await f.poll(newPair);
    assert.equal(pairedResponse.status, 201);
    const paired = (await pairedResponse.json() as { data: { token: string } }).data;
    assert.equal(f.server.database.authenticate(paired.token).user_id, f.account.actor.user_id);
    assert.equal((await f.poll(pendingPair)).status, 401); assert.equal(f.notices(), 1);
  });
}

for (const invalidation of ["revoked", "expired"] as const) {
  test(`DSH polling rechecks an approved but ${invalidation} device at issuance`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t);
    const pair = await f.pair();
    if (invalidation === "revoked") {
      const response = await fetch(`${f.server.origin}/v1/devices/${f.account.actor.device_id}`, { method: "DELETE", headers: { cookie: f.cookie, origin: f.registration.origin! } });
      assert.equal(response.status, 204);
    } else {
      f.server.database.sqlite.prepare("UPDATE devices SET expires_at=? WHERE id=?").run(new Date(0).toISOString(), f.account.actor.device_id);
    }
    const count = f.server.database.sqlite.prepare("SELECT count(*) n FROM devices").get()!.n;
    assert.equal((await f.poll(pair)).status, 401);
    assert.equal(f.server.database.sqlite.prepare("SELECT count(*) n FROM devices").get()!.n, count);
  });
}
