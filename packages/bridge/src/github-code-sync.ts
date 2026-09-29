import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import {
  GitHubConnectionSchema, GitHubProjectStatusSchema,
  GITHUB_CODE_SYNC_LIMITS, createCodeFilesSchema, containsCodeSyncSecret,
  type CodeFile, type CodeStatus, type CodeCheckpointInput, type CodeMutationResult,
} from "@gatherthread/protocol";
import { CodeSyncError, ProjectCodeSync, type CodeSyncStorage, type ProjectCodeSyncOptions } from "./code-sync.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const Commit = /^[a-f0-9]{40}$/u;
const filesSchema = createCodeFilesSchema(GITHUB_CODE_SYNC_LIMITS);
const generatedPath = /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.cache|\.turbo|\.venv|venv|__pycache__)(?:\/|$)/u;
export interface GitHubCodeSyncOptions extends ProjectCodeSyncOptions {
  repository: string;
  baseBranch: string;
  /** Exact configuration shown when local consent was granted. */
  revision: string;
}
export type GitHubGitRunner = (args: string[], options: { cwd: string; input?: Buffer; index?: string }) => Promise<Buffer>;

/** Local transport, not an HTTP code proxy. Injectable runner is for offline fixtures only. */
export function createGitHubCodeSync(options: GitHubCodeSyncOptions, runner: GitHubGitRunner = runGitHubGit): ProjectCodeSync {
  return new ProjectCodeSync({ ...options, storage: new GitHubCodeStorage(options, runner) });
}

