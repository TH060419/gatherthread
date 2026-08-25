import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const EnvironmentSchema = z.enum(["development", "test", "production"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const PLACEHOLDER_SECRET = /^(?:change|dummy|example|placeholder|replace|secret|test)(?:[-_ ].*)?$/i;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface ServerConfig {
  environment: z.infer<typeof EnvironmentSchema>;
  host: string;
  port: number;
  databasePath: string;
  staticDirectory: string;
  publicBaseUrl: string;
  allowedOrigins: string[];
  authTokenPepper?: string;
  allowHttpBootstrap: boolean;
  secureTransport: boolean;
  maxUserEventBytes: number;
  maxSessionEventBytes: number;
  maxTotalEventBytes: number;
  maxEventBytes: number;
}

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) throw new ConfigurationError(`${name} must be an integer from 1 to 65535`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigurationError(`${name} must be exactly true or false`);
}

function parseByteLimit(name: string, raw: string | undefined, fallback: number, minimum = 1024 * 1024): number {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) throw new ConfigurationError(`${name} must be a positive integer number of bytes`);
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < minimum) {
    throw new ConfigurationError(`${name} must be a safe integer of at least ${minimum} bytes`);
  }
  return bytes;
}

function parseLoopbackHost(raw: string | undefined): string {
  const host = raw?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigurationError("GATHERTHREAD_SERVER_HOST must be a loopback host (127.0.0.1, ::1, or localhost)");
  }
  return host;
}

