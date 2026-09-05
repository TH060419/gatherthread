import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  HttpCollaborationClient,
  type ProjectSummary,
} from "@gatherthread/bridge";
import {
  DSH_NPM_COMPATIBILITY,
} from "./dsh-compat.js";
import {
  parseDshHostConfig,
  type EnabledDshProjectHostConfig,
} from "./config.js";

export const DSH_NATIVE_CREDENTIAL_KEY = "gatherthread-dsh-host/default";
export const DSH_NATIVE_GRANT_SCHEMA_VERSION = 1;
export const DSH_NATIVE_PAIRING_CHANNEL = "/gatherthread";
export const DSH_NATIVE_MAX_RESPONSE_BYTES = 64 * 1_024;

export interface DshNativeBinding {
  readonly projectId: string;
  readonly projectName: string;
  readonly provider: string;
  readonly model: string;
}

export interface DshNativeGrant {
  readonly schemaVersion: 1;
  readonly serverUrl: string;
  readonly apiUrl: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly token: string;
  readonly binding?: DshNativeBinding;
}

export interface DshNativePairingView {
  readonly schemaVersion: 1;
  readonly status: "pending";
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export interface DshNativePairingIntent extends DshNativePairingView {
  readonly pairingId: string;
  readonly pollToken: string;
  readonly apiUrl: string;
  readonly serverUrl: string;
  readonly deviceName: string;
}

export type DshNativePairingPoll =
  | {
    readonly status: "pending";
    readonly expiresAt: string;
    readonly intervalSeconds: number;
  }
  | {
    readonly status: "paired";
    readonly deviceId: string;
    readonly token: string;
  };

interface DshCredentialRecordLike {
  readonly kind: string;
  readonly payload?: unknown;
}

interface DshCredentialsLike {
  readRecord(key: string): Promise<DshCredentialRecordLike | undefined>;
  modifyRecord(
    key: string,
    mutate: (
      current: DshCredentialRecordLike | undefined,
    ) => Promise<DshCredentialRecordLike | undefined>,
  ): Promise<DshCredentialRecordLike | undefined>;
  deleteRecord(key: string): Promise<void>;
}

/**
 * The only native credential boundary. The public Client contract exposes
 * presence and labels only; the opaque grant value never crosses DSH RPC.
 */
export class DshNativeCredentialStore {
  readonly #credentials: DshCredentialsLike;

  constructor(contextValue: unknown) {
    this.#credentials = requireCredentials(contextValue);
  }

  async load(): Promise<DshNativeGrant | undefined> {
    const record = await this.#credentials.readRecord(DSH_NATIVE_CREDENTIAL_KEY);
    if (record === undefined) return undefined;
    if (record.kind !== "grant") {
      throw new Error("GatherThread DSH credential record has an incompatible kind");
    }
    return parseNativeGrant(record.payload);
  }

  async save(grantValue: DshNativeGrant): Promise<DshNativeGrant> {
    const grant = parseNativeGrant(grantValue);
    const record = await this.#credentials.modifyRecord(
      DSH_NATIVE_CREDENTIAL_KEY,
      async (current) => {
        if (current !== undefined && current.kind !== "grant") {
          throw new Error("GatherThread DSH credential record has an incompatible kind");
        }
        return { kind: "grant", payload: grant };
      },
    );
    if (record?.kind !== "grant") {
      throw new Error("DSH credential provider did not persist the GatherThread grant");
    }
    return parseNativeGrant(record.payload);
  }

  async clear(): Promise<void> {
    await this.#credentials.deleteRecord(DSH_NATIVE_CREDENTIAL_KEY);
  }
}

export function publicPairingView(intent: DshNativePairingIntent): DshNativePairingView {
  return {
    schemaVersion: 1,
    status: "pending",
    userCode: intent.userCode,
    verificationUrl: intent.verificationUrl,
    expiresAt: intent.expiresAt,
    intervalSeconds: intent.intervalSeconds,
  };
}

