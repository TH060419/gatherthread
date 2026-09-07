import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { prospectiveRealPath, secureDirectoryChain } from "./path-security.js";

const CONFIG_KEYS = new Set([
  "enabled",
  "bindingMode",
  "apiUrl",
  "credentialReference",
  "projectId",
  "projectName",
  "sessionId",
  "deviceId",
  "workspacePath",
  "statePath",
  "stateRoot",
  "provider",
  "model",
  "pollIntervalMs",
  "pollLimit",
  "shareToolEvents",
  "refreshIntervalMs",
  "maxConcurrentSessions",
  "retryBaseMs",
  "retryMaxMs",
]);

const SINGLE_ONLY_KEYS = ["sessionId", "statePath"] as const;
const PROJECT_ONLY_KEYS = [
  "stateRoot",
  "refreshIntervalMs",
  "maxConcurrentSessions",
  "retryBaseMs",
  "retryMaxMs",
] as const;

export interface DisabledDshHostConfig {
  enabled: false;
}

export type DshCredentialReference =
  | {
    kind: "environment";
    variable: string;
  }
  | {
    kind: "dsh-grant";
    key: string;
  };

export interface EnabledDshHostConfig {
  enabled: true;
  bindingMode: "single";
  apiUrl: string;
  credentialReference: DshCredentialReference;
  projectId: string;
  projectName?: string;
  sessionId: string;
  deviceId: string;
  workspacePath: string;
  statePath: string;
  provider: string;
  model: string;
  pollIntervalMs: number;
  pollLimit: number;
  shareToolEvents: boolean;
  dshSessionId: string;
}

export interface EnabledDshProjectHostConfig {
  enabled: true;
  bindingMode: "project";
  apiUrl: string;
  credentialReference: EnabledDshHostConfig["credentialReference"];
  projectId: string;
  projectName?: string;
  deviceId: string;
  workspacePath: string;
  stateRoot: string;
  provider: string;
  model: string;
  pollIntervalMs: number;
  pollLimit: number;
  shareToolEvents: boolean;
  refreshIntervalMs: number;
  maxConcurrentSessions: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export type DshHostConfig =
  | DisabledDshHostConfig
  | EnabledDshHostConfig
  | EnabledDshProjectHostConfig;

export function parseDshHostConfig(input: unknown): DshHostConfig {
  if (input === undefined) return { enabled: false };
  const value = requiredObject(input, "config");
  rejectUnknownKeys(value, CONFIG_KEYS, "config");
  if (value.enabled !== true) {
    if (value.enabled !== undefined && value.enabled !== false) {
      throw new Error("config.enabled must be true or false");
    }
    return { enabled: false };
  }

  const bindingMode = value.bindingMode === undefined ? "single" : value.bindingMode;
  if (bindingMode !== "single" && bindingMode !== "project") {
    throw new Error("config.bindingMode must be single or project");
  }
  rejectModeKeys(value, bindingMode === "single" ? PROJECT_ONLY_KEYS : SINGLE_ONLY_KEYS, bindingMode);

  const workspacePath = absolutePath(value.workspacePath, "config.workspacePath");
  const credential = requiredObject(value.credentialReference, "config.credentialReference");
  rejectUnknownKeys(
    credential,
    new Set(["kind", "variable"]),
    "config.credentialReference",
  );
  if (credential.kind !== "environment") {
    throw new Error("config.credentialReference.kind must be environment");
  }
  const variable = requiredString(credential.variable, "config.credentialReference.variable", 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) {
    throw new Error("config.credentialReference.variable must be an uppercase environment variable name");
  }

  const projectId = safeIdentifier(value.projectId, "config.projectId");
  const projectName = value.projectName === undefined
    ? undefined
    : safeText(value.projectName, "config.projectName", 160);
  const deviceId = safeIdentifier(value.deviceId, "config.deviceId");
  const provider = safeText(value.provider, "config.provider", 80);
  const model = safeText(value.model, "config.model", 160);

  const common = {
    enabled: true as const,
    apiUrl: normalizeApiUrl(requiredString(value.apiUrl, "config.apiUrl", 2_048)),
    credentialReference: { kind: "environment" as const, variable },
    projectId,
    ...(projectName === undefined ? {} : { projectName }),
    deviceId,
    workspacePath,
    provider,
    model,
    pollIntervalMs: boundedInteger(value.pollIntervalMs, 1_000, 50, 60_000, "config.pollIntervalMs"),
    pollLimit: boundedInteger(value.pollLimit, 200, 1, 500, "config.pollLimit"),
    shareToolEvents: optionalBoolean(value.shareToolEvents, false, "config.shareToolEvents"),
  };

  if (bindingMode === "project") {
    const stateRoot = absolutePath(value.stateRoot, "config.stateRoot");
    if (isWithin(workspacePath, stateRoot)) {
      throw new Error("config.stateRoot must be outside the read-only workspace");
    }
    const retryBaseMs = boundedInteger(value.retryBaseMs, 1_000, 50, 60_000, "config.retryBaseMs");
    const retryMaxMs = boundedInteger(value.retryMaxMs, 30_000, 50, 300_000, "config.retryMaxMs");
    if (retryMaxMs < retryBaseMs) {
      throw new Error("config.retryMaxMs must be greater than or equal to config.retryBaseMs");
    }
    return {
      ...common,
      bindingMode,
      stateRoot,
      refreshIntervalMs: boundedInteger(
        value.refreshIntervalMs,
        5_000,
        250,
        300_000,
        "config.refreshIntervalMs",
      ),
      maxConcurrentSessions: boundedInteger(
        value.maxConcurrentSessions,
        4,
        1,
        32,
        "config.maxConcurrentSessions",
      ),
      retryBaseMs,
      retryMaxMs,
    };
  }

  const sessionId = safeIdentifier(value.sessionId, "config.sessionId");
  const statePath = absolutePath(value.statePath, "config.statePath");
  if (isWithin(workspacePath, statePath)) {
    throw new Error("config.statePath must be outside the read-only workspace");
  }

  return {
    ...common,
    bindingMode,
    sessionId,
    statePath,
    dshSessionId: deriveDshSessionId(projectId, sessionId, workspacePath),
  };
}

export function assertSafeDshEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const telemetryDisabled = env.DSH_TELEMETRY_DISABLED === "1"
    || env.DSH_TELEMETRY_MODE?.trim().toUpperCase() === "DISABLED";
  if (!telemetryDisabled) {
    throw new Error("DeepSeek Harness telemetry must be disabled for the GatherThread host plugin");
  }
  if (env.DSH_PERMISSION_MODE?.trim().toLowerCase() !== "read-only") {
    throw new Error("DSH_PERMISSION_MODE must be read-only for the GatherThread host plugin MVP");
  }
}

