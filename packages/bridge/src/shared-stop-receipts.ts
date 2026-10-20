import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { AgentShareJobResponseSchema, IdSchema, type AbortAgentShareJobInput } from "@gatherthread/protocol";

/** Proof of local quiescence, never a native task, transcript or credential. */
export interface SharedStoppedReceipt {
  version: 1; jobId: string; claimAttempt: number; sourceRuntimeId: string; projectId: string; ownerDeviceId: string;
}
export type SharedStoppedScope = Pick<SharedStoppedReceipt, "sourceRuntimeId" | "projectId" | "ownerDeviceId">;

export interface RecoverSharedStoppedReceiptsOptions {
  privateControlRoot: string;
  projectId: string;
  ownerDeviceId: string;
  api: { abortAck(jobId: string, input: AbortAgentShareJobInput): Promise<unknown> };
}

/** Private single-owner atomic outbox. Unknown orphan work never gets a receipt. */
export class SharedStoppedReceiptOutbox {
  readonly #directory: string; readonly #root: string;
  constructor(privateStateRoot: string) {
    if (!path.isAbsolute(privateStateRoot)) throw new Error("Shared execution control state must have an absolute private path");
    this.#root = privateStateRoot; this.#directory = path.join(privateStateRoot, "stopped-receipts");
  }
  async list(scope: SharedStoppedScope): Promise<SharedStoppedReceipt[]> {
    await this.#prepare();
    const names = (await readdir(this.#directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
    if (names.length > 256) throw new Error("Shared cleanup outbox exceeds its bound");
    const receipts: SharedStoppedReceipt[] = [];
    for (const name of names) {
      const file = await open(path.join(this.#directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 2048 || (info.mode & 0o077) !== 0) throw new Error("Invalid private shared cleanup receipt");
        const receipt = parseReceipt(JSON.parse(await file.readFile("utf8")));
        if (receipt.sourceRuntimeId !== scope.sourceRuntimeId || receipt.projectId !== scope.projectId || receipt.ownerDeviceId !== scope.ownerDeviceId
          || path.basename(this.#path(receipt)) !== name) throw new Error("Shared cleanup receipt scope mismatch");
        receipts.push(receipt);
      } finally { await file.close(); }
    }
    return receipts;
  }
  async put(input: SharedStoppedReceipt): Promise<void> {
    const receipt = parseReceipt(input); await this.#prepare();
    const final = this.#path(receipt), temporary = `${final}.${randomUUID()}.tmp`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${JSON.stringify(receipt)}\n`); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, final); await this.#syncDirectory(); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
  async remove(receipt: SharedStoppedReceipt): Promise<void> {
    await this.#prepare();
    await unlink(this.#path(parseReceipt(receipt))).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    await this.#syncDirectory();
  }
  #path(receipt: SharedStoppedReceipt): string {
    return path.join(this.#directory, `${createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}.json`);
  }
  async #prepare(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.#root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Shared cleanup root must be a private directory");
    await chmod(this.#root, 0o700);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Shared cleanup state must be a private directory");
    await chmod(this.#directory, 0o700);
  }
  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

/** Restore only already-confirmed exact exits, before any current source ACL or native startup. */
export async function recoverSharedStoppedReceipts(options: RecoverSharedStoppedReceiptsOptions): Promise<number> {
  if (!path.isAbsolute(options.privateControlRoot)) throw new Error("Shared cleanup recovery requires an absolute private root");
  const projectId = IdSchema.parse(options.projectId), ownerDeviceId = IdSchema.parse(options.ownerDeviceId);
  if (!await privateDirectory(options.privateControlRoot)) return 0;
  // Empty old source directories are harmless. Bound the entire scan without
  // making normal long-lived projects spend a receipt slot on each old session.
  const sources = await boundedChildren(options.privateControlRoot, 4096);
  const pending: Array<{ outbox: SharedStoppedReceiptOutbox; receipt: SharedStoppedReceipt }> = [];
  for (const source of sources.sort()) {
    const parsed = IdSchema.safeParse(source);
    if (!parsed.success || parsed.data !== source || source === "." || source === "..") throw new Error("Invalid shared cleanup source directory");
    const root = path.join(options.privateControlRoot, source);
    if (!await privateDirectory(root)) throw new Error("Shared cleanup source disappeared during recovery");
    const box = path.join(root, "stopped-receipts");
    if (!await privateDirectory(box)) continue;
    const entries = await boundedChildren(box, 512);
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry) && !/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/u.test(entry)) throw new Error("Invalid shared cleanup receipt filename");
      const info = await lstat(path.join(box, entry));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2048 || (info.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Invalid private shared cleanup receipt");
    }
    const outbox = new SharedStoppedReceiptOutbox(root);
    for (const receipt of await outbox.list({ sourceRuntimeId: source, projectId, ownerDeviceId })) pending.push({ outbox, receipt });
    if (pending.length > 256) throw new Error("Shared cleanup recovery exceeds its receipt bound");
  }
  // Validate the complete bounded scope before acknowledging anything. No
  // deleted source, missing PID or arbitrary native file can supply exit proof.
  for (const { outbox, receipt } of pending) {
    assertSharedStoppedAcknowledgment(receipt, await options.api.abortAck(receipt.jobId, {
      claim_attempt: receipt.claimAttempt, executor_stopped: true,
      idempotency_key: `shared-abort:${receipt.jobId}:${receipt.claimAttempt}`,
    }));
    await outbox.remove(receipt);
  }
  return pending.length;
}

/** Both live and restart cleanup require a confirmed exact terminal server reply. */
export function assertSharedStoppedAcknowledgment(receipt: SharedStoppedReceipt, response: unknown): void {
  const result = AgentShareJobResponseSchema.parse(response);
  if (result.job.id !== receipt.jobId || result.job.project_id !== receipt.projectId || result.job.cleanup_pending
    || result.job.status === "queued" || result.job.status === "running") throw new Error("Shared cleanup acknowledgment scope mismatch");
}

async function privateDirectory(directory: string): Promise<boolean> {
  let info;
  try { info = await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Shared cleanup recovery requires an owned private directory");
  return true;
}

async function boundedChildren(directory: string, limit: number): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of await opendir(directory)) {
    if (names.length >= limit) throw new Error("Shared cleanup recovery exceeds its directory bound");
    names.push(entry.name);
  }
  return names;
}

function parseReceipt(value: unknown): SharedStoppedReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shared cleanup receipt");
  const input = value as Record<string, unknown>;
  const fields = ["version", "jobId", "claimAttempt", "sourceRuntimeId", "projectId", "ownerDeviceId"];
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key)) || input.version !== 1
    || !Number.isSafeInteger(input.claimAttempt) || (input.claimAttempt as number) < 1 || (input.claimAttempt as number) > 1000) throw new Error("Invalid shared cleanup receipt");
  return { version: 1, jobId: IdSchema.parse(input.jobId), claimAttempt: input.claimAttempt as number,
    sourceRuntimeId: IdSchema.parse(input.sourceRuntimeId), projectId: IdSchema.parse(input.projectId), ownerDeviceId: IdSchema.parse(input.ownerDeviceId) };
}
