import { spawn } from "node:child_process";
import { redactText, type TranscriptEvent } from "@gatherthread/adapters";
import { withoutGatherThreadCredentials } from "./executor.js";
import type { ZcodeCommandSpec } from "./zcode-compat.js";

/**
 * Client for the official ZCode Protocol stdio app-server (`zcode app-server`).
 *
 * This surface is the connector's only structured execution interface. Every
 * protocol-version-sensitive constant (method names, envelope shape, reviewed
 * event vocabulary) lives here so upstream changes fail in one reviewed place
 * instead of leaking into execution policy. The protocol is newline-delimited
 * JSON without a JSON-RPC envelope:
 *
 * - client request:  `{"id":1,"method":"session/create","params":{...}}`
 * - server response: `{"id":1,"result":{...}}` or `{"id":1,"error":{...}}`
 * - notification:    `{"method":"state.updated","params":{...}}`
 * - server request:  `{"id":"server-1","method":"...","params":{...}}`, which
 *   the client must answer with `{"id":"server-1","result":{...}}`.
 *
 * Server-initiated `interaction/*` requests (permission prompts, user input,
 * MCP auth headers) are always declined with an error response so a headless
 * run can never approve a local tool action it cannot show the user.
 */

export const ZCODE_PROTOCOL_NAME = "ZCode Protocol";
export const ZCODE_PROTOCOL_VERSION = 1;

const PROTOCOL_SPAWN_TIMEOUT_MS = 15_000;
const PROTOCOL_MAX_OUTPUT_BYTES = 33_554_432;

export interface ZcodeProtocolEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface ZcodeTurnHandlers {
  /** Reviewed session-event deliveries from `session/subscribe`. */
  onSessionEvent?: (event: ZcodeProtocolEvent) => void;
  /** `state.updated` notifications; used for observed-model metadata only. */
  onStateUpdated?: (patch: Record<string, unknown>) => void;
}

export interface ZcodeProtocolSession {
  sessionId: string;
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  handlers: ZcodeTurnHandlers;
}

export interface ZcodeProtocolRunOptions {
  spec: ZcodeCommandSpec;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/**
 * Opens one bounded app-server child, hands it to `run`, and guarantees the
 * child is terminated afterwards. Every GatherThread credential is stripped
 * from the child environment before spawn.
 */
export async function withZcodeProtocol<T>(
  options: ZcodeProtocolRunOptions,
  run: (protocol: ZcodeProtocolConnection) => Promise<T>,
): Promise<T> {
  const connection = await openZcodeProtocolConnection(options);
  try {
    return await run(connection);
  } finally {
    connection.close();
  }
}

export class ZcodeProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ZcodeProtocolError";
    this.code = code;
  }
}

interface PendingEntry {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ZcodeProtocolConnection {
  readonly #child: ReturnType<typeof spawn>;
  readonly #pending = new Map<number, PendingEntry>();
  readonly #serverHandlers: Map<string, (params: Record<string, unknown>) => Record<string, unknown>>;
  #nextRequestId = 1;
  #settled = false;
  #outputBytes = 0;
  #maxOutputBytes: number;
  #stderrTail = "";
  #exitError: Error | undefined;
  #closed = false;