class GitHubCodeStorage implements CodeSyncStorage {
  readonly limits = GITHUB_CODE_SYNC_LIMITS;
  readonly key: string;
  readonly metadata;
  readonly #options: GitHubCodeSyncOptions;
  readonly #run: GitHubGitRunner;
  readonly #remote: string;
  readonly #branchId: string;
  #directory = "";
  readonly #revision: string;
  constructor(options: GitHubCodeSyncOptions, runner: GitHubGitRunner) {
    if (!GitHubConnectionSchema.safeParse({ repository: options.repository, base_branch: options.baseBranch, revision: options.revision, enabled: true }).success) {
      throw new CodeSyncError("code_sync_binding", "GitHub requires an owner/repository and a valid base branch.");
    }
    const branch = `gatherthread/${hash(options.projectId).slice(0, 24)}/${hash(options.actorId).slice(0, 24)}`;
    if (options.baseBranch.startsWith("gatherthread/")) throw new CodeSyncError("code_sync_binding", "Choose a base branch outside GatherThread personal branches.");
    this.#options = options;
    this.#run = runner;
    this.#revision = options.revision;
    this.#remote = `https://github.com/${options.repository}.git`;
    this.#branchId = `branch-${hash(branch).slice(0, 24)}`;
    this.key = JSON.stringify(["github", options.apiUrl.replace(/\/$/u, "").replace(/\/v1$/u, ""), options.projectId, options.actorId, options.repository.toLowerCase(), options.baseBranch, options.revision]);
    this.metadata = { provider: "github" as const, repository: options.repository, branch, base_branch: options.baseBranch };
  }
  async initialize(privateDirectory: string): Promise<void> {
    this.#directory = path.join(privateDirectory, "github.git");
    try { if ((await lstat(this.#directory)).isSymbolicLink()) throw new CodeSyncError("code_sync_binding", "Private GitHub state cannot be a symbolic link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#git(["init", "--bare", "--quiet", "."]);
    // Repository-controlled .gitattributes must not amplify conflict markers
    // into unbounded objects before we can validate the resulting tree.
    const info = path.join(this.#directory, "info");
    await mkdir(info, { recursive: true, mode: 0o700 });
    if ((await lstat(info)).isSymbolicLink()) throw new CodeSyncError("code_sync_binding", "Private GitHub attributes directory is unsafe.");
    const attributes = await open(path.join(info, "attributes"), constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { if (!(await attributes.stat()).isFile() || (await attributes.stat()).nlink !== 1) throw new CodeSyncError("code_sync_binding", "Private GitHub attributes must be a regular file.");
      await attributes.truncate(0);
      await attributes.writeFile("* conflict-marker-size=7\n"); } finally { await attributes.close(); }
  }
  async #authorize(): Promise<boolean> {
    const url = new URL(this.#options.apiUrl);
    url.pathname = url.pathname.replace(/\/$/u, "").replace(/\/v1$/u, "") + `/v1/projects/${encodeURIComponent(this.#options.projectId)}/github`;
    let response: Response;
    try { response = await (this.#options.fetch ?? fetch)(url.toString(), {
      headers: { authorization: `Bearer ${this.#options.token}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
    }); } catch { throw new CodeSyncError("code_sync_unavailable", "GatherThread could not verify current GitHub project access."); }
    if (!response.ok) { await response.body?.cancel(); throw new CodeSyncError("code_sync_forbidden", "Current GatherThread project access is required for GitHub synchronization."); }
    if (!response.body) throw new CodeSyncError("code_sync_unavailable", "Invalid GitHub configuration response.");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 16_384) { await reader.cancel(); throw new CodeSyncError("code_sync_limit", "GitHub configuration response is too large."); } chunks.push(part.value); }
    let data;
    try { data = GitHubProjectStatusSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")).data); }
    catch { throw new CodeSyncError("code_sync_unavailable", "Invalid GitHub configuration response."); }
    const connection = data.connection;
    if (!data.can_write || data.branch !== this.metadata.branch || !connection
      || connection.repository.toLowerCase() !== this.#options.repository.toLowerCase() || connection.base_branch !== this.#options.baseBranch) {
      throw new CodeSyncError("code_sync_binding", "GitHub target or project permissions changed. Review the connection and authorize it locally again.");
    }
    // Disabling must still allow status and the local auto-upload off action.
    if (!connection.enabled) return false;
    if (this.#revision !== connection.revision) throw new CodeSyncError("code_sync_binding", "GitHub configuration changed. Reconnect and authorize the current target locally again.");
    return true;
  }
  async #enabled(): Promise<void> {
    if (!await this.#authorize()) throw new CodeSyncError("code_sync_disabled", "GitHub synchronization is paused for this project.");
  }
  async status(): Promise<CodeStatus> {
    if (!await this.#authorize()) return { repository: { enabled: false, main_commit: null }, branches: [], own_branch_id: null };
    const refs = (await this.#git(["ls-remote", "--refs", this.#remote, `refs/heads/${this.#options.baseBranch}`, `refs/heads/${this.metadata.branch}`])).toString("utf8");
    let main: string | null = null; let own: string | null = null;
    for (const line of refs.trim().split("\n")) { const [oid, ref] = line.split("\t"); if (!oid || !Commit.test(oid)) continue;
      if (ref === `refs/heads/${this.#options.baseBranch}`) main = oid;
      if (ref === `refs/heads/${this.metadata.branch}`) own = oid;
    }
    return { repository: { enabled: true, main_commit: main },
      own_branch_id: own ? this.#branchId : null,
      branches: own ? [{ id: this.#branchId, name: "My GitHub branch", user_id: this.#options.actorId, head_commit: own, review_status: "draft" }] : [] };
  }
  #head(status: CodeStatus): string | null { return status.branches[0]?.head_commit ?? status.repository.main_commit; }
  async #fetch(status: CodeStatus): Promise<void> {
    await this.#enabled();
    const refs: string[] = [];
    if (status.repository.main_commit) refs.push(`+refs/heads/${this.#options.baseBranch}:refs/gt/base`);
    if (status.own_branch_id) refs.push(`+refs/heads/${this.metadata.branch}:refs/gt/own`);
    if (refs.length) await this.#git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", this.#remote, ...refs]);
    // A moving remote must not quietly change the snapshot requested by the caller.
    for (const [ref, expected] of [["refs/gt/base", status.repository.main_commit], ["refs/gt/own", status.branches[0]?.head_commit]] as const) {
      if (expected && (await this.#git(["rev-parse", "--verify", ref])).toString().trim() !== expected) throw conflict();
    }
  }
  async snapshot(status: CodeStatus): Promise<{ commit: string; files: CodeFile[] }> {
    const commit = this.#head(status);
    if (!commit) throw new CodeSyncError("code_sync_empty", "No GitHub files have been uploaded yet.");
    await this.#fetch(status);
    return { commit, files: await this.#files(commit) };
  }
  async #files(commit: string): Promise<CodeFile[]> {
    if (!Commit.test(commit)) throw conflict();
    const listing = await this.#git(["ls-tree", "-r", "-z", "-l", commit]);
    if (!Buffer.from(listing.toString("utf8"), "utf8").equals(listing)) throw new CodeSyncError("code_sync_unsafe_path", "The GitHub tree contains non-UTF-8 filenames. Use native Git for this repository.");
    const entries = listing.toString("utf8").split("\0").filter(Boolean).map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/u.exec(entry);
      if (!match) throw new CodeSyncError("code_sync_unsupported", "This GitHub tree contains unsupported links, submodules or paths. Use native Git for this repository.");
      return { mode: match[1]!, oid: match[2]!, size: Number(match[3]), path: match[4]! };
    });
    if (entries.length > this.limits.maxFiles || entries.some((entry) => entry.size > this.limits.maxFileBytes)
      || entries.reduce((sum, entry) => sum + entry.size, 0) > this.limits.maxSnapshotBytes) throw new CodeSyncError("code_sync_limit", "GitHub source exceeds the supported checkpoint limit. Use native Git for larger trees.");
    const output = entries.length ? await this.#git(["cat-file", "--batch"], Buffer.from(entries.map((entry) => entry.oid).join("\n") + "\n")) : Buffer.alloc(0);
    let offset = 0;
    const files: CodeFile[] = [];
    for (const entry of entries) {
      const end = output.indexOf(10, offset);
      if (end < 0 || output.subarray(offset, end).toString() !== `${entry.oid} blob ${entry.size}`) throw conflict();
      const content = output.subarray(end + 1, end + 1 + entry.size); offset = end + 2 + entry.size;
      if (content.length !== entry.size || output[offset - 1] !== 10) throw conflict();
      if (generatedPath.test(entry.path) || containsCodeSyncSecret(content.toString("utf8")) || content.subarray(0, 80).toString().startsWith("version https://git-lfs.github.com/spec/v1")) {
        throw new CodeSyncError("code_sync_unsupported", "This GitHub tree contains excluded generated files, credentials or Git LFS pointers. Nothing was applied; use native Git or a source-only repository.");
      }
      files.push({ path: entry.path, content_base64: content.toString("base64"), executable: entry.mode === "100755" });
    }
    if (!filesSchema.safeParse(files).success) throw new CodeSyncError("code_sync_unsafe_path", "The GitHub tree contains non-portable or private paths. Nothing was applied.");
    return files;
  }
  async #tree(files: CodeFile[]): Promise<string> {
    if (!filesSchema.safeParse(files).success) throw new CodeSyncError("code_sync_limit", "Source tree exceeds GitHub checkpoint limits.");
    const index = path.join(this.#directory, `index-${randomUUID()}`);
    try {
      await this.#git(["read-tree", "--empty"], undefined, index);
      const records: string[] = [];
      for (const file of files) {
        const bytes = Buffer.from(file.content_base64, "base64");
        if (containsCodeSyncSecret(bytes.toString("utf8"))) throw new CodeSyncError("code_sync_secret", "A recognizable credential was detected in source.");
        if (generatedPath.test(file.path) || bytes.subarray(0, 80).toString().startsWith("version https://git-lfs.github.com/spec/v1")) throw new CodeSyncError("code_sync_unsupported", "Use native Git for Git LFS or generated-file repositories.");
        const oid = (await this.#git(["hash-object", "-w", "--stdin", "--no-filters"], bytes)).toString().trim();
        if (!Commit.test(oid)) throw conflict();
        records.push(`${file.executable ? "100755" : "100644"} ${oid}\t${file.path}\0`);
      }
      await this.#git(["update-index", "-z", "--index-info"], Buffer.from(records.join("")), index);
      return (await this.#git(["write-tree"], undefined, index)).toString().trim();
    } finally { await unlink(index).catch(() => {}); }
  }
  async checkpoint(input: CodeCheckpointInput): Promise<CodeMutationResult> {
    const status = await this.status(); await this.#enabled();
    const current = this.#head(status);
    await this.#fetch(status);
    // Validate the entire existing tree before replacing it: never silently
    // drop unsupported/filtered remote files in a source checkpoint.
    if (current) await this.#files(current);
    const tree = await this.#tree(input.files);
    if (current && (await this.#git(["rev-parse", `${current}^{tree}`])).toString().trim() === tree) return { status, commit: current };
    if (input.base_commit !== current) throw conflict();
    const commit = (await this.#git(["commit-tree", tree, ...(current ? ["-p", current] : []), "-m", "GatherThread workspace checkpoint"])).toString().trim();
    await this.#push(commit, status);
    const next = await this.status(); if (this.#head(next) !== commit) throw conflict();
    return { status: next, commit };
  }
  async #push(commit: string, expected: CodeStatus): Promise<void> {
    await this.#enabled();
    const latest = await this.status();
    if (this.#head(latest) !== this.#head(expected) || latest.own_branch_id !== expected.own_branch_id) throw conflict();
    // Normal fast-forward push only. No force, default-branch mutation or hooks.
    await this.#git(["push", "--porcelain", "--no-verify", this.#remote, `${commit}:refs/heads/${this.metadata.branch}`]);
  }
  async update(): Promise<CodeStatus> {
    const status = await this.status(); await this.#enabled();
    if (!status.own_branch_id || !status.repository.main_commit) return status;
    await this.#fetch(status);
    const own = this.#head(status)!; const base = status.repository.main_commit;
    await this.#files(own); await this.#files(base);
    if (own === base) return status;
    try { await this.#git(["merge-base", "--is-ancestor", base, own]); return status; }
    catch { /* A new base must be recorded as ancestry even if its tree is identical. */ }
    let tree: string;
    try { tree = (await this.#git(["merge-tree", "--write-tree", own, base])).toString().split("\n")[0]!.trim(); }
    catch { throw new CodeSyncError("code_sync_conflict", "The base branch could not be merged automatically. Resolve conflicts using native Git or GitHub, then download again. Git 2.38 or newer is required."); }
    if (!Commit.test(tree)) throw conflict();
    // Validate merged tree before publishing it (it can exceed combined limits).
    await this.#files(tree);
    const commit = (await this.#git(["commit-tree", tree, "-p", own, "-p", base, "-m", "Merge shared GitHub base into my GatherThread branch"])).toString().trim();
    await this.#push(commit, status); return this.status();
  }
  #git(args: string[], input?: Buffer, index?: string): Promise<Buffer> { return this.#run(args, { cwd: this.#directory, ...(input ? { input } : {}), ...(index ? { index } : {}) }); }
}
function conflict() { return new CodeSyncError("code_sync_conflict", "GitHub progress changed. Refresh, then download or recover before uploading again."); }

/** No workspace Git config, executable hooks, filters, URL rewrites or token output. */
export async function runGitHubGit(args: string[], options: { cwd: string; input?: Buffer; index?: string }): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("GIT_") && !key.startsWith("GATHERTHREAD_")
    && !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_PROMPT_DISABLED"].includes(key)));
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false",
      "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false",
      "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-c", "credential.interactive=false",
      "-c", "user.name=GatherThread", "-c", "user.email=checkpoint@users.noreply.github.com", ...args], {
      cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) },
    });
    const chunks: Buffer[] = []; let size = 0; let failed = false;
    const fail = () => { if (failed) return; failed = true; child.kill(); reject(new CodeSyncError("code_sync_unavailable", "GitHub Git operation failed. Check Git 2.38+, GitHub CLI login, repository access and network. No credentials are sent through GatherThread.")); };
    const timer = setTimeout(fail, 120_000); timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > GITHUB_CODE_SYNC_LIMITS.maxSnapshotBytes + 8 * 1024 * 1024) fail(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.on("error", fail);
    child.on("close", (code) => { clearTimeout(timer); if (code !== 0) fail(); else if (!failed) resolve(Buffer.concat(chunks)); });
    child.stdin.end(options.input);
  });
}
