import { lstatSync, opendirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { ApiError } from "./errors.js";

export const CODE_PROJECT_DISK_BYTES = 256 * 1024 * 1024;
export const CODE_TOTAL_DISK_BYTES = 1024 * 1024 * 1024;
interface BudgetOptions {
  maxEntries?: number;
  maxMilliseconds?: number;
  scanIntervalMilliseconds?: number;
  clock?: () => number;
}

/** Private, append-only storage: reservations survive transaction failures and project deletion.
 * A bounded cold/periodic reconciliation includes orphan objects and deleted projects too.
 * Exhausting the scan budget latches closed until restart, rather than rescan on every request.
 */
export class CodeStorageBudget {
  private usage: { total: number; repositories: Map<string, number>; scannedAt: number } | undefined;
  private scanFailure: ApiError | undefined;
  constructor(private readonly root: string, private readonly options: BudgetOptions = {}) {}

  reserve(repository: string, bytes: number): void {
    if (this.scanFailure) throw this.scanFailure;
    const now = this.options.clock?.() ?? performance.now();
    if (!this.usage || now - this.usage.scannedAt >= (this.options.scanIntervalMilliseconds ?? 60_000)) {
      try { this.usage = this.scan(now); }
      catch (error) {
        this.scanFailure = error instanceof ApiError ? error : new ApiError(503, "code_storage_unavailable", "Code storage could not be checked safely. Check storage access before restarting the server.");
        throw this.scanFailure;
      }
    }
    const own = this.usage.repositories.get(repository) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || own + bytes > CODE_PROJECT_DISK_BYTES || this.usage.total + bytes > CODE_TOTAL_DISK_BYTES) {
      throw new ApiError(507, "code_storage_quota_exceeded", "Code storage quota exceeded. Recent writes reserve space conservatively until the next bounded storage check.");
    }
    this.usage.total += bytes;
    this.usage.repositories.set(repository, own + bytes);
  }

  private scan(scannedAt: number): { total: number; repositories: Map<string, number>; scannedAt: number } {
    const started = performance.now();
    let entries = 0;
    let total = 0;
    const repositories = new Map<string, number>();
    const pending = [this.root];
    const check = () => {
      if (++entries > (this.options.maxEntries ?? 20_000) || performance.now() - started > (this.options.maxMilliseconds ?? 100)) {
        throw new ApiError(503, "code_storage_check_required", "Code storage inspection exceeded its safety budget. Code writes are paused; check or compact storage during maintenance and restart the server. Chat remains available.");
      }
    };
    while (pending.length) {
      const path = pending.pop()!;
      check();
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if (path === this.root && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new ApiError(503, "code_storage_unavailable", "Unexpected entry in private server code storage");
      }
      // Include directory metadata as well as file lengths; do not follow any links.
      total += stat.size;
      const top = relative(this.root, path).split(sep)[0];
      if (top?.endsWith(".git")) {
        const repository = join(this.root, top);
        const size = (repositories.get(repository) ?? 0) + stat.size;
        repositories.set(repository, size);
        if (size > CODE_PROJECT_DISK_BYTES) throw new ApiError(507, "code_storage_quota_exceeded", "Code repository storage quota exceeded");
      }
      if (total > CODE_TOTAL_DISK_BYTES) throw new ApiError(507, "code_storage_quota_exceeded", "Code deployment storage quota exceeded");
      if (stat.isDirectory()) {
        const directory = opendirSync(path);
        try {
          let child;
          while ((child = directory.readSync()) !== null) {
            check();
            pending.push(join(path, child.name));
          }
        } finally { directory.closeSync(); }
      }
    }
    return { total, repositories, scannedAt };
  }
}
