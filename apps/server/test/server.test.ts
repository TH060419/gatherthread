import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
  cookie?: string;
  origin?: string;
  headers?: Record<string, string>;
  body?: unknown;
} = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? undefined as T : await response.json() as T,
    headers: response.headers,
  };
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
    ["gatherthread-v1", `gatherthread-ticket.${ticket.body.data.ticket}`],
    originHeader ? { origin: originHeader } : undefined,
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

test("HTTP replay and WebSocket reconnect provide ordered multi-client updates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-http-"));
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

test("owner session rename validates input and reaches another client as metadata-only control", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-rename-"));
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
  }, 0);
  let socket: WebSocket | undefined;
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "rename-owner", display_name: "Owner", device_id: "rename-owner-device", device_name: "Laptop" },
    });
    await api(running.origin, "/v1/projects", {
      method: "POST", token: owner.body.data.token,
      body: { project_id: "rename-project", idempotency_key: "rename-project-create", title: "Rename" },
    });
    await api(running.origin, "/v1/projects/rename-project/sessions", {
      method: "POST", token: owner.body.data.token,
      body: { session_id: "rename-room", idempotency_key: "rename-room-create", mode: "multi", title: "Before" },
    });
    const invitation = await api<{ data: { invite_token: string } }>(running.origin, "/v1/projects/rename-project/invitations", {
      method: "POST", token: owner.body.data.token, body: { role: "participant", ttl: "1h" },
    });
    const member = await api<IdentityResponse>(running.origin, "/v1/invitations/claim", {
      method: "POST",
      body: { invite_token: invitation.body.data.invite_token, user_id: "rename-member", display_name: "Member", device_id: "rename-member-device", device_name: "Phone" },
    });
    socket = await realtimeSocket(running.origin, member.body.data.token, "rename-room");
    const subscribed = waitForSocketMessage(socket, (message) => message.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", session_id: "rename-room", after_sequence: 0 }));
    await subscribed;
    const delivered = waitForSocketMessage(socket, (message) => message.type === "event");
    const renamed = await api<{ data: { session: { title: string }; event: { payload: unknown } } }>(running.origin, "/v1/sessions/rename-room", {
      method: "PATCH", token: owner.body.data.token,
      body: { title: "After 🚀", idempotency_key: "rename-room-title-0001" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.session.title, "After 🚀");
    assert.deepEqual(renamed.body.data.event.payload, { action: "renamed", title: "After 🚀" });
    const message = await delivered;
    assert.deepEqual((message.event as { payload: unknown }).payload, { action: "renamed", title: "After 🚀" });
    assert.equal(JSON.stringify(message).includes("Before"), false);

    assert.equal((await api(running.origin, "/v1/sessions/rename-room", {
      method: "PATCH", token: member.body.data.token,
      body: { title: "Denied", idempotency_key: "rename-room-denied" },
    })).status, 403);
    assert.equal((await api(running.origin, "/v1/sessions/rename-room", {
      method: "PATCH", token: owner.body.data.token,
      body: { title: "   ", idempotency_key: "rename-room-invalid" },
    })).status, 422);
    for (const [index, title] of ["line\nbreak", "nul\u0000byte", "c1\u0085control"].entries()) {
      assert.equal((await api(running.origin, "/v1/sessions/rename-room", {
        method: "PATCH", token: owner.body.data.token,
        body: { title, idempotency_key: `rename-room-control-${index}` },
      })).status, 422);
      assert.equal((await api(running.origin, "/v1/projects", {
        method: "POST", token: owner.body.data.token,
        body: { title, idempotency_key: `control-project-${index}` },
      })).status, 422);
      assert.equal((await api(running.origin, "/v1/projects/rename-project/sessions", {
        method: "POST", token: owner.body.data.token,
        body: { title, mode: "multi", idempotency_key: `control-session-${index}` },
      })).status, 422);
    }
  } finally {
    socket?.terminate();
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project invitations grant current and future sessions while viewer ACL stays read only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-acl-"));
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
    const createdProject = await api<{ data: { project: { id: string; role: string; session_count: number } } }>(running.origin, "/v1/projects", {
      method: "POST",
      token: owner.body.data.token,
      body: { project_id: "acl-project", idempotency_key: "create-acl-project", title: "ACL project" },
    });
    assert.equal(createdProject.status, 201);
    assert.equal(createdProject.body.data.project.role, "owner");
    assert.equal(createdProject.body.data.project.session_count, 0);
    const projectList = await api<{ data: { projects: Array<{ id: string; session_count: number }> } }>(
      running.origin, "/v1/projects", { token: owner.body.data.token },
    );
    assert.equal(projectList.body.data.projects.find((project) => project.id === "acl-project")?.session_count, 0);
    const initialSessions = await api<{ data: { sessions: Array<{ id: string; title: string; mode: string }> } }>(
      running.origin, "/v1/projects/acl-project/sessions", { token: owner.body.data.token },
    );
    assert.deepEqual(initialSessions.body.data.sessions, []);
    await api(running.origin, "/v1/projects/acl-project/sessions", {
      method: "POST",
      token: owner.body.data.token,
      body: { session_id: "solo", idempotency_key: "create-solo-http-1", mode: "solo", title: "Solo" },
    });
    const invitation = await api<{ data: { invite_token: string } }>(running.origin, "/v1/projects/acl-project/invitations", {
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
    await api(running.origin, "/v1/projects/acl-project/sessions", {
      method: "POST",
      token: owner.body.data.token,
      body: { session_id: "private", idempotency_key: "create-private-1", mode: "multi", title: "Private" },
    });
    const viewerSessions = await api<{ data: { sessions: Array<{ id: string; role: string; mode: string; current_sequence: number }> } }>(
      running.origin,
      "/v1/sessions",
      { token: viewer.body.data.token },
    );
    assert.equal(viewerSessions.body.data.sessions.length, 2);
    assert.deepEqual(
      new Set(viewerSessions.body.data.sessions.map((session) => session.id)),
      new Set(["solo", "private"]),
    );
    assert.ok(viewerSessions.body.data.sessions.every((session) => session.role === "viewer"));
    const ownerSessions = await api<{ data: { sessions: Array<{ id: string }> } }>(
      running.origin,
      "/v1/sessions",
      { token: owner.body.data.token },
    );
    assert.deepEqual(
      new Set(ownerSessions.body.data.sessions.map((session) => session.id)),
      new Set(["solo", "private"]),
    );
    const denied = await api<{ error: { code: string } }>(running.origin, "/v1/sessions/solo/events", {
      method: "POST",
      token: viewer.body.data.token,
      body: { idempotency_key: "viewer-write-http-1", type: "human_chat", payload: { text: "no" } },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "forbidden");
    const promoted = await api<{ data: { member: { role: string } } }>(
      running.origin,
      "/v1/projects/acl-project/members/viewer",
      {
        method: "PUT",
        token: owner.body.data.token,
        body: { role: "participant", idempotency_key: "promote-viewer-http" },
      },
    );
    assert.equal(promoted.body.data.member.role, "participant");
    assert.equal((await api(running.origin, "/v1/sessions/private/events", {
      method: "POST",
      token: viewer.body.data.token,
      body: { idempotency_key: "participant-multi-write", type: "human_chat", payload: { text: "yes" } },
    })).status, 201);
    assert.equal((await api(running.origin, "/v1/sessions/solo/events", {
      method: "POST",
      token: viewer.body.data.token,
      body: { idempotency_key: "participant-solo-write", type: "human_chat", payload: { text: "no" } },
    })).status, 403);
    const readable = await api<{ data: { events: unknown[] } }>(running.origin, "/v1/sessions/solo/events", {
      token: viewer.body.data.token,
    });
    assert.equal(readable.status, 200);
    assert.equal(readable.body.data.events.length, 1);
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
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-browser-"));
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
      ["gatherthread-v1", `gatherthread-ticket.${ticket}`],
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
      ["gatherthread-v1", `gatherthread-ticket.${ticket}`],
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

test("browser sessions survive refresh, reject CSRF writes, and revoke on logout or device revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-browser-session-"));
  const browserOrigin = "http://127.0.0.1:8787";
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    allowedOrigins: [browserOrigin],
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
  }, 0);
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    const opened = await api<{ data: { actor: { id: string }; expires_at: string } }>(
      running.origin,
      "/v1/browser-sessions",
      { method: "POST", token: owner.body.data.token, origin: browserOrigin },
    );
    assert.equal(opened.status, 201);
    assert.equal(opened.body.data.actor.id, "owner");
    const setCookie = opened.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^gatherthread_session=gtb_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    assert.doesNotMatch(setCookie, /Secure|Max-Age|Expires/i);
    assert.equal(JSON.stringify(opened.body).includes(owner.body.data.token), false);
    assert.equal(opened.headers.get("access-control-allow-credentials"), "true");
    const cookie = setCookie.split(";", 1)[0] ?? "";

    const restored = await api<{ data: { id: string; username: string; device_id: string } }>(
      running.origin,
      "/v1/me",
      { cookie },
    );
    assert.deepEqual(restored.body.data, { id: "owner", username: "Owner", device_id: "owner-device" });

    const csrfDenied = await api<{ error: { code: string } }>(running.origin, "/v1/sessions", {
      method: "POST",
      cookie,
      body: { session_id: "csrf-room", idempotency_key: "create-csrf-room", mode: "multi", title: "Denied" },
    });
    assert.equal(csrfDenied.status, 403);
    assert.equal(csrfDenied.body.error.code, "csrf_origin_required");
    const wrongOrigin = await api<{ error: { code: string } }>(running.origin, "/v1/sessions", {
      method: "POST",
      cookie,
      origin: "https://attacker.invalid",
      body: { session_id: "wrong-origin", idempotency_key: "create-wrong-origin", mode: "multi", title: "Denied" },
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.body.error.code, "origin_forbidden");
    const allowedWrite = await api<{ data: { session: { id: string } } }>(running.origin, "/v1/sessions", {
      method: "POST",
      cookie,
      origin: browserOrigin,
      body: { session_id: "cookie-room", idempotency_key: "create-cookie-room", mode: "multi", title: "Allowed" },
    });
    assert.equal(allowedWrite.status, 201);

    const invitation = await api<{ data: { invite_token: string } }>(running.origin, "/v1/sessions/cookie-room/invitations", {
      method: "POST",
      cookie,
      origin: browserOrigin,
      body: { role: "participant", ttl: "1h" },
    });
    const claimed = await api<IdentityResponse>(running.origin, "/v1/invitations/claim", {
      method: "POST",
      origin: browserOrigin,
      headers: { "x-gatherthread-browser-session": "1" },
      body: {
        invite_token: invitation.body.data.invite_token,
        user_id: "member",
        display_name: "Member",
        device_id: "member-device",
        device_name: "Browser",
      },
    });
    assert.match(claimed.body.data.token, /^gta_/);
    const memberSetCookie = claimed.headers.get("set-cookie") ?? "";
    assert.match(memberSetCookie, /^gatherthread_session=gtb_/);
    assert.equal(JSON.stringify(claimed.body).includes(memberSetCookie.split("=", 2)[1]?.split(";", 1)[0] ?? ""), false);
    const memberCookie = memberSetCookie.split(";", 1)[0] ?? "";
    assert.equal((await api<{ data: { id: string } }>(running.origin, "/v1/me", { cookie: memberCookie })).body.data.id, "member");

    const logout = await api(running.origin, "/v1/browser-sessions/current", {
      method: "DELETE",
      cookie,
      origin: browserOrigin,
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /^gatherthread_session=;.*HttpOnly;.*SameSite=Strict;.*Max-Age=0;/);
    assert.equal((await api(running.origin, "/v1/me", { cookie })).status, 401);

    const reopened = await api(running.origin, "/v1/browser-sessions", {
      method: "POST",
      token: owner.body.data.token,
      origin: browserOrigin,
    });
    const reopenedCookie = (reopened.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const revoked = await api(running.origin, "/v1/devices/owner-device", {
      method: "DELETE",
      token: owner.body.data.token,
    });
    assert.equal(revoked.status, 204);
    assert.equal((await api(running.origin, "/v1/me", { cookie: reopenedCookie })).status, 401);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("blocked snapshot mutation revalidates browser session after logout before committing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-browser-session-race-"));
  const browserOrigin = "http://127.0.0.1:8787";
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    allowedOrigins: [browserOrigin],
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
      body: { session_id: "race-room", idempotency_key: "race-room-create", mode: "multi", title: "Race" },
    });
    const opened = await api(running.origin, "/v1/browser-sessions", {
      method: "POST",
      token: owner.body.data.token,
      origin: browserOrigin,
    });
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const browserSession = running.database.sqlite.prepare("SELECT id, last_used_at FROM browser_sessions LIMIT 1")
      .get() as { id: string; last_used_at: string | null };
    assert.equal(browserSession.last_used_at, null);

    let blockedRequest!: ReturnType<typeof httpRequest>;
    const blockedResponse = new Promise<{ status: number; body: { error?: { code?: string } } }>((resolve, reject) => {
      blockedRequest = httpRequest(`${running.origin}/v1/sessions/race-room/snapshot-requests`, {
        method: "POST",
        headers: {
          cookie,
          origin: browserOrigin,
          "content-type": "application/json",
          "content-length": "2",
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: string } },
        }));
      });
      blockedRequest.on("error", reject);
      blockedRequest.write("{");
    });

    let bodyReadStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = running.database.sqlite.prepare("SELECT last_used_at FROM browser_sessions WHERE id = ?")
        .get(browserSession.id) as { last_used_at: string | null };
      if (row.last_used_at !== null) {
        bodyReadStarted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(bodyReadStarted, true);
    assert.equal((await api(running.origin, "/v1/browser-sessions/current", {
      method: "DELETE",
      cookie,
      origin: browserOrigin,
    })).status, 204);
    blockedRequest.end("}");
    const rejected = await blockedResponse;
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error?.code, "unauthorized");
    assert.equal((running.database.sqlite.prepare("SELECT count(*) AS count FROM snapshot_requests")
      .get() as { count: number }).count, 0);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("secure owner hosts issue __Host- browser session cookies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-secure-cookie-"));
  const browserOrigin = "https://gatherthread.example.ts.net";
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    allowedOrigins: [browserOrigin],
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
    secureTransport: true,
  }, 0);
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    const opened = await api(running.origin, "/v1/browser-sessions", {
      method: "POST",
      token: owner.body.data.token,
      origin: browserOrigin,
    });
    const setCookie = opened.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^__Host-gatherthread_session=gtb_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
    assert.doesNotMatch(setCookie, /Domain=/i);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("network bootstrap, URL credentials, direct bearer sockets, and unapproved origins fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-boundary-"));
  const allowedOrigin = "https://gatherthread.example.ts.net";
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
      ["gatherthread-v1", `gatherthread-ticket.${ticket.body.data.ticket}`],
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
      ["gatherthread-v1", `gatherthread-ticket.${ticket.body.data.ticket}`],
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

    const legacyTicket = await api<{ data: { ticket: string; websocket_url: string } }>(running.origin, "/v1/realtime-ticket", {
      method: "POST",
      token: owner.token,
      body: { session_id: "room" },
    });
    const legacyProtocol = new WebSocket(
      `${running.origin.replace("http", "ws")}${legacyTicket.body.data.websocket_url}`,
      ["relayroom-v1", `gatherthread-ticket.${legacyTicket.body.data.ticket}`],
      { origin: allowedOrigin },
    );
    legacyProtocol.on("error", () => {});
    const legacyProtocolStatus = await new Promise<number>((resolve) => {
      legacyProtocol.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      legacyProtocol.once("open", () => resolve(101));
    });
    assert.equal(legacyProtocolStatus, 401);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner host serves only the configured static tree without authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-static-"));
  const staticDirectory = join(directory, "public");
  mkdirSync(join(staticDirectory, "assets"), { recursive: true });
  writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>GatherThread</title>");
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
    assert.equal(index.headers.get("cache-control"), "no-store");
    assert.match(await index.text(), /GatherThread/);

    const asset = await fetch(`${running.origin}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(asset.headers.get("cache-control"), "no-cache");

    const traversal = await fetch(`${running.origin}/..%2Fprivate.txt`);
    assert.notEqual(traversal.status, 200);
    assert.doesNotMatch(await traversal.text(), /must not leak/);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revoking a device closes its realtime socket and invalidates delegated authorizations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-revoke-"));
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

test("project membership removal closes realtime immediately without leaking a cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-membership-revoke-"));
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"),
    heartbeatIntervalMs: 50,
    authTokenPepper: TEST_PEPPER,
    allowHttpBootstrap: true,
  }, 0);
  let socket: WebSocket | undefined;
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    const created = await api<{ data: { session: { id: string; project_id: string } } }>(running.origin, "/v1/sessions", {
      method: "POST",
      token: owner.body.data.token,
      body: { session_id: "membership-room", idempotency_key: "membership-room-create", mode: "multi", title: "Room" },
    });
    const member = running.database.createIdentity({
      user_id: "member", display_name: "Member", device_id: "member-device", device_name: "Phone",
    });
    running.service.setMembership(
      running.database.authenticate(owner.body.data.token),
      created.body.data.session.id,
      member.actor.user_id,
      "participant",
      "membership-room-member",
    );

    socket = await realtimeSocket(running.origin, member.token, created.body.data.session.id);
    const subscribed = waitForSocketMessage(socket, (message) => message.type === "subscribed");
    socket.send(JSON.stringify({ type: "subscribe", session_id: created.body.data.session.id, after_sequence: 0 }));
    await subscribed;
    const messagesAfterRemoval: Record<string, unknown>[] = [];
    socket.on("message", (data) => messagesAfterRemoval.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const closed = new Promise<number>((resolve) => socket?.once("close", resolve));
    const removed = await api(running.origin, `/v1/projects/${created.body.data.session.project_id}/members/${member.actor.user_id}`, {
      method: "DELETE", token: owner.body.data.token, body: {},
    });
    assert.equal(removed.status, 204);
    assert.equal(await closed, 1008);
    socket = undefined;

    assert.equal((await api(running.origin, `/v1/sessions/${created.body.data.session.id}/events`, {
      method: "POST", token: owner.body.data.token,
      body: { idempotency_key: "after-membership-removal", type: "human_chat", payload: { text: "private now" } },
    })).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepEqual(messagesAfterRemoval, []);
    const replay = await api<{ error: { code: string } }>(
      running.origin, `/v1/sessions/${created.body.data.session.id}/events`, { token: member.token },
    );
    assert.equal(replay.status, 404);
    assert.equal(replay.body.error.code, "not_found");
  } finally {
    socket?.terminate();
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP exposes idempotent local turns and snapshot request control-plane", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-sync-http-"));
  const running = await startCollaborationServer({
    databasePath: join(directory, "server.sqlite"), authTokenPepper: TEST_PEPPER, allowHttpBootstrap: true,
  }, 0);
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST", body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    const token = owner.body.data.token;
    await api(running.origin, "/v1/sessions", {
      method: "POST", token,
      body: { session_id: "sync-http", idempotency_key: "sync-http-create", mode: "multi", title: "Sync" },
    });
    for (const runtime of [
      { runtime_id: "execution-http", purpose: "execution", harness: "codex", local_session_id: "exec-local" },
      { runtime_id: "snapshot-http", purpose: "snapshot_connector", harness: "connector", local_session_id: "snapshot-local" },
    ]) {
      assert.equal((await api(running.origin, "/v1/runtimes", {
        method: "POST", token, body: {
          ...runtime, session_id: "sync-http", device_id: "owner-device", provider: "local", model: "test",
          capture_fidelity: "canonical_history",
        },
      })).status, 201);
    }
    const executionPresence = await api<{ data: { members: Array<{ user_id: string; runtime: { id: string; purpose: string } | null }> } }>(
      running.origin, "/v1/sessions/sync-http/members", { token },
    );
    assert.equal(executionPresence.body.data.members[0]?.runtime?.id, "execution-http");
    assert.equal(executionPresence.body.data.members[0]?.runtime?.purpose, "execution");
    const turn = {
      local_turn_id: "http-turn-1", runtime_id: "execution-http", based_on_sequence: 0,
      occurred_at: "2026-08-25T12:00:00.000Z", observed_model: "gpt-5.6-terra",
      observed_reasoning_effort: "high", request_payload: { text: "q" }, response_payload: { text: "a" },
    };
    const first = await api<{ data: { request_event: { id: string; actor_display_name: string; runtime_provenance: { model: string; reasoning_effort?: string } }; response_event: { sequence: number; actor_display_name: string } } }>(
      running.origin, "/v1/sessions/sync-http/local-turns", { method: "POST", token, body: turn },
    );
    const retry = await api<typeof first.body>(running.origin, "/v1/sessions/sync-http/local-turns", {
      method: "POST", token, body: turn,
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.request_event.actor_display_name, "Owner");
    assert.equal(first.body.data.request_event.runtime_provenance.model, "gpt-5.6-terra");
    assert.equal(first.body.data.request_event.runtime_provenance.reasoning_effort, "high");
    assert.equal(first.body.data.response_event.actor_display_name, "Owner");
    assert.deepEqual(retry.body, first.body);
    const completedClaim = await api<{ error: { code: string } }>(
      running.origin, `/v1/sessions/sync-http/agent-requests/${first.body.data.request_event.id}/claim`, {
        method: "POST", token, body: { runtime_id: "execution-http" },
      },
    );
    assert.equal(completedClaim.status, 409);
    assert.equal(completedClaim.body.error.code, "agent_request_already_completed");
    const created = await api<{ data: { snapshot_request: { id: string; through_sequence: number } } }>(
      running.origin, "/v1/sessions/sync-http/snapshot-requests", { method: "POST", token, body: {} },
    );
    assert.equal(created.body.data.snapshot_request.through_sequence, first.body.data.response_event.sequence);
    const id = created.body.data.snapshot_request.id;
    assert.equal((await api(running.origin, `/v1/snapshot-requests/${id}/claim`, {
      method: "POST", token, body: { runtime_id: "snapshot-http" },
    })).status, 200);
    const completed = await api<{ data: { snapshot_request: { status: string } } }>(
      running.origin, `/v1/snapshot-requests/${id}/complete`, {
        method: "POST", token, body: { runtime_id: "snapshot-http", result: { summary: "ready" } },
      },
    );
    assert.equal(completed.body.data.snapshot_request.status, "completed");
    assert.equal((await api(running.origin, `/v1/snapshot-requests/${id}`, { token })).status, 200);
    const filteredSnapshots = await api<{ data: { snapshot_requests: Array<{ id: string }> } }>(
      running.origin, "/v1/snapshot-requests?status=completed&session_id=sync-http&limit=40", { token },
    );
    assert.deepEqual(filteredSnapshots.body.data.snapshot_requests.map((request) => request.id), [id]);
    const oversizedRequest = await api<{ data: { snapshot_request: { id: string } } }>(
      running.origin, "/v1/sessions/sync-http/snapshot-requests", { method: "POST", token, body: {} },
    );
    const oversizedId = oversizedRequest.body.data.snapshot_request.id;
    await api(running.origin, `/v1/snapshot-requests/${oversizedId}/claim`, {
      method: "POST", token, body: { runtime_id: "snapshot-http" },
    });
    const oversizedResult = await api<{ error: { code: string } }>(
      running.origin, `/v1/snapshot-requests/${oversizedId}/complete`, {
        method: "POST", token,
        body: { runtime_id: "snapshot-http", result: { content: "x".repeat(100_000) } },
      },
    );
    assert.equal(oversizedResult.status, 400);
    assert.equal(oversizedResult.body.error.code, "validation_error");
    const oversizedStored = running.database.sqlite.prepare("SELECT status, storage_bytes FROM snapshot_requests WHERE id = ?")
      .get(oversizedId) as { status: string; storage_bytes: number };
    assert.equal(oversizedStored.status, "claimed");
    assert.equal(oversizedStored.storage_bytes, 1_024);

    const viewer = running.database.createIdentity({
      user_id: "viewer", display_name: "Viewer", device_id: "viewer-device", device_name: "Browser",
    });
    running.service.setMembership(
      running.database.authenticate(token), "sync-http", viewer.actor.user_id, "viewer", "sync-http-viewer-add",
    );
    assert.equal((await api(running.origin, "/v1/runtimes", {
      method: "POST", token: viewer.token, body: {
        runtime_id: "viewer-snapshot-http", session_id: "sync-http", device_id: "viewer-device",
        purpose: "snapshot_connector", harness: "viewer-connector", provider: "local", model: "snapshot",
        local_session_id: "viewer-snapshot-local", capture_fidelity: "canonical_history",
      },
    })).status, 201);
    const viewerMembers = await api<{ data: { members: Array<{ user_id: string; runtime: { id: string; purpose: string; status: string } | null }> } }>(
      running.origin, "/v1/sessions/sync-http/members", { token: viewer.token },
    );
    const viewerPresence = viewerMembers.body.data.members.find((member) => member.user_id === "viewer")?.runtime;
    assert.equal(viewerPresence?.id, "viewer-snapshot-http");
    assert.equal(viewerPresence?.purpose, "snapshot_connector");
    assert.equal(viewerPresence?.status, "online");
    assert.equal((await api(running.origin, "/v1/sessions/sync-http/local-turns", {
      method: "POST", token: viewer.token, body: {
        ...turn, local_turn_id: "viewer-cannot-execute", runtime_id: "viewer-snapshot-http",
      },
    })).status, 403);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