  constructor(child: ReturnType<typeof spawn>, options: { maxOutputBytes: number }) {
    this.#child = child;
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#serverHandlers = new Map([
      [
        "session/requestRuntimePreferences",
        () => ({ nativeSearchEnhancementsEnabled: false }),
      ],
    ]);
    if (!child.stdout || !child.stderr || !child.stdin) {
      throw new Error("ZCode app-server child must be spawned with piped stdio");
    }
    this.#stdin = child.stdin;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Bounded tail for failure diagnostics; never persisted or logged.
      this.#stderrTail = (this.#stderrTail + chunk).slice(-2_000);
    });
    child.once("error", (error: Error) => {
      this.#fail(new Error(`ZCode app-server could not be started: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      this.#fail(new Error(
        `ZCode app-server exited unexpectedly (${signal ?? code ?? "unknown"})${this.#stderrSuffix()}`,
      ));
    });
  }

  get exited(): boolean {
    return this.#child.exitCode !== null || this.#child.signalCode !== null;
  }

  #stderrSuffix(): string {
    const last = this.#stderrTail.trim().split(/\r?\n/).pop();
    return last ? `: ${last.slice(0, 300)}` : "";
  }

  #onStdout(chunk: string): void {
    this.#outputBytes += Buffer.byteLength(chunk, "utf8");
    if (this.#outputBytes > this.#maxOutputBytes) {
      this.#fail(new Error("ZCode app-server output exceeded the configured limit"));
      return;
    }
    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line) this.#handleLine(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  #buffer = "";
  #stdin: NodeJS.WritableStream;

  #handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      // Unparseable output lines are ignored: the app-server may print
      // diagnostics on stdout in future versions, and guessing shapes here
      // would turn a cosmetic change into an execution failure.
      return;
    }
    const id = message.id;
    if (id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const key = typeof id === "number" ? id : -1;
      const entry = this.#pending.get(key);
      if (!entry) return;
      this.#pending.delete(key);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        const error = isRecord(message.error) ? message.error : {};
        entry.reject(new ZcodeProtocolError(
          typeof error.code === "number" ? error.code : -32000,
          redactText(String(error.message ?? "ZCode Protocol request failed")).slice(0, 400),
        ));
      } else {
        entry.resolve(isRecord(message.result) ? message.result : {});
      }
      return;
    }
    if (typeof message.method === "string") {
      void this.#handleServerMessage(message);
    }
  }

  async #handleServerMessage(message: Record<string, unknown>): Promise<void> {
    const method = typeof message.method === "string" ? message.method : "";
    const id = message.id;
    const params = isRecord(message.params) ? message.params : {};
    if (method === "session/event") {
      this.#turnHandlers?.onSessionEvent?.(toProtocolEvent(params));
      return;
    }
    if (method === "state.updated" && isRecord(params.patch)) {
      this.#turnHandlers?.onStateUpdated?.(params.patch);
      return;
    }
    if (id === undefined) return; // Pure notification we do not consume.
    const handler = this.#serverHandlers.get(method);
    if (!handler) {
      // Fail closed: an unknown or interactive request never resolves itself.
      this.#write({ id, error: { code: -32000, message: `GatherThread connector declines: ${method}` } });
      return;
    }
    try {
      this.#write({ id, result: handler(params) });
    } catch (error) {
      this.#write({
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : "handler failed" },
      });
    }
  }

  #turnHandlers: ZcodeTurnHandlers | undefined;

  setTurnHandlers(handlers: ZcodeTurnHandlers): void {
    this.#turnHandlers = handlers;
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = PROTOCOL_SPAWN_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new Error("ZCode Protocol connection is closed"));
    if (this.exited) {
      return Promise.reject(new Error(`ZCode app-server is not running${this.#stderrSuffix()}`));
    }
    const id = this.#nextRequestId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ZcodeProtocolError(-32001, `ZCode Protocol request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed || this.exited) return;
    this.#stdin.write(`${JSON.stringify(message)}\n`);
  }

  #fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    for (const [key, entry] of [...this.#pending]) {
      this.#pending.delete(key);
      clearTimeout(entry.timer);
      entry.reject(this.#exitError ?? error);
    }
    this.#exitError = error;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill("SIGTERM");
    const forceKill = setTimeout(() => this.#child.kill("SIGKILL"), 5_000);
    forceKill.unref();
  }
}

function toProtocolEvent(params: Record<string, unknown>): ZcodeProtocolEvent {
  const type = typeof params.type === "string" ? params.type : "";
  return { type, payload: params };
}

