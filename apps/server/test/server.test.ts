import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startCollaborationServer } from "../src/server.js";

interface IdentityResponse {
  data: { actor: { user_id: string; device_id: string }; token: string };
}

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

test("HTTP replay and WebSocket reconnect provide ordered multi-client updates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-http-"));
  const running = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"), heartbeatIntervalMs: 100 }, 0);
  let socket: WebSocket | undefined;
  try {
    const bootstrap = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    assert.equal(bootstrap.status, 201);
    const ownerToken = bootstrap.body.data.token;
    const member = await api<IdentityResponse>(running.origin, "/v1/users", {
      method: "POST",
      token: ownerToken,
      body: { user_id: "member", display_name: "Member", device_id: "member-device", device_name: "Laptop" },
    });
    const memberToken = member.body.data.token;
    const created = await api<{ data: { session: { id: string } } }>(running.origin, "/v1/sessions", {
      method: "POST",
      token: ownerToken,
      body: { session_id: "shared", idempotency_key: "create-shared-0001", mode: "multi", title: "Shared" },
    });
    assert.equal(created.status, 201);
    await api(running.origin, "/v1/sessions/shared/members/member", {
      method: "PUT",
      token: ownerToken,
      body: { role: "participant", idempotency_key: "add-member-0001" },
    });

    socket = new WebSocket(running.origin.replace("http", "ws") + "/v1/ws", {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", () => resolve());
      socket?.once("error", reject);
    });
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
    socket = new WebSocket(running.origin.replace("http", "ws") + "/v1/ws", {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", () => resolve());
      socket?.once("error", reject);
    });
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
      body: { idempotency_key: "member-chat-0001", type: "human_chat", payload: { text: "retry changed" } },
    });
    assert.equal(repeated.body.data.event.id, chat.body.data.event.id);
    assert.equal(repeated.body.data.event.sequence, 3);
  } finally {
    socket?.terminate();
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("token auth and solo viewer ACL are enforced over HTTP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-acl-"));
  const running = await startCollaborationServer({ databasePath: join(directory, "server.sqlite") }, 0);
  try {
    const owner = await api<IdentityResponse>(running.origin, "/v1/bootstrap", {
      method: "POST",
      body: { user_id: "owner", display_name: "Owner", device_id: "owner-device", device_name: "Laptop" },
    });
    const viewer = await api<IdentityResponse>(running.origin, "/v1/users", {
      method: "POST",
      token: owner.body.data.token,
      body: { user_id: "viewer", display_name: "Viewer", device_id: "viewer-device", device_name: "Phone" },
    });
    await api(running.origin, "/v1/sessions", {
      method: "POST",
      token: owner.body.data.token,
      body: { session_id: "solo", idempotency_key: "create-solo-http-1", mode: "solo", title: "Solo" },
    });
    await api(running.origin, "/v1/sessions/solo/members/viewer", {
      method: "PUT",
      token: owner.body.data.token,
      body: { role: "viewer", idempotency_key: "add-viewer-http-1" },
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
    assert.equal((await api(running.origin, "/v1/sessions/solo/events")).status, 401);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
