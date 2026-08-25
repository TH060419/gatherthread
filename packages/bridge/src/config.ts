import { homedir } from "node:os";
import path from "node:path";
import type { HarnessName } from "@gatherthread/adapters";
import type { RuntimeRegistration } from "./types.js";

export interface GatherThreadConnectionConfig {
  apiUrl: string;
  bearerToken: string;
  requestTimeoutMs: number;
}

export interface BridgeDaemonConfig {
  connection: GatherThreadConnectionConfig;
  runtime: RuntimeRegistration;
  cursorPath: string;
  pollIntervalMs: number;
  pollLimit: number;
  adapter: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

export function loadGatherThreadConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatherThreadConnectionConfig {
  const apiUrl = normalizeApiUrl(requiredEnv(env, "GATHERTHREAD_API_URL"));
  const bearerToken = requiredEnv(env, "GATHERTHREAD_TOKEN", false);
  if (!bearerToken.trim() || /[\r\n]/.test(bearerToken)) {
    throw new Error("GATHERTHREAD_TOKEN must be non-empty and cannot contain line breaks");
  }
  return {
    apiUrl,
    bearerToken,
    requestTimeoutMs: integerEnv(env, "GATHERTHREAD_REQUEST_TIMEOUT_MS", 30_000, 100, 600_000),
  };
}

export function loadBridgeDaemonConfig(
  env: NodeJS.ProcessEnv = process.env,
): BridgeDaemonConfig {
  const connection = loadGatherThreadConnectionConfig(env);
  const harness = enumEnv(env, "GATHERTHREAD_HARNESS", ["codex", "claude-code"] as const);
  const args = jsonStringArrayEnv(env, "GATHERTHREAD_ADAPTER_ARGS_JSON", []);
  if (args.some((argument) => argument.includes(connection.bearerToken))) {
    throw new Error("GATHERTHREAD_TOKEN must not be included in adapter arguments");
  }
  const capabilities = optionalJsonStringArrayEnv(env, "GATHERTHREAD_CAPABILITIES_JSON");
  const runtime: RuntimeRegistration = {
    sessionId: requiredEnv(env, "GATHERTHREAD_SESSION_ID"),
    deviceId: requiredEnv(env, "GATHERTHREAD_DEVICE_ID"),
    harness,
    provider: requiredEnv(env, "GATHERTHREAD_PROVIDER"),
    model: requiredEnv(env, "GATHERTHREAD_MODEL"),
    localSessionId: requiredEnv(env, "GATHERTHREAD_LOCAL_SESSION_ID"),
    captureFidelity: "harness_transcript",
    ...(capabilities === undefined ? {} : { capabilities }),
  };
  return {
    connection,
    runtime,
    cursorPath: path.resolve(env.GATHERTHREAD_CURSOR_PATH?.trim()
      || path.join(homedir(), ".gatherthread", "bridge-cursor.json")),
    pollIntervalMs: integerEnv(env, "GATHERTHREAD_POLL_INTERVAL_MS", 1_000, 50, 60_000),
    pollLimit: integerEnv(env, "GATHERTHREAD_POLL_LIMIT", 200, 1, 500),
    adapter: {
      command: requiredEnv(env, "GATHERTHREAD_ADAPTER_COMMAND"),
      args,
      timeoutMs: integerEnv(env, "GATHERTHREAD_ADAPTER_TIMEOUT_MS", 300_000, 100, 3_600_000),
      maxOutputBytes: integerEnv(env, "GATHERTHREAD_ADAPTER_MAX_OUTPUT_BYTES", 4_194_304, 1_024, 67_108_864),
    },
  };
}

export function booleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback = false,
): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GATHERTHREAD_API_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GATHERTHREAD_API_URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("GATHERTHREAD_API_URL cannot contain credentials, a query, or a fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("GATHERTHREAD_API_URL must use HTTPS except for a loopback host");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string, trim = true): string {
  const raw = env[name];
  const value = trim ? raw?.trim() : raw;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function enumEnv<const T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: T,
): T[number] {
  const value = requiredEnv(env, name);
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value as T[number];
}

function jsonStringArrayEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: readonly string[],
): readonly string[] {
  const value = optionalJsonStringArrayEnv(env, name);
  return value ?? fallback;
}

function optionalJsonStringArrayEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): readonly string[] | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed as string[];
}
