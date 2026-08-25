import type { HarnessExecutor } from "./types.js";
import { LocalBridge } from "./bridge.js";

export interface BridgeDaemonOptions {
  bridge: LocalBridge;
  executor: HarnessExecutor;
  pollIntervalMs?: number;
  pollLimit?: number;
  heartbeatIntervalMs?: number;
  signal?: AbortSignal;
  onPollError?: (error: unknown) => void;
}

export class BridgeDaemon {
  readonly #bridge: LocalBridge;
  readonly #executor: HarnessExecutor;
  readonly #pollIntervalMs: number;
  readonly #pollLimit: number;
  readonly #heartbeatIntervalMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #onPollError: ((error: unknown) => void) | undefined;

  constructor(options: BridgeDaemonOptions) {
    this.#bridge = options.bridge;
    this.#executor = options.executor;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#pollLimit = options.pollLimit ?? 200;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.#signal = options.signal;
    this.#onPollError = options.onPollError;
  }

  async run(): Promise<void> {
    await this.#bridge.connect();
    const heartbeatStop = new AbortController();
    const heartbeatSignal = this.#signal
      ? AbortSignal.any([this.#signal, heartbeatStop.signal])
      : heartbeatStop.signal;
    const heartbeat = this.#runHeartbeats(heartbeatSignal);
    try {
      while (!this.#signal?.aborted) {
        try {
          await this.#bridge.processPendingAgentRequests(this.#executor, this.#pollLimit);
        } catch (error) {
          if (this.#signal?.aborted) break;
          this.#onPollError?.(error);
        }
        await abortableDelay(this.#pollIntervalMs, this.#signal);
      }
    } finally {
      heartbeatStop.abort();
      await heartbeat;
    }
  }

  async #runHeartbeats(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await abortableDelay(this.#heartbeatIntervalMs, signal);
      if (signal.aborted) break;
      try {
        await this.#bridge.heartbeat();
      } catch (error) {
        if (!signal.aborted) this.#onPollError?.(error);
      }
    }
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
