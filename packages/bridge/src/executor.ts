import { spawn } from "node:child_process";
import type { HarnessName, TranscriptEvent } from "@gatherthread/adapters";
import type {
  HarnessExecutionInput,
  HarnessExecutionResult,
  HarnessExecutor,
} from "./types.js";

export interface SubprocessHarnessExecutorOptions {
  command: string;
  args?: readonly string[];
  harness: HarnessName;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
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

  constructor(options: SubprocessHarnessExecutorOptions) {
    if (!options.command.trim()) throw new Error("adapter command must be non-empty");
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#harness = options.harness;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 4_194_304;
    this.#signal = options.signal;
    this.#env = withoutGatherThreadCredentials(options.env ?? process.env);
  }

  async execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult> {
    const stdout = await runAdapterProcess({
      command: this.#command,
      args: this.#args,
      input,
      env: this.#env,
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      signal: this.#signal,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("Harness adapter returned invalid JSON");
    }
    return validateExecutionResult(parsed, this.#harness);
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
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const abort = () => {
      terminateChild();
      finish(new Error("Harness adapter execution aborted"));
    };
    const timeout = setTimeout(() => {
      terminateChild();
      finish(new Error("Harness adapter timed out"));
    }, options.timeoutMs);
    timeout.unref();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        terminateChild();
        finish(new Error("Harness adapter output exceeded the configured limit"));
        return;
      }
      chunks.push(chunk);
    });
    // Drain stderr so a noisy adapter cannot block. Its contents are deliberately not logged.
    child.stderr.resume();
    child.once("error", () => finish(new Error("Harness adapter could not be started")));
    child.once("close", (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (code !== 0) {
        finish(new Error(`Harness adapter exited unsuccessfully (${signal ?? code ?? "unknown"})`));
        return;
      }
      finish(undefined, Buffer.concat(chunks).toString("utf8").trim());
    });
    child.stdin.end(`${JSON.stringify(options.input)}\n`);

    function terminateChild() {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
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

function withoutGatherThreadCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
