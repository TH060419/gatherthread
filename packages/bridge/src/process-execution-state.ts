import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessExecutionTerminatedError, HarnessExecutionUnconfirmedError } from "./bridge.js";
import type { HarnessExecutionInput, HarnessExecutionResult, RegisteredRuntime, CanonicalEvent, NativeExecutionExitReceipt } from "./types.js";

const writers = new Set<string>();
const MAX_ENTRIES = 1000;
const MAX_BYTES = 64 * 1024 * 1024;
interface Entry {
  sessionId: string; runtimeId: string; requestId: string; claimAttempt: number; fingerprint: string;
  phase: "prepared" | "started" | "settled";
  pid?: number;
  result?: HarnessExecutionResult;
  failure?: { code: string; message: string };
  exitAcknowledged?: boolean;
}
interface Journal { version: 1; entries: Record<string, Entry> }

/** Private metadata/result recovery. A missing/dead PID never establishes native exit. */
export class ProcessExecutionState {
  readonly #path: string;
  readonly #reserveBytes: number;
  constructor(statePath: string, reserveBytes: number) {
    this.#path = path.resolve(statePath);
    this.#reserveBytes = reserveBytes + 64 * 1024;
  }

  async execute(input: HarnessExecutionInput, run: (started: (pid: number) => Promise<void>) => Promise<HarnessExecutionResult>): Promise<HarnessExecutionResult> {
    return this.#owned(async () => {
      const state = await this.#read();
      const identity = exactIdentity(input.request, input.runtime, input.claimAttempt);
      const key = identityKey(identity);
      const { id, userId, sessionId, deviceId, harness, provider, model, localSessionId } = input.runtime;
      const fingerprint = createHash("sha256").update(JSON.stringify({ request: input.request,
        runtime: { id, userId, sessionId, deviceId, harness, provider, model, localSessionId },
        history: input.canonicalHistory, historyContext: input.historyContext })).digest("hex");
      const prior = state.entries[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new HarnessExecutionUnconfirmedError("Native process recovery input changed for the accepted attempt");
        if (prior.phase !== "settled") throw new HarnessExecutionUnconfirmedError("Native process execution is prepared, active or indeterminate; confirm its exit before recovery");
        if (prior.failure) throw new HarnessExecutionTerminatedError(prior.failure.code, prior.failure.message);
        if (prior.result!.events.some((event) => event.harness !== input.runtime.harness)) throw new HarnessExecutionUnconfirmedError("Recovered native process output belongs to another harness");
        return prior.result!;
      }
      if (Object.values(state.entries).some((entry) => entry.phase !== "settled")) throw new HarnessExecutionUnconfirmedError("An earlier native process has no confirmed exit");
      if (Object.keys(state.entries).length >= MAX_ENTRIES || Buffer.byteLength(JSON.stringify(state)) + this.#reserveBytes > MAX_BYTES) {
        throw new HarnessExecutionUnconfirmedError("Native process recovery storage is full; resolve pending accepted attempts before starting more work");
      }
      const entry: Entry = { ...identity, fingerprint, phase: "prepared" };
      state.entries[key] = entry;
      await this.#save(state);
      try {
        const result = await run(async (pid) => {
          entry.phase = "started"; entry.pid = pid;
          await this.#save(state);
        });
        entry.phase = "settled"; entry.result = result;
        await this.#save(state);
        return result;
      } catch (error) {
        if (error instanceof HarnessExecutionTerminatedError) {
          entry.phase = "settled"; entry.failure = { code: error.failureCode, message: error.publicMessage };
          await this.#save(state);
        }
        throw error;
      }
    });
  }

  /** Only an authoritative canonical completion permits pruning replay evidence. */
  async completed(request: CanonicalEvent, runtime: RegisteredRuntime, claimAttempt: number): Promise<void> {
    await this.#owned(async () => {
      const state = await this.#read();
      let changed = false;
      for (const [key, entry] of Object.entries(state.entries)) if (entry.phase === "settled" && entry.sessionId === request.sessionId
        && entry.runtimeId === runtime.id && entry.requestId === request.id && entry.claimAttempt === claimAttempt) {
        delete state.entries[key]; changed = true;
      }
      if (changed) await this.#save(state);
    });
  }

  async stopped(): Promise<NativeExecutionExitReceipt[]> {
    return this.#owned(async () => Object.values((await this.#read()).entries)
      .filter((entry) => entry.phase === "settled" && !entry.exitAcknowledged)
      .map(({ sessionId, requestId, runtimeId, claimAttempt }) => ({ sessionId, requestId, runtimeId, claimAttempt })));
  }

  async acknowledgeExit(receipt: NativeExecutionExitReceipt): Promise<void> {
    await this.#owned(async () => {
      const state = await this.#read(), entry = state.entries[identityKey(receipt)];
      if (entry?.phase === "settled") { entry.exitAcknowledged = true; await this.#save(state); }
    });
  }

  async #owned<T>(operation: () => Promise<T>): Promise<T> {
    if (writers.has(this.#path)) throw new HarnessExecutionUnconfirmedError("Another process-local writer owns this native process state");
    writers.add(this.#path);
    const lockPath = `${this.#path}.owner`, owner = randomUUID();
    let lock;
    try {
      await mkdir(path.dirname(this.#path), { recursive: true, mode: 0o700 });
      try { lock = await open(lockPath, "wx", 0o600); }
      catch { throw new HarnessExecutionUnconfirmedError("Native process state has another or indeterminate owner; confirm old execution exit before repairing its owner file"); }
      await lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, owner }));
      return await operation();
    } finally {
      try { if (lock) { await lock.close(); await rm(lockPath); } }
      finally { writers.delete(this.#path); }
    }
  }

  async #read(): Promise<Journal> {
    try {
      if ((await stat(this.#path)).size > MAX_BYTES) throw new Error("Native process journal exceeded its bound");
      const state: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (!isRecord(state) || state.version !== 1 || !isRecord(state.entries) || Object.keys(state.entries).length > MAX_ENTRIES) throw new Error("Invalid native process journal");
      for (const [key, value] of Object.entries(state.entries)) {
        if (!isRecord(value) || ![value.sessionId, value.runtimeId, value.requestId].every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
          || !Number.isSafeInteger(value.claimAttempt) || Number(value.claimAttempt) < 1 || !["prepared", "started", "settled"].includes(String(value.phase))
          || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
          || (value.exitAcknowledged !== undefined && (typeof value.exitAcknowledged !== "boolean" || value.phase !== "settled"))
          || key !== identityKey(value as unknown as Entry)) throw new Error("Invalid native process journal entry");
        if (value.phase === "settled") {
          const validFailure = isRecord(value.failure) && typeof value.failure.code === "string" && /^[a-z0-9_]{1,64}$/.test(value.failure.code)
            && typeof value.failure.message === "string" && value.failure.message.length > 0 && value.failure.message.length <= 400;
          const validResult = isRecord(value.result) && Array.isArray(value.result.events) && value.result.events.some((event: unknown) => isRecord(event) && event.kind === "assistant")
            && value.result.events.every((event: unknown) => isRecord(event) && event.captureFidelity === "harness_transcript" && typeof event.localEventId === "string"
              && ["assistant", "tool_call", "tool_result"].includes(String(event.kind)) && ["codex", "claude-code"].includes(String(event.harness)));
          if (validFailure === validResult || (value.failure !== undefined && !validFailure) || (value.result !== undefined && !validResult)) throw new Error("Invalid settled native process journal entry");
        }
      }
      return state as unknown as Journal;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, entries: {} };
      throw new HarnessExecutionUnconfirmedError("Native process recovery state could not be verified");
    }
  }

  async #save(state: Journal): Promise<void> {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new HarnessExecutionUnconfirmedError("Native process recovery state exceeded its storage bound");
    const temporary = `${this.#path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, body + "\n", { mode: 0o600 });
    await rename(temporary, this.#path);
  }
}

function exactIdentity(request: CanonicalEvent, runtime: RegisteredRuntime, claimAttempt: number | undefined) {
  if (!Number.isSafeInteger(claimAttempt) || Number(claimAttempt) < 1 || request.sessionId !== runtime.sessionId) throw new HarnessExecutionUnconfirmedError("Native process execution requires an exact claimed attempt and session");
  return { sessionId: request.sessionId, runtimeId: runtime.id, requestId: request.id, claimAttempt: claimAttempt! };
}
function identityKey(value: Pick<Entry, "sessionId" | "runtimeId" | "requestId" | "claimAttempt">) {
  return createHash("sha256").update(JSON.stringify([value.sessionId, value.runtimeId, value.requestId, value.claimAttempt])).digest("hex");
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