export async function openZcodeProtocolConnection(options: ZcodeProtocolRunOptions): Promise<ZcodeProtocolConnection> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error("ZCode execution aborted");
  }
  const child = spawn(options.spec.command, [...options.spec.baseArgs, "app-server"], {
    cwd: options.cwd,
    env: withoutGatherThreadCredentialEnvironment(process.env),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdout || !child.stderr || !child.stdin) {
    throw new Error("ZCode app-server child must be spawned with piped stdio");
  }
  // A write racing a child exit surfaces as EPIPE on stdin; the connection
  // already fails its pending requests through the close handler, so the
  // stream error itself must not crash the connector process.
  child.stdin.once("error", () => undefined);
  const connection = new ZcodeProtocolConnection(child, {
    maxOutputBytes: options.maxOutputBytes ?? PROTOCOL_MAX_OUTPUT_BYTES,
  });
  if (options.signal) {
    const abort = () => connection.close();
    options.signal.addEventListener("abort", abort, { once: true });
  }
  return connection;
}

/**
 * Structured live handshake used at preflight: proves the resolved CLI starts
 * an app-server that answers on the expected surface. The `session/list`
 * round trip fails closed on the one structural marker every compatible
 * server returns (`sessions`); the protocol name and version are enforced
 * fail-closed at `session/create` time, which is where the upstream server
 * actually declares them. A server that declares a protocol here is still
 * validated strictly.
 */
export async function probeZcodeProtocol(
  spec: ZcodeCommandSpec,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ protocolName: string; protocolVersion: number }> {
  return withZcodeProtocol(
    {
      spec,
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? PROTOCOL_SPAWN_TIMEOUT_MS,
    },
    async (connection) => {
      // `session/list` is the cheapest stateless request that exercises the
      // full envelope round trip without creating native state.
      const result = await connection.request("session/list", {}, options.timeoutMs ?? PROTOCOL_SPAWN_TIMEOUT_MS);
      if (!Array.isArray(result.sessions)) {
        throw new Error(
          "ZCode app-server did not answer session/list with a session list; the resolved CLI does not speak the ZCode Protocol. Upgrade ZCode or point --zcode-command at a compatible build.",
        );
      }
      const protocolName = ZCODE_PROTOCOL_NAME;
      const protocolVersion = ZCODE_PROTOCOL_VERSION;
      if (result.protocol !== undefined) {
        const protocol = isRecord(result.protocol) ? result.protocol : {};
        const name = typeof protocol.name === "string" ? protocol.name : protocolName;
        const version = typeof protocol.version === "number" ? protocol.version : protocolVersion;
        if (name !== ZCODE_PROTOCOL_NAME || version !== ZCODE_PROTOCOL_VERSION) {
          throw new Error(
            `ZCode app-server speaks ${name} version ${version}; this connector requires ${ZCODE_PROTOCOL_NAME} version ${ZCODE_PROTOCOL_VERSION}. Upgrade or downgrade ZCode and reconnect.`,
          );
        }
        return { protocolName: name, protocolVersion: version };
      }
      return { protocolName, protocolVersion };
    },
  ).finally(() => undefined);
}

/**
 * Strips the fixed GatherThread credential list plus every `GATHERTHREAD_*`
 * variable from a child environment. The prefix sweep means a future
 * credential-shaped variable cannot leak into the model-driven ZCode child
 * just because someone forgot to extend the fixed list.
 */
export function withoutGatherThreadCredentialEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const stripped = withoutGatherThreadCredentials(env);
  return Object.fromEntries(
    Object.entries(stripped).filter(([key]) => !/^gatherthread_/i.test(key)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reviewed projection of raw protocol tool payloads into transcript events.
 * Values are truncated to `maxValueBytes`; unknown fields never leave.
 */
export function boundZcodeToolValue(value: unknown, maxValueBytes: number): unknown {
  if (value === undefined) return undefined;
  const encoded = safeJson(value);
  if (encoded.length <= maxValueBytes) return value;
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(encoded, "utf8"),
    preview: utf8Prefix(encoded, maxValueBytes),
  };
}

export function zcodeTranscriptEvent(
  kind: TranscriptEvent["kind"],
  localEventId: string,
  fields: Partial<TranscriptEvent>,
): TranscriptEvent {
  return {
    kind,
    localEventId,
    harness: "zcode",
    captureFidelity: "harness_transcript",
    ...fields,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}