export async function beginDshNativePairing(options: {
  readonly serverUrl: string;
  readonly deviceName: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<DshNativePairingIntent> {
  const target = normalizeDshServerUrl(options.serverUrl);
  const deviceName = boundedText(options.deviceName, "device name", 120);
  const body = requiredObject(await requestJson(
    `${target.apiUrl}/dsh-pairings`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ device_name: deviceName }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    options.fetch,
  ));
  const payload = requiredObject(body.data);
  const pairingId = safeIdentifier(payload.pairing_id, "pairing id");
  const pollToken = pairingSecret(payload.poll_token, "pairing poll token", "gtp_");
  const userCode = requiredString(payload.user_code, "pairing user code", 9);
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(userCode)) {
    throw new Error("GatherThread returned an invalid DSH pairing code");
  }
  const verificationPath = requiredString(payload.verification_path, "verification path", 2_048);
  if (!verificationPath.startsWith("/") || verificationPath.startsWith("//")) {
    throw new Error("GatherThread returned an invalid DSH verification path");
  }
  const verificationUrl = new URL(verificationPath, `${target.serverUrl}/`).toString();
  if (new URL(verificationUrl).origin !== new URL(target.serverUrl).origin) {
    throw new Error("GatherThread returned a cross-origin DSH verification path");
  }
  return {
    schemaVersion: 1,
    status: "pending",
    pairingId,
    pollToken,
    userCode,
    verificationUrl,
    expiresAt: timestamp(payload.expires_at, "pairing expiry"),
    intervalSeconds: boundedInteger(payload.interval_seconds, "pairing interval", 1, 30),
    apiUrl: target.apiUrl,
    serverUrl: target.serverUrl,
    deviceName,
  };
}

export async function pollDshNativePairing(
  intent: DshNativePairingIntent,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
  } = {},
): Promise<DshNativePairingPoll> {
  const body = requiredObject(await requestJson(
    `${intent.apiUrl}/dsh-pairings/${encodeURIComponent(intent.pairingId)}/poll`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `DSH-Pairing ${intent.pollToken}`,
        "content-type": "application/json",
      },
      body: "{}",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    options.fetch,
    new Set([200, 201, 202]),
  ));
  const payload = requiredObject(body.data);
  if (payload.status === "pending") {
    return {
      status: "pending",
      expiresAt: timestamp(payload.expires_at, "pairing expiry"),
      intervalSeconds: boundedInteger(payload.interval_seconds, "pairing interval", 1, 30),
    };
  }
  if (payload.status !== "paired") {
    throw new Error("GatherThread returned an invalid DSH pairing status");
  }
  return {
    status: "paired",
    deviceId: safeIdentifier(payload.device_id, "paired device id"),
    token: pairingSecret(payload.token, "paired device credential", "gta_"),
  };
}

export function createNativeProjectConfig(options: {
  readonly grant: DshNativeGrant;
  readonly binding: DshNativeBinding;
  readonly workspacePath: string;
  readonly dshHome?: string;
}): EnabledDshProjectHostConfig {
  const stateRoot = nativeStateRoot(
    options.dshHome ?? resolveDshHome(process.env),
    options.grant.serverUrl,
    options.binding.projectId,
    options.workspacePath,
  );
  const parsed = parseDshHostConfig({
    enabled: true,
    bindingMode: "project",
    apiUrl: options.grant.apiUrl,
    credentialReference: {
      kind: "environment",
      variable: "GATHERTHREAD_DSH_NATIVE_GRANT_INTERNAL",
    },
    projectId: options.binding.projectId,
    projectName: options.binding.projectName,
    deviceId: options.grant.deviceId,
    workspacePath: path.resolve(options.workspacePath),
    stateRoot,
    provider: options.binding.provider,
    model: options.binding.model,
    pollIntervalMs: 1_000,
    pollLimit: 200,
    shareToolEvents: false,
    refreshIntervalMs: 5_000,
    maxConcurrentSessions: 4,
    retryBaseMs: 1_000,
    retryMaxMs: 30_000,
  });
  if (!parsed.enabled || parsed.bindingMode !== "project") {
    throw new Error("Native DSH project configuration did not resolve to project mode");
  }
  return {
    ...parsed,
    credentialReference: {
      kind: "dsh-grant",
      key: DSH_NATIVE_CREDENTIAL_KEY,
    },
  };
}

