import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isCodeSyncPathAllowed, containsCodeSyncSecret, DshFileOperationSchema, FileBranchesResultSchema, FileTreeResultSchema, FileContentResultSchema, FileHistoryResultSchema, FileChangesResultSchema, FileMutationResultSchema } from "@gatherthread/protocol";
import type { z } from "zod";
import { secureDirectoryChain, assertSameDirectoryChain } from "./path-security.js";

export class WorkspaceFileError extends Error { constructor(readonly code: string) { super(code); } }
type Request = z.infer<typeof DshFileOperationSchema>;
const MAX_TEXT = 65536;
const ignored = new Set(["node_modules", "dist", "build", ".local", ".cache", ".venv", "__pycache__"]);
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Private, bounded comparison data. Never serialized into collaboration history. */
export class DshWorkspaceFiles {
  #baseline: Map<string, { text: string; hash: string }> | undefined;
  #time: string | null = null;
  #request: string | null = null;
  #incomplete = false;
  #omitted = new Set<string>();
  #generation = 0;
  constructor(readonly directory: string, readonly isBusy: () => boolean) {}
  clear() { this.#generation++; this.#baseline = undefined; this.#time = null; this.#request = null; this.#omitted.clear(); this.#incomplete = false; }
  async #root() {
    const st = await lstat(this.directory);
    if (!st.isDirectory() || st.isSymbolicLink() || await realpath(this.directory) !== path.resolve(this.directory)) throw new WorkspaceFileError("workspace_file_path");
    return secureDirectoryChain(this.directory);
  }
  async tree() {
    const ancestors = await this.#root();
    const entries: Array<{ path: string; size: number }> = [];
    let truncated = false, visited = 0;
    const walk = async (relative: string, depth: number) => {
      if (depth > 12) { truncated = true; return; }
      const dir = path.join(this.directory, relative);
      const chain = await secureDirectoryChain(dir);
      // Metadata only. Never follow links or walk private/generated trees.
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (++visited > 2500 || entries.length >= 300) { truncated = true; break; }
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (!isCodeSyncPathAllowed(child) || ignored.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.isFile()) {
          const st = await lstat(path.join(this.directory, child));
          if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1) entries.push({ path: child, size: st.size });
        }
      }
      assertSameDirectoryChain(chain, await secureDirectoryChain(dir));
    };
    await walk("", 0);
    assertSameDirectoryChain(ancestors, await this.#root());
    return { kind: "localTree" as const, directory: this.directory, entries: entries.sort((a,b) => a.path.localeCompare(b.path)), truncated, busy: this.isBusy() };
  }
  async read(relative: string) {
    if (!isCodeSyncPathAllowed(relative) || relative.split("/").some(p => ignored.has(p.toLowerCase()))) throw new WorkspaceFileError("workspace_file_path");
    const rootChain = await this.#root();
    const file = path.join(this.directory, relative);
    const chain = await secureDirectoryChain(path.dirname(file));
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new WorkspaceFileError("workspace_file_path");
    if (before.size > MAX_TEXT) throw new WorkspaceFileError("workspace_file_large");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await handle.stat();
      if (st.dev !== before.dev || st.ino !== before.ino) throw new WorkspaceFileError("workspace_file_changed");
      const bytes = Buffer.alloc(MAX_TEXT + 1);
      let count = 0;
      while (count <= MAX_TEXT) { const next = await handle.read(bytes, count, bytes.length - count, null); if (!next.bytesRead) break; count += next.bytesRead; }
      if (count > MAX_TEXT) throw new WorkspaceFileError("workspace_file_large");
      const after = await handle.stat();
      if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) throw new WorkspaceFileError("workspace_file_changed");
      assertSameDirectoryChain(chain, await secureDirectoryChain(path.dirname(file)));
      assertSameDirectoryChain(rootChain, await this.#root());
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0,count)); } catch { throw new WorkspaceFileError("workspace_file_binary"); }
      if (text.includes("\0")) throw new WorkspaceFileError("workspace_file_binary");
      if (containsCodeSyncSecret(text)) throw new WorkspaceFileError("workspace_file_private");
      return { kind: "text" as const, path: relative, text };
    } finally { await handle.close(); }
  }
  async #snapshot(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const tree = await this.tree();
    const files = new Map<string, { text: string; hash: string }>();
    const omitted = new Set<string>(); let bytes = 0, incomplete = tree.truncated;
    for (const entry of tree.entries) {
      signal?.throwIfAborted();
      if (entry.size > MAX_TEXT || bytes + entry.size > 2 * 1024 * 1024) { omitted.add(entry.path); incomplete = true; continue; }
      try { const value = await this.read(entry.path); const data = Buffer.from(value.text); if (bytes + data.length > 2 * 1024 * 1024) { omitted.add(entry.path); incomplete = true; continue; } bytes += data.length; files.set(entry.path, { text: value.text, hash: digest(data) }); }
      catch { omitted.add(entry.path); incomplete = true; }
    }
    return { files, omitted, incomplete };
  }
  async capture(requestId: string | null = null, signal?: AbortSignal) {
    this.clear();
    const generation = this.#generation;
    const snapshot = await this.#snapshot(signal);
    signal?.throwIfAborted();
    if (generation !== this.#generation) throw new WorkspaceFileError("workspace_file_changed");
    this.#omitted = snapshot.omitted;
    this.#baseline = snapshot.files; this.#time = new Date().toISOString(); this.#request = requestId; this.#incomplete = snapshot.incomplete;
  }
  async changes() {
    if (!this.#baseline) return { kind: "localChanges" as const, baseline: null, requestId: null, incomplete: false, files: [] };
    const baseline = this.#baseline, generation = this.#generation;
    const current = await this.#snapshot();
    if (generation !== this.#generation) throw new WorkspaceFileError("workspace_file_changed");
    const files: Array<{ path: string; status: "added" | "modified" | "deleted" }> = [];
    for (const [name, value] of current.files) {
      const old = baseline.get(name);
      if (!old && (this.#incomplete || this.#omitted.has(name))) continue;
      if (!old || old.hash !== value.hash) files.push({ path: name, status: old ? "modified" : "added" });
    }
    // A failed or bounded scan cannot prove that an unseen file was deleted.
    if (!current.incomplete) for (const name of baseline.keys()) if (!current.files.has(name)) files.push({ path: name, status: "deleted" });
    return { kind: "localChanges" as const, baseline: this.#time, requestId: this.#request, incomplete: this.#incomplete || current.incomplete || files.length > 300, files: files.slice(0,300) };
  }
  async diff(relative: string) {
    if (!this.#baseline) throw new WorkspaceFileError("workspace_file_baseline");
    if (!this.#baseline.has(relative) && this.#incomplete) throw new WorkspaceFileError("workspace_file_baseline");
    const generation = this.#generation;
    const before = this.#baseline.get(relative)?.text ?? "";
    let after: string;
    try { after = (await this.read(relative)).text; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; after = ""; }
    if (generation !== this.#generation) throw new WorkspaceFileError("workspace_file_changed");
    return { kind: "diff" as const, path: relative, before, after };
  }
}

export async function cloudFileAction(request: Request, options: { apiUrl: string; token: string; projectId: string; signal: AbortSignal; fetch?: typeof fetch }) {
  if (!["branches", "tree", "content", "history", "changes", "save"].includes(request.operation)) throw new WorkspaceFileError("workspace_invalid_input");
  const op = request.operation as "branches"|"tree"|"content"|"history"|"changes"|"save";
  const input = request.operation === "branches" ? { provider: request.provider } : (request as Extract<Request, { input: unknown }>).input;
  const mutation = op === "save";
  const url = new URL(`${options.apiUrl.replace(/\/$/u, "")}/projects/${encodeURIComponent(options.projectId)}/files/${mutation ? "mutations" : op}`);
  if (!mutation) for (const [key, value] of Object.entries(input)) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await (options.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${options.token}`, ...(mutation ? { "content-type": "application/json" } : {}) },
    redirect: "error", signal: options.signal, ...(mutation ? { method: "POST", body: JSON.stringify(input) } : {}) });
  if (!response.ok) {
    if (response.status === 409) throw new WorkspaceFileError("workspace_file_conflict");
    if (response.status === 401 || response.status === 403) throw new WorkspaceFileError("workspace_file_forbidden");
    if (response.status === 404 || response.status === 503) throw new WorkspaceFileError("workspace_file_not_configured");
    throw new WorkspaceFileError("workspace_file_unavailable");
  }
  if (!response.body) throw new WorkspaceFileError("workspace_invalid_response");
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) throw new WorkspaceFileError("workspace_file_large"); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
  const schemas = { branches: FileBranchesResultSchema, tree: FileTreeResultSchema, content: FileContentResultSchema, history: FileHistoryResultSchema, changes: FileChangesResultSchema, save: FileMutationResultSchema };
  const parsed = schemas[op].safeParse(data);
  if (!parsed.success) throw new WorkspaceFileError("workspace_invalid_response");
  const value = parsed.data as any;
  if (value.provider !== input.provider || ("branch_id" in input && value.branch_id !== input.branch_id)
    || ("connection_revision" in input && value.connection_revision !== input.connection_revision)
    || (op !== "history" && "commit" in input && input.commit && value.commit !== input.commit)) throw new WorkspaceFileError("workspace_invalid_response");
  if (op === "content") {
    if (!("path" in input) || value.path !== input.path) throw new WorkspaceFileError("workspace_invalid_response");
    const bytes = Buffer.from(value.content_base64, "base64");
    if (bytes.length !== value.size) throw new WorkspaceFileError("workspace_invalid_response");
    if (bytes.length > MAX_TEXT) throw new WorkspaceFileError("workspace_file_large");
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new WorkspaceFileError("workspace_file_binary"); }
    if (text.includes("\0")) throw new WorkspaceFileError("workspace_file_binary");
    return { kind: "text", path: value.path, text };
  }
  if (op === "tree") return { kind: "tree", value: { ...value, entries: value.entries.slice(0,300) }, truncated: value.entries.length > 300 };
  return { kind: op === "save" ? "saved" : op, value };
}
