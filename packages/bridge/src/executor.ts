import { spawn } from "node:child_process";
import type { HarnessName, TranscriptEvent } from "@gatherthread/adapters";
import { HarnessExecutionTerminatedError, HarnessExecutionUnconfirmedError } from "./bridge.js";
import { ProcessExecutionState } from "./process-execution-state.js";
import { stopOwnedProcess, terminateOwnedProcessGroup } from "./owned-process.js";
import type {
  HarnessExecutionInput,
  HarnessExecutionResult,
  HarnessExecutor,
  NativeExecutionExitReceipt,
} from "./types.js";

export interface SubprocessHarnessExecutorOptions {
  command: string;
  args?: readonly string[];
  harness: HarnessName;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Private exact-attempt journal; required before this adapter may claim native Team work. */
  executionStatePath?: string;
}

/**
 * Executes an explicitly configured adapter executable once per claimed request.
 * The adapter receives one JSON object on stdin and must emit one JSON object on stdout.
 */
export class SubprocessHarnessExecutor implements HarnessExecutor {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #harness: HarnessName;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #signal: AbortSignal | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #executionState: ProcessExecutionState | undefined;

  get executionControlVersion(): 1 | undefined { return this.#executionState && process.platform !== "win32" ? 1 : undefined; }

  constructor(options: SubprocessHarnessExecutorOptions) {
    if (!options.command.trim()) throw new Error("adapter command must be non-empty");
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#harness = options.harness;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 4_194_304;
    this.#signal = options.signal;
    this.#env = withoutGatherThreadCredentials(options.env ?? process.env);
    this.#executionState = options.executionStatePath ? new ProcessExecutionState(options.executionStatePath, this.#maxOutputBytes) : undefined;
  }

  async execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult> {
    const signals = [this.#signal, input.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    signal?.throwIfAborted();
    const run = (started?: (pid: number) => Promise<void>) => this.#execute(input, signal, started);
    const team = input.request.payload !== null && typeof input.request.payload === "object" && "agent_team" in input.request.payload;
    return team && this.#executionState ? this.#executionState.execute(input, run) : run();
  }

  async acknowledgeCanonicalCompletion(request: HarnessExecutionInput["request"], runtime: HarnessExecutionInput["runtime"], claimAttempt: number): Promise<void> {
    if (this.#executionState && request.payload !== null && typeof request.payload === "object" && "agent_team" in request.payload) await this.#executionState.completed(request, runtime, claimAttempt);
  }

  async readStoppedExecutions(): Promise<NativeExecutionExitReceipt[]> { return this.#executionState ? this.#executionState.stopped() : []; }
  async acknowledgeExecutionExit(receipt: NativeExecutionExitReceipt): Promise<void> { await this.#executionState?.acknowledgeExit(receipt); }

  async #execute(input: HarnessExecutionInput, signal: AbortSignal | undefined, started?: (pid: number) => Promise<void>): Promise<HarnessExecutionResult> {
    const stdout = await runAdapterProcess({
      command: this.#command,
      args: this.#args,
      input,
      env: this.#env,
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      signal,
      ...(started === undefined ? {} : { started }),
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new HarnessExecutionTerminatedError("harness_output_invalid", "Harness adapter returned invalid JSON after its process exited.");
    }
    try { return validateExecutionResult(parsed, this.#harness); }
    catch (cause) { throw new HarnessExecutionTerminatedError("harness_output_invalid", "Harness adapter returned invalid provenance or output after its process exited.", { cause }); }
  }
}

interface RunAdapterProcessOptions {
  command: string;
  args: readonly string[];
  input: HarnessExecutionInput;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal | undefined;
  started?: (pid: number) => Promise<void>;
}

function runAdapterProcess(options: RunAdapterProcessOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("Harness adapter execution aborted"));
      return;
    }
    const child = spawn(options.command, [...options.args], {
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let termination: HarnessExecutionTerminatedError | undefined;
    let startupError: Error | undefined;
    let preparation: Promise<void> | undefined;
    let terminationAttempt: Promise<void> | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const abort = () => {
      terminateChild("harness_execution_cancelled", "Harness adapter execution aborted after its process exited.", options.signal?.reason);
    };
    const timeout = setTimeout(() => {
      terminateChild("harness_execution_timeout", "Harness adapter timed out and its process exited.");
    }, options.timeoutMs);
    timeout.unref();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        terminateChild("harness_output_limit", "Harness adapter output exceeded the configured limit; its process exited.");
        return;
      }
      chunks.push(chunk);
    });
    // Drain stderr so a noisy adapter cannot block. Its contents are deliberately not logged.
    child.stderr.resume();
    child.once("error", (error) => { startupError = error; });
    child.once("close", async (code, signal) => {
      await preparation;
      await terminationAttempt;
      if (process.platform !== "win32" && child.pid) {
        try { await terminateOwnedProcessGroup(child.pid); }
        catch { finish(new HarnessExecutionUnconfirmedError("Harness adapter process-group exit could not be confirmed")); return; }
      }
      if (termination) { finish(termination); return; }
      if (startupError) { finish(new HarnessExecutionTerminatedError("harness_start_failed", "Harness adapter could not be started; no process remains active.", { cause: startupError })); return; }
      if (code !== 0) {
        finish(new HarnessExecutionTerminatedError("harness_execution_failed", `Harness adapter exited unsuccessfully (${signal ?? code ?? "unknown"}).`));
        return;
      }
      finish(undefined, Buffer.concat(chunks).toString("utf8").trim());
    });
    child.stdin.once("error", () => undefined);
    child.once("spawn", () => {
      preparation = (async () => {
        try {
          if (options.started && child.pid) await options.started(child.pid);
          if (options.signal?.aborted) abort();
          if (!termination && !settled) child.stdin.end(`${JSON.stringify(options.input)}\n`);
        } catch (cause) { terminateChild("harness_preparation_failed", "Harness adapter preparation failed; its process exited.", cause); }
      })();
    });

    function terminateChild(code: string, message: string, cause?: unknown) {
      if (termination || settled) return;
      termination = new HarnessExecutionTerminatedError(code, message, { cause });
      terminationAttempt = stopOwnedProcess(child, "SIGTERM").catch(() => undefined);
      forceKillTimer = setTimeout(() => { void stopOwnedProcess(child, "SIGKILL").catch(() => undefined); }, 5_000);
      forceKillTimer.unref();
    }
  });
}

function validateExecutionResult(value: unknown, harness: HarnessName): HarnessExecutionResult {
  const result = requiredObject(value, "adapter result");
  if (!Array.isArray(result.events)) throw new Error("Harness adapter result.events must be an array");
  const events = result.events.map((event, index) => validateTranscriptEvent(event, index, harness));
  if (!events.some((event) => event.kind === "assistant")) {
    throw new Error("Harness adapter result must contain an assistant event");
  }
  const localSessionId = result.localSessionId;
  if (localSessionId !== undefined && (typeof localSessionId !== "string" || !localSessionId)) {
    throw new Error("Harness adapter result.localSessionId must be a non-empty string");
  }
  return { events, ...(localSessionId === undefined ? {} : { localSessionId }) };
}

function validateTranscriptEvent(value: unknown, index: number, harness: HarnessName): TranscriptEvent {
  const event = requiredObject(value, `adapter event ${index}`);
  const kind = event.kind;
  if (!isOneOf(kind, ["user", "assistant", "tool_call", "tool_result"] as const)) {
    throw new Error(`Harness adapter event ${index} has an invalid kind`);
  }
  if (event.harness !== harness || event.captureFidelity !== "harness_transcript") {
    throw new Error(`Harness adapter event ${index} has invalid provenance`);
  }
  const localEventId = requiredString(event.localEventId, `adapter event ${index}.localEventId`);
  const transcriptEvent: TranscriptEvent = {
    kind,
    localEventId,
    harness,
    captureFidelity: "harness_transcript",
  };
  copyOptionalString(event, transcriptEvent, "timestamp", index);
  copyOptionalString(event, transcriptEvent, "content", index);
  copyOptionalString(event, transcriptEvent, "toolName", index);
  copyOptionalString(event, transcriptEvent, "toolCallId", index);
  if ("arguments" in event) transcriptEvent.arguments = event.arguments;
  if ("result" in event) transcriptEvent.result = event.result;
  if (event.isError !== undefined) {
    if (typeof event.isError !== "boolean") throw new Error(`Harness adapter event ${index}.isError must be boolean`);
    transcriptEvent.isError = event.isError;
  }
  if (kind === "assistant" && transcriptEvent.content === undefined) {
    throw new Error(`Harness adapter event ${index} assistant content is required`);
  }
  return transcriptEvent;
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: TranscriptEvent,
  key: "timestamp" | "content" | "toolName" | "toolCallId",
  index: number,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error(`Harness adapter event ${index}.${key} must be a string`);
  target[key] = value;
}

export function withoutGatherThreadCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set([
    "GATHERTHREAD_AUTH_TOKEN_PEPPER",
    "GATHERTHREAD_AUTHORIZATION_TOKEN",
    "GATHERTHREAD_BEARER_TOKEN",
    "GATHERTHREAD_TOKEN",
    // Strip pre-GatherThread alpha names too, so a stale shell cannot leak an old credential.
    "ACP_AUTH_TOKEN_PEPPER",
    "RELAYROOM_AUTHORIZATION_TOKEN",
    "RELAYROOM_BEARER_TOKEN",
    "RELAYROOM_TOKEN",
  ]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !blocked.has(name)));
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}
