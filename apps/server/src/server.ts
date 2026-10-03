import { HostedGithub, type HostedGithubOptions } from "./hosted-github.js";
import { stopInterruptedHostedContainers } from "./hosted-agent-recovery.js";
import { HostedGithubRepositoryInputSchema, HostedGithubTaskInputSchema, HostedGithubPrInputSchema, HostedGithubCompleteInputSchema } from "@gatherthread/protocol";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep, join } from "node:path";
import {
  EmailLoginInputSchema, EmailAccountSessionSchema, RegistrationStatusSchema, RegistrationSentSchema, SendRegistrationInputSchema, VerifyRegistrationInputSchema,
  SendPasswordResetInputSchema, VerifyPasswordResetInputSchema, PasswordResetSentSchema,
  AppendEventInputSchema,
  AgentProgressInputSchema,
  AcceptInvitationInputSchema,
  ApproveDshPairingInputSchema,
  BeginDshPairingInputSchema,
  ClaimAgentRequestInputSchema,
  PauseAgentRequestInputSchema,
  ClaimDeviceAuthorizationInputSchema,
  ClaimSnapshotRequestInputSchema,
  CommitLocalTurnInputSchema,
  CompleteAgentRequestInputSchema,
  CompleteSnapshotRequestInputSchema,
  CreateSnapshotRequestInputSchema,
  CreateInvitationInputSchema,
  CreateHistorySummaryInputSchema,
  HostedAgentRequestInputSchema,
  HostedAgentStatusSchema,
  CreateProjectInputSchema,
  CreateSessionInputSchema,
  CODE_SYNC_MAX_BODY_BYTES,
  FailSnapshotRequestInputSchema,
  GitHubConnectionInputSchema,
  GitHubProjectStatusSchema,
  DetachedCodeClearResultSchema,
  ListSnapshotRequestsQuerySchema,
  ProjectMentionsPageSchema,
  RegisterRuntimeInputSchema,
  RemoveProjectMembershipInputSchema,
  RemoveSessionMembershipInputSchema,
  RotateDeviceTokenInputSchema,
  SetMembershipInputSchema,
  SubscribeMessageSchema,
  UpdateDeviceInputSchema,
  UpdateContextPolicyInputSchema,
  UpdateProjectInputSchema,
  TransferProjectOwnershipInputSchema,
  DeleteAccountInputSchema,
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
import type { RegistrationOptions } from "./registration.js";
import { registrationClientIp } from "./registration-providers.js";
import { CodeRepository } from "./code-repository.js";
import { HostedAgent, type HostedAgentOptions } from "./hosted-agent.js";

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
const DEVELOPMENT_REMEMBERED_BROWSER_COOKIE = "gatherthread_remembered";
const SECURE_REMEMBERED_BROWSER_COOKIE = "__Host-gatherthread_remembered";
const REMEMBERED_BROWSER_SESSION_MAX_AGE_SECONDS = REMEMBERED_BROWSER_SESSION_TTL_MS / 1_000;
const SENSITIVE_UNAUTHENTICATED_PATHS = new Set([
  "/v1/bootstrap",
  "/v1/browser-sessions",
  "/v1/invitations/claim",
  "/v1/test-access/claim",
  "/v1/device-authorizations/claim",
]);

function isSensitiveUnauthenticatedPath(pathname: string): boolean {
  return SENSITIVE_UNAUTHENTICATED_PATHS.has(pathname)
    || /^\/v1\/remembered-accounts(?:\/[^/]+(?:\/activate)?)?$/u.test(pathname)
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
  rememberedBrowserSession: boolean;
}

export interface ServerOptions {
  registration?: RegistrationOptions;
  databasePath: string;
  codeRepositoryDirectory?: string;
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
  hostedAgent?: HostedAgentOptions;
  hostedGithub?: HostedGithubOptions;
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
  // Only the public mock example is embeddable. Real UI/API framing stays denied.
  if (relative === "app/example.html") {
    response.removeHeader("x-frame-options");
    response.setHeader("content-security-policy", "default-src 'none'; script-src 'nonce-gatherthread-example-v1'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'; sandbox allow-scripts");
  }
  response.writeHead(200, {
    "content-type": STATIC_CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": relative.endsWith("index.html") ? "no-store" : "no-cache",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(resolved).pipe(response);
  return true;
}

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes) throw new ApiError(413, "payload_too_large", `Request bodies are limited to ${maxBytes} bytes`);
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

function rememberedBrowserCookieName(secureTransport: boolean): string {
  return secureTransport ? SECURE_REMEMBERED_BROWSER_COOKIE : DEVELOPMENT_REMEMBERED_BROWSER_COOKIE;
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

function rememberedBrowserCookieValue(request: IncomingMessage, name: string): string | null {
  const matches = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (matches.length !== 1) return null;
  const value = matches[0] ?? "";
  return /^gtr_[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

function appendSetCookie(response: ServerResponse, value: string): void {
  const prior = response.getHeader("set-cookie");
  response.setHeader("set-cookie", prior === undefined ? value : [...(Array.isArray(prior) ? prior : [String(prior)]), value]);
}

function serializeRememberedBrowserCookie(name: string, token: string, secureTransport: boolean, expiresAt: string): string {
  const maxAge = Math.max(0, Math.min(REMEMBERED_BROWSER_SESSION_MAX_AGE_SECONDS,
    Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000)));
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}${secureTransport ? "; Secure" : ""}`;
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
  if (database.hostedActiveRuns() && !options.hostedAgent?.runContainer) {
    try { stopInterruptedHostedContainers(); }
    catch (error) { database.close(); throw error; }
  }
  database.failInterruptedHostedAgentJobs();
  const publicAccountActor = (actor: Actor) => ({
    id: actor.user_id,
    username: actor.display_name,
    device_id: actor.device_id,
    can_create_projects: database.canCreateProjects(actor.user_id),
  });
  const ephemeralCodeDirectory = options.databasePath === ":memory:" && !options.codeRepositoryDirectory
    ? mkdtempSync(join(tmpdir(), "gatherthread-code-")) : undefined;
  const codeRepository = new CodeRepository(database, options.codeRepositoryDirectory ?? ephemeralCodeDirectory ?? `${resolve(options.databasePath)}.code`);
  const hostedAgent = options.hostedAgent ? new HostedAgent(service, codeRepository, options.hostedAgent) : undefined;
  if (options.hostedGithub && !hostedAgent) throw new Error("Cloud GitHub requires Cloud Agent");
  const hostedGithub = options.hostedGithub && options.hostedAgent && hostedAgent
    ? new HostedGithub(service, hostedAgent, options.hostedAgent, options.hostedGithub) : undefined;
  const dshPairings = new DshDevicePairingBroker();
  const registration = options.authTokenPepper && Buffer.byteLength(options.authTokenPepper) >= 32 ? options.registration : undefined;
  const secureTransport = options.secureTransport ?? false;
  const registrationCookieName = secureTransport ? "__Host-gatherthread_registration" : "gatherthread_registration";
  const registrationBrowser = (request: IncomingMessage): string | null => {
    const values = (request.headers.cookie ?? "").split(";").map((value) => value.trim())
      .filter((value) => value.startsWith(`${registrationCookieName}=`)).map((value) => value.slice(registrationCookieName.length + 1));
    return values.length === 1 && /^grc_[A-Za-z0-9_-]{43}$/.test(values[0] ?? "") ? values[0]! : null;
  };
  const browserCookieName = browserSessionCookieName(secureTransport);
  const rememberedCookieName = rememberedBrowserCookieName(secureTransport);
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
      const url = new URL(request.url ?? "/", options.publicBaseUrl ?? "http://localhost");
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

      if (["/v1/bootstrap", "/v1/browser-sessions", "/v1/invitations/claim", "/v1/test-access/claim"].includes(url.pathname)
        || url.pathname === "/v1/remembered-accounts" || url.pathname.startsWith("/v1/remembered-accounts/")) {
        throw new ApiError(410, "account_flow_retired", "Use email registration and password sign-in. Accept project invitations after signing in.");
      }

      if (url.pathname === "/v1/email-login") {
        if (!options.authTokenPepper || Buffer.byteLength(options.authTokenPepper) < 32) throw new ApiError(503, "registration_unavailable", "Email sign-in is temporarily unavailable.");
        if (url.search) throw new ApiError(400, "registration_invalid", "Credentials belong in the request body.");
        if (request.headers["sec-fetch-site"] === "cross-site") throw new ApiError(403, "origin_forbidden", "The browser origin is not allowed");
        if (request.method === "GET") {
          const browser = registrationBrowser(request) ?? `grc_${randomBytes(32).toString("base64url")}`;
          appendSetCookie(response, `${registrationCookieName}=${browser}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secureTransport ? "; Secure" : ""}`);
          sendJson(response, 200, { data: { enabled: true } });
          return;
        }
        if (request.method === "POST") {
          if (!requestOrigin || !options.allowedOrigins?.includes(requestOrigin) || (options.publicBaseUrl && requestOrigin !== options.publicBaseUrl)) throw new ApiError(403, "csrf_origin_required", "Email sign-in requires the configured browser origin");
          if (!request.headers["content-type"]?.startsWith("application/json")) throw new ApiError(415, "invalid_content_type", "Email sign-in requires JSON");
          const browser = registrationBrowser(request);
          if (!browser) throw new ApiError(400, "registration_browser", "Open registration in this browser and try again.");
          const input = EmailLoginInputSchema.parse(await readJson(request, 8192));
          const ip = registrationClientIp(remoteAddress, request.headers["x-gatherthread-client-ip"], registration?.trustedProxy);
          const result = await database.loginWithEmail(input, browser, ip);
          const browserSession = result.browser_session;
          appendSetCookie(response, serializeBrowserSessionCookie(browserCookieName, browserSession.token, secureTransport,
            browserSession.remembered ? browserSession.expires_at : undefined));
          sendJson(response, 201, { data: EmailAccountSessionSchema.parse({ actor: { ...result.actor, can_create_projects: true }, expires_at: browserSession.expires_at }) });
          return;
        }
        throw notFound("Email sign-in route");
      }
      if (url.pathname.startsWith("/v1/registration")) {
        if (url.search) throw new ApiError(400, "registration_invalid", "Registration parameters belong in the request body.");
        const enabled = database.registration.ready(registration);
        if (request.method === "GET" && url.pathname === "/v1/registration") {
          if (request.headers["sec-fetch-site"] === "cross-site") throw new ApiError(403, "origin_forbidden", "The browser origin is not allowed");
          const browser = registrationBrowser(request) ?? `grc_${randomBytes(32).toString("base64url")}`;
          if (enabled) appendSetCookie(response, `${registrationCookieName}=${browser}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secureTransport ? "; Secure" : ""}`);
          sendJson(response, 200, { data: RegistrationStatusSchema.parse({ enabled, site_key: enabled ? registration!.siteKey : null,
            challenge_binding: enabled ? database.registration.binding(browser) : null }) });
          return;
        }
        if (request.method === "POST" && ["/v1/registration/send", "/v1/registration/verify"].includes(url.pathname)) {
          if (!enabled) throw new ApiError(503, "registration_unavailable", "Email registration is temporarily unavailable.");
          if (!requestOrigin || requestOrigin !== registration!.origin || !options.allowedOrigins?.includes(requestOrigin)) {
            throw new ApiError(403, "csrf_origin_required", "Registration requires the configured browser origin");
          }
          if (!request.headers["content-type"]?.startsWith("application/json")) throw new ApiError(415, "invalid_content_type", "Registration requires JSON");
          const browser = registrationBrowser(request);
          if (!browser) throw new ApiError(400, "registration_browser", "Open registration in this browser and try again.");
          const ip = registrationClientIp(remoteAddress, request.headers["x-gatherthread-client-ip"], registration!.trustedProxy);
          if (url.pathname.endsWith("/send")) {
            const input = SendRegistrationInputSchema.parse(await readJson(request, 8192));
            const result = await database.registration.send(input, browser, ip, registration!);
            sendJson(response, 202, { data: RegistrationSentSchema.parse(result) });
          } else {
            const input = VerifyRegistrationInputSchema.parse(await readJson(request, 8192));
            const { browser_session: browserSession, ...result } = await database.verifyPublicRegistration(input, browser, ip, registration!);
            appendSetCookie(response, serializeBrowserSessionCookie(browserCookieName, browserSession.token, secureTransport,
              browserSession.remembered ? browserSession.expires_at : undefined));
            sendJson(response, 201, { data: EmailAccountSessionSchema.parse({ actor: { ...result.actor, can_create_projects: true }, expires_at: browserSession.expires_at }) });
          }
          return;
        }
        throw notFound("Registration route");
      }
      if (url.pathname.startsWith("/v1/password-reset")) {
        if (url.search) throw new ApiError(400, "registration_invalid", "Reset parameters belong in the request body.");
        const enabled = database.registration.recoveryReady(registration);
        if (request.headers["sec-fetch-site"] === "cross-site") throw new ApiError(403, "origin_forbidden", "The browser origin is not allowed");
        if (request.method === "GET" && url.pathname === "/v1/password-reset") {
          const browser = registrationBrowser(request) ?? `grc_${randomBytes(32).toString("base64url")}`;
          if (enabled) appendSetCookie(response, `${registrationCookieName}=${browser}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secureTransport ? "; Secure" : ""}`);
          sendJson(response, 200, { data: RegistrationStatusSchema.parse({ enabled, site_key: enabled ? registration!.siteKey : null,
            challenge_binding: enabled ? database.registration.binding(browser, "password-reset") : null }) });
          return;
        }
        if (request.method === "POST" && ["/v1/password-reset/send", "/v1/password-reset/verify"].includes(url.pathname)) {
          if (!enabled) throw new ApiError(503, "password_reset_unavailable", "Password recovery is temporarily unavailable.");
          if (!requestOrigin || requestOrigin !== registration!.origin || !options.allowedOrigins?.includes(requestOrigin)) throw new ApiError(403, "csrf_origin_required", "Password reset requires the configured browser origin");
          if (!request.headers["content-type"]?.startsWith("application/json")) throw new ApiError(415, "invalid_content_type", "Password reset requires JSON");
          const browser = registrationBrowser(request);
          if (!browser) throw new ApiError(400, "registration_browser", "Open password recovery in this browser and try again.");
          const ip = registrationClientIp(remoteAddress, request.headers["x-gatherthread-client-ip"], registration!.trustedProxy);
          if (url.pathname.endsWith("/send")) {
            const result = await database.registration.send(SendPasswordResetInputSchema.parse(await readJson(request, 8192)), browser, ip, registration!, "password-reset");
            sendJson(response, 202, { data: PasswordResetSentSchema.parse({ reset_id: result.registration_id, expires_in_seconds: result.expires_in_seconds, resend_after_seconds: result.resend_after_seconds }) });
          } else {
            const input = VerifyPasswordResetInputSchema.parse(await readJson(request, 8192));
            const userId = await database.resetPassword(input, browser, ip, registration!);
            dshPairings.revokeUser(userId);
            for (const [value, ticket] of realtimeTickets) if (ticket.actor.user_id === userId) realtimeTickets.delete(value);
            for (const [socket, state] of sockets) if (state.actor.user_id === userId) { socket.close(1008, "password_reset"); sockets.delete(socket); }
            // All database and in-memory authorization is revoked before any notification wait.
            // The notice budget was reserved during verification; attempt once, without retry or provider logging.
            try { await registration!.mailer!.notifyPasswordChanged!({ email: input.email, locale: input.locale, deliveryId: input.reset_id }); } catch { /* reset remains committed */ }
            sendJson(response, 200, { data: { reset: true } });
          }
          return;
        }
        throw notFound("Password reset route");
      }
      // The external challenge is limited to the real login document and configured deployments.
      if (["/app/", "/app/index.html"].includes(url.pathname) && (database.registration.ready(registration) || database.registration.recoveryReady(registration))) {
        const csp = String(response.getHeader("content-security-policy"));
        response.setHeader("content-security-policy", csp.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com")
          .replace("connect-src 'self'", "connect-src 'self' https://challenges.cloudflare.com") + "; frame-src 'self' https://challenges.cloudflare.com");
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
          (authorizer, deviceName, deviceId) => {
            database.assertActiveDevice(authorizer);
            return database.createDevice(authorizer.user_id, deviceName, deviceId);
          },
        );
        sendJson(response, result.status === "pending" ? 202 : 201, { data: result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/device-authorizations/claim") {
        const input = ClaimDeviceAuthorizationInputSchema.parse(await readJson(request));
        sendJson(response, 201, { data: service.claimDeviceAuthorization(input) });
        return;
      }

      if (options.staticDirectory && sendStaticFile(request, response, options.staticDirectory, url.pathname)) return;

      if (request.method === "GET" && url.pathname === "/v1/hosted-github/callback") {
        if (!hostedGithub) throw new ApiError(503, "hosted_github_disabled", "Cloud GitHub is not enabled");
        const code = url.searchParams.get("code"), state = url.searchParams.get("state");
        if (!code || !state || code.length > 500 || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
          throw new ApiError(400, "github_state", "Restart GitHub authorization");
        }
        response.writeHead(303, { location: `/app/#${new URLSearchParams({ github_code: code, github_state: state })}`,
          "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
        return;
      }
      const authorization = request.headers.authorization;
      const authentication: HttpAuthentication = authorization === undefined
        ? (() => {
          const cookieToken = browserSessionCookieValue(request, browserCookieName);
          if (!cookieToken) throw unauthorized();
          const authenticated = database.authenticateBrowserSession(cookieToken);
          if (!database.registration.hasAccount(authenticated.actor.user_id)) throw unauthorized("Sign in with email and password");
          return {
            actor: authenticated.actor,
            kind: "browser_session",
            browserSessionId: authenticated.session_id,
            rememberedBrowserSession: authenticated.remembered,
          };
        })()
        : { actor: database.authenticate(bearerToken(request)), kind: "bearer", browserSessionId: null, rememberedBrowserSession: false };
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
      const readAuthenticatedJson = async (maxBytes = MAX_BODY_BYTES): Promise<unknown> => {
        const value = await readJson(request, maxBytes);
        if (authentication.kind === "browser_session" && authentication.browserSessionId) {
          database.assertActiveBrowserSession(authentication.browserSessionId, actor);
        }
        return value;
      };

      if (request.method === "GET" && url.pathname === "/v1/me") {
        sendJson(response, 200, { data: publicAccountActor(actor) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/hosted-agent") {
        sendJson(response, 200, { data: HostedAgentStatusSchema.parse(hostedAgent?.status(actor) ?? { enabled: false }) });
        return;
      }

      if (url.pathname.startsWith("/v1/hosted-github/")) {
        if (!hostedGithub) throw new ApiError(503, "hosted_github_disabled", "Cloud GitHub is not enabled");
        if (url.pathname === "/v1/hosted-github/authorize" && request.method === "POST") {
          z.object({}).strict().parse(await readAuthenticatedJson());
          sendJson(response, 200, { data: hostedGithub.authorize(actor) }); return;
        }
        if (url.pathname === "/v1/hosted-github/complete" && request.method === "POST") {
          const input = HostedGithubCompleteInputSchema.parse(await readAuthenticatedJson());
          sendJson(response, 200, { data: await hostedGithub.complete(actor, input) }); return;
        }
        if (url.pathname === "/v1/hosted-github/account" && request.method === "DELETE") {
          sendJson(response, 200, { data: hostedGithub.disconnect(actor) }); return;
        }
        const match = /^\/v1\/hosted-github\/tasks\/(gh-task-[a-f0-9]{32})(\/pull-request)?$/u.exec(url.pathname);
        if (match) {
          const id = match[1]!;
          if (!match[2] && request.method === "GET") { sendJson(response, 200, { data: hostedGithub.view(actor, id) }); return; }
          if (!match[2] && request.method === "DELETE") { hostedGithub.remove(actor, id); response.writeHead(204).end(); return; }
          if (match[2] && request.method === "POST") {
            const input = HostedGithubPrInputSchema.parse(await readAuthenticatedJson());
            sendJson(response, 200, { data: await hostedGithub.publish(actor, id, input) }); return;
          }
        }
      }
      const githubProject = /^\/v1\/projects\/([^/]+)\/hosted-github(\/repository|\/tasks)?$/u.exec(url.pathname);
      if (githubProject) {
        const projectId = decodeURIComponent(githubProject[1]!);
        if (!hostedGithub) {
          service.requireProjectMembership(actor, projectId);
          if (!githubProject[2] && request.method === "GET") { sendJson(response, 200, { data: { enabled: false } }); return; }
          throw new ApiError(503, "hosted_github_disabled", "Cloud GitHub is not enabled");
        }
        if (!githubProject[2] && request.method === "GET") { sendJson(response, 200, { data: hostedGithub.status(actor, projectId) }); return; }
        if (githubProject[2] === "/repository" && request.method === "POST") {
          const input = HostedGithubRepositoryInputSchema.parse(await readAuthenticatedJson());
          sendJson(response, 200, { data: await hostedGithub.bind(actor, projectId, input) }); return;
        }
        if (githubProject[2] === "/tasks" && request.method === "GET") { sendJson(response, 200, { data: { tasks: hostedGithub.list(actor, projectId) } }); return; }
      }
      if (url.pathname === "/v1/account/deletion-preview" && request.method === "GET") {
        if (authentication.kind !== "browser_session") throw new ApiError(403, "browser_session_required", "Account deletion requires a browser session");
        sendJson(response, 200, { data: service.accountDeletionPreview(actor) });
        return;
      }

      if (url.pathname === "/v1/account" && request.method === "DELETE") {
        if (authentication.kind !== "browser_session") throw new ApiError(403, "browser_session_required", "Account deletion requires a browser session");
        DeleteAccountInputSchema.parse(await readAuthenticatedJson());
        const result = service.deleteAccount(actor);
        dshPairings.revokeUser(actor.user_id);
        for (const [ticketValue, ticket] of realtimeTickets) {
          if (ticket.actor.user_id === actor.user_id) realtimeTickets.delete(ticketValue);
        }
        for (const [activeSocket, state] of sockets) {
          if (state.actor.user_id === actor.user_id) activeSocket.close(1008, "account_deleted");
        }
        response.setHeader("set-cookie", [
          serializeClearedBrowserSessionCookie(browserCookieName, secureTransport),
          serializeClearedBrowserSessionCookie(rememberedCookieName, secureTransport),
        ]);
        sendJson(response, 200, { data: result });
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

      if (request.method === "GET" && url.pathname === "/v1/code-storage") {
        sendJson(response, 200, { data: codeRepository.storageSummary(actor) });
        return;
      }
      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "code-storage"
        && parts[2] === "detached-branches" && parts[3] && parts[4] === "clear" && parts.length === 5) {
        const result = codeRepository.clearDetachedBranch(actor, parts[3], await readAuthenticatedJson());
        sendJson(response, 200, { data: DetachedCodeClearResultSchema.parse(result) });
        return;
      }

      const projectId = parts[0] === "v1" && parts[1] === "projects" ? parts[2] : undefined;
      if (projectId && parts[3] === "github" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: GitHubProjectStatusSchema.parse(service.getProjectGitHub(actor, projectId)) });
        return;
      }
      if (projectId && parts[3] === "github" && parts.length === 4 && request.method === "PUT") {
        const input = GitHubConnectionInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: GitHubProjectStatusSchema.parse(service.setProjectGitHub(actor, projectId, input)) });
        return;
      }
      if (projectId && parts[3] === "context-policy" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: service.getProjectContextPolicy(actor, projectId) });
        return;
      }
      if (projectId && parts[3] === "context-policy" && parts.length === 4 && request.method === "PUT") {
        const input = UpdateContextPolicyInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: service.setProjectContextPolicy(actor, projectId, input.mode) });
        return;
      }
      if (projectId && parts[3] === "code") {
        service.requireProjectMembership(actor, projectId);
        if (request.method === "GET" && parts.length === 4) {
          sendJson(response, 200, { data: codeRepository.status(actor, projectId) });
          return;
        }
        if (request.method === "GET" && parts.length === 5 && parts[4] === "snapshot") {
          sendJson(response, 200, { data: codeRepository.snapshot(actor, projectId, url.searchParams.get("branch_id") ?? "main") });
          return;
        }
        if (request.method === "POST" && parts.length === 5) {
          const actions = {
            enable: codeRepository.enable.bind(codeRepository), disable: codeRepository.disable.bind(codeRepository), checkpoints: codeRepository.checkpoint.bind(codeRepository),
            review: codeRepository.review.bind(codeRepository), merge: codeRepository.merge.bind(codeRepository), update: codeRepository.update.bind(codeRepository),
            "clear-branch": codeRepository.clearBranch.bind(codeRepository), "clear-project": codeRepository.clearProject.bind(codeRepository),
          };
          const action = Object.hasOwn(actions, parts[4]!) ? actions[parts[4] as keyof typeof actions] : undefined;
          if (action) {
            const body = await readAuthenticatedJson(parts[4] === "checkpoints" ? CODE_SYNC_MAX_BODY_BYTES : MAX_BODY_BYTES);
            sendJson(response, 200, { data: action(actor, projectId, body) });
            return;
          }
        }
      }
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

      if (projectId && parts[3] === "transfer-ownership" && parts.length === 4 && request.method === "POST") {
        if (authentication.kind !== "browser_session") throw new ApiError(403, "browser_session_required", "Ownership transfer requires a browser session");
        const input = TransferProjectOwnershipInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: { project: service.transferProjectOwnership(actor, projectId,
          input.target_user_id, input.idempotency_key) } });
        return;
      }

      if (projectId && parts[3] === "sessions" && parts.length === 4 && request.method === "GET") {
        sendJson(response, 200, { data: { sessions: service.listProjectSessions(actor, projectId) } });
        return;
      }

      if (projectId && parts[3] === "mentions" && parts.length === 4 && request.method === "GET") {
        const beforeId = url.searchParams.get("before_event_id") ?? undefined;
        if (beforeId !== undefined && !/^[A-Za-z0-9_.:-]{1,200}$/u.test(beforeId)) {
          throw new ApiError(400, "invalid_cursor", "Invalid mention cursor");
        }
        sendJson(response, 200, { data: ProjectMentionsPageSchema.parse(service.listProjectMentions(actor, projectId, beforeId)) });
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
        const decision = RemoveProjectMembershipInputSchema.parse(await readAuthenticatedJson());
        service.removeProjectMembership(actor, projectId, parts[4], decision);
        codeRepository.repairAfterMembershipRemoval(projectId);
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
      if (sessionId && parts[3] === "hosted-github-tasks" && parts.length === 4 && request.method === "POST") {
        if (!hostedGithub) throw new ApiError(503, "hosted_github_disabled", "Cloud GitHub is not enabled");
        const input = HostedGithubTaskInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 202, { data: hostedGithub.start(actor, sessionId, input) }); return;
      }
      if (sessionId && parts[3] === "hosted-agent-requests" && parts.length === 4 && request.method === "POST") {
        if (!hostedAgent) throw new ApiError(503, "hosted_agent_disabled", "Cloud Agent is not available on this server");
        const input = HostedAgentRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: await hostedAgent.request(actor, sessionId, input) });
        return;
      }
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
        const input = RemoveSessionMembershipInputSchema.parse(await readAuthenticatedJson());
        const projectId = database.requireSession(sessionId).project_id;
        const event = service.removeMembership(actor, sessionId, parts[4], input.idempotency_key, input);
        codeRepository.repairAfterMembershipRemoval(projectId);
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

      if (sessionId && parts[3] === "history-summaries" && parts.length === 4 && request.method === "POST") {
        const input = CreateHistorySummaryInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 201, { data: { event: service.createHistorySummary(actor, sessionId, input) } });
        return;
      }

      if (sessionId && parts[3] === "context" && parts.length === 4 && request.method === "GET") {
        const view = z.enum(["summary", "original"]).optional().parse(url.searchParams.get("view") ?? undefined);
        const through = url.searchParams.get("through_sequence");
        if (url.searchParams.getAll("view").length > 1 || url.searchParams.getAll("through_sequence").length > 1
          || (through !== null && !/^(0|[1-9][0-9]*)$/u.test(through))) {
          throw new ApiError(400, "validation_error", "Context view and through_sequence must each have one valid value");
        }
        const throughSequence = through === null ? undefined : numericQuery(url, "through_sequence", 0, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, { data: service.readHistoryContext(actor, sessionId, view, throughSequence) });
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

      if (sessionId && parts[3] === "agent-requests" && parts[4] && parts[5] === "pause" && parts.length === 6 && request.method === "POST") {
        PauseAgentRequestInputSchema.parse(await readAuthenticatedJson());
        sendJson(response, 200, { data: service.pauseAgentRequest(actor, sessionId, parts[4]) });
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
          input.claim_attempt,
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
          input.claim_attempt,
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
  const registrationCleanup = setInterval(() => {
    try { database.registration.cleanup(); } catch { console.warn("Registration retention cleanup failed"); }
  }, 60_000);
  registrationCleanup.unref();

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
      clearInterval(registrationCleanup);
      unsubscribe();
      dshPairings.clear();
      for (const socket of sockets.keys()) socket.terminate();
      wsServer.close();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      await hostedGithub?.close();
      database.close();
      if (ephemeralCodeDirectory) rmSync(ephemeralCodeDirectory, { recursive: true, force: true });
    },
  };
}
