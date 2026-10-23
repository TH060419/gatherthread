import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { FileCursorStore, parseBridgeCursorState, type CursorStore } from "./cursors.js";
import { recoverNativeExecutionReceipts, type ExitEvidence } from "./native-stop-receipts.js";
import { ProcessExecutionState } from "./process-execution-state.js";
import type { CollaborationApi, NativeExecutionExitReceipt } from "./types.js";

// The existing journal bound also bounds one complete startup scan. No native
// conversation files or arbitrary subdirectories are searched.
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const sessionKey = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 24);

/** The caller derives stateRoot from exact server/device/project/workspace identity. */
export async function recoverProjectNativeReceipts(stateRoot: string,
  api: Pick<CollaborationApi, "acknowledgeAgentExecutionStopped">): Promise<void> {
  if (!api.acknowledgeAgentExecutionStopped) return;
  if (!path.isAbsolute(stateRoot)) throw new Error("Invalid private native cleanup root");
  let root;
  try { root = await lstat(stateRoot); }
  catch (error) { if (missing(error)) return; throw error; }
  if (!root.isDirectory() || root.isSymbolicLink() || !ownedPrivate(root)) {
    throw new Error("Invalid private native cleanup root");
  }
  // Accept OS aliases such as macOS /var -> /private/var, but never a symlink
  // used as the actual caller-derived state directory.
  stateRoot = await realpath(stateRoot);
  const groups = new Map<string, string[]>();
  let count = 0, bytes = 0;
  for await (const entry of await opendir(stateRoot)) {
    if (++count > MAX_ENTRIES) throw new Error("Private native cleanup scan exceeds its bound");
    const match = /^([a-f0-9]{24})-(?:cursor\.json|(?:execution|session)\.json\.native-execution\.json)$/u.exec(entry.name);
    if (!match) continue;
    const file = await open(path.join(stateRoot, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || !ownedPrivate(info) || (bytes += info.size) > MAX_BYTES) {
        throw new Error("Invalid private native cleanup file");
      }
    } finally { await file.close(); }
    const key = match[1]!;
    groups.set(key, [...groups.get(key) ?? [], entry.name]);
  }
  for (const [key, names] of groups) {
    const cursorPath = path.join(stateRoot, `${key}-cursor.json`), writer = new FileCursorStore(cursorPath);
    const checked = (receipts: NativeExecutionExitReceipt[]) => {
      if (receipts.some(receipt => sessionKey(receipt.sessionId) !== key)) throw new Error("Native cleanup receipt scope mismatch");
      return receipts;
    };
    const store: CursorStore = {
      async load() {
        const raw = await readPrivateJson(cursorPath);
        const state = raw === undefined ? { server: {}, local: {} } : parseBridgeCursorState(raw);
        checked(state.stoppedExecutions ?? []);
        return state;
      },
      save: state => writer.save(state),
    };
    // Flush already proved cursor exits even if an old native journal's owner
    // is unknown. Then consult only its validated settled entries, never a PID.
    await recoverNativeExecutionReceipts(api, store);
    for (const name of names.filter(name => name.endsWith(".native-execution.json"))) {
      const journal = new ProcessExecutionState(path.join(stateRoot, name), 0);
      const evidence: ExitEvidence = {
        readStoppedExecutions: async () => checked(await journal.stopped()),
        acknowledgeExecutionExit: receipt => journal.acknowledgeExit(receipt),
      };
      await recoverNativeExecutionReceipts(api, store, evidence);
    }
  }
}

async function readPrivateJson(filePath: string): Promise<unknown> {
  let file;
  try { file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !ownedPrivate(info) || info.size > MAX_BYTES) throw new Error("Invalid private native cleanup cursor");
    const body = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await file.read(body, offset, body.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("Private native cleanup cursor changed during its bounded read");
    return JSON.parse(body.subarray(0, offset).toString("utf8"));
  } finally { await file.close(); }
}

function ownedPrivate(info: { mode: number; uid: number }): boolean {
  return (process.platform === "win32" || (info.mode & 0o077) === 0)
    && (typeof process.getuid !== "function" || info.uid === process.getuid());
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
