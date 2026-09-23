import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CODE_SYNC_MAX_BODY_BYTES, CODE_SYNC_MAX_FILE_BYTES, CODE_SYNC_MAX_FILES, CODE_SYNC_MAX_SNAPSHOT_BYTES,
  CodeFilesSchema, CodeMutationResultSchema, CodeSnapshotResultSchema, CodeStatusSchema,
  containsCodeSyncSecret, isCodeSyncPathAllowed, type CodeFile, type CodeStatus,
} from "@gatherthread/protocol";

const execFileAsync = promisify(execFile);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const BUILD_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.cache|\.turbo|\.venv|venv|__pycache__)(?:\/|$)/u;
// Up to 1,000 portable paths (500 UTF-16 units each), hashes and a second
// executable-path list must fit even when every path uses multibyte UTF-8.
const MAX_BINDING_BYTES = 4 * 1024 * 1024;

export class CodeSyncError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CodeSyncError"; }
}

export interface ProjectCodeSyncStatus {
  enabled: boolean;
  automatic_upload: boolean;
  local_changes: number;
  file_count: number;
  excluded_count: number;
  base_commit: string | null;
  cloud_commit: string | null;
  branch_id: string | null;
  needs_download: boolean;
  recovery_directory?: string;
  /** A recovery does not inspect the possibly damaged original directory. */
  local_status_unknown?: boolean;
}

export interface ProjectCodeSyncOptions {
  apiUrl: string;
  token: string;
  projectId: string;
  actorId: string;
  workspacePath: string;
  /** Tests/embedded hosts may supply a private directory outside the source tree. */
  stateRoot?: string;
  onRecovery?: (absolutePath: string) => void;
  fetch?: typeof globalThis.fetch;
}

interface Binding {
  version: 1;
  api_url: string;
  project_id: string;
  actor_id: string;
  workspace_path: string;
  base_commit: string | null;
  automatic_upload: boolean;
  baseline: Record<string, string>;
  executable_paths?: string[];
  interrupted_download?: boolean;
}
interface Inventory { files: CodeFile[]; hashes: Record<string, string>; excluded: number; }

/** Opt-in source checkpoints. Never changes an existing Git index, branch or remote. */
export class ProjectCodeSync {
  readonly #options: ProjectCodeSyncOptions;
  readonly #apiUrl: string;
  #root = "";
  #stateRoot = "";
  #initialized: Promise<void> | undefined;
  #stableDigest = "";
  #stableSince = 0;
  #lastAutomaticAttempt = 0;

