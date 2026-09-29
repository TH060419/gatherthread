import { createHash } from "node:crypto";
import type { GitHubConnection, GitHubProjectStatus } from "@gatherthread/protocol";
import {
  DshCodeSyncController, GITHUB_CODE_ACTIONS, codeSyncErrorCode,
  type DshCodeSyncControllerOptions, type DshCodeSyncEngine, type DshCodeSyncView,
} from "./code-sync-controller.js";

export type DshGitHubTarget = Pick<GitHubConnection, "repository" | "base_branch" | "revision">;
export type DshGitHubMetadata = GitHubProjectStatus;

export interface DshGitHubCodeSyncView extends DshCodeSyncView {
  connection: DshGitHubMetadata["connection"];
  branch: string | null;
}

export interface DshGitHubCodeSyncOptions extends Omit<DshCodeSyncControllerOptions, "createEngine" | "actionKinds"> {
  readMetadata(): Promise<DshGitHubMetadata>;
  createEngine(target: DshGitHubTarget): DshCodeSyncEngine;
}

/** Refresh metadata before local consent or work; the browser cannot redirect a bound engine. */
export class DshGitHubCodeSyncController {
  #controller: DshCodeSyncController | undefined;
  #metadata: DshGitHubMetadata | undefined;
  #key: string | undefined;
  #error: string | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #stopped = false;
  #poll: Promise<void> | undefined;

  constructor(readonly options: DshGitHubCodeSyncOptions) {}

  view(): DshGitHubCodeSyncView {
    return {
      ...(this.#controller?.view() ?? { authorized: false }),
      connection: this.#metadata?.connection ? { ...this.#metadata.connection } : null,
      branch: this.#metadata?.branch ?? null,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  async start(): Promise<void> { await this.#serialize(async () => { await this.#refresh(); }); }

  authorize(enabled: boolean, expected?: DshGitHubTarget): Promise<DshGitHubCodeSyncView> {
    return this.#serialize(async () => {
      // Disabling local access must remain possible while offline.
      if (!enabled) {
        await this.#controller?.authorize(false);
        return this.view();
      }
      await this.#refresh();
      const target = this.#metadata?.connection;
      if (!target || !expected || targetKey(target) !== targetKey(expected)) throw coded("code_github_binding_changed");
      if (!this.#metadata?.can_write || !target.enabled) throw coded("code_sync_forbidden");
      await this.#controller!.authorize(true);
      return this.view();
    });
  }

  execute(kind: string): Promise<DshGitHubCodeSyncView> {
    return this.#serialize(async () => {
      if (kind === "github_code_auto_upload_disable" && this.#controller) {
        await this.#controller.execute(kind);
        return this.view();
      }
      await this.#refresh();
      if (kind === "github_code_sync_status" && !this.#controller?.view().authorized) return this.view();
      if (!this.#controller) throw coded("code_github_not_configured");
      if (!this.#metadata?.connection?.enabled && kind !== "github_code_sync_status") throw coded("code_not_enabled");
      await this.#controller.execute(kind);
      return this.view();
    });
  }

  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#poll ??= this.#serialize(async () => {
      await this.#refresh();
      await this.#controller?.poll();
    }).finally(() => { this.#poll = undefined; });
    return this.#poll;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#tail;
    await this.#controller?.stop();
  }

  async #refresh(): Promise<void> {
    const metadata = await this.options.readMetadata();
    const target = metadata.connection;
    const key = target && metadata.can_write ? targetKey(target) : undefined;
    if (key !== this.#key) {
      // Clear the old persisted consent too: A → B → A cannot silently restore access.
      await this.#controller?.authorize(false);
      await this.#controller?.stop();
      this.#controller = undefined;
      this.#key = undefined;
      if (target && key) {
        const capturedTarget = { ...target };
        this.#controller = new DshCodeSyncController({
          ...this.options,
          binding: createHash("sha256").update(JSON.stringify([this.options.binding, key])).digest("hex"),
          actionKinds: GITHUB_CODE_ACTIONS,
          createEngine: () => this.options.createEngine(capturedTarget),
        });
        await this.#controller.start();
        this.#key = key;
      }
    }
    this.#metadata = metadata;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(async () => {
      if (this.#stopped) throw coded("code_sync_stopped");
      this.#error = undefined;
      try { return await operation(); }
      catch (error) { this.#error = codeSyncErrorCode(error); throw coded(this.#error); }
    });
    this.#tail = pending.catch(() => undefined);
    return pending;
  }
}

function targetKey(target: DshGitHubTarget): string {
  return JSON.stringify([target.repository, target.base_branch, target.revision]);
}

function coded(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
