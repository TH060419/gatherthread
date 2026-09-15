import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { redactValue } from "@gatherthread/adapters";
import {
  assertSameDirectoryChain,
  secureDirectoryChain,
} from "./path-security.js";
import type {
  ConnectorOutboxOperation,
  ConnectorState,
  ConnectorStateStore,
  DshAppendEventInput,
} from "./types.js";
import type { CommitLocalTurnInput, CompleteAgentRequestInput } from "@gatherthread/bridge";

export class MemoryConnectorStateStore implements ConnectorStateStore {
  #state: ConnectorState | undefined;

  constructor(initial?: unknown) {
    this.#state = initial === undefined ? undefined : validateConnectorState(structuredClone(initial));
  }

  async load(): Promise<ConnectorState | undefined> {
    return this.#state === undefined ? undefined : structuredClone(this.#state);
  }

  async save(state: ConnectorState): Promise<void> {
    this.#state = validateConnectorState(structuredClone(state));
  }
}

export class FileConnectorStateStore implements ConnectorStateStore {
  readonly #path: string;

  constructor(statePath: string) {
    if (!path.isAbsolute(statePath)) throw new Error("DSH connector state path must be absolute");
    this.#path = path.resolve(statePath);
  }

  async load(): Promise<ConnectorState | undefined> {
    const directory = path.dirname(this.#path);
    const ancestorsBefore = await secureDirectoryChain(directory);
    let metadata;
    try {
      metadata = await lstat(this.#path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    assertPrivateRegularFile(metadata, "DSH connector state");
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(this.#path, constants.O_RDONLY | noFollow);
    let raw: string;
    try {
      const opened = await handle.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new Error("DSH connector state path changed while opening");
      }
      raw = await handle.readFile({ encoding: "utf8" });
      assertSameDirectoryChain(
        ancestorsBefore,
        await secureDirectoryChain(directory),
      );
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("DSH connector state is not valid JSON");
    }
    return validateConnectorState(parsed);
  }

  async save(state: ConnectorState): Promise<void> {
    const validated = validateConnectorState(structuredClone(state));
    const directory = path.dirname(this.#path);
    await secureDirectoryChain(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const ancestorsBefore = await secureDirectoryChain(directory);
    const directoryBefore = await lstat(directory);
    assertSecureDirectory(directoryBefore);
    const targetBefore = await optionalLstat(this.#path);
    if (targetBefore !== undefined) assertPrivateRegularFile(targetBefore, "DSH connector state");
    const temporaryPath = `${this.#path}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const directoryAfter = await lstat(directory);
      if (directoryAfter.isSymbolicLink()
        || directoryAfter.dev !== directoryBefore.dev
        || directoryAfter.ino !== directoryBefore.ino) {
        throw new Error("DSH connector state directory changed during atomic save");
      }
      assertSameDirectoryChain(
        ancestorsBefore,
        await secureDirectoryChain(directory),
      );
      const targetAfter = await optionalLstat(this.#path);
      if (!sameArtifact(targetBefore, targetAfter)) {
        throw new Error("DSH connector state path changed during atomic save");
      }
      await rename(temporaryPath, this.#path);
      assertSameDirectoryChain(
        ancestorsBefore,
        await secureDirectoryChain(directory),
      );
      assertPrivateRegularFile(await lstat(this.#path), "DSH connector state");
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export function validateConnectorState(value: unknown): ConnectorState {
  const state = requiredObject(value, "state");
  const legacy = state.version === 1;
  const legacyUploadPolicy = state.version === 1 || state.version === 2;
  exactKeys(
    state,
    new Set([
      "version",
      "binding",
      "serverCursor",
      ...(legacy ? [] : ["projectionCursor"]),
      "publishedDshSequence",
      ...(legacyUploadPolicy ? [] : ["automaticUpload"]),
      "activeRequest",
      "outbox",
    ]),
    "state",
  );
  if (state.version !== 1 && state.version !== 2 && state.version !== 3) {
    throw new Error("Unsupported DSH connector state version");
  }
  const binding = requiredObject(state.binding, "state.binding");
  exactKeys(binding, new Set(["projectId", "sessionId", "dshSessionId"]), "state.binding");
  const serverCursor = nonNegativeInteger(state.serverCursor, "state.serverCursor");
  const publishedDshSequence = nonNegativeInteger(
    state.publishedDshSequence,
    "state.publishedDshSequence",
  );
  // V1 advanced serverCursor without ever materializing ordinary canonical
  // history. Reset only the native projection cursor so the first V2 start
  // safely backfills from sequence zero while retaining transport diagnostics.
  const projectionCursor = legacy
    ? 0
    : nonNegativeInteger(state.projectionCursor, "state.projectionCursor");
  const activeRequest = state.activeRequest === undefined
    ? undefined
    : parseActiveRequest(state.activeRequest);
  if (!Array.isArray(state.outbox)) throw new Error("state.outbox must be an array");
  const outbox = state.outbox.map(parseOutboxOperation);
  const validated: ConnectorState = {
    version: 3,
    binding: {
      projectId: safeString(binding.projectId, "state.binding.projectId", 128),
      sessionId: safeString(binding.sessionId, "state.binding.sessionId", 128),
      dshSessionId: safeString(binding.dshSessionId, "state.binding.dshSessionId", 128),
    },
    serverCursor,
    projectionCursor,
    publishedDshSequence,
    automaticUpload: legacyUploadPolicy
      ? true
      : requiredBoolean(state.automaticUpload, "state.automaticUpload"),
    ...(activeRequest === undefined ? {} : { activeRequest }),
    outbox,
  };
  assertAlreadyRedacted(validated);
  return validated;
}

function parseActiveRequest(value: unknown): NonNullable<ConnectorState["activeRequest"]> {
  const active = requiredObject(value, "state.activeRequest");
  exactKeys(
    active,
    new Set(["requestId", "requestSequence", "dshFromSequence", "dshToSequence", "promptDigest"]),
    "state.activeRequest",
  );
  const parsed = {
    requestId: safeString(active.requestId, "state.activeRequest.requestId", 128),
    requestSequence: positiveInteger(active.requestSequence, "state.activeRequest.requestSequence"),
    dshFromSequence: nonNegativeInteger(active.dshFromSequence, "state.activeRequest.dshFromSequence"),
    ...(active.dshToSequence === undefined ? {} : {
      dshToSequence: nonNegativeInteger(active.dshToSequence, "state.activeRequest.dshToSequence"),
    }),
    promptDigest: hexDigest(active.promptDigest, "state.activeRequest.promptDigest"),
  };
  if (parsed.dshToSequence !== undefined && parsed.dshToSequence < parsed.dshFromSequence) {
    throw new Error("state.activeRequest.dshToSequence cannot precede dshFromSequence");
  }
  return parsed;
}

function parseOutboxOperation(value: unknown, index: number): ConnectorOutboxOperation {
  const label = `state.outbox[${index}]`;
  const operation = requiredObject(value, label);
  const kind = operation.kind;
  if (kind === "append") {
    exactKeys(operation, new Set(["id", "kind", "input"]), label);
    return {
      id: safeString(operation.id, `${label}.id`, 200),
      kind,
      input: parseAppendInput(operation.input, `${label}.input`),
    };
  }
  if (kind === "progress" || kind === "complete") {
    exactKeys(operation, new Set(["id", "kind", "requestId", "input"]), label);
    return {
      id: safeString(operation.id, `${label}.id`, 200),
      kind,
      requestId: safeString(operation.requestId, `${label}.requestId`, 128),
      input: parseCompletionInput(operation.input, `${label}.input`),
    };
  }
  if (kind === "local_turn") {
    exactKeys(operation, new Set(["id", "kind", "dshToSequence", "input"]), label);
    return {
      id: safeString(operation.id, `${label}.id`, 200),
      kind,
      dshToSequence: nonNegativeInteger(operation.dshToSequence, `${label}.dshToSequence`),
      input: parseLocalTurnInput(operation.input, `${label}.input`),
    };
  }
  throw new Error(`${label}.kind is unsupported`);
}

function parseLocalTurnInput(value: unknown, label: string): CommitLocalTurnInput {
  const input = requiredObject(value, label);
  exactKeys(
    input,
    new Set([
      "localTurnId",
      "runtimeId",
      "basedOnSequence",
      "occurredAt",
      "observedModel",
      "observedReasoningEffort",
      "requestPayload",
      "responsePayload",
      "toolEvents",
    ]),
    label,
  );
  const occurredAt = safeString(input.occurredAt, `${label}.occurredAt`, 64);
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error(`${label}.occurredAt must be an ISO timestamp`);
  if (input.toolEvents !== undefined && !Array.isArray(input.toolEvents)) {
    throw new Error(`${label}.toolEvents must be an array`);
  }
  return {
    localTurnId: safeString(input.localTurnId, `${label}.localTurnId`, 200),
    runtimeId: safeString(input.runtimeId, `${label}.runtimeId`, 128),
    basedOnSequence: nonNegativeInteger(input.basedOnSequence, `${label}.basedOnSequence`),
    occurredAt,
    ...(input.observedModel === undefined ? {} : {
      observedModel: safeString(input.observedModel, `${label}.observedModel`, 160),
    }),
    ...(input.observedReasoningEffort === undefined ? {} : {
      observedReasoningEffort: safeString(
        input.observedReasoningEffort,
        `${label}.observedReasoningEffort`,
        80,
      ),
    }),
    requestPayload: jsonValue(input.requestPayload, `${label}.requestPayload`),
    responsePayload: jsonValue(input.responsePayload, `${label}.responsePayload`),
    ...(input.toolEvents === undefined ? {} : {
      toolEvents: input.toolEvents.map((event, eventIndex) => jsonValue(
        event,
        `${label}.toolEvents[${eventIndex}]`,
      )),
    }),
  };
}

function parseAppendInput(value: unknown, label: string): DshAppendEventInput {
  const input = requiredObject(value, label);
  exactKeys(
    input,
    new Set([
      "type",
      "idempotencyKey",
      "payload",
      "replyTo",
      "visibility",
      "runtimeId",
      "observedModel",
      "observedReasoningEffort",
    ]),
    label,
  );
  if (input.type !== "tool_call" && input.type !== "tool_result") {
    throw new Error(`${label}.type must be tool_call or tool_result`);
  }
  return {
    type: input.type,
    idempotencyKey: safeString(input.idempotencyKey, `${label}.idempotencyKey`, 200),
    payload: jsonValue(input.payload, `${label}.payload`),
    ...(input.replyTo === undefined ? {} : { replyTo: safeString(input.replyTo, `${label}.replyTo`, 128) }),
    ...(input.visibility === undefined ? {} : { visibility: safeString(input.visibility, `${label}.visibility`, 32) }),
    ...(input.runtimeId === undefined ? {} : { runtimeId: safeString(input.runtimeId, `${label}.runtimeId`, 128) }),
    ...(input.observedModel === undefined ? {} : { observedModel: safeString(input.observedModel, `${label}.observedModel`, 160) }),
    ...(input.observedReasoningEffort === undefined ? {} : {
      observedReasoningEffort: safeString(input.observedReasoningEffort, `${label}.observedReasoningEffort`, 80),
    }),
  };
}

function parseCompletionInput(value: unknown, label: string): CompleteAgentRequestInput {
  const input = requiredObject(value, label);
  exactKeys(
    input,
    new Set(["runtimeId", "idempotencyKey", "payload", "observedModel", "observedReasoningEffort"]),
    label,
  );
  return {
    runtimeId: safeString(input.runtimeId, `${label}.runtimeId`, 128),
    idempotencyKey: safeString(input.idempotencyKey, `${label}.idempotencyKey`, 200),
    payload: jsonValue(input.payload, `${label}.payload`),
    ...(input.observedModel === undefined ? {} : { observedModel: safeString(input.observedModel, `${label}.observedModel`, 160) }),
    ...(input.observedReasoningEffort === undefined ? {} : {
      observedReasoningEffort: safeString(input.observedReasoningEffort, `${label}.observedReasoningEffort`, 80),
    }),
  };
}

function assertAlreadyRedacted(state: ConnectorState): void {
  const encoded = JSON.stringify(state);
  const redacted = JSON.stringify(redactValue(state));
  if (encoded !== redacted) {
    throw new Error("DSH connector state contains a secret-bearing field or value");
  }
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new Error(`${label} contains unsupported keys: ${extra.join(", ")}`);
}

function safeString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a safe non-empty string`);
  }
  return value;
}

function jsonValue(value: unknown, label: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`${label} must be a JSON value`);
  }
}

function hexDigest(value: unknown, label: string): string {
  const digest = safeString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

type ArtifactStats = Awaited<ReturnType<typeof lstat>>;

async function optionalLstat(target: string): Promise<ArtifactStats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPrivateRegularFile(metadata: ArtifactStats, label: string): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, never a symbolic link`);
  }
  if (process.platform !== "win32" && (Number(metadata.mode) & 0o777) !== 0o600) {
    throw new Error(`${label} permissions must be 0600`);
  }
}

function assertSecureDirectory(metadata: ArtifactStats): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("DSH connector state directory must be a real directory");
  }
  if (process.platform !== "win32" && (Number(metadata.mode) & 0o777) !== 0o700) {
    throw new Error("DSH connector state directory permissions must be 0700");
  }
}

function sameArtifact(
  before: ArtifactStats | undefined,
  after: ArtifactStats | undefined,
): boolean {
  if (before === undefined || after === undefined) return before === after;
  return !after.isSymbolicLink()
    && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino;
}