  constructor(options: ProjectCodeSyncOptions) {
    const url = new URL(options.apiUrl);
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new CodeSyncError("code_sync_binding", "Code sync requires HTTPS or a loopback server.");
    }
    if (!options.token || /[\r\n]/u.test(options.token)) throw new CodeSyncError("code_sync_binding", "Code sync requires a device credential.");
    url.pathname = url.pathname.replace(/\/$/u, "").replace(/\/v1$/u, "") + "/v1";
    this.#apiUrl = url.toString().replace(/\/$/u, "");
    this.#options = options;
  }

  async initialize(): Promise<void> {
    const initializing = this.#initialized ??= this.#initialize();
    try { await initializing; }
    catch (error) {
      if (this.#initialized === initializing) this.#initialized = undefined;
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    const requestedRoot = path.resolve(this.#options.workspacePath);
    try {
      this.#root = await realpath(requestedRoot);
      if (!(await lstat(this.#root)).isDirectory()) throw new CodeSyncError("code_sync_binding", "The authorized workspace is unavailable.");
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A lost workspace can still recover its cloud checkpoint without recreating
      // or rebinding the original directory. Only its existing parent is trusted.
      this.#root = path.join(await realpath(path.dirname(requestedRoot)), path.basename(requestedRoot));
    }
    this.#stateRoot = this.#options.stateRoot ?? path.join(homedir(), ".gatherthread", "code-sync", digest(this.#root));
    if (isWithin(this.#root, path.resolve(this.#stateRoot))) throw new CodeSyncError("code_sync_binding", "Code sync state must stay outside source files.");
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(this.#stateRoot)).isSymbolicLink()) throw new CodeSyncError("code_sync_binding", "Code sync state cannot be a symbolic link.");
    this.#stateRoot = await realpath(this.#stateRoot);
    if (isWithin(this.#root, this.#stateRoot)) throw new CodeSyncError("code_sync_binding", "Private code sync state resolves inside source files.");
    await chmod(this.#stateRoot, 0o700);
    // A separate empty Git index implements .gitignore even for non-Git workspaces.
    // It never stages, commits, checks out, or runs hooks inside the user's repository.
    await this.#locked(async () => {
      const inventoryPath = path.join(this.#stateRoot, "inventory.git");
      try { if ((await lstat(inventoryPath)).isSymbolicLink()) throw new CodeSyncError("code_sync_binding", "Private Git inventory cannot be a symbolic link."); }
      catch (error) { if (!isMissing(error)) throw error; }
      await git(["init", "--bare", "--quiet", inventoryPath], this.#stateRoot);
      const filename = path.join(this.#stateRoot, "binding.json");
      try { await this.#readBinding(); }
      catch (error) {
        if (!isMissing(error)) throw error;
        await writePrivate(filename, JSON.stringify({
          version: 1, api_url: this.#apiUrl, project_id: this.#options.projectId, actor_id: this.#options.actorId,
          workspace_path: this.#root, base_commit: null, automatic_upload: false, baseline: {},
        } satisfies Binding));
      }
    });
  }

  async status(): Promise<ProjectCodeSyncStatus> {
    await this.initialize();
    return this.#locked(async () => this.#status(await this.#readBinding(), await this.#cloudStatus(), await this.#inventory()));
  }

  async upload(): Promise<ProjectCodeSyncStatus> {
    return this.#upload();
  }

  async #upload(stableHashes?: Record<string, string>): Promise<ProjectCodeSyncStatus> {
    await this.initialize();
    return this.#locked(async () => {
      const binding = await this.#readBinding();
      if (binding.interrupted_download) throw new CodeSyncError("code_sync_recovery_required", "A previous download was interrupted. Original files remain in the private download backup. Recover cloud code into a new folder and review the original before reconnecting.");
      await this.#requireWorkspace();
      const cloud = await this.#cloudStatus();
      assertEnabled(cloud);
      const inventory = await this.#inventory();
      // tick's idle/deletion checks apply only to the exact settled file set.
      // A slow status request must not authorize a newer, unreviewed snapshot.
      if (stableHashes && (!binding.automatic_upload || !sameHashes(stableHashes, inventory.hashes))) {
        throw new CodeSyncError("code_sync_busy", "Source files or automatic-upload permission changed before upload. Wait for a new idle stability check.");
      }
      let uploadBase = binding.base_commit;
      // New devices must download/adopt existing progress before publishing over it.
      if (binding.base_commit === null && (cloud.repository.main_commit !== null || cloud.own_branch_id !== null)) {
        const snapshot = await this.#snapshot(cloud);
        if (snapshot.files.length === 0) {
          uploadBase = snapshot.commit;
        } else {
          if (sameHashes(inventory.hashes, fileHashes(snapshot.files))) {
            binding.base_commit = snapshot.commit;
            binding.baseline = inventory.hashes;
            binding.executable_paths = inventory.files.filter((file) => file.executable).map((file) => file.path);
            await this.#save(binding);
            return this.#status(binding, cloud, inventory);
          }
          throw new CodeSyncError("code_sync_conflict", "Cloud code already exists. Download into an empty workspace or recover it into a new folder before uploading.");
        }
      }
      if (binding.base_commit !== null && sameHashes(binding.baseline, inventory.hashes)) return this.#status(binding, cloud, inventory);
      const body = {
        base_commit: uploadBase, files: inventory.files, message: "GatherThread workspace checkpoint",
        idempotency_key: `code-upload-${digest(JSON.stringify([this.#options.projectId, this.#options.actorId, uploadBase, inventory.hashes]))}`,
      };
      await this.#requireWorkspace();
      const parsed = CodeMutationResultSchema.safeParse(await this.#request("/checkpoints", body));
      if (!parsed.success) throw invalidResponse();
      // A committed checkpoint is acknowledged only after reading its exact file tree back.
      const verified = await this.#snapshot(parsed.data.status);
      if (verified.commit !== parsed.data.commit || !sameHashes(fileHashes(verified.files), inventory.hashes)) {
        throw new CodeSyncError("code_sync_conflict", "Cloud code changed during checkpoint verification; the local baseline was not advanced.");
      }
      binding.base_commit = parsed.data.commit;
      binding.baseline = inventory.hashes;
      binding.executable_paths = inventory.files.filter((file) => file.executable).map((file) => file.path);
      await this.#save(binding);
      return this.#status(binding, parsed.data.status, await this.#inventory());
    });
  }

  async download(): Promise<ProjectCodeSyncStatus> {
    await this.initialize();
    return this.#locked(async () => {
      const binding = await this.#readBinding();
      if (binding.interrupted_download) throw new CodeSyncError("code_sync_recovery_required", "A previous download was interrupted. Recover cloud code into a new folder; review the private download backup before using the original workspace.");
      const cloud = await this.#cloudStatus();
      assertEnabled(cloud);
      const snapshot = await this.#snapshot(cloud);
      const current = await this.#inventory();
      const nextHashes = fileHashes(snapshot.files);
      if (sameHashes(current.hashes, nextHashes)) {
        binding.base_commit = snapshot.commit;
        binding.baseline = nextHashes;
        binding.executable_paths = snapshot.files.filter((file) => file.executable).map((file) => file.path);
        await this.#save(binding);
        return this.#status(binding, cloud, current);
      }
      if (!sameHashes(current.hashes, binding.baseline)) throw new CodeSyncError("code_sync_dirty", "Local files have unuploaded changes. Upload first, or recover cloud code into a new folder.");
      await applySnapshot(this.#root, snapshot.files, binding.baseline, {
        backupRoot: path.join(this.#stateRoot, "download-backups", randomUUID()),
        beforeWrite: async () => { binding.interrupted_download = true; await this.#save(binding); },
        baselineExecutables: new Set(binding.executable_paths ?? []),
      });
      const verified = await this.#inventory(new Set(snapshot.files.filter((file) => file.executable).map((file) => file.path)));
      if (!sameHashes(verified.hashes, nextHashes)) throw new CodeSyncError("code_sync_conflict", "Local files changed during download. Check the workspace before retrying.");
      binding.base_commit = snapshot.commit;
      binding.baseline = nextHashes;
      binding.executable_paths = snapshot.files.filter((file) => file.executable).map((file) => file.path);
      delete binding.interrupted_download;
      await this.#save(binding);
      return this.#status(binding, cloud, verified);
    });
  }

  async recover(operationId?: string): Promise<ProjectCodeSyncStatus> {
    await this.initialize();
    return this.#locked(async () => {
      const receiptPath = operationId === undefined ? undefined : path.join(this.#stateRoot, `recovery-${digest(operationId)}.json`);
      if (receiptPath) {
        try {
          const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as ProjectCodeSyncStatus;
          if (typeof receipt.recovery_directory !== "string" || path.basename(receipt.recovery_directory) !== receipt.recovery_directory) throw new CodeSyncError("code_sync_binding", "Private recovery receipt is invalid.");
          const recoveredPath = path.join(path.dirname(this.#root), receipt.recovery_directory);
          if ((await lstat(recoveredPath)).isSymbolicLink() || await realpath(recoveredPath) !== recoveredPath) throw new CodeSyncError("code_sync_binding", "The recovered directory no longer matches its private receipt.");
          this.#options.onRecovery?.(recoveredPath);
          return receipt;
        } catch (error) { if (!isMissing(error)) throw error; }
      }
      const binding = await this.#readBinding();
      const cloud = await this.#cloudStatus();
      assertEnabled(cloud);
      const snapshot = await this.#snapshot(cloud);
      const recoveryStem = [...path.basename(this.#root)];
      while (Buffer.byteLength(recoveryStem.join("")) > 180) recoveryStem.pop();
      const recoveryName = `${recoveryStem.join("")}-recovered-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      const recoveryPath = path.join(path.dirname(this.#root), recoveryName);
      await mkdir(recoveryPath, { mode: 0o700 });
      await applySnapshot(recoveryPath, snapshot.files, {});
      // Give the recovered directory its own private baseline, without changing
      // the original binding or any native task. Editing it before reconnecting
      // must still upload against this exact restored commit, not cloud main.
      const restored = new ProjectCodeSync({
        ...this.#options, workspacePath: recoveryPath,
        stateRoot: path.join(path.dirname(this.#stateRoot), digest(recoveryPath)),
      });
      await restored.initialize();
      await restored.#locked(async () => {
        const restoredBinding = await restored.#readBinding();
        restoredBinding.base_commit = snapshot.commit;
        restoredBinding.baseline = fileHashes(snapshot.files);
        restoredBinding.executable_paths = snapshot.files.filter((file) => file.executable).map((file) => file.path);
        restoredBinding.automatic_upload = false;
        await restored.#save(restoredBinding);
      });
      this.#options.onRecovery?.(recoveryPath);
      // Never rebind native Agent sessions or delete the original workspace.
      const result = {
        ...this.#status(binding, cloud, { files: [], hashes: binding.baseline, excluded: 0 }),
        recovery_directory: recoveryName, local_status_unknown: true,
      };
      if (receiptPath) await writePrivate(receiptPath, JSON.stringify(result));
      return result;
    });
  }

  async setAutomaticUpload(enabled: boolean): Promise<ProjectCodeSyncStatus> {
    await this.initialize();
    return this.#locked(async () => {
      const binding = await this.#readBinding();
      const cloud = await this.#cloudStatus();
      if (enabled) assertEnabled(cloud);
      binding.automatic_upload = enabled;
      await this.#save(binding);
      this.#stableSince = Date.now();
      this.#stableDigest = "";
      return this.#status(binding, cloud, await this.#inventory());
    });
  }

  async automaticUploadEnabled(): Promise<boolean> {
    await this.initialize();
    return (await this.#readBinding()).automatic_upload;
  }

  /** Call only after the host checked all native and Web runs for this workspace. */
  async tick({ busy }: { busy: boolean }): Promise<ProjectCodeSyncStatus | undefined> {
    await this.initialize();
    if (busy) { this.#stableDigest = ""; this.#stableSince = 0; return; }
    const binding = await this.#readBinding();
    if (!binding.automatic_upload) return;
    if (binding.interrupted_download) throw new CodeSyncError("code_sync_recovery_required", "Automatic upload is paused after an interrupted download. Recover into a new folder and review the private download backup.");
    const inventory = await this.#inventory();
    const currentDigest = digest(JSON.stringify(inventory.hashes));
    if (currentDigest !== this.#stableDigest) { this.#stableDigest = currentDigest; this.#stableSince = Date.now(); return; }
    if (Date.now() - this.#stableSince < 5_000 || Date.now() - this.#lastAutomaticAttempt < 15_000
      || sameHashes(binding.baseline, inventory.hashes)) return;
    const previousNames = Object.keys(binding.baseline);
    const deleted = previousNames.filter((name) => inventory.hashes[name] === undefined).length;
    if (deleted > 0 && deleted >= previousNames.length / 2) {
      throw new CodeSyncError("code_sync_dirty", "Many local source files are missing. Automatic upload is paused; recover cloud code or explicitly upload the intended deletions.");
    }
    this.#lastAutomaticAttempt = Date.now();
    return this.#upload(inventory.hashes);
  }

  async execute(kind: string, { busy = false, operationId }: { busy?: boolean; operationId?: string } = {}): Promise<ProjectCodeSyncStatus> {
    if (busy && ["code_upload", "code_download", "code_recover", "code_auto_upload_enable"].includes(kind)) {
      throw new CodeSyncError("code_sync_busy", "An Agent is working in this workspace. Wait until it finishes before syncing code.");
    }
    switch (kind) {
      case "code_sync_status": return this.status();
      case "code_upload": return this.upload();
      case "code_download": return this.download();
      case "code_recover": return this.recover(operationId);
      case "code_auto_upload_enable": return this.setAutomaticUpload(true);
      case "code_auto_upload_disable": return this.setAutomaticUpload(false);
      default: throw new CodeSyncError("code_sync_unsupported", "Unsupported code sync action.");
    }
  }

  async #cloudStatus(): Promise<CodeStatus> {
    const parsed = CodeStatusSchema.safeParse(await this.#request(""));
    if (!parsed.success) throw invalidResponse();
    return parsed.data;
  }
  async #snapshot(cloud: CodeStatus) {
    if (!cloud.repository.main_commit && !cloud.own_branch_id) throw new CodeSyncError("code_sync_empty", "No code has been uploaded yet.");
    const parsed = CodeSnapshotResultSchema.safeParse(await this.#request(`/snapshot?branch_id=${encodeURIComponent(cloud.own_branch_id ?? "main")}`));
    if (!parsed.success) throw invalidResponse();
    return parsed.data.snapshot;
  }
  #status(binding: Binding, cloud: CodeStatus, inventory: Inventory): ProjectCodeSyncStatus {
    const cloudCommit = cloud.branches.find((branch) => branch.id === cloud.own_branch_id)?.head_commit ?? cloud.repository.main_commit;
    return {
      enabled: cloud.repository.enabled, automatic_upload: binding.automatic_upload,
      local_changes: changedCount(binding.baseline, inventory.hashes), file_count: inventory.files.length,
      excluded_count: inventory.excluded, base_commit: binding.base_commit, cloud_commit: cloudCommit,
      branch_id: cloud.own_branch_id, needs_download: cloudCommit !== null && cloudCommit !== binding.base_commit,
    };
  }
  async #request(suffix: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(`${this.#apiUrl}/projects/${encodeURIComponent(this.#options.projectId)}/code${suffix}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${this.#options.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new CodeSyncError("code_sync_unavailable", "The code server could not be reached. No local files were discarded."); }
    if (!response.body) throw invalidResponse();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > CODE_SYNC_MAX_BODY_BYTES) { await reader.cancel(); throw new CodeSyncError("code_sync_limit", "The cloud code response exceeds the safe size limit."); }
      chunks.push(next.value);
    }
    let data: { data?: unknown; error?: { code?: unknown } };
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof data; }
    catch { throw invalidResponse(); }
    if (!response.ok) {
      const publicErrors: Record<string, string> = {
        code_secret_detected: "The server detected a credential or private key in source. Remove it before sharing.",
        code_storage_quota_exceeded: "The project code storage limit was reached. Ask the server administrator to review storage.",
        code_storage_check_required: "Code writes are paused for a storage check. Contact the server administrator; conversation synchronization remains available.",
        code_git_unavailable: "Server Git is unavailable. Ask the server administrator to verify Git and code storage access.",
        code_storage_unavailable: "Server code storage is unavailable. Ask the server administrator to check storage access.",
        code_not_enabled: "The project owner must enable code storage before transferring source.",
      };
      const publicCode = data && typeof data === "object" && typeof data.error?.code === "string" ? data.error.code : "";
      if (Object.hasOwn(publicErrors, publicCode)) throw new CodeSyncError(publicCode, publicErrors[publicCode]!);
      throw new CodeSyncError(response.status === 409 ? "code_sync_conflict" : response.status === 401 || response.status === 403 ? "code_sync_forbidden" : "code_sync_unavailable",
        response.status === 409 ? "Cloud code changed or has a merge conflict. Refresh and download or recover it before retrying." : "The code operation was rejected. Check project access and repository availability.");
    }
    if (!data || typeof data !== "object" || !("data" in data)) throw invalidResponse();
    return data.data;
  }
  async #readBinding(): Promise<Binding> {
    const file = path.join(this.#stateRoot, "binding.json");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BINDING_BYTES) throw new CodeSyncError("code_sync_binding", "Private code sync state is not a regular bounded file.");
    let binding: Binding;
    try { binding = JSON.parse(await readFile(file, "utf8")) as Binding; }
    catch (error) { if (isMissing(error)) throw error; throw new CodeSyncError("code_sync_binding", "Private code sync state is invalid."); }
    if (!binding || typeof binding !== "object" || Array.isArray(binding)
      || binding.version !== 1 || binding.api_url !== this.#apiUrl || binding.project_id !== this.#options.projectId
      || binding.actor_id !== this.#options.actorId || binding.workspace_path !== this.#root
      || typeof binding.automatic_upload !== "boolean" || !binding.baseline || typeof binding.baseline !== "object"
      || Array.isArray(binding.baseline) || (binding.base_commit !== null && !/^[a-f0-9]{40}$/u.test(binding.base_commit))) {
      throw new CodeSyncError("code_sync_binding", "This workspace code binding belongs to another project, server or user, or is invalid. Use a separate workspace.");
    }
    if (binding.interrupted_download !== undefined && typeof binding.interrupted_download !== "boolean") throw new CodeSyncError("code_sync_binding", "Private download recovery state is invalid.");
    if (binding.executable_paths !== undefined && (!Array.isArray(binding.executable_paths)
      || binding.executable_paths.length > CODE_SYNC_MAX_FILES
      || binding.executable_paths.some((name) => typeof name !== "string" || !isCodeSyncPathAllowed(name)))) throw new CodeSyncError("code_sync_binding", "Private code file-mode state is invalid.");
    const baseline = Object.entries(binding.baseline);
    if (baseline.length > CODE_SYNC_MAX_FILES) throw new CodeSyncError("code_sync_binding", "Private code sync baseline exceeds the file limit.");
    for (const [name, hash] of baseline) {
      if (!isCodeSyncPathAllowed(name) || typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) throw new CodeSyncError("code_sync_binding", "Private code sync baseline is invalid.");
    }
    return binding;
  }
  #save(binding: Binding) { return writePrivate(path.join(this.#stateRoot, "binding.json"), JSON.stringify(binding)); }

  async #requireWorkspace(): Promise<void> {
    try {
      const info = await lstat(this.#root);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.#root) !== this.#root) {
        throw new CodeSyncError("code_sync_binding", "The authorized workspace changed location or type.");
      }
    } catch (error) {
      if (isMissing(error)) throw new CodeSyncError("code_sync_recovery_required", "The local workspace is missing. Recover cloud code into a new folder; missing source is not uploaded as a deletion.");
      throw error;
    }
  }

  async #inventory(executableHints?: ReadonlySet<string>): Promise<Inventory> {
    try {
      if ((await realpath(this.#root)) !== this.#root) throw new CodeSyncError("code_sync_binding", "The authorized workspace changed location.");
    } catch (error) { if (isMissing(error)) return { files: [], hashes: {}, excluded: 0 }; throw error; }
    let tracked = new Set<string>();
    const nativeExecutables = new Set<string>();
    let candidates: string[];
    let nativeRoot = "";
    try { nativeRoot = (await git(["rev-parse", "--show-toplevel"], this.#root)).trim(); } catch { /* Non-Git workspaces use the private inventory index. */ }
    if (nativeRoot && await realpath(nativeRoot) === this.#root) {
      const trackedEntries = (await git(["ls-files", "--stage", "-z"], this.#root)).split("\0").filter(Boolean);
      tracked = new Set(trackedEntries.map((entry) => entry.slice(entry.indexOf("\t") + 1)));
      for (const entry of trackedEntries) if (entry.startsWith("100755 ")) nativeExecutables.add(entry.slice(entry.indexOf("\t") + 1));
      candidates = [...tracked, ...(await git(["ls-files", "--others", "--exclude-standard", "-z"], this.#root)).split("\0").filter(Boolean)];
    } else {
      candidates = (await git([`--git-dir=${path.join(this.#stateRoot, "inventory.git")}`, `--work-tree=${this.#root}`, "ls-files", "--others", "--exclude-standard", "-z"], this.#root)).split("\0").filter(Boolean);
    }
    // Previously uploaded cloud files stay tracked even if a new .gitignore
    // matches them, exactly as normal Git-tracked files do.
    const binding = await this.#readBinding();
    const executablePaths = executableHints ?? new Set(binding.executable_paths ?? []);
    for (const name of Object.keys(binding.baseline)) { tracked.add(name); candidates.push(name); }
    const files: CodeFile[] = [];
    let excluded = 0;
    let totalBytes = 0;
    for (const name of [...new Set(candidates)].sort()) {
      if (!isCodeSyncPathAllowed(name) || BUILD_PATH.test(name)) {
        if (tracked.has(name) && !BUILD_PATH.test(name)) throw new CodeSyncError("code_sync_secret", "A tracked private or unsafe file is excluded from code sync. Remove it from version control before uploading.");
        excluded += 1; continue;
      }
      const target = path.join(this.#root, ...name.split("/"));
      if (!await safeAncestors(this.#root, name)) { excluded += 1; continue; }
      let info;
      try { info = await lstat(target); } catch (error) { if (isMissing(error)) continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) { excluded += 1; continue; }
      if (info.size > CODE_SYNC_MAX_FILE_BYTES) throw new CodeSyncError("code_sync_limit", "A source file exceeds the 2 MiB code sync limit.");
      const source = await readBoundedSource(target);
      const bytes = source.bytes;
      if (containsCodeSyncSecret(bytes.toString("utf8"))) throw new CodeSyncError("code_sync_secret", "A source file contains a recognizable credential or private key. Remove it before uploading.");
      totalBytes += bytes.byteLength;
      if (totalBytes > CODE_SYNC_MAX_SNAPSHOT_BYTES || files.length >= CODE_SYNC_MAX_FILES) throw new CodeSyncError("code_sync_limit", "Code sync is limited to 1,000 files and 8 MiB per checkpoint.");
      files.push({ path: name, content_base64: bytes.toString("base64"), executable: process.platform === "win32"
        ? executablePaths.has(name) || nativeExecutables.has(name) : source.executable });
    }
    if (!CodeFilesSchema.safeParse(files).success) throw new CodeSyncError("code_sync_unsafe_path", "Source files contain non-portable or conflicting paths.");
    return { files, hashes: fileHashes(files), excluded };
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.#stateRoot, "operation.lock");
    let handle;
    try { handle = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimDeadLock(lockPath)) {
        try { handle = await open(lockPath, "wx", 0o600); } catch { /* Another connector won recovery. */ }
      }
      if (!handle) throw new CodeSyncError("code_sync_locked", "Another local code sync operation is running. Retry when it finishes; an unrecognized lock requires local review.");
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); return await operation(); }
    finally { await handle.close(); await unlink(lockPath); }
  }
}

async function reclaimDeadLock(filename: string): Promise<boolean> {
  try {
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512) return false;
    const data = JSON.parse(await readFile(filename, "utf8")) as { pid?: number };
    if (!Number.isSafeInteger(data.pid) || (data.pid ?? 0) < 1) return false;
    try { process.kill(data.pid!, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    const current = await lstat(filename);
    if (before.ino !== current.ino || before.mtimeMs !== current.mtimeMs || before.size !== current.size) return false;
    await unlink(filename);
    return true;
  } catch { return false; }
}

function fileHashes(files: readonly CodeFile[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, digest(`${file.executable ? "1" : "0"}\0${file.content_base64}`)]).sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")));
}
function sameHashes(a: Record<string, string>, b: Record<string, string>) { return changedCount(a, b) === 0; }
function changedCount(a: Record<string, string>, b: Record<string, string>) { return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((name) => a[name] !== b[name]).length; }
function invalidResponse() { return new CodeSyncError("code_sync_unavailable", "The code server returned an invalid response."); }
function assertEnabled(status: CodeStatus) { if (!status.repository.enabled) throw new CodeSyncError("code_sync_disabled", "The project owner must enable code collaboration first."); }
function isMissing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function isWithin(root: string, target: string) { const relative = path.relative(root, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }

async function git(args: string[], cwd: string): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("GATHERTHREAD_")));
  try {
    const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    });
    return result.stdout;
  } catch { throw new CodeSyncError("code_sync_unavailable", "Git file inspection failed. Install Git and check the local workspace."); }
}

async function writePrivate(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filename);
}

async function safeAncestors(root: string, relative: string, create = false): Promise<boolean> {
  const pieces = relative.split("/");
  pieces.pop();
  let current = root;
  for (const piece of pieces) {
    current = path.join(current, piece);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (create) await mkdir(current, { mode: 0o700 });
    }
  }
  return true;
}

async function fileHash(root: string, name: string, executableHint?: boolean): Promise<string | undefined> {
  if (!await safeAncestors(root, name)) throw new CodeSyncError("code_sync_unsafe_path", "A destination directory is a symbolic link or not a directory.");
  const target = path.join(root, ...name.split("/"));
  let info;
  try { info = await lstat(target); } catch (error) { if (isMissing(error)) return; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > CODE_SYNC_MAX_FILE_BYTES) throw new CodeSyncError("code_sync_unsafe_path", "A destination is not a bounded regular source file.");
  const source = await readBoundedSource(target);
  const executable = process.platform === "win32" && executableHint !== undefined ? executableHint : source.executable;
  return digest(`${executable ? "1" : "0"}\0${source.bytes.toString("base64")}`);
}

async function readBoundedSource(filename: string): Promise<{ bytes: Buffer; executable: boolean }> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > CODE_SYNC_MAX_FILE_BYTES) throw new CodeSyncError("code_sync_unsafe_path", "A source path is not a bounded regular file.");
    const buffer = Buffer.alloc(before.size + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (result.bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new CodeSyncError("code_sync_busy", "Source files changed during inspection. Retry when the workspace is idle.");
    return { bytes: buffer.subarray(0, result.bytesRead), executable: (before.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}

async function applySnapshot(root: string, files: CodeFile[], baseline: Record<string, string>, options?: {
  backupRoot: string;
  beforeWrite: () => Promise<void>;
  baselineExecutables?: ReadonlySet<string>;
}): Promise<void> {
  if (!CodeFilesSchema.safeParse(files).success) throw new CodeSyncError("code_sync_unsafe_path", "Cloud code contains unsafe paths.");
  const names = new Set([...Object.keys(baseline), ...files.map((file) => file.path)]);
  // Check every destination before modifying any file, including ignored local files.
  for (const name of names) {
    if (await fileHash(root, name, options?.baselineExecutables?.has(name)) !== baseline[name]) throw new CodeSyncError("code_sync_dirty", "Cloud code would overwrite local or ignored files. Recover into a new folder instead.");
  }
  if (options) {
    await mkdir(options.backupRoot, { recursive: true, mode: 0o700 });
    for (const name of Object.keys(baseline)) {
      const source = await readBoundedSource(path.join(root, ...name.split("/")));
      if (process.platform === "win32" && options.baselineExecutables) source.executable = options.baselineExecutables.has(name);
      if (digest(`${source.executable ? "1" : "0"}\0${source.bytes.toString("base64")}`) !== baseline[name]) throw new CodeSyncError("code_sync_busy", "Source files changed before the download backup was complete.");
      const destination = path.join(options.backupRoot, ...name.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(destination, "wx", source.executable ? 0o700 : 0o600);
      try { await handle.writeFile(source.bytes); await handle.sync(); } finally { await handle.close(); }
    }
    await options.beforeWrite();
  }
  const targetNames = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (!await safeAncestors(root, file.path, true) || await fileHash(root, file.path, options?.baselineExecutables?.has(file.path)) !== baseline[file.path]) throw new CodeSyncError("code_sync_busy", "Local files changed during download. No further files were applied.");
    const filename = path.join(root, ...file.path.split("/"));
    // Keep the temporary leaf short even when the portable filename is at the
    // filesystem limit. Staying in the same directory preserves atomic rename.
    const temporary = path.join(path.dirname(filename), `.gatherthread-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", file.executable ? 0o700 : 0o600);
    try { await handle.writeFile(Buffer.from(file.content_base64, "base64")); await handle.sync(); } finally { await handle.close(); }
    if (!await safeAncestors(root, file.path) || await fileHash(root, file.path, options?.baselineExecutables?.has(file.path)) !== baseline[file.path]) {
      await unlink(temporary);
      throw new CodeSyncError("code_sync_busy", "Source files changed while preparing a download. Original files were backed up; no further files were applied.");
    }
    await rename(temporary, filename);
  }
  for (const name of Object.keys(baseline)) {
    if (!targetNames.has(name)) {
      if (await fileHash(root, name, options?.baselineExecutables?.has(name)) !== baseline[name]) throw new CodeSyncError("code_sync_busy", "Local files changed during download. No further files were applied.");
      await unlink(path.join(root, ...name.split("/")));
    }
  }
}