/**
 * Activation-time filesystem boundary. Lexically separate paths are not
 * sufficient because an existing ancestor may redirect through a symlink.
 */
export async function assertSafeDshPaths(
  config: { workspacePath: string; statePath: string },
): Promise<void> {
  await assertRealStateSeparation(config.workspacePath, config.statePath, "config.statePath");
  await secureDirectoryChain(path.dirname(config.statePath));
  try {
    const target = await lstat(config.statePath);
    if (target.isSymbolicLink()) {
      throw new Error("config.statePath must never be a symbolic link");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

export async function assertSafeDshStateRoot(
  config: Pick<EnabledDshProjectHostConfig, "workspacePath" | "stateRoot">,
): Promise<void> {
  await assertRealStateSeparation(config.workspacePath, config.stateRoot, "config.stateRoot");
  await secureDirectoryChain(config.stateRoot);
  try {
    const target = await lstat(config.stateRoot);
    if (target.isSymbolicLink() || !target.isDirectory()) {
      throw new Error("config.stateRoot must be a real directory, never a symbolic link");
    }
    if (process.platform !== "win32" && (Number(target.mode) & 0o777) !== 0o700) {
      throw new Error("config.stateRoot permissions must be 0700");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function assertRealStateSeparation(
  workspacePath: string,
  stateLocation: string,
  label: string,
): Promise<void> {
  const [workspaceRealPath, stateRealPath] = await Promise.all([
    prospectiveRealPath(workspacePath),
    prospectiveRealPath(stateLocation),
  ]);
  if (isWithin(workspaceRealPath, stateRealPath)) {
    throw new Error(`${label} real path must be outside the read-only workspace`);
  }
}

function rejectModeKeys(
  value: Record<string, unknown>,
  forbidden: readonly string[],
  bindingMode: "single" | "project",
): void {
  const present = forbidden.filter((key) => value[key] !== undefined);
  if (present.length > 0) {
    throw new Error(`config bindingMode ${bindingMode} does not accept: ${present.join(", ")}`);
  }
}

export function resolveCredentialReference(
  reference: EnabledDshHostConfig["credentialReference"],
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (reference.kind !== "environment") {
    throw new Error("DSH grant credentials must be resolved by the native Host boundary");
  }
  const credential = env[reference.variable];
  if (!credential || !credential.trim() || /[\r\n]/.test(credential)) {
    throw new Error(`credential reference ${reference.variable} is missing or invalid`);
  }
  return credential;
}

export function deriveDshSessionId(
  projectId: string,
  sessionId: string,
  workspacePath: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([projectId, sessionId, path.resolve(workspacePath)]))
    .digest("hex")
    .slice(0, 32);
  return `gatherthread-${digest}`;
}

/**
 * Native Web projections use a versioned identity so Sessions created by the
 * earlier read-only integration are not resumed under an incompatible preset.
 */
export function deriveNativeDshSessionId(
  projectId: string,
  sessionId: string,
  workspacePath: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["native-web-v2", projectId, sessionId, path.resolve(workspacePath)]))
    .digest("hex")
    .slice(0, 32);
  return `gatherthread-${digest}`;
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("config.apiUrl must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("config.apiUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("config.apiUrl cannot contain credentials, a query, or a fragment");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("config.apiUrl must use HTTPS except for a loopback host");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function safeIdentifier(value: unknown, label: string): string {
  const text = requiredString(value, label, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error(`${label} contains unsupported characters`);
  return text;
}

function safeText(value: unknown, label: string, maximum: number): string {
  const text = requiredString(value, label, maximum);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) throw new Error(`${label} contains control characters`);
  return text;
}

function absolutePath(value: unknown, label: string): string {
  const text = requiredString(value, label, 4_096);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be absolute`);
  return path.resolve(text);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported keys: ${unknown.join(", ")}`);
}