export function createNativeCollaborationClient(grant: DshNativeGrant, signal?: AbortSignal) {
  return new HttpCollaborationClient({
    baseUrl: grant.apiUrl,
    bearerToken: grant.token,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function activeNativeProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  return projects
    .filter((project) => project.state === "active")
    .map((project) => ({ ...project }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function parseNativeGrant(value: unknown): DshNativeGrant {
  const input = exactObject(value, new Set([
    "schemaVersion",
    "serverUrl",
    "apiUrl",
    "deviceId",
    "deviceName",
    "token",
    "binding",
  ]), "GatherThread DSH grant");
  if (input.schemaVersion !== DSH_NATIVE_GRANT_SCHEMA_VERSION) {
    throw new Error("GatherThread DSH credential grant has an unsupported schema version");
  }
  const normalized = normalizeDshServerUrl(requiredString(input.serverUrl, "server URL", 2_048));
  const apiUrl = requiredString(input.apiUrl, "API URL", 2_048);
  if (apiUrl !== normalized.apiUrl) {
    throw new Error("GatherThread DSH credential grant has inconsistent server identity");
  }
  const binding = input.binding === undefined ? undefined : parseBinding(input.binding);
  return {
    schemaVersion: 1,
    serverUrl: normalized.serverUrl,
    apiUrl: normalized.apiUrl,
    deviceId: safeIdentifier(input.deviceId, "device id"),
    deviceName: boundedText(input.deviceName, "device name", 120),
    token: pairingSecret(input.token, "device credential", "gta_"),
    ...(binding === undefined ? {} : { binding }),
  };
}

export function normalizeDshServerUrl(value: string): {
  readonly serverUrl: string;
  readonly apiUrl: string;
} {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("GatherThread server must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GatherThread server must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("GatherThread server cannot contain credentials, a query, or a fragment");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("GatherThread DSH pairing requires HTTPS except on loopback");
  }
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (pathname !== "/" && pathname !== "/v1") {
    throw new Error("GatherThread server URL path must be empty or /v1");
  }
  const serverUrl = url.origin;
  return { serverUrl, apiUrl: `${serverUrl}/v1` };
}

export function dshNpmLaunchCommand(): string {
  return `npx ${DSH_NPM_COMPATIBILITY.package} web`;
}

function nativeStateRoot(
  dshHome: string,
  serverUrl: string,
  projectId: string,
  workspacePath: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([serverUrl, projectId, path.resolve(workspacePath)]))
    .digest("hex")
    .slice(0, 32);
  return path.join(path.resolve(dshHome), "gatherthread", "state", digest);
}

function resolveDshHome(env: NodeJS.ProcessEnv): string {
  const configured = env.DSH_HOME?.trim();
  return path.resolve(configured ? configured : path.join(homedir(), ".dsh"));
}

function parseBinding(value: unknown): DshNativeBinding {
  const input = exactObject(value, new Set([
    "projectId",
    "projectName",
    "provider",
    "model",
  ]), "GatherThread DSH binding");
  return {
    projectId: safeIdentifier(input.projectId, "project id"),
    projectName: boundedText(input.projectName, "project name", 160),
    provider: boundedText(input.provider, "provider", 80),
    model: boundedText(input.model, "model", 160),
  };
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchOverride: typeof globalThis.fetch | undefined,
  acceptedStatuses = new Set([200, 201]),
): Promise<unknown> {
  const response = await (fetchOverride ?? globalThis.fetch)(url, {
    ...init,
    redirect: "error",
  });
  if (!acceptedStatuses.has(response.status)) {
    throw new Error(`GatherThread DSH pairing request failed with HTTP ${String(response.status)}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > DSH_NATIVE_MAX_RESPONSE_BYTES) {
    throw new Error("GatherThread DSH pairing response exceeded the size limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > DSH_NATIVE_MAX_RESPONSE_BYTES) {
    throw new Error("GatherThread DSH pairing response exceeded the size limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("GatherThread DSH pairing response was not valid JSON");
  }
}

function exactObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  const input = requiredObject(value);
  if (Object.keys(input).some((key) => !keys.has(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
  return input;
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GatherThread returned an invalid DSH pairing object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`GatherThread returned an invalid ${label}`);
  }
  return value.trim();
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const text = requiredString(value, label, maximum);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`GatherThread returned an invalid ${label}`);
  }
  return text;
}

function safeIdentifier(value: unknown, label: string): string {
  const text = requiredString(value, label, 128);
  if (!/^[A-Za-z0-9._:-]+$/u.test(text)) {
    throw new Error(`GatherThread returned an invalid ${label}`);
  }
  return text;
}

function pairingSecret(value: unknown, label: string, prefix: string): string {
  const text = requiredString(value, label, 512);
  if (!text.startsWith(prefix) || /\s/u.test(text) || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`GatherThread returned an invalid ${label}`);
  }
  return text;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`GatherThread returned an invalid ${label}`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  const text = requiredString(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`GatherThread returned an invalid ${label}`);
  }
  return text;
}

function requireCredentials(contextValue: unknown): DshCredentialsLike {
  if (!contextValue || typeof contextValue !== "object") {
    throw new Error("Unsupported DeepSeek Harness Host context");
  }
  const direct = Reflect.get(contextValue, "credentials") as unknown;
  const context = contextValue as { get?: (name: string) => unknown };
  const candidate = direct ?? context.get?.("credentials");
  if (!candidate || typeof candidate !== "object"
    || typeof Reflect.get(candidate, "readRecord") !== "function"
    || typeof Reflect.get(candidate, "modifyRecord") !== "function"
    || typeof Reflect.get(candidate, "deleteRecord") !== "function") {
    throw new Error("Pinned DSH Host service credentials is unavailable or incompatible");
  }
  return candidate as DshCredentialsLike;
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4
    && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}
