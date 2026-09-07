import type { DshExecutionGate } from "./types.js";

interface PendingOperation<T = unknown> {
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly detachAbort: () => void;
}

/**
 * One project-wide upper bound for model-driving work. Closing the gate rejects
 * work that has not started; the owning connectors dispose any running Agents.
 */
export class BoundedDshExecutionGate implements DshExecutionGate {
  readonly #limit: number;
  readonly #pending: PendingOperation[] = [];
  #active = 0;
  #closed: Error | undefined;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("DSH execution concurrency must be a positive integer");
    }
    this.#limit = limit;
  }

  get activeCount(): number {
    return this.#active;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      let pending: PendingOperation<T>;
      const onAbort = () => {
        const index = this.#pending.indexOf(pending as PendingOperation);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        pending.detachAbort();
        reject(abortReason(signal));
      };
      pending = {
        operation,
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.push(pending as PendingOperation);
      this.#drain();
    });
  }

  close(reason = new Error("DSH project execution gate is closed")): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    for (const pending of this.#pending.splice(0)) {
      pending.detachAbort();
      pending.reject(reason);
    }
  }

  #drain(): void {
    while (this.#closed === undefined && this.#active < this.#limit) {
      const pending = this.#pending.shift();
      if (pending === undefined) return;
      pending.detachAbort();
      this.#active += 1;
      void Promise.resolve()
        .then(pending.operation)
        .then((value) => {
          this.#active -= 1;
          this.#drain();
          pending.resolve(value);
        }, (error: unknown) => {
          this.#active -= 1;
          this.#drain();
          pending.reject(error);
        });
    }
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("DSH execution permit was canceled");
}
