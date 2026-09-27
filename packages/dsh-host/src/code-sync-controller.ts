import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CollaborationApi, ProjectCodeSyncStatus } from "@gatherthread/bridge";
import { secureDirectoryChain, assertSameDirectoryChain } from "./path-security.js";

const ACTIONS = new Set([
  "code_sync_status", "code_upload", "code_download", "code_recover",
  "code_auto_upload_enable", "code_auto_upload_disable",
]);

export interface DshCodeSyncEngine {
  initialize(): Promise<void>;
  status(): Promise<ProjectCodeSyncStatus>;
  execute(kind: string, options?: { busy?: boolean; operationId?: string }): Promise<ProjectCodeSyncStatus>;
  tick(options: { busy: boolean }): Promise<ProjectCodeSyncStatus | undefined>;
}

export interface DshCodeSyncView {
  authorized: boolean;
  status?: ProjectCodeSyncStatus;
  error?: string;
}

export interface DshCodeSyncControllerOptions {
  permissionPath: string;
  binding: string;
  createEngine: () => DshCodeSyncEngine;
  api: Pick<CollaborationApi, "listSnapshotRequests" | "claimSnapshotRequest" | "completeSnapshotRequest" | "failSnapshotRequest">;
  runtimes: () => ReadonlyMap<string, string>;
  isBusy: () => boolean;
}

/** Project-scoped local consent; remote jobs can never grant filesystem access. */
export class DshCodeSyncController {
  #authorized = false;
  #status: ProjectCodeSyncStatus | undefined;
  #error: string | undefined;
  #engine: DshCodeSyncEngine | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #poll: Promise<void> | undefined;
  #stopped = false;
  readonly #options: DshCodeSyncControllerOptions;

  constructor(options: DshCodeSyncControllerOptions) {
    this.#options = options;
  }

  view(): DshCodeSyncView {
    return {
      authorized: this.#authorized,
      ...(this.#status === undefined ? {} : { status: { ...this.#status } }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }

  async start(): Promise<void> {
    try { this.#authorized = await loadConsent(this.#options.permissionPath, this.#options.binding); }
    catch (error) { this.#error = codeSyncErrorCode(error); return; }
    if (this.#authorized) {
      try {
        await this.#requireEngine().initialize();
        this.#status = await this.#requireEngine().status();
      }
      catch (error) { this.#error = codeSyncErrorCode(error); }
    }
  }

  authorize(enabled: boolean): Promise<DshCodeSyncView> {
    return this.#serialized(async () => {
      // Persist explicit consent before any source file is enumerated.
      await saveConsent(this.#options.permissionPath, this.#options.binding, enabled);
      this.#authorized = enabled;
      this.#status = undefined;
      this.#error = undefined;
      if (enabled) {
        try {
          await this.#requireEngine().initialize();
          this.#status = await this.#requireEngine().status();
        }
        catch (error) { this.#error = codeSyncErrorCode(error); }
      } else {
        this.#engine = undefined;
      }
      return this.view();
    });
  }

  execute(kind: string): Promise<DshCodeSyncView> {
    return this.#serialized(async () => {
      try {
        this.#status = await this.#execute(kind);
        this.#error = undefined;
      } catch (error) {
        this.#error = codeSyncErrorCode(error);
      }
      return this.view();
    });
  }

  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#poll ??= this.#serialized(async () => {
      const api = this.#options.api;
      const runtimes = this.#options.runtimes();
      if (api.listSnapshotRequests && api.claimSnapshotRequest && api.completeSnapshotRequest && api.failSnapshotRequest
        && runtimes.size > 0) {
        const pending = await api.listSnapshotRequests("pending", 100);
        const claimedJobs = await api.listSnapshotRequests("claimed", 100);
        const jobs = new Map([...pending, ...claimedJobs].map((job) => [job.id, job]));
        for (const job of jobs.values()) {
          if (this.#stopped) return;
          const runtime = runtimes.get(job.sessionId);
          if (!runtime || job.targetRuntimeId !== runtime || !ACTIONS.has(job.kind)) continue;
          let claimed;
          try { claimed = await api.claimSnapshotRequest(job.id, runtime); }
          catch { continue; } // A stale/foreign claim must never cause a local mutation.
          if (claimed.status !== "claimed" || claimed.targetRuntimeId !== runtime
            || claimed.sessionId !== job.sessionId || claimed.kind !== job.kind) continue;
          try {
            this.#status = await this.#execute(claimed.kind, claimed.id);
            this.#error = undefined;
          } catch (error) {
            this.#error = codeSyncErrorCode(error);
            await api.failSnapshotRequest(claimed.id, runtime, {
              code: this.#error,
              message: "Code sync could not finish safely. Check local authorization, idle state and cloud version.",
            });
            continue;
          }
          // A missing server acknowledgement is not a failed local operation.
          // Leave the claim retryable; the stable job ID reuses recovery receipts.
          await api.completeSnapshotRequest(claimed.id, runtime, this.#status);
        }
      }
      if (this.#authorized && !this.#stopped) {
        const result = await this.#requireEngine().tick({ busy: this.#options.isBusy() });
        if (result !== undefined) {
          this.#status = result;
          this.#error = undefined;
        }
      }
    }).catch((error: unknown) => {
      this.#error = codeSyncErrorCode(error);
    }).finally(() => { this.#poll = undefined; });
    return this.#poll;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#tail;
  }

  async #execute(kind: string, operationId?: string): Promise<ProjectCodeSyncStatus> {
    if (!ACTIONS.has(kind)) throw new CodeSyncLocalError("code_action_invalid");
    if (!this.#authorized) throw new CodeSyncLocalError("code_sync_disabled");
    if (this.#options.isBusy() && kind !== "code_sync_status" && kind !== "code_auto_upload_disable") {
      throw new CodeSyncLocalError("code_sync_busy");
    }
    return this.#requireEngine().execute(kind, {
      busy: this.#options.isBusy(), ...(operationId === undefined ? {} : { operationId }),
    });
  }

  #requireEngine(): DshCodeSyncEngine {
    this.#engine ??= this.#options.createEngine();
    return this.#engine;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(() => {
      if (this.#stopped) throw new CodeSyncLocalError("code_sync_stopped");
      return operation();
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }
}

class CodeSyncLocalError extends Error {
  constructor(readonly code: string) { super(code); }
}

function codeSyncErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^code_[a-z_]{1,60}$/u.test(code) ? code : "code_sync_failed";
}

async function loadConsent(file: string, binding: string): Promise<boolean> {
  const ancestors = await secureDirectoryChain(path.dirname(file));
  let before;
  try { before = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096
    || (process.platform !== "win32" && (before.mode & 0o077) !== 0)) {
    throw new CodeSyncLocalError("code_consent_invalid");
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new CodeSyncLocalError("code_consent_invalid");
    const value = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
    assertSameDirectoryChain(ancestors, await secureDirectoryChain(path.dirname(file)));
    return value.version === 1 && value.binding === binding && value.enabled === true;
  } finally { await handle.close(); }
}

async function saveConsent(file: string, binding: string, enabled: boolean): Promise<void> {
  await secureDirectoryChain(path.dirname(file));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const ancestors = await secureDirectoryChain(path.dirname(file));
  // Refuse existing unsafe targets rather than overwriting a symlink.
  await loadConsent(file, binding);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, binding, enabled }));
    await handle.sync();
  } finally { await handle.close(); }
  try {
    assertSameDirectoryChain(ancestors, await secureDirectoryChain(path.dirname(file)));
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
