import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import {
  AppendEventInputSchema,
  AgentProgressInputSchema,
  AcceptInvitationInputSchema,
  ApproveDshPairingInputSchema,
  BeginDshPairingInputSchema,
  ClaimAgentRequestInputSchema,
  ClaimDeviceAuthorizationInputSchema,
  ClaimInvitationInputSchema,
  ClaimSnapshotRequestInputSchema,
  CommitLocalTurnInputSchema,
  CompleteAgentRequestInputSchema,
  CompleteSnapshotRequestInputSchema,
  CreateSnapshotRequestInputSchema,
  CreateBrowserSessionInputSchema,
  CreateInvitationInputSchema,
  CreateIdentityInputSchema,
  CreateProjectInputSchema,
  CreateSessionInputSchema,
  FailSnapshotRequestInputSchema,
  IdempotencyKeySchema,
  ListSnapshotRequestsQuerySchema,
  RegisterRuntimeInputSchema,
  RotateDeviceTokenInputSchema,
  SetMembershipInputSchema,
  SubscribeMessageSchema,
  UpdateDeviceInputSchema,
  UpdateProjectInputSchema,
  UpdateSessionInputSchema,
  type ApiErrorBody,
  type CanonicalEvent,
  type JsonValue,
} from "@gatherthread/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { z, ZodError } from "zod";
import {
  CollaborationDatabase,
  REMEMBERED_BROWSER_SESSION_TTL_MS,
  type Actor,
} from "./database.js";
import { ApiError, notFound, unauthorized } from "./errors.js";
import { DshDevicePairingBroker, dshPairingPollToken } from "./dsh-pairing.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { CollaborationService } from "./service.js";

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_REPLAY_LIMIT = 50;
const MAX_REPLAY_LIMIT = 500;
const MAX_REPLAY_BYTES = 768 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;
const DEVELOPMENT_BROWSER_SESSION_COOKIE = "gatherthread_session";
const SECURE_BROWSER_SESSION_COOKIE = "__Host-gatherthread_session";
const REMEMBERED_BROWSER_SESSION_MAX_AGE_SECONDS = REMEMBERED_BROWSER_SESSION_TTL_MS / 1_000;
const SENSITIVE_UNAUTHENTICATED_PATHS = new Set([
  "/v1/bootstrap",
  "/v1/browser-sessions",
  "/v1/invitations/claim",
  "/v1/device-authorizations/claim",
]);

function isSensitiveUnauthenticatedPath(pathname: string): boolean {
  return SENSITIVE_UNAUTHENTICATED_PATHS.has(pathname)
    || pathname === "/v1/dsh-pairings"
    || /^\/v1\/dsh-pairings\/[^/]+\/poll$/u.test(pathname);
}

interface SocketState {
  actor: Actor;
  alive: boolean;
  sessionId: string | null;
  cursor: number;
  replaying: boolean;
}

interface SocketAuth {
  actor: Actor;
  allowedSessionId: string | null;
}

interface RealtimeTicket extends SocketAuth {
  expiresAt: number;
}

interface HttpAuthentication {
  actor: Actor;
  kind: "bearer" | "browser_session";
  browserSessionId: string | null;
}

