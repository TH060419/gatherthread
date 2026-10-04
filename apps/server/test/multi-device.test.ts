import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { startCollaborationServer } from "../src/server.js";
import type { RegistrationOptions } from "../src/registration.js";

test("one email account stays live on three browsers; logout and revocation are device-scoped", async () => {
  const allowedOrigin = "https://multi-device.invalid", password = "isolated multi device password 57";
  const mails: Array<{ code: string }> = [];
  const registration: RegistrationOptions = { enabled: true, origin: allowedOrigin, siteKey: "fixture",
    challenge: { async verify() { return true; } }, mailer: { async send(mail) { mails.push(mail); } } };
  const server = await startCollaborationServer({ databasePath: ":memory:",
    authTokenPepper: "multi-device-isolated-fixture-pepper-over-32-bytes", allowedOrigins: [allowedOrigin],
    publicBaseUrl: allowedOrigin, secureTransport: true, registration, heartbeatIntervalMs: 50 });
  const sockets: WebSocket[] = [];
  const request = (path: string, cookie: string, method = "GET", body?: unknown) => fetch(server.origin + path, {
    method, headers: { cookie, origin: allowedOrigin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookieOf = (response: Response) => response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const message = (socket: WebSocket, kind: string) => new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error(`No ${kind} message`)); }, 3000);
    const listen = (raw: WebSocket.RawData) => { const data = JSON.parse(raw.toString()); if (data.type === kind) { cleanup(); resolve(data); } };
    const cleanup = () => { clearTimeout(timer); socket.off("message", listen); };
    socket.on("message", listen);
  });
  try {
    const initial = await request("/v1/registration", "");
    const browser1 = cookieOf(initial);
    const send = await request("/v1/registration/send", browser1, "POST", { email: "multi@example.invalid", locale: "en", challenge_token: randomUUID(), idempotency_key: randomUUID() });
    assert.equal(send.status, 202);
    const registrationId = (await send.json() as any).data.registration_id;
    const enrolled = await request("/v1/registration/verify", browser1, "POST", { registration_id: registrationId, code: mails[0]!.code,
      display_name: "One account", device_name: "Computer", remember_device: true, password, privacy_acknowledged: true });
    assert.equal(enrolled.status, 201);
    const account = (await enrolled.json() as any).data.actor;
    const computer = cookieOf(enrolled);
    const login = async (name: string, marker?: string) => {
      const browser = marker ?? cookieOf(await request("/v1/email-login", ""));
      const response = await request("/v1/email-login", browser, "POST", { email: "multi@example.invalid", password, device_name: name, remember_device: false });
      assert.equal(response.status, 201);
      const body = await response.json() as any;
      assert.equal(body.data.actor.user_id, account.user_id);
      assert.equal(JSON.stringify(body).includes("token"), false);
      return { browser, cookie: cookieOf(response), actor: body.data.actor };
    };
    const phone = await login("Phone"), tablet = await login("Tablet");
    assert.equal(new Set([account.device_id, phone.actor.device_id, tablet.actor.device_id]).size, 3);
    const project = await request("/v1/projects", computer, "POST", { title: "Shared across devices", idempotency_key: randomUUID() });
    assert.equal(project.status, 201);
    const projectId = (await project.json() as any).data.project.id;
    const created = await request(`/v1/projects/${projectId}/sessions`, computer, "POST", { title: "Multi", mode: "multi", idempotency_key: randomUUID() });
    assert.equal(created.status, 201);
    const sessionId = (await created.json() as any).data.session.id;
    const cookies = [computer, phone.cookie, tablet.cookie];
    for (const cookie of cookies) {
      assert.equal((await request("/v1/me", cookie)).status, 200);
      assert.equal((await request(`/v1/projects/${projectId}`, cookie)).status, 200);
      const ticketResponse = await request("/v1/realtime-ticket", cookie, "POST", { session_id: sessionId });
      assert.equal(ticketResponse.status, 201);
      const ticket = (await ticketResponse.json() as any).data.ticket;
      const socket = new WebSocket(server.origin.replace("http:", "ws:") + "/v1/ws", ["gatherthread-v1", `gatherthread-ticket.${ticket}`], { origin: allowedOrigin });
      sockets.push(socket); await once(socket, "open");
      const subscribed = message(socket, "subscribed");
      socket.send(JSON.stringify({ type: "subscribe", session_id: sessionId, after_sequence: 0 }));
      await subscribed;
    }
    // Both device-origin attribution and canonical account identity must be preserved.
    for (const [index, cookie] of cookies.entries()) {
      const received = sockets.map(socket => message(socket, "event"));
      const sent = await request(`/v1/sessions/${sessionId}/events`, cookie, "POST", {
        type: "human_chat", idempotency_key: randomUUID(), payload: { content: `Device ${index}` },
      });
      assert.equal(sent.status, 201);
      const deliveries = await Promise.all(received);
      for (const delivery of deliveries) { assert.equal(delivery.event.actor_user_id, account.user_id); assert.equal(delivery.event.payload.content, `Device ${index}`); }
    }
    const rotated = await login("Phone", phone.browser);
    assert.equal(rotated.actor.device_id, phone.actor.device_id);
    assert.equal((await request("/v1/me", phone.cookie)).status, 401);
    assert.equal((await request("/v1/me", computer)).status, 200);
    assert.equal((await request("/v1/me", tablet.cookie)).status, 200);
    const grantResponse = await request("/v1/device-authorizations", computer, "POST");
    const grant = (await grantResponse.json() as any).data.authorization_token;
    const claimed = await fetch(server.origin + "/v1/device-authorizations/claim", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorization_token: grant, device_name: "Computer Agent" }) });
    assert.equal(claimed.status, 201);
    const native = (await claimed.json() as any).data;
    const dsh = server.database.createDevice(account.user_id, "Computer DSH");
    const nativeRequest = (token: string, path: string, body: unknown) => fetch(server.origin + path, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const agents = [
      { token: native.token, deviceId: native.actor.device_id, harness: "codex", runtimeId: "multi-device-codex" },
      { token: dsh.token, deviceId: dsh.device_id, harness: "deepseek-harness", runtimeId: "multi-device-dsh" },
    ];
    for (const agent of agents) {
      const registered = await nativeRequest(agent.token, "/v1/runtimes", { runtime_id: agent.runtimeId,
        session_id: sessionId, device_id: agent.deviceId, purpose: "execution", harness: agent.harness,
        provider: "local", model: "fixture", local_session_id: randomUUID(), capture_fidelity: "canonical_history" });
      assert.equal(registered.status, 201);
    }
    assert.equal((await request("/v1/browser-sessions/current", computer, "DELETE")).status, 204);
    assert.equal((await request("/v1/me", computer)).status, 401);
    assert.equal((await request("/v1/me", rotated.cookie)).status, 200);
    assert.equal((await request("/v1/me", tablet.cookie)).status, 200);
    assert.equal((await fetch(server.origin + "/v1/me", { headers: { authorization: `Bearer ${native.token}` } })).status, 200, "browser logout does not revoke independently authorized Agent");
    // A phone requests an exact same-account computer Agent without sharing its credential.
    for (const [index, agent] of agents.entries()) {
      const profile = { runtime_id: agent.runtimeId, harness: agent.harness, provider: "local", model: "fixture" };
      const requested = await request(`/v1/sessions/${sessionId}/events`, rotated.cookie, "POST", {
        type: "agent_request", idempotency_key: randomUUID(), payload: { content: "Phone requests computer", execution_profile: profile },
      });
      assert.equal(requested.status, 201);
      const requestId = (await requested.json() as any).data.event.id;
      const path = `/v1/sessions/${sessionId}/agent-requests/${requestId}`;
      const other = agents[1 - index]!;
      assert.equal((await nativeRequest(other.token, `${path}/claim`, { runtime_id: other.runtimeId })).status, 409,
        "an unselected device cannot claim a same-account request");
      assert.equal((await nativeRequest(agent.token, `${path}/claim`, { runtime_id: agent.runtimeId })).status, 200);
      assert.equal((await nativeRequest(agent.token, `${path}/complete`, { runtime_id: agent.runtimeId,
        idempotency_key: randomUUID(), payload: { content: "Computer replies to phone" } })).status, 201);
    }
    const tabletClosed = once(sockets[2]!, "close");
    assert.equal((await request(`/v1/devices/${tablet.actor.device_id}`, rotated.cookie, "DELETE")).status, 204);
    await tabletClosed;
    assert.equal((await request("/v1/me", tablet.cookie)).status, 401);
    assert.equal((await request("/v1/me", rotated.cookie)).status, 200);
    const stranger = server.database.createIdentity({ display_name: "Stranger", device_name: "Other" });
    assert.equal((await request(`/v1/devices/${stranger.actor.device_id}`, rotated.cookie, "DELETE")).status, 404);
    assert.equal(server.database.authenticate(stranger.token).user_id, stranger.actor.user_id);
    const devices = (await (await request("/v1/devices", rotated.cookie)).json() as any).data.devices;
    assert.ok(devices.every((device: any) => device.user_id === account.user_id));
    assert.equal((await request(`/v1/devices/${native.actor.device_id}`, rotated.cookie, "DELETE")).status, 204);
    assert.equal((await fetch(server.origin + "/v1/me", { headers: { authorization: `Bearer ${native.token}` } })).status, 401);
    assert.equal((await request("/v1/me", rotated.cookie)).status, 200);
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
  }
});