function parseOrigin(name: string, raw: string, requireHttps: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`${name} must contain absolute HTTP(S) origins`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new ConfigurationError(`${name} must contain absolute HTTP(S) origins without credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash || raw.replace(/\/$/, "") !== url.origin) {
    throw new ConfigurationError(`${name} entries must be exact origins without paths, queries, or fragments`);
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new ConfigurationError(`${name} must use HTTPS in production`);
  }
  return url.origin;
}

function parseOrigins(raw: string | undefined, requireHttps: boolean): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const origins = raw.split(",").map((item) => item.trim());
  if (origins.some((origin) => origin === "")) {
    throw new ConfigurationError("GATHERTHREAD_ALLOWED_ORIGINS must not contain empty entries");
  }
  return [...new Set(origins.map((origin) => parseOrigin("GATHERTHREAD_ALLOWED_ORIGINS", origin, requireHttps)))];
}

function resolvePath(raw: string | undefined, fallback: string, cwd: string): string {
  const candidate = raw?.trim() || fallback;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ServerConfig {
  const environmentResult = EnvironmentSchema.safeParse(env.NODE_ENV ?? "development");
  if (!environmentResult.success) {
    throw new ConfigurationError("NODE_ENV must be development, test, or production");
  }
  const environment = environmentResult.data;
  const isProduction = environment === "production";
  const host = parseLoopbackHost(env.GATHERTHREAD_SERVER_HOST);
  const port = parsePort("GATHERTHREAD_SERVER_PORT", env.GATHERTHREAD_SERVER_PORT, 8787);
  const databasePath = resolvePath(env.GATHERTHREAD_DATABASE_PATH, ".local/collaboration.sqlite", cwd);
  const staticDirectory = resolvePath(env.GATHERTHREAD_STATIC_DIRECTORY, "apps/web/dist", cwd);
  const configuredPublicBaseUrl = env.GATHERTHREAD_PUBLIC_BASE_URL?.trim();
  if (isProduction && !configuredPublicBaseUrl) {
    throw new ConfigurationError("GATHERTHREAD_PUBLIC_BASE_URL is required in production");
  }
  const publicBaseUrl = parseOrigin(
    "GATHERTHREAD_PUBLIC_BASE_URL",
    configuredPublicBaseUrl || `http://127.0.0.1:${port}`,
    isProduction,
  );
  const configuredOrigins = parseOrigins(env.GATHERTHREAD_ALLOWED_ORIGINS, isProduction);
  const allowedOrigins = [...new Set([publicBaseUrl, ...configuredOrigins])];
  const secureTransport = parseBoolean("GATHERTHREAD_TLS_TERMINATED_BY_PROXY", env.GATHERTHREAD_TLS_TERMINATED_BY_PROXY, false);
  const allowHttpBootstrap = parseBoolean("GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP", env.GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP, false);
  const maxUserEventBytes = parseByteLimit("GATHERTHREAD_MAX_USER_EVENT_BYTES", env.GATHERTHREAD_MAX_USER_EVENT_BYTES, 256 * 1024 * 1024);
  const maxSessionEventBytes = parseByteLimit("GATHERTHREAD_MAX_SESSION_EVENT_BYTES", env.GATHERTHREAD_MAX_SESSION_EVENT_BYTES, 512 * 1024 * 1024);
  const maxTotalEventBytes = parseByteLimit("GATHERTHREAD_MAX_TOTAL_EVENT_BYTES", env.GATHERTHREAD_MAX_TOTAL_EVENT_BYTES, 2 * 1024 * 1024 * 1024);
  const maxEventBytes = parseByteLimit("GATHERTHREAD_MAX_EVENT_BYTES", env.GATHERTHREAD_MAX_EVENT_BYTES, 256 * 1024, 1024);
  const rawAuthTokenPepper = env.GATHERTHREAD_AUTH_TOKEN_PEPPER;
  if (rawAuthTokenPepper !== undefined && rawAuthTokenPepper !== rawAuthTokenPepper.trim()) {
    throw new ConfigurationError("GATHERTHREAD_AUTH_TOKEN_PEPPER must not have leading or trailing whitespace");
  }
  const authTokenPepper = rawAuthTokenPepper || undefined;

  if (databasePath === staticDirectory || isWithin(staticDirectory, databasePath)) {
    throw new ConfigurationError("GATHERTHREAD_DATABASE_PATH must not be inside GATHERTHREAD_STATIC_DIRECTORY");
  }
  if (maxSessionEventBytes > maxTotalEventBytes || maxUserEventBytes > maxTotalEventBytes
    || maxEventBytes > Math.min(maxUserEventBytes, maxSessionEventBytes, maxTotalEventBytes)) {
    throw new ConfigurationError("Event, per-user, and per-session limits must fit within GATHERTHREAD_MAX_TOTAL_EVENT_BYTES");
  }
  if (isProduction) {
    if (!secureTransport) {
      throw new ConfigurationError("GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true is required in production");
    }
    if (allowHttpBootstrap) {
      throw new ConfigurationError("GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP cannot be enabled in production; use the local bootstrap command");
    }
    if (!authTokenPepper || Buffer.byteLength(authTokenPepper, "utf8") < 32 || PLACEHOLDER_SECRET.test(authTokenPepper)) {
      throw new ConfigurationError("GATHERTHREAD_AUTH_TOKEN_PEPPER must be a non-placeholder secret of at least 32 bytes in production");
    }
    if (env.GATHERTHREAD_DATABASE_PATH?.trim() === ":memory:") {
      throw new ConfigurationError("GATHERTHREAD_DATABASE_PATH must be durable in production");
    }
  }

  return {
    environment,
    host,
    port,
    databasePath,
    staticDirectory,
    publicBaseUrl,
    allowedOrigins,
    ...(authTokenPepper ? { authTokenPepper } : {}),
    allowHttpBootstrap,
    secureTransport,
    maxUserEventBytes,
    maxSessionEventBytes,
    maxTotalEventBytes,
    maxEventBytes,
  };
}

export function prepareDatabaseDirectory(config: ServerConfig): void {
  const directory = dirname(config.databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);

  if (config.environment !== "production") return;
  const info = statSync(directory);
  if (!info.isDirectory()) throw new ConfigurationError("The database parent must be a directory");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ConfigurationError("The production database directory must not grant group or other permissions (use mode 0700)");
  }
}

export function assertPersistentCredentialPepper(config: ServerConfig): asserts config is ServerConfig & { authTokenPepper: string } {
  if (!config.authTokenPepper || Buffer.byteLength(config.authTokenPepper, "utf8") < 32) {
    throw new ConfigurationError(
      "GATHERTHREAD_AUTH_TOKEN_PEPPER must contain at least 32 bytes so credentials remain valid across owner-host restarts",
    );
  }
}

export function assertStaticDirectory(config: ServerConfig): void {
  const info = statSync(config.staticDirectory, { throwIfNoEntry: false });
  if (!info?.isDirectory()) {
    throw new ConfigurationError(`Static Web build not found at ${config.staticDirectory}; run npm run build:web`);
  }
}