export interface ServerOptions {
  databasePath: string;
  heartbeatIntervalMs?: number;
  allowedOrigins?: string[];
  authTokenPepper?: string;
  allowHttpBootstrap?: boolean;
  staticDirectory?: string;
  publicBaseUrl?: string;
  secureTransport?: boolean;
  requestRateLimit?: { windowMs: number; limit: number };
  sensitiveRateLimit?: { windowMs: number; limit: number };
  websocketRateLimit?: { windowMs: number; limit: number };
  actorRateLimit?: { windowMs: number; limit: number };
  actorWriteRateLimit?: { windowMs: number; limit: number };
  maxConnections?: number;
  maxUserEventBytes?: number;
  maxSessionEventBytes?: number;
  maxTotalEventBytes?: number;
  maxEventBytes?: number;
  maxSnapshotResultBytes?: number;
  maxUserSnapshotBytes?: number;
  maxSessionSnapshotBytes?: number;
  maxTotalSnapshotBytes?: number;
  maxUserActiveSnapshotRequests?: number;
  maxSessionActiveSnapshotRequests?: number;
  maxTotalActiveSnapshotRequests?: number;
  maxUserSessions?: number;
  maxProjectSessions?: number;
  maxTotalSessions?: number;
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

function setSecurityHeaders(response: ServerResponse, secureTransport: boolean): void {
  response.setHeader("content-security-policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  if (secureTransport) response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendStaticFile(request: IncomingMessage, response: ServerResponse, staticDirectory: string, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (pathname.startsWith("/v1/") || pathname.startsWith("/health")) return false;
  if (pathname === "/app") {
    response.writeHead(308, { location: "/app/", "cache-control": "no-store" });
    response.end();
    return true;
  }
  const root = realpathSync(staticDirectory);
  const relative = pathname === "/"
    ? "index.html"
    : pathname.endsWith("/")
      ? `${pathname.replace(/^\/+/, "")}index.html`
      : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return false;
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return false;
  }
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return false;
  const stat = statSync(resolved);
  if (!stat.isFile()) return false;
  response.writeHead(200, {
    "content-type": STATIC_CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": relative.endsWith("index.html") ? "no-store" : "no-cache",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(resolved).pipe(response);
  return true;
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
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
    assertJsonComplexity(parsed);
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON within the depth and node limits");
  }
}

function assertJsonComplexity(value: JsonValue): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) throw new Error("JSON complexity limit exceeded");
    if (current.value === null || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  throw unauthorized();
}

function browserSessionCookieName(secureTransport: boolean): string {
  return secureTransport ? SECURE_BROWSER_SESSION_COOKIE : DEVELOPMENT_BROWSER_SESSION_COOKIE;
}

function browserSessionCookieValue(request: IncomingMessage, name: string): string | null {
  const matches = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (matches.length !== 1) return null;
  const value = matches[0] ?? "";
  return /^gtb_[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function serializeBrowserSessionCookie(
  name: string,
  token: string,
  secureTransport: boolean,
  rememberedUntil?: string,
): string {
  const persistence = rememberedUntil
    ? `; Max-Age=${REMEMBERED_BROWSER_SESSION_MAX_AGE_SECONDS}; Expires=${new Date(rememberedUntil).toUTCString()}`
    : "";
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict${persistence}${secureTransport ? "; Secure" : ""}`;
}

function serializeClearedBrowserSessionCookie(name: string, secureTransport: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureTransport ? "; Secure" : ""}`;
}

function realtimeTicketFromProtocols(request: IncomingMessage): string {
  const protocols = request.headers["sec-websocket-protocol"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  if (!protocols.includes("gatherthread-v1")) throw unauthorized("GatherThread WebSocket protocol is required");
  const ticketProtocol = protocols.find((protocol) => protocol.startsWith("gatherthread-ticket."));
  const ticket = ticketProtocol?.slice("gatherthread-ticket.".length);
  if (!ticket) throw unauthorized("A one-use realtime ticket is required");
  return ticket;
}

function pathParts(url: URL): string[] {
  try {
    return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new ApiError(400, "invalid_path", "Request path contains invalid percent encoding");
  }
}

function numericQuery(url: URL, name: string, fallback: number, max: number, min = 0): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, "validation_error", `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

async function socketSend(socket: WebSocket, body: unknown): Promise<boolean> {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const encoded = JSON.stringify(body);
  if (socket.bufferedAmount + Buffer.byteLength(encoded) > MAX_SOCKET_BUFFER_BYTES) {
    socket.close(1013, "client_too_slow");
    return false;
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.close(1013, "client_too_slow");
      resolve(false);
    }, 5_000);
    timeout.unref();
    socket.send(encoded, (error) => {
      clearTimeout(timeout);
      if (error) {
        socket.close(1011, "send_failed");
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
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
  if (typeof error === "object" && error !== null) {
    const code = "code" in error ? String(error.code) : "";
    const message = "message" in error ? String(error.message) : "";
    if (code === "SQLITE_FULL" || /database or disk is full/i.test(message)) {
      return new ApiError(507, "storage_exhausted", "The owner host has no available database storage");
    }
    if (code.startsWith("ERR_SQLITE_CONSTRAINT")) {
      return new ApiError(409, "conflict", "The requested resource conflicts with existing data");
    }
  }
  console.error(error);
  return new ApiError(500, "internal_error", "Internal server error");
}

function parseTitleMutationInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError(422, "validation_error", "Request validation failed", error.issues as unknown as JsonValue);
    }
    throw error;
  }
}

export async function startCollaborationServer(
  options: ServerOptions,
  port = 0,
  host = "127.0.0.1",
): Promise<RunningCollaborationServer> {
  const database = new CollaborationDatabase(options.databasePath, {
    authTokenPepper: options.authTokenPepper,
    maxUserEventBytes: options.maxUserEventBytes,
    maxSessionEventBytes: options.maxSessionEventBytes,
    maxTotalEventBytes: options.maxTotalEventBytes,
    maxEventBytes: options.maxEventBytes,
    maxSnapshotResultBytes: options.maxSnapshotResultBytes,
    maxUserSnapshotBytes: options.maxUserSnapshotBytes,
    maxSessionSnapshotBytes: options.maxSessionSnapshotBytes,
    maxTotalSnapshotBytes: options.maxTotalSnapshotBytes,
    maxUserActiveSnapshotRequests: options.maxUserActiveSnapshotRequests,
    maxSessionActiveSnapshotRequests: options.maxSessionActiveSnapshotRequests,
    maxTotalActiveSnapshotRequests: options.maxTotalActiveSnapshotRequests,
    maxUserSessions: options.maxUserSessions,
    maxProjectSessions: options.maxProjectSessions,
    maxTotalSessions: options.maxTotalSessions,
  });
  const service = new CollaborationService(database);
  const dshPairings = new DshDevicePairingBroker();
  const secureTransport = options.secureTransport ?? false;
  const browserCookieName = browserSessionCookieName(secureTransport);
  const sockets = new Map<WebSocket, SocketState>();
  const realtimeTickets = new Map<string, RealtimeTicket>();
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY_BYTES,
    handleProtocols(protocols) {
      return protocols.has("gatherthread-v1") ? "gatherthread-v1" : false;
    },
  });
  const requestLimiter = new FixedWindowRateLimiter(options.requestRateLimit ?? { windowMs: 60_000, limit: 6_000 });
  const sensitiveLimiter = new FixedWindowRateLimiter(options.sensitiveRateLimit ?? { windowMs: 60_000, limit: 30 });
  const websocketLimiter = new FixedWindowRateLimiter(options.websocketRateLimit ?? { windowMs: 60_000, limit: 120 });
  const actorLimiter = new FixedWindowRateLimiter(options.actorRateLimit ?? { windowMs: 60_000, limit: 600 });
  const actorWriteLimiter = new FixedWindowRateLimiter(options.actorWriteRateLimit ?? { windowMs: 60_000, limit: 120 });
  const maxConnections = options.maxConnections ?? 128;

  const closeRealtimeWithoutMembership = (): void => {
    for (const [socket, state] of sockets) {
      if (state.sessionId !== null && database.membershipRole(state.sessionId, state.actor.user_id) === null) {
        socket.close(1008, "membership_revoked");
        sockets.delete(socket);
      }
    }
    for (const [ticketValue, ticket] of realtimeTickets) {
      if (ticket.allowedSessionId !== null
        && database.membershipRole(ticket.allowedSessionId, ticket.actor.user_id) === null) {
        realtimeTickets.delete(ticketValue);
      }
    }
  };

  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const parts = pathParts(url);
      setSecurityHeaders(response, secureTransport);
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      const rateLimit = requestLimiter.consume(remoteAddress);
      response.setHeader("ratelimit-limit", rateLimit.limit);
      response.setHeader("ratelimit-remaining", rateLimit.remaining);
      if (!rateLimit.allowed) {
        response.setHeader("retry-after", rateLimit.retryAfterSeconds);
        throw new ApiError(429, "rate_limited", "Too many requests");
      }
      if (isSensitiveUnauthenticatedPath(url.pathname)) {
        const sensitiveLimit = sensitiveLimiter.consume(`${remoteAddress}:${url.pathname}`);
        if (!sensitiveLimit.allowed) {
          response.setHeader("retry-after", sensitiveLimit.retryAfterSeconds);
          throw new ApiError(429, "rate_limited", "Too many credential attempts");
        }
      }
      const requestOrigin = request.headers.origin;
      if (requestOrigin) {
        if (!options.allowedOrigins?.includes(requestOrigin)) {
          throw new ApiError(403, "origin_forbidden", "The browser origin is not allowed");
        }
        response.setHeader("access-control-allow-origin", requestOrigin);
        response.setHeader("access-control-allow-credentials", "true");
        response.setHeader("access-control-allow-headers", "authorization, content-type, x-gatherthread-browser-session");
        response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader("vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health/live") {
        sendJson(response, 200, { data: { status: "ok" } });
        return;
      }

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/health/ready")) {
        try {
          const readiness = database.readiness();
          const ready = readiness.journal_mode === "wal" && readiness.foreign_keys && readiness.writable;
          sendJson(response, ready ? 200 : 503, { data: { status: ready ? "ready" : "unavailable", ...readiness } });
        } catch {
          sendJson(response, 503, { data: { status: "unavailable" } });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dsh-pairings") {
        if (requestOrigin !== undefined) {
          throw new ApiError(403, "pairing_host_only", "DSH pairing must start from the local Host plugin");
        }
        const input = BeginDshPairingInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: dshPairings.begin(input.device_name) });
        return;
      }

      if (request.method === "POST"
        && parts[0] === "v1"
        && parts[1] === "dsh-pairings"
        && parts[2]
        && parts[3] === "poll"
        && parts.length === 4) {
        if (requestOrigin !== undefined) {
          throw new ApiError(403, "pairing_host_only", "DSH pairing must be polled by the local Host plugin");
        }
        z.object({}).parse(await readJson(request));
        const result = dshPairings.poll(
          parts[2],
          dshPairingPollToken(request.headers.authorization),
          (userId, deviceName, deviceId) => database.createDevice(userId, deviceName, deviceId),
        );
        sendJson(response, result.status === "pending" ? 202 : 201, { data: result });
        return;
      }

      if (options.allowHttpBootstrap && request.method === "POST" && url.pathname === "/v1/bootstrap") {
        const input = CreateIdentityInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: database.bootstrapIdentity(input) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/invitations/claim") {
        const input = ClaimInvitationInputSchema.parse(await readJson(request));
        if (request.headers["x-gatherthread-browser-session"] === "1") {
          const { browser_session: browserSession, ...result } = service.claimInvitationWithBrowserSession(input);
          response.setHeader("set-cookie", serializeBrowserSessionCookie(
            browserCookieName,
            browserSession.token,
            secureTransport,
            browserSession.remembered ? browserSession.expires_at : undefined,
          ));
          sendJson(response, 201, { data: result });
          return;
        }
        sendJson(response, 201, { data: service.claimInvitation(input) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/device-authorizations/claim") {
        const input = ClaimDeviceAuthorizationInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: service.claimDeviceAuthorization(input) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/browser-sessions") {
        const actor = database.authenticate(bearerToken(request));
        const input = CreateBrowserSessionInputSchema.parse(await readJson(request));
        const browserSession = database.createBrowserSession(actor, input.remember_device);
        response.setHeader("set-cookie", serializeBrowserSessionCookie(
          browserCookieName,
          browserSession.token,
          secureTransport,
          browserSession.remembered ? browserSession.expires_at : undefined,
        ));
        sendJson(response, 201, { data: {
          actor: { id: actor.user_id, username: actor.display_name, device_id: actor.device_id },
          expires_at: browserSession.expires_at,
        } });
        return;
      }

      if (options.staticDirectory && sendStaticFile(request, response, options.staticDirectory, url.pathname)) return;

      const authorization = request.headers.authorization;
      const authentication: HttpAuthentication = authorization === undefined
        ? (() => {
          const cookieToken = browserSessionCookieValue(request, browserCookieName);
          if (!cookieToken) throw unauthorized();
          const authenticated = database.authenticateBrowserSession(cookieToken);
          return { actor: authenticated.actor, kind: "browser_session", browserSessionId: authenticated.session_id };
        })()
        : { actor: database.authenticate(bearerToken(request)), kind: "bearer", browserSessionId: null };
      const { actor } = authentication;
      const isWrite = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
      if (authentication.kind === "browser_session" && isWrite
        && (!requestOrigin || !options.allowedOrigins?.includes(requestOrigin))) {
        throw new ApiError(403, "csrf_origin_required", "Cookie-authenticated writes require an allowed Origin");
      }
      const actorRateLimit = actorLimiter.consume(actor.device_id);
      if (!actorRateLimit.allowed) {
        response.setHeader("retry-after", actorRateLimit.retryAfterSeconds);
        throw new ApiError(429, "rate_limited", "Too many requests for this device");
      }
      if (isWrite) {
        const writeRateLimit = actorWriteLimiter.consume(actor.device_id);
        if (!writeRateLimit.allowed) {
          response.setHeader("retry-after", writeRateLimit.retryAfterSeconds);
          throw new ApiError(429, "rate_limited", "Too many writes for this device");
        }
      }
      const readAuthenticatedJson = async (): Promise<unknown> => {
        const value = await readJson(request);
        if (authentication.kind === "browser_session" && authentication.browserSessionId) {
          database.assertActiveBrowserSession(authentication.browserSessionId, actor);
        }
        return value;
      };

      if (request.method === "GET" && url.pathname === "/v1/me") {
        sendJson(response, 200, { data: {
          id: actor.user_id,
          username: actor.display_name,
          device_id: actor.device_id,
        } });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/v1/browser-sessions/current") {
        if (authentication.browserSessionId) {
          database.revokeBrowserSession(authentication.browserSessionId, actor);
        }
        response.setHeader("set-cookie", serializeClearedBrowserSessionCookie(browserCookieName, secureTransport));
        response.writeHead(204).end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dsh-pairings/approve") {
        if (authentication.kind !== "browser_session") {
          throw new ApiError(403, "browser_session_required", "DSH pairing approval requires the signed-in browser session");
        }
        const input = ApproveDshPairingInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: { pairing: dshPairings.approve(actor, input.user_code) } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/invitations/accept") {
        const input = AcceptInvitationInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: service.claimInvitationForActor(actor, input.invite_token) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/devices") {
        sendJson(response, 200, { data: { devices: service.listDevices(actor) } });
        return;
      }

      if (request.method === "PATCH" && parts[0] === "v1" && parts[1] === "devices" && parts[2] && parts.length === 3) {
        const input = UpdateDeviceInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: { device: service.updateDeviceName(actor, parts[2], input.name) } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/device-authorizations") {
        sendJson(response, 201, { data: service.createDeviceAuthorization(actor) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/device-authorizations") {
        sendJson(response, 200, { data: { authorizations: service.listDeviceAuthorizations(actor) } });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "v1" && parts[1] === "device-authorizations" && parts[2] && parts.length === 3) {
        sendJson(response, 200, { data: { authorization: service.revokeDeviceAuthorization(actor, parts[2]) } });
        return;
      }

      if (request.method === "DELETE" && parts[0] === "v1" && parts[1] === "devices" && parts[2] && parts.length === 3) {
        const revokedDeviceId = parts[2];
        service.revokeDevice(actor, revokedDeviceId);
        for (const [ticketValue, ticket] of realtimeTickets) {
          if (ticket.actor.device_id === revokedDeviceId) realtimeTickets.delete(ticketValue);
        }
        for (const [activeSocket, state] of sockets) {
          if (state.actor.device_id === revokedDeviceId) activeSocket.close(1008, "device_revoked");
        }
        response.writeHead(204).end();
        return;
      }

      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "devices" && parts[2] && parts[3] === "rotate" && parts.length === 4) {
        const input = RotateDeviceTokenInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: service.rotateDeviceToken(actor, parts[2], input.expires_at) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readAuthenticatedJson();
        const input = parseTitleMutationInput(() => CreateSessionInputSchema.parse(body));
        sendJson(response, 201, { data: service.createSession(actor, input) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        sendJson(response, 200, { data: { sessions: service.listSessions(actor) } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/projects") {
        const body = await readAuthenticatedJson();
        const input = parseTitleMutationInput(() => CreateProjectInputSchema.parse(body));
        sendJson(response, 201, { data: { project: service.createProject(actor, input) } });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/projects") {
        sendJson(response, 200, { data: { projects: service.listProjects(actor) } });
        return;
      }

      const projectId = parts[0] === "v1" && parts[1] === "projects" ? parts[2] : undefined;
      if (projectId && request.method === "GET" && parts.length === 3) {
        sendJson(response, 200, { data: service.getProject(actor, projectId) });
        return;
      }

      if (projectId && request.method === "PATCH" && parts.length === 3) {
        const body = await readAuthenticatedJson();
        const input = parseTitleMutationInput(() => UpdateProjectInputSchema.parse(body));
        sendJson(response, 200, { data: { project: service.updateProject(actor, projectId, input) } });
        return;
      }

      if (projectId && request.method === "DELETE" && parts.length === 3) {
        service.deleteProject(actor, projectId);
        closeRealtimeWithoutMembership();
        response.writeHead(204).end();
        return;
      }

      if (projectId && parts[3] === "sessions" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { sessions: service.listProjectSessions(actor, projectId) } });
        return;
      }

      if (projectId && parts[3] === "sessions" && parts.length === 4 && request.method === "POST") {
        const body = await readAuthenticatedJson();
        const input = parseTitleMutationInput(() => CreateSessionInputSchema.parse(body));
        sendJson(response, 201, { data: service.createSession(actor, { ...input, project_id: projectId }) });
        return;
      }

      if (projectId && parts[3] === "members" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { members: service.listProjectMembers(actor, projectId) } });
        return;
      }

      if (projectId && parts[3] === "members" && parts[4] && parts.length === 5 && request.method === "PUT") {
        const input = SetMembershipInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: {
          member: service.setProjectMembership(actor, projectId, parts[4], input.role),
        } });
        return;
      }

      if (projectId && parts[3] === "members" && parts[4] && parts.length === 5 && request.method === "DELETE") {
        await readAuthenticatedJson();
        service.removeProjectMembership(actor, projectId, parts[4]);
        closeRealtimeWithoutMembership();
        response.writeHead(204).end();
        return;
      }

      if (projectId && parts[3] === "invitations" && parts.length === 4 && request.method === "POST") {
        const input = CreateInvitationInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: service.createProjectInvitation(actor, projectId, input) });
        return;
      }

      if (projectId && parts[3] === "invitations" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { invitations: service.listProjectInvitations(actor, projectId) } });
        return;
      }

      if (projectId && parts[3] === "invitations" && parts[4] && parts.length === 5 && request.method === "DELETE") {
        sendJson(response, 200, { data: {
          invitation: service.revokeProjectInvitation(actor, projectId, parts[4]),
        } });
        return;
      }

      if (projectId && parts[3] === "invitation-audit" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { audit: service.listProjectInvitationAudit(actor, projectId) } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/realtime-ticket") {
        const input = z.object({ session_id: z.string().trim().min(1).max(128) }).parse(await readAuthenticatedJson());
        service.requireMembership(actor, input.session_id);
        const ticket = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + 30_000;
        realtimeTickets.set(ticket, { actor, allowedSessionId: input.session_id, expiresAt });
        sendJson(response, 201, { data: {
          ticket,
          websocket_url: "/v1/ws",
          expires_at: new Date(expiresAt).toISOString(),
        } });
        return;
      }

      const sessionId = parts[0] === "v1" && parts[1] === "sessions" ? parts[2] : undefined;
      if (sessionId && request.method === "GET" && parts.length === 3) {
        sendJson(response, 200, { data: service.getSession(actor, sessionId) });
        return;
      }

      if (sessionId && request.method === "PATCH" && parts.length === 3) {
        const body = await readAuthenticatedJson();
        const input = parseTitleMutationInput(() => UpdateSessionInputSchema.parse(body));
        sendJson(response, 200, { data: service.updateSession(actor, sessionId, input) });
        return;
      }

      if (sessionId && request.method === "DELETE" && parts.length === 3) {
        service.deleteSession(actor, sessionId);
        closeRealtimeWithoutMembership();
        response.writeHead(204).end();
        return;
      }

      if (sessionId && parts[3] === "members" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { members: service.listMembers(actor, sessionId) } });
        return;
      }

      if (sessionId && parts[3] === "runtimes" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { runtimes: service.listOwnExecutionRuntimes(actor, sessionId) } });
        return;
      }

      if (sessionId && parts[3] === "invitations" && parts.length === 4 && request.method === "POST") {
        const input = CreateInvitationInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: service.createInvitation(actor, sessionId, input) });
        return;
      }

      if (sessionId && parts[3] === "invitations" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { invitations: service.listInvitations(actor, sessionId) } });
        return;
      }

      if (sessionId && parts[3] === "invitations" && parts[4] && parts.length === 5 && request.method === "DELETE") {
        sendJson(response, 200, { data: { invitation: service.revokeInvitation(actor, sessionId, parts[4]) } });
        return;
      }

      if (sessionId && parts[3] === "invitation-audit" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { audit: service.listInvitationAudit(actor, sessionId) } });
        return;
      }

      if (sessionId && parts[3] === "members" && parts[4] && parts.length === 5 && request.method === "PUT") {
        const input = SetMembershipInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: { event: service.setMembership(actor, sessionId, parts[4], input.role, input.idempotency_key) } });
        return;
      }

      if (sessionId && parts[3] === "members" && parts[4] && parts.length === 5 && request.method === "DELETE") {
        const input = z.object({ idempotency_key: IdempotencyKeySchema }).parse(await readAuthenticatedJson());
        const event = service.removeMembership(actor, sessionId, parts[4], input.idempotency_key);
        closeRealtimeWithoutMembership();
        sendJson(response, 200, { data: { event } });
        return;
      }

      if (sessionId && parts[3] === "events" && parts.length === 4 && request.method === "POST") {
        const input = AppendEventInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: { event: service.appendEvent(actor, sessionId, input) } });
        return;
      }

      if (sessionId && parts[3] === "events" && parts.length === 4 && request.method === "GET") {
        const afterSequence = numericQuery(url, "after_sequence", 0, Number.MAX_SAFE_INTEGER);
        const limit = numericQuery(url, "limit", DEFAULT_REPLAY_LIMIT, MAX_REPLAY_LIMIT, 1);
        sendJson(response, 200, { data: service.replay(actor, sessionId, afterSequence, limit, MAX_REPLAY_BYTES) });
        return;
      }

      if (sessionId && parts[3] === "local-turns" && parts.length === 4 && request.method === "POST") {
        const input = CommitLocalTurnInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: service.commitLocalTurn(actor, sessionId, input) });
        return;
      }

      if (sessionId && parts[3] === "snapshot-requests" && parts.length === 4 && request.method === "POST") {
        const input = CreateSnapshotRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: { snapshot_request: service.createSnapshotRequest(
          actor, sessionId, input.kind, input.target_runtime_id,
        ) } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/runtimes") {
        const input = RegisterRuntimeInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: { runtime: service.registerRuntime(actor, input) } });
        return;
      }

      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "runtimes" && parts[2] && parts[3] === "heartbeat" && parts.length === 4) {
        sendJson(response, 200, { data: { runtime: service.heartbeatRuntime(actor, parts[2]) } });
        return;
      }

      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "snapshot-requests" && parts.length === 2) {
        const query = ListSnapshotRequestsQuerySchema.parse({
          status: url.searchParams.get("status") ?? undefined,
          session_id: url.searchParams.get("session_id") ?? undefined,
          limit: numericQuery(url, "limit", 50, 100, 1),
        });
        sendJson(response, 200, { data: {
          snapshot_requests: service.listSnapshotRequests(actor, query.status, query.session_id, query.limit),
        } });
        return;
      }

      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "snapshot-requests" && parts[2] && parts.length === 3) {
        sendJson(response, 200, { data: { snapshot_request: service.getSnapshotRequest(actor, parts[2]) } });
        return;
      }

      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "snapshot-requests" && parts[2] && parts[3] === "claim" && parts.length === 4) {
        const input = ClaimSnapshotRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: { snapshot_request: service.claimSnapshotRequest(actor, parts[2], input.runtime_id) } });
        return;
      }

      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "snapshot-requests" && parts[2] && parts[3] === "complete" && parts.length === 4) {
        const input = CompleteSnapshotRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: { snapshot_request: service.completeSnapshotRequest(actor, parts[2], input.runtime_id, input.result) } });
        return;
      }

      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "snapshot-requests" && parts[2] && parts[3] === "fail" && parts.length === 4) {
        const input = FailSnapshotRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: { snapshot_request: service.failSnapshotRequest(actor, parts[2], input.runtime_id, input.error) } });
        return;
      }

      if (sessionId && parts[3] === "agent-requests" && parts[4] && parts[5] === "claim" && parts.length === 6 && request.method === "POST") {
        const input = ClaimAgentRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: service.claimAgentRequest(actor, sessionId, parts[4], input.runtime_id) });
        return;
      }

      if (sessionId && parts[3] === "agent-requests" && parts[4] && parts[5] === "progress" && parts.length === 6 && request.method === "POST") {
        const input = AgentProgressInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: { event: service.appendAgentProgress(
          actor,
          sessionId,
          parts[4],
          input.runtime_id,
          input.idempotency_key,
          input.payload,
          input.observed_model,
          input.observed_reasoning_effort,
        ) } });
        return;
      }

      if (sessionId && parts[3] === "agent-requests" && parts[4] && parts[5] === "complete" && parts.length === 6 && request.method === "POST") {
        const input = CompleteAgentRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: { event: service.completeAgentRequest(
          actor,
          sessionId,
          parts[4],
          input.runtime_id,
          input.idempotency_key,
          input.payload,
          input.observed_model,
          input.observed_reasoning_effort,
        ) } });
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
      const requestOrigin = request.headers.origin;
      if (options.allowedOrigins?.length && (!requestOrigin || !options.allowedOrigins.includes(requestOrigin))) {
        throw new ApiError(403, "origin_forbidden", "The WebSocket origin is not allowed");
      }
      if (sockets.size >= maxConnections) throw new ApiError(503, "connection_limit", "Realtime connection limit reached");
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      const rateLimit = websocketLimiter.consume(`upgrade:${remoteAddress}`);
      if (!rateLimit.allowed) throw new ApiError(429, "rate_limited", "Too many realtime connection attempts");
      const ticketValue = realtimeTicketFromProtocols(request);
      const ticket = realtimeTickets.get(ticketValue);
      realtimeTickets.delete(ticketValue);
      if (!ticket || ticket.expiresAt < Date.now()) throw unauthorized("Realtime ticket is invalid or expired");
      database.assertActiveDevice(ticket.actor);
      const auth: SocketAuth = { actor: ticket.actor, allowedSessionId: ticket.allowedSessionId };
      wsServer.handleUpgrade(request, socket, head, (webSocket) => {
        wsServer.emit("connection", webSocket, request, auth);
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  wsServer.on("connection", (socket: WebSocket, _request: IncomingMessage, auth: SocketAuth) => {
    const { actor } = auth;
    const state: SocketState = { actor, alive: true, sessionId: null, cursor: 0, replaying: false };
    sockets.set(socket, state);
    socket.on("pong", () => { state.alive = true; });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("message", (data, isBinary) => {
      void (async () => {
        let ownsReplay = false;
        try {
          database.assertActiveDevice(actor);
          const rateLimit = websocketLimiter.consume(`message:${actor.device_id}`);
          if (!rateLimit.allowed) throw new ApiError(429, "rate_limited", "Too many realtime messages");
          if (isBinary) throw new ApiError(400, "invalid_message", "WebSocket messages must be JSON text");
          const message = SubscribeMessageSchema.parse(JSON.parse(data.toString()) as unknown);
          if (auth.allowedSessionId && message.session_id !== auth.allowedSessionId) {
            throw new ApiError(403, "ticket_scope_mismatch", "Realtime ticket is scoped to another session");
          }
          if (state.replaying) throw new ApiError(409, "replay_in_progress", "A replay is already in progress");
          state.replaying = true;
          ownsReplay = true;
          service.requireMembership(actor, message.session_id);
          state.sessionId = message.session_id;
          state.cursor = message.after_sequence;
          let page = service.replay(actor, message.session_id, state.cursor, DEFAULT_REPLAY_LIMIT, MAX_REPLAY_BYTES);
          while (true) {
            service.requireMembership(actor, message.session_id);
            if (!await socketSend(socket, { type: "replay", events: page.events, cursor: page.cursor, has_more: page.has_more })) return;
            state.cursor = page.cursor;
            database.assertActiveDevice(actor);
            const nextPage = service.replay(actor, message.session_id, state.cursor, DEFAULT_REPLAY_LIMIT, MAX_REPLAY_BYTES);
            if (!page.has_more && nextPage.events.length === 0 && nextPage.cursor === state.cursor) break;
            page = nextPage;
          }
          service.requireMembership(actor, message.session_id);
          const subscribedSend = socketSend(socket, { type: "subscribed", session_id: message.session_id, cursor: state.cursor });
          state.replaying = false;
          ownsReplay = false;
          await subscribedSend;
        } catch (error) {
          const normalized = normalizeError(error);
          await socketSend(socket, { type: "error", ...errorBody(normalized) });
          if (normalized.status === 401 || normalized.status === 403 || normalized.status === 404) socket.close(1008, normalized.code);
        } finally {
          if (ownsReplay) state.replaying = false;
        }
      })();
    });
  });

  const unsubscribe = service.onEvent((event: CanonicalEvent) => {
    for (const [socket, state] of sockets) {
      if (state.replaying || state.sessionId !== event.session_id || event.sequence <= state.cursor) continue;
      try {
        database.assertActiveDevice(state.actor);
        service.requireMembership(state.actor, event.session_id);
        if (service.canReadEvent(state.actor, event)) {
          void socketSend(socket, { type: "event", event: service.presentEvent(state.actor, event) });
        } else {
          void socketSend(socket, { type: "cursor", cursor: event.sequence });
        }
        state.cursor = event.sequence;
      } catch {
        socket.close(1008, "membership_or_device_revoked");
        sockets.delete(socket);
      }
    }
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ticket, value] of realtimeTickets) {
      if (value.expiresAt < now) realtimeTickets.delete(ticket);
    }
    for (const [socket, state] of sockets) {
      try {
        database.assertActiveDevice(state.actor);
        if (state.sessionId !== null) service.requireMembership(state.actor, state.sessionId);
      } catch {
        socket.close(1008, "membership_or_device_revoked");
        sockets.delete(socket);
        continue;
      }
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
      dshPairings.clear();
      for (const socket of sockets.keys()) socket.terminate();
      wsServer.close();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      database.close();
    },
  };
}
