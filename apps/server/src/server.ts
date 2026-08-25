import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AppendEventInputSchema,
  ClaimAgentRequestInputSchema,
  CompleteAgentRequestInputSchema,
  CreateIdentityInputSchema,
  CreateSessionInputSchema,
  IdempotencyKeySchema,
  RegisterRuntimeInputSchema,
  SetMembershipInputSchema,
  SubscribeMessageSchema,
  type ApiErrorBody,
  type CanonicalEvent,
  type JsonValue,
} from "@agent-cooperation/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { z, ZodError } from "zod";
import { CollaborationDatabase, type Actor } from "./database.js";
import { ApiError, notFound, unauthorized } from "./errors.js";
import { CollaborationService } from "./service.js";

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;

const UpdateSessionInputSchema = z.object({
  mode: z.enum(["solo", "multi"]).optional(),
  state: z.enum(["active", "archived"]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  idempotency_key: IdempotencyKeySchema,
}).refine((value) => value.mode !== undefined || value.state !== undefined || value.title !== undefined, {
  message: "At least one session field must be updated",
});

const CreateDeviceInputSchema = z.object({
  device_id: z.string().trim().min(1).max(128).optional(),
  device_name: z.string().trim().min(1).max(120),
});

interface SocketState {
  actor: Actor;
  alive: boolean;
  sessionId: string | null;
  cursor: number;
}

export interface ServerOptions {
  databasePath: string;
  heartbeatIntervalMs?: number;
}

export interface RunningCollaborationServer {
  readonly database: CollaborationDatabase;
  readonly service: CollaborationService;
  readonly origin: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", `Request bodies are limited to ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function bearerToken(request: IncomingMessage, url: URL): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const queryToken = url.searchParams.get("access_token");
  if (queryToken) return queryToken;
  const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim());
  if (protocols?.[0] === "bearer" && protocols[1]) return protocols[1];
  throw unauthorized();
}

function pathParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function numericQuery(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ApiError(400, "validation_error", `${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

function socketSend(socket: WebSocket, body: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

function errorBody(error: ApiError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    return new ApiError(400, "validation_error", "Request validation failed", error.issues as unknown as JsonValue);
  }
  if (typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("ERR_SQLITE_CONSTRAINT")) {
    return new ApiError(409, "conflict", "The requested resource conflicts with existing data");
  }
  console.error(error);
  return new ApiError(500, "internal_error", "Internal server error");
}

export async function startCollaborationServer(
  options: ServerOptions,
  port = 0,
  host = "127.0.0.1",
): Promise<RunningCollaborationServer> {
  const database = new CollaborationDatabase(options.databasePath);
  const service = new CollaborationService(database);
  const sockets = new Map<WebSocket, SocketState>();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const parts = pathParts(url);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { data: { status: "ok", journal_mode: database.journalMode() } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/bootstrap") {
        const input = CreateIdentityInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: database.bootstrapIdentity(input) });
        return;
      }

      const actor = database.authenticate(bearerToken(request, url));

      if (request.method === "POST" && url.pathname === "/v1/users") {
        const input = CreateIdentityInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: database.createIdentity(input) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/devices") {
        const input = CreateDeviceInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: database.createDevice(actor.user_id, input.device_name, input.device_id) });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "v1" && parts[1] === "devices" && parts[2] && parts.length === 3) {
        database.revokeDevice(actor, parts[2]);
        response.writeHead(204).end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const input = CreateSessionInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: service.createSession(actor, input) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        sendJson(response, 200, { data: { sessions: service.listSessions(actor) } });
        return;
      }

      const sessionId = parts[0] === "v1" && parts[1] === "sessions" ? parts[2] : undefined;
      if (sessionId && request.method === "GET" && parts.length === 3) {
        sendJson(response, 200, { data: service.getSession(actor, sessionId) });
        return;
      }

      if (sessionId && request.method === "PATCH" && parts.length === 3) {
        const input = UpdateSessionInputSchema.parse(await readJson(request));
        sendJson(response, 200, { data: service.updateSession(actor, sessionId, input) });
        return;
      }

      if (sessionId && parts[3] === "members" && parts[4] && parts.length === 5 && request.method === "PUT") {
        const input = SetMembershipInputSchema.parse(await readJson(request));
        sendJson(response, 200, { data: { event: service.setMembership(actor, sessionId, parts[4], input.role, input.idempotency_key) } });
        return;
      }

      if (sessionId && parts[3] === "members" && parts[4] && parts.length === 5 && request.method === "DELETE") {
        const input = z.object({ idempotency_key: IdempotencyKeySchema }).parse(await readJson(request));
        sendJson(response, 200, { data: { event: service.removeMembership(actor, sessionId, parts[4], input.idempotency_key) } });
        return;
      }

      if (sessionId && parts[3] === "events" && parts.length === 4 && request.method === "POST") {
        const input = AppendEventInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: { event: service.appendEvent(actor, sessionId, input) } });
        return;
      }

      if (sessionId && parts[3] === "events" && parts.length === 4 && request.method === "GET") {
        const afterSequence = numericQuery(url, "after_sequence", 0, Number.MAX_SAFE_INTEGER);
        const limit = numericQuery(url, "limit", DEFAULT_REPLAY_LIMIT, MAX_REPLAY_LIMIT);
        sendJson(response, 200, { data: service.replay(actor, sessionId, afterSequence, limit) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/runtimes") {
        const input = RegisterRuntimeInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: { runtime: service.registerRuntime(actor, input) } });
        return;
      }

      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "runtimes" && parts[2] && parts[3] === "heartbeat" && parts.length === 4) {
        sendJson(response, 200, { data: { runtime: service.heartbeatRuntime(actor, parts[2]) } });
        return;
      }

      if (sessionId && parts[3] === "agent-requests" && parts[4] && parts[5] === "claim" && parts.length === 6 && request.method === "POST") {
        const input = ClaimAgentRequestInputSchema.parse(await readJson(request));
        sendJson(response, 200, { data: service.claimAgentRequest(actor, sessionId, parts[4], input.runtime_id) });
        return;
      }

      if (sessionId && parts[3] === "agent-requests" && parts[4] && parts[5] === "complete" && parts.length === 6 && request.method === "POST") {
        const input = CompleteAgentRequestInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: { event: service.completeAgentRequest(actor, sessionId, parts[4], input.runtime_id, input.idempotency_key, input.payload) } });
        return;
      }

      throw notFound("Route");
    } catch (error) {
      const normalized = normalizeError(error);
      sendJson(response, normalized.status, errorBody(normalized));
    }
  });

  httpServer.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/v1/ws") throw notFound("WebSocket route");
      const actor = database.authenticate(bearerToken(request, url));
      wsServer.handleUpgrade(request, socket, head, (webSocket) => {
        wsServer.emit("connection", webSocket, request, actor);
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  wsServer.on("connection", (socket: WebSocket, _request: IncomingMessage, actor: Actor) => {
    const state: SocketState = { actor, alive: true, sessionId: null, cursor: 0 };
    sockets.set(socket, state);
    socket.on("pong", () => { state.alive = true; });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) throw new ApiError(400, "invalid_message", "WebSocket messages must be JSON text");
        const message = SubscribeMessageSchema.parse(JSON.parse(data.toString()) as unknown);
        service.requireMembership(actor, message.session_id);
        state.sessionId = message.session_id;
        state.cursor = message.after_sequence;
        let page = service.replay(actor, message.session_id, state.cursor, DEFAULT_REPLAY_LIMIT);
        while (true) {
          socketSend(socket, { type: "replay", events: page.events, cursor: page.cursor, has_more: page.has_more });
          state.cursor = page.cursor;
          if (!page.has_more) break;
          page = service.replay(actor, message.session_id, state.cursor, DEFAULT_REPLAY_LIMIT);
        }
        socketSend(socket, { type: "subscribed", session_id: message.session_id, cursor: state.cursor });
      } catch (error) {
        const normalized = normalizeError(error);
        socketSend(socket, { type: "error", ...errorBody(normalized) });
        if (normalized.status === 401 || normalized.status === 403 || normalized.status === 404) socket.close(1008, normalized.code);
      }
    });
  });

  const unsubscribe = service.onEvent((event: CanonicalEvent) => {
    for (const [socket, state] of sockets) {
      if (state.sessionId !== event.session_id || event.sequence <= state.cursor) continue;
      if (service.canReadEvent(state.actor, event)) {
        socketSend(socket, { type: "event", event });
      } else {
        socketSend(socket, { type: "cursor", cursor: event.sequence });
      }
      state.cursor = event.sequence;
    }
  });

  const heartbeat = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.alive) {
        socket.terminate();
        sockets.delete(socket);
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;

  return {
    database,
    service,
    origin: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const socket of sockets.keys()) socket.terminate();
      wsServer.close();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      database.close();
    },
  };
}
