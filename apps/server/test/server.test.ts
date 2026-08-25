import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startCollaborationServer } from "../src/server.js";

interface IdentityResponse {
  data: { actor: { user_id: string; device_id: string }; token: string };
}

const TEST_PEPPER = "server-test-pepper-that-is-long-and-random-enough";

async function api<T>(origin: string, path: string, options: {
  method?: string;
  token?: string;
  body?: unknown;
} = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: response.status === 204 ? undefined as T : await response.json() as T };
}

function waitForSocketMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function realtimeSocket(origin: string, token: string, sessionId: string, originHeader?: string): Promise<WebSocket> {
  const ticket = await api<{ data: { ticket: string; websocket_url: string } }>(origin, "/v1/realtime-ticket", {
    method: "POST",
    token,
    body: { session_id: sessionId },
  });
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}${ticket.body.data.websocket_url}`,
    ["relayroom-v1", `relayroom-ticket.${ticket.body.data.ticket}`],
    originHeader ? { origin: originHeader } : undefined,
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

test("HTTP replay and WebSocket reconnect provide ordered multi-client updates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-http-"));
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    heartbeatIntervalMs: 100,
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
  }, 0);
  let socket: WebSocket | undefined;
  try {
    const bootstrap = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    assert.equal(bootstrap.status, 201);
    const ownerToken = bootstrap.body.data.token;
    const created = await api<{ data: { session: { id: string } } }>(running.origin, "/v1/sessions", {
      method: "POST",
      token: ownerToken,
      body: { session_id: "shared", idempotency_key: "create-shared-0001", mode: "multi", title: "Shared" },
    });
    assert.equal(created.status, 201);
    const invitation = await api<{ data: { invite_token: string } }>(running.origin, "/v1/sessions/shared/invitations", {
      method: "POST",
      token: ownerToken,
      body: { role: "participant", ttl: "1h" },
    });
    const member = await api<IdentityResponse>(running.origin, "/v1/invitations/claim", {
      method: "POST",
      body: {
        invite_token: invitation.body.data.invite_token,
        user_id: "member",
        display_name: "Member",
        device_id: "member-device",
        device_name: "Laptop",
      },
    });
    const memberToken = member.body.data.token;

    socket = await realtimeSocket(running.origin, memberToken, "shared");
    const subscribed = waitForSocketMessage(socket, (message) => message.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", session_id: "shared", after_sequence: 0 }));
    assert.equal((await subscribed).cursor, 2);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for heartbeat ping")), 1_000);
      socket?.once("ping", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const live = waitForSocketMessage(socket, (message) => message.type === "event");
    const chat = await api<{ data: { event: { id: string; sequence: number } } }>(running.origin, "/v1/sessions/shared/events", {
      method: "POST",
      token: memberToken,
      body: { idempotency_key: "member-chat-0001", type: "human_chat", payload: { text: "hello" } },
    });
    assert.equal(chat.status, 201);
    const liveMessage = await live;
    assert.equal((liveMessage.event as { sequence: number }).sequence, 3);

    const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => api<{ data: { event: { sequence: number } } }>(
      running.origin,
      "/v1/sessions/shared/events",
      {
        method: "POST",
        token: index % 2 === 0 ? ownerToken : memberToken,
        body: { idempotency_key: `concurrent-write-${index}`, type: "human_chat", payload: { index } },
      },
    )));
    assert.ok(writes.every((write) => write.status === 201));

    await new Promise<void>((resolve) => {
      socket?.once("close", () => resolve());
      socket?.close();
    });
    socket = await realtimeSocket(running.origin, memberToken, "shared");
    const reconnectReplay = waitForSocketMessage(socket, (message) => message.type === "replay");
    const reconnectSubscribed = waitForSocketMessage(socket, (message) => message.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", session_id: "shared", after_sequence: 3 }));
    const reconnectPage = await reconnectReplay;
    assert.deepEqual(
      (reconnectPage.events as { sequence: number }[]).map((event) => event.sequence),
      [4, 5, 6, 7, 8, 9, 10, 11],
    );
    assert.equal((await reconnectSubscribed).cursor, 11);
    await new Promise<void>((resolve) => {
      socket?.once("close", () => resolve());
      socket?.close();
    });
    socket = undefined;
    const replay = await api<{ data: { events: { sequence: number }[]; cursor: number; has_more: boolean } }>(
      running.origin,
      "/v1/sessions/shared/events?after_sequence=3&limit=100",
      { token: memberToken },
    );
    assert.deepEqual(replay.body.data.events.map((event) => event.sequence), [4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(replay.body.data.cursor, 11);

    const repeated = await api<{ data: { event: { id: string; sequence: number } } }>(running.origin, "/v1/sessions/shared/events", {
      method: "POST",
      token: memberToken,
      body: { idempotency_key: "member-chat-0001", type: "human_chat", payload: { text: "hello" } },
    });
    assert.equal(repeated.body.data.event.id, chat.body.data.event.id);
    assert.equal(repeated.body.data.event.sequence, 3);
    const mismatchedRetry = await api<{ error: { code: string } }>(running.origin, "/v1/sessions/shared/events", {
      method: "POST",
      token: memberToken,
      body: { idempotency_key: "member-chat-0001", type: "human_chat", payload: { text: "retry changed" } },
    });
    assert.equal(mismatchedRetry.status, 409);
    assert.equal(mismatchedRetry.body.error.code, "idempotency_conflict");
  } finally {
    socket?.terminate();
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("token auth and solo viewer ACL are enforced over HTTP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-acl-"));
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
  }, 0);
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    await api(running.origin, "/v1/sessions", {
      method: "POST",
      token: owner.body.data.token,
      body: { session_id: "solo", idempotency_key: "create-solo-http-1", mode: "solo", title: "Solo" },
    });
    const invalidParticipantInvitation = await api<{ error: { code: string } }>(running.origin, "/v1/sessions/solo/invitations", {
      method: "POST",
      token: owner.body.data.token,
      body: { role: "participant", ttl: "1h" },
    });
    assert.equal(invalidParticipantInvitation.status, 403);
    const invitation = await api<{ data: { invite_token: string } }>(running.origin, "/v1/sessions/solo/invitations", {
      method: "POST",
      token: owner.body.data.token,
      body: { role: "viewer", ttl: "24h" },
    });
    const viewer = await api<IdentityResponse>(running.origin, "/v1/invitations/claim", {
      method: "POST",
      body: {
        invite_token: invitation.body.data.invite_token,
        user_id: "viewer",
        display_name: "Viewer",
        device_id: "viewer-device",
        device_name: "Phone",
      },
    });
    await api(running.origin, "/v1/sessions", {
      method: "POST",
      token: owner.body.data.token,
      body: { session_id: "private", idempotency_key: "create-private-1", mode: "multi", title: "Private" },
    });
    const viewerSessions = await api<{ data: { sessions: Array<{ id: string; role: string; mode: string; current_sequence: number }> } }>(
      running.origin,
      "/v1/sessions",
      { token: viewer.body.data.token },
    );
    assert.equal(viewerSessions.body.data.sessions.length, 1);
    assert.deepEqual({
      id: viewerSessions.body.data.sessions[0]?.id,
      mode: viewerSessions.body.data.sessions[0]?.mode,
      role: viewerSessions.body.data.sessions[0]?.role,
      current_sequence: viewerSessions.body.data.sessions[0]?.current_sequence,
    }, {
      id: "solo",
      mode: "solo",
      role: "viewer",
      current_sequence: 2,
    });
    const ownerSessions = await api<{ data: { sessions: Array<{ id: string }> } }>(
      running.origin,
      "/v1/sessions",
      { token: owner.body.data.token },
    );
    assert.deepEqual(new Set(ownerSessions.body.data.sessions.map((session) => session.id)), new Set(["solo", "private"]));
    const denied = await api<{ error: { code: string } }>(running.origin, "/v1/sessions/solo/events", {
      method: "POST",
      token: viewer.body.data.token,
      body: { idempotency_key: "viewer-write-http-1", type: "human_chat", payload: { text: "no" } },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "forbidden");
    const readable = await api<{ data: { events: unknown[] } }>(running.origin, "/v1/sessions/solo/events", {
      token: viewer.body.data.token,
    });
    assert.equal(readable.status, 200);
    assert.equal(readable.body.data.events.length, 2);
    assert.equal((await api(running.origin, "/v1/sessions/solo/events?limit=0", {
      token: viewer.body.data.token,
    })).status, 400);
    assert.equal((await api(running.origin, "/v1/sessions/solo/events")).status, 401);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("browser integration exposes identity, members, CORS, and one-use scoped realtime tickets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-browser-"));
  const browserOrigin = "http://127.0.0.1:4173";
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    allowedOrigins: [browserOrigin],
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
  }, 0);
  let socket: WebSocket | undefined;
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    const token = owner.body.data.token;
    await api(running.origin, "/v1/sessions", {
      method: "POST",
      token,
      body: { session_id: "browser-room", idempotency_key: "create-browser-room", mode: "multi", title: "Browser room" },
    });
    await api(running.origin, "/v1/runtimes", {
      method: "POST",
      token,
      body: {
        runtime_id: "owner-runtime",
        session_id: "browser-room",
        device_id: "owner-device",
        harness: "Codex",
        provider: "OpenAI",
        model: "gpt-5.6-sol",
        local_session_id: "local-browser-room",
        capture_fidelity: "harness_transcript",
      },
    });

    const me = await api<{ data: { id: string; username: string; device_id: string } }>(
      running.origin,
      "/v1/me",
      { token },
    );
    assert.deepEqual(me.body.data, { id: "owner", username: "Owner", device_id: "owner-device" });

    const members = await api<{ data: { members: Array<{ user_id: string; display_name: string; role: string; runtime: { model: string } | null }> } }>(
      running.origin,
      "/v1/sessions/browser-room/members",
      { token },
    );
    assert.equal(members.body.data.members[0]?.display_name, "Owner");
    assert.equal(members.body.data.members[0]?.runtime?.model, "gpt-5.6-sol");

    const preflight = await fetch(`${running.origin}/v1/me`, {
      method: "OPTIONS",
      headers: { origin: browserOrigin, "access-control-request-headers": "authorization" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), browserOrigin);

    const ticketResponse = await api<{ data: { ticket: string; websocket_url: string } }>(
      running.origin,
      "/v1/realtime-ticket",
      { method: "POST", token, body: { session_id: "browser-room" } },
    );
    const ticket = ticketResponse.body.data.ticket;
    socket = new WebSocket(
      `${running.origin.replace("http", "ws")}${ticketResponse.body.data.websocket_url}`,
      ["relayroom-v1", `relayroom-ticket.${ticket}`],
      { origin: browserOrigin },
    );
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", resolve);
      socket?.once("error", reject);
    });
    const subscribed = waitForSocketMessage(socket, (message) => message.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", session_id: "browser-room", after_sequence: 0 }));
    assert.equal((await subscribed).session_id, "browser-room");
    socket.close();
    socket = undefined;

    const reused = new WebSocket(
      `${running.origin.replace("http", "ws")}/v1/ws`,
      ["relayroom-v1", `relayroom-ticket.${ticket}`],
      { origin: browserOrigin },
    );
    reused.on("error", () => {});
    const status = await new Promise<number>((resolve) => {
      reused.once("unexpected-response", (_request, response) => {
        const statusCode = response.statusCode ?? 0;
        response.resume();
        resolve(statusCode);
      });
      reused.once("open", () => resolve(101));
    });
    assert.equal(status, 401);
  } finally {
    socket?.terminate();
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("network bootstrap, URL credentials, direct bearer sockets, and unapproved origins fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-boundary-"));
  const allowedOrigin = "https://relayroom.example.ts.net";
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    allowedOrigins: [allowedOrigin],
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: false,
    secureTransport: true,
  }, 0);
  try {
    const owner = running.database.bootstrapIdentity({
      user_id: "owner",
      display_name: "Owner",
      device_id: "owner-device",
      device_name: "Laptop",
    });
    const bootstrap = await api<{ error: { code: string } }>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { display_name: "Attacker", device_name: "Browser" },
    });
    assert.equal(bootstrap.status, 401);
    assert.equal(bootstrap.body.error.code, "unauthorized");

    const queryCredential = await api<{ error: { code: string } }>(
      running.origin,
      `/v1/me?access_token=${encodeURIComponent(owner.token)}`,
    );
    assert.equal(queryCredential.status, 401);
    assert.equal(queryCredential.body.error.code, "unauthorized");

    const removedIdentityMint = await api<{ error: { code: string } }>(running.origin, "/v1/users", {
      method: "POST",
      token: owner.token,
      body: { display_name: "Forged", device_name: "Forged" },
    });
    assert.equal(removedIdentityMint.status, 404);

    const health = await fetch(`${running.origin}/health`);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.match(health.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(health.headers.get("strict-transport-security") ?? "", /max-age=/);

    const directBearer = new WebSocket(`${running.origin.replace("http", "ws")}/v1/ws`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    directBearer.on("error", () => {});
    const directStatus = await new Promise<number>((resolve) => {
      directBearer.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      directBearer.once("open", () => resolve(101));
    });
    assert.equal(directStatus, 401);

    await api(running.origin, "/v1/sessions", {
      method: "POST",
      token: owner.token,
      body: { session_id: "room", idempotency_key: "create-boundary-room", mode: "multi", title: "Room" },
    });
    const ticket = await api<{ data: { ticket: string; websocket_url: string } }>(running.origin, "/v1/realtime-ticket", {
      method: "POST",
      token: owner.token,
      body: { session_id: "room" },
    });
    const wrongOrigin = new WebSocket(
      `${running.origin.replace("http", "ws")}${ticket.body.data.websocket_url}`,
      ["relayroom-v1", `relayroom-ticket.${ticket.body.data.ticket}`],
      { origin: "https://attacker.invalid" },
    );
    wrongOrigin.on("error", () => {});
    const wrongOriginStatus = await new Promise<number>((resolve) => {
      wrongOrigin.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      wrongOrigin.once("open", () => resolve(101));
    });
    assert.equal(wrongOriginStatus, 401);

    const missingOrigin = new WebSocket(
      `${running.origin.replace("http", "ws")}${ticket.body.data.websocket_url}`,
      ["relayroom-v1", `relayroom-ticket.${ticket.body.data.ticket}`],
    );
    missingOrigin.on("error", () => {});
    const missingOriginStatus = await new Promise<number>((resolve) => {
      missingOrigin.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      missingOrigin.once("open", () => resolve(101));
    });
    assert.equal(missingOriginStatus, 401);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner host serves only the configured static tree without authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-static-"));
  const staticDirectory = join(directory, "public");
  mkdirSync(join(staticDirectory, "assets"), { recursive: true });
  writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>Relayroom</title>");
  writeFileSync(join(staticDirectory, "assets", "app.js"), "export const ready = true;\n");
  writeFileSync(join(directory, "private.txt"), "must not leak");
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    authTokenPepper: TEST_PEPPER,
    staticDirectory,
  }, 0);
  try {
    const index = await fetch(`${running.origin}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await index.text(), /Relayroom/);

    const asset = await fetch(`${running.origin}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");

    const traversal = await fetch(`${running.origin}/..%2Fprivate.txt`);
    assert.notEqual(traversal.status, 200);
    assert.doesNotMatch(await traversal.text(), /must not leak/);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revoking a device closes its realtime socket and invalidates delegated authorizations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-revoke-"));
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
  }, 0);
  let socket: WebSocket | undefined;
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    await api(running.origin, "/v1/sessions", {
      method: "POST",
      token: owner.body.data.token,
      body: { session_id: "revocation-room", idempotency_key: "create-revocation-room", mode: "multi", title: "Revocation" },
    });
    const delegated = await api<{ data: { authorization_token: string } }>(running.origin, "/v1/device-authorizations", {
      method: "POST",
      token: owner.body.data.token,
    });
    socket = await realtimeSocket(running.origin, owner.body.data.token, "revocation-room");
    const subscribed = waitForSocketMessage(socket, (message) => message.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", session_id: "revocation-room", after_sequence: 0 }));
    await subscribed;
    const closed = new Promise<number>((resolve) => socket?.once("close", resolve));
    const revoked = await api(running.origin, "/v1/devices/owner-device", {
      method: "DELETE",
      token: owner.body.data.token,
    });
    assert.equal(revoked.status, 204);
    assert.equal(await closed, 1008);
    socket = undefined;
    const recovered = await api<{ error: { code: string } }>(running.origin, "/v1/device-authorizations/claim", {
      method: "POST",
      body: { authorization_token: delegated.body.data.authorization_token, device_name: "Unexpected recovery" },
    });
    assert.equal(recovered.status, 401);
    assert.equal(recovered.body.error.code, "unauthorized");
  } finally {
    socket?.terminate();
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
