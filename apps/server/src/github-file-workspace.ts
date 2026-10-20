import { createHash } from "node:crypto";
import {
  FileBranchesInputSchema, FileContentInputSchema, FileTreeInputSchema, FileHistoryInputSchema,
  FileChangesInputSchema, FileMutationInputSchema, GITHUB_CODE_SYNC_LIMITS,
  containsCodeSyncSecret, isCodeSyncPathAllowed,
  type FileBranchesInput, type FileBranchesResult, type FileTreeInput, type FileTreeResult,
  type FileContentInput, type FileContentResult, type FileHistoryInput, type FileHistoryResult,
  type FileChangesInput, type FileChangesResult, type FileMutationInput, type FileMutationResult,
  type FileOperation,
} from "@gatherthread/protocol";
import type { Actor } from "./database.js";
import { ApiError, idempotencyConflict } from "./errors.js";
import type { FileWorkspaceProviderAdapter } from "./file-workspace.js";
import type { HostedGithub, HostedGithubRepositoryGuard } from "./hosted-github.js";
import { redactJson } from "./redaction.js";
import type { CollaborationService } from "./service.js";

const MAX_BROWSER_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MUTATION_RECEIPTS = 10_000;
const SHA = /^[a-f0-9]{40}$/u;
const personalBranch = (projectId: string, userId: string) => `gatherthread/${hash(projectId).slice(0, 24)}/${hash(userId).slice(0, 24)}`;
// "own" is a virtual personal selection, but is also a valid shared Git ref.
// A colon cannot occur in a Git ref, so this read-only base ID is unambiguous.
const baseBranchId = (branch: string) => branch === "own" ? "base:own" : branch;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const key = (path: string) => path.normalize("NFC").replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "").toLowerCase();
const eligible = (path: string) => isCodeSyncPathAllowed(path)
  && !path.split("/").some(part => ["node_modules", "dist", "coverage", ".next", ".turbo"].includes(key(part)))
  && key(path) !== ".github/workflows" && !key(path).startsWith(".github/workflows/");
const fail = (code: string, message: string, status = 409) => new ApiError(status, code, message);
const invalid = () => fail("github_response", "GitHub returned unsupported repository metadata. Refresh or use GitHub directly.", 502);
const limit = () => fail("github_source_limit", "This repository or file exceeds browser safety limits. Open it on GitHub or use native Git.", 413);
const conflict = () => fail("file_path_conflict", "The destination already exists or conflicts with another file or folder.");
const changed = () => fail("file_head_changed", "The branch changed. Refresh and review your files before saving again.");
const locks = new Map<string, Promise<void>>();

interface Entry { path: string; sha: string; size: number; mode: string; type: string; content_base64?: string }
interface Selection { guard: HostedGithubRepositoryGuard; branch: string; branch_id: string; head: string; commit: string; can_write: boolean; assertCurrent(): void }
interface Receipt {
  fingerprint: string; repository_id: number; binding_revision: string; connection_revision: string;
  authorization_generation: number; branch: string; base_commit: string; initial_head: string | null;
  timestamp: string; new_commit: string | null;
}

/** Bounded Git Data adapter. Only selected file bytes cross the browser read path. */
export class GithubFileWorkspace implements FileWorkspaceProviderAdapter {
  constructor(private readonly service: CollaborationService, private readonly github: HostedGithub,
    private readonly assertRequestCurrent: () => void = () => {}) {
    assertRequestCurrent();
    service.database.sqlite.exec(`CREATE TABLE IF NOT EXISTS github_file_mutation_receipts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      repository_id INTEGER NOT NULL, binding_revision TEXT NOT NULL, connection_revision TEXT NOT NULL,
      authorization_generation INTEGER NOT NULL, branch TEXT NOT NULL, base_commit TEXT NOT NULL,
      initial_head TEXT, timestamp TEXT NOT NULL, new_commit TEXT,
      PRIMARY KEY(user_id,project_id,idempotency_key)
    ) STRICT`);
  }

  async branches(actor: Actor, projectId: string, value: FileBranchesInput): Promise<FileBranchesResult> {
    const input = FileBranchesInputSchema.parse(value), guard = await this.guard(actor, projectId, input.connection_revision);
    const prefix = `/repos/${guard.repository}`, members = this.service.listProjectMembers(actor, projectId);
    const visible = new Map(members.map(member => [personalBranch(projectId, member.user_id), member.user_id]));
    const refs = await guard.request(`${prefix}/git/matching-refs/heads/${encodeURIComponent(`gatherthread/${hash(projectId).slice(0, 24)}/`)}`);
    if (!Array.isArray(refs) || refs.length > GITHUB_CODE_SYNC_LIMITS.maxFiles) throw limit();
    const base = await this.head(guard, guard.base_branch);
    if (!base) throw fail("github_branch_missing", "The project's shared GitHub branch is unavailable.", 404);
    const branches: FileBranchesResult["branches"] = [{ id: baseBranchId(guard.base_branch), name: guard.base_branch, user_id: null, head_commit: base, can_write: false }];
    const seen = new Set([guard.base_branch]);
    for (const ref of refs) {
      if (typeof ref?.ref !== "string" || !ref.ref.startsWith("refs/heads/")) throw invalid();
      const name = ref.ref.slice(11), userId = visible.get(name);
      if (!userId || seen.has(name)) continue;
      const current = this.service.database.projectMembershipRole(projectId, userId);
      if (!current) continue;
      seen.add(name);
      branches.push({ id: name, name, user_id: userId, head_commit: this.sha(ref.object?.sha), can_write: name === guard.own_branch && guard.can_write });
    }
    if (!seen.has(guard.own_branch)) branches.push({ id: "own", name: guard.own_branch, user_id: actor.user_id, head_commit: base, can_write: guard.can_write });
    if (branches.length > 1000) throw limit();
    guard.assertCurrent();
    return { provider: "github", branches, default_branch_id: seen.has(guard.own_branch) ? guard.own_branch : "own", connection_revision: guard.connection_revision };
  }

  async tree(actor: Actor, projectId: string, value: FileTreeInput): Promise<FileTreeResult> {
    const input = FileTreeInputSchema.parse(value), selected = await this.selection(actor, projectId, input);
    const tree = await this.entries(selected.guard, selected.commit);
    selected.assertCurrent();
    return { ...this.result(selected), commit: selected.commit, head_commit: selected.head,
      can_write: selected.can_write && selected.commit === selected.head,
      entries: tree.visible.map(entry => ({ path: entry.path, size: entry.size, executable: entry.mode === "100755" })) };
  }

  async content(actor: Actor, projectId: string, value: FileContentInput): Promise<FileContentResult> {
    const input = FileContentInputSchema.parse(value), selected = await this.selection(actor, projectId, input);
    const tree = await this.entries(selected.guard, selected.commit), entry = tree.visible.find(item => item.path === input.path);
    if (!entry) throw fail("file_not_found", "The selected file is unavailable.", 404);
    if (entry.size > MAX_BROWSER_FILE_BYTES) throw limit();
    const blob = await selected.guard.request(`/repos/${selected.guard.repository}/git/blobs/${entry.sha}`);
    const bytes = this.blob(blob);
    if (bytes.length !== entry.size) throw invalid();
    if (containsCodeSyncSecret(bytes.toString("utf8"))) throw fail("file_secret", "This file contains recognizable credentials and cannot be shown in the browser.", 403);
    selected.assertCurrent();
    return { ...this.result(selected), commit: selected.commit, path: input.path, content_base64: bytes.toString("base64"), size: bytes.length, executable: entry.mode === "100755" };
  }

  async history(actor: Actor, projectId: string, value: FileHistoryInput): Promise<FileHistoryResult> {
    const input = FileHistoryInputSchema.parse(value), selected = await this.selection(actor, projectId, input);
    if (input.path && !eligible(input.path)) throw fail("file_unsupported", "This path is not available in the browser.", 422);
    if (input.cursor) await this.reachable(selected.guard, input.cursor, selected.commit);
    const commits: FileHistoryResult["commits"] = [];
    let found = !input.cursor, nextCursor: string | undefined;
    // The cursor is a commit in the pinned GitHub ordering, not a caller-supplied refspec.
    for (let page = 1; page <= 100; page++) {
      const data = await selected.guard.request(`/repos/${selected.guard.repository}/commits?sha=${selected.commit}&per_page=100&page=${page}${input.path ? `&path=${encodeURIComponent(input.path)}` : ""}`);
      if (!Array.isArray(data) || data.length > 100) throw invalid();
      for (const item of data) {
        const id = this.sha(item?.sha);
        if (!found) { if (id === input.cursor) found = true; continue; }
        if (commits.length === input.limit) { nextCursor = commits.at(-1)!.id; break; }
        if (!Array.isArray(item.parents) || item.parents.length > 16 || typeof item.commit?.message !== "string"
          || typeof item.commit?.author?.name !== "string" || typeof item.commit?.author?.date !== "string"
          || !Number.isFinite(Date.parse(item.commit.author.date))) throw invalid();
        commits.push({ id, parent_ids: item.parents.map((parent: { sha: string }) => this.sha(parent.sha)),
          message: String(redactJson(item.commit.message)).slice(0, 10000), author_name: String(redactJson(item.commit.author.name)).slice(0, 512),
          created_at: new Date(item.commit.author.date).toISOString() });
      }
      if (nextCursor || data.length < 100) break;
      if (commits.length === input.limit) { nextCursor = commits.at(-1)!.id; break; }
      if (page === 100) throw fail("file_history_limit", "This history cursor is too deep for browser access. Open the history on GitHub.", 413);
    }
    if (!found) throw fail("file_history_cursor", "This history cursor is unavailable. Refresh the branch history.");
    selected.assertCurrent();
    return { ...this.result(selected), commits, ...(nextCursor ? { next_cursor: nextCursor } : {}) };
  }

  async changes(actor: Actor, projectId: string, value: FileChangesInput): Promise<FileChangesResult> {
    const input = FileChangesInputSchema.parse(value), selected = await this.selection(actor, projectId, input);
    const commit = await this.commit(selected.guard, selected.commit);
    const base = input.base_commit ?? (commit.parents[0]?.sha ?? null);
    if (base) await this.reachable(selected.guard, base, selected.head);
    const after = await this.entries(selected.guard, selected.commit), before = base ? await this.entries(selected.guard, base) : { visible: [] as Entry[] };
    const previous = new Map(before.visible.map(entry => [entry.path, entry])), current = new Map(after.visible.map(entry => [entry.path, entry]));
    const files: FileChangesResult["files"] = [];
    for (const entry of after.visible) {
      const old = previous.get(entry.path);
      if (!old) files.push({ path: entry.path, status: "added" });
      else if (old.sha !== entry.sha || old.mode !== entry.mode) files.push({ path: entry.path, status: "modified" });
    }
    for (const entry of before.visible) if (!current.has(entry.path)) files.push({ path: entry.path, status: "deleted" });
    selected.assertCurrent();
    return { ...this.result(selected), base_commit: base, commit: selected.commit, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  async mutate(actor: Actor, projectId: string, value: FileMutationInput): Promise<FileMutationResult> {
    const input = FileMutationInputSchema.parse(value), guard = await this.guard(actor, projectId, input.connection_revision, true);
    if (input.branch_id !== "own" && input.branch_id !== guard.own_branch) throw fail("file_read_only", "Only your stable personal GitHub branch can be edited.", 403);
    const lockId = `${actor.user_id}:${guard.repository_id}:${guard.own_branch}`, prior = locks.get(lockId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = prior.then(() => current); locks.set(lockId, queued);
    await prior;
    try { return await this.write(actor, projectId, input, guard); }
    finally { release(); if (locks.get(lockId) === queued) locks.delete(lockId); }
  }

  private async write(actor: Actor, projectId: string, input: FileMutationInput, guard: HostedGithubRepositoryGuard): Promise<FileMutationResult> {
    guard.assertCurrent();
    const sqlite = this.service.database.sqlite, fingerprint = guard.fingerprint(JSON.stringify(input));
    let receipt = sqlite.prepare("SELECT * FROM github_file_mutation_receipts WHERE user_id=? AND project_id=? AND idempotency_key=?")
      .get(actor.user_id, projectId, input.idempotency_key) as unknown as Receipt | undefined;
    const replayed = Boolean(receipt);
    if (receipt && receipt.fingerprint !== fingerprint) throw idempotencyConflict();
    if (receipt && (receipt.repository_id !== guard.repository_id || receipt.binding_revision !== guard.binding_revision
      || receipt.connection_revision !== guard.connection_revision || receipt.authorization_generation !== guard.authorization_generation)) {
      throw fail("github_binding_changed", "This save belongs to an earlier GitHub authorization. Refresh and review the repository.");
    }
    let head = await this.head(guard, guard.own_branch);
    if (receipt?.new_commit && await this.applied(guard, receipt.new_commit, head)) {
      return { provider: "github", branch_id: guard.own_branch, connection_revision: guard.connection_revision, commit: receipt.new_commit, replayed: true };
    }
    const expectedHead = receipt ? receipt.initial_head : head ? input.base_commit : null;
    if (head !== expectedHead) throw changed();
    if (!head) {
      const base = await this.head(guard, guard.base_branch);
      if (!base || base !== input.base_commit) throw changed();
    }
    // Reject invalid transforms before allocating durable metadata. No external
    // object write occurs until the original-input receipt has been committed.
    const original = receipt?.new_commit ? null : await this.entries(guard, input.base_commit);
    const next = original ? this.transform(original.all, input.operations) : null;
    if (!receipt) {
      receipt = { fingerprint, repository_id: guard.repository_id, binding_revision: guard.binding_revision,
        connection_revision: guard.connection_revision, authorization_generation: guard.authorization_generation,
        branch: guard.own_branch, base_commit: input.base_commit, initial_head: head, timestamp: new Date().toISOString(), new_commit: null };
      guard.assertCurrent();
      const inserted = sqlite.prepare(`INSERT INTO github_file_mutation_receipts
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM github_file_mutation_receipts WHERE user_id=? AND project_id=?) < ?`).run(
        actor.user_id, projectId, input.idempotency_key, receipt.fingerprint, receipt.repository_id, receipt.binding_revision,
        receipt.connection_revision, receipt.authorization_generation, receipt.branch, receipt.base_commit, receipt.initial_head, receipt.timestamp, receipt.new_commit,
        actor.user_id, projectId, MAX_MUTATION_RECEIPTS,
      );
      if (!inserted.changes) throw fail("file_receipt_limit",
        "This project reached your browser save-receipt safety limit. Continue through GitHub or native Git; previous browser saves can still be retried.", 429);
    }
    if (!receipt.new_commit) {
      if (!original || !next) throw invalid();
      const old = new Map(original.all.map(entry => [entry.path, entry])), paths = new Set(next.map(entry => entry.path));
      const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
      for (const entry of next) {
        if (entry.content_base64 !== undefined) {
          const blob = await guard.request(`/repos/${guard.repository}/git/blobs`, "POST", { content: entry.content_base64, encoding: "base64" });
          entry.sha = this.sha(blob.sha);
        }
        const previous = old.get(entry.path);
        if (!previous || previous.sha !== entry.sha || previous.mode !== entry.mode) tree.push({ path: entry.path, mode: entry.mode, type: "blob", sha: entry.sha });
      }
      for (const entry of original.all) if (!paths.has(entry.path)) tree.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: null });
      let newCommit = input.base_commit;
      if (tree.length) {
        const result = await guard.request(`/repos/${guard.repository}/git/trees`, "POST", { base_tree: original.tree_sha, tree });
        const treeSha = this.sha(result.sha);
        const identity = { name: "GatherThread browser", email: "noreply@gatherthread.invalid", date: receipt.timestamp };
        const resultCommit = await guard.request(`/repos/${guard.repository}/git/commits`, "POST", {
          message: input.message, tree: treeSha, parents: [input.base_commit], author: identity, committer: identity,
        });
        newCommit = this.sha(resultCommit.sha);
      }
      guard.assertCurrent();
      // Persist the exact result before the only write that makes objects reachable.
      sqlite.prepare(`UPDATE github_file_mutation_receipts SET new_commit=? WHERE user_id=? AND project_id=? AND idempotency_key=? AND fingerprint=?`)
        .run(newCommit, actor.user_id, projectId, input.idempotency_key, fingerprint);
      receipt.new_commit = newCommit;
    }
    head = await this.head(guard, guard.own_branch);
    if (await this.applied(guard, receipt.new_commit, head)) {
      return { provider: "github", branch_id: guard.own_branch, connection_revision: guard.connection_revision, commit: receipt.new_commit, replayed: true };
    }
    if (head !== receipt.initial_head) throw changed();
    guard.assertCurrent();
    // REST offers fast-forward, not an expected-old-SHA CAS. Serialize this process,
    // re-read immediately, never force, and verify the exact commit after dispatch.
    try {
      if (head) await guard.request(`/repos/${guard.repository}/git/refs/heads/${encodeURIComponent(guard.own_branch)}`, "PATCH", { sha: receipt.new_commit, force: false });
      else await guard.request(`/repos/${guard.repository}/git/refs`, "POST", { ref: `refs/heads/${guard.own_branch}`, sha: receipt.new_commit });
    } catch (error) {
      guard.assertCurrent();
      const reconciled = await this.head(guard, guard.own_branch);
      if (!await this.applied(guard, receipt.new_commit, reconciled)) {
        if (reconciled !== receipt.initial_head) throw changed();
        throw error;
      }
    }
    const verified = await this.head(guard, guard.own_branch);
    if (!await this.applied(guard, receipt.new_commit, verified)) throw changed();
    guard.assertCurrent();
    return { provider: "github", branch_id: guard.own_branch, connection_revision: guard.connection_revision, commit: receipt.new_commit, ...(replayed ? { replayed: true } : {}) };
  }

  private async guard(actor: Actor, projectId: string, revision: string | number | undefined, write = false) {
    this.assertRequestCurrent();
    const guard = await this.github.repositoryGuard(actor, projectId, write, this.assertRequestCurrent);
    this.assertRequestCurrent();
    if (revision !== undefined && revision !== guard.connection_revision) throw fail("github_binding_changed", "The project repository changed. Refresh the file browser.");
    return guard;
  }
  private result(selected: Selection) {
    return { provider: "github" as const, branch_id: selected.branch_id, connection_revision: selected.guard.connection_revision };
  }
  private sha(value: unknown): string { if (typeof value !== "string" || !SHA.test(value)) throw invalid(); return value; }
  private async head(guard: HostedGithubRepositoryGuard, branch: string): Promise<string | null> {
    const refs = await guard.request(`/repos/${guard.repository}/git/matching-refs/heads/${encodeURIComponent(branch)}`);
    if (!Array.isArray(refs) || refs.length > GITHUB_CODE_SYNC_LIMITS.maxFiles) throw invalid();
    const matches = refs.filter(ref => ref?.ref === `refs/heads/${branch}`);
    if (matches.length > 1) throw invalid();
    return matches.length ? this.sha(matches[0].object?.sha) : null;
  }
  private async selection(actor: Actor, projectId: string, input: { branch_id: string; commit?: string | undefined; connection_revision?: string | number | undefined }): Promise<Selection> {
    const guard = await this.guard(actor, projectId, input.connection_revision);
    const branch = input.branch_id === "own" ? guard.own_branch
      : input.branch_id === baseBranchId(guard.base_branch) ? guard.base_branch : input.branch_id;
    const member = this.service.listProjectMembers(actor, projectId).find(item => personalBranch(projectId, item.user_id) === branch);
    if (branch !== guard.base_branch && !member) throw fail("file_branch_unavailable", "This branch is not part of the current project.", 404);
    const assertCurrent = () => {
      guard.assertCurrent();
      if (member && !this.service.database.projectMembershipRole(projectId, member.user_id)) throw fail("file_branch_unavailable", "This member's branch is no longer available in the project.", 404);
    };
    assertCurrent();
    let head = await this.head(guard, branch);
    if (!head && branch === guard.own_branch) head = await this.head(guard, guard.base_branch);
    if (!head) throw fail("file_branch_unavailable", "This branch is unavailable.", 404);
    const commit = input.commit ?? head;
    await this.reachable(guard, commit, head); assertCurrent();
    const selectedGuard: HostedGithubRepositoryGuard = { ...guard, get can_write() { return guard.can_write; }, assertCurrent,
      request: async (path, method, body) => {
        assertCurrent(); const result = await guard.request(path, method, body); assertCurrent(); return result;
      } };
    return { guard: selectedGuard, branch, branch_id: input.branch_id, head, commit,
      get can_write() { return branch === guard.own_branch && guard.can_write; }, assertCurrent };
  }
  private async reachable(guard: HostedGithubRepositoryGuard, commit: string, head: string): Promise<void> {
    this.sha(commit); this.sha(head); if (commit === head) return;
    const result = await guard.request(`/repos/${guard.repository}/compare/${commit}...${head}?per_page=1`);
    if (!["ahead", "identical"].includes(result.status) || result.merge_base_commit?.sha !== commit || result.base_commit?.sha !== commit) {
      throw fail("file_commit_unavailable", "This version is not reachable from the selected project branch.", 404);
    }
  }
  private async applied(guard: HostedGithubRepositoryGuard, commit: string, head: string | null): Promise<boolean> {
    if (!head) return false;
    if (head === commit) return true;
    try { await this.reachable(guard, commit, head); return true; }
    catch (error) { if (error instanceof ApiError && error.code === "file_commit_unavailable") return false; throw error; }
  }
  private async commit(guard: HostedGithubRepositoryGuard, sha: string) {
    const commit = await guard.request(`/repos/${guard.repository}/git/commits/${this.sha(sha)}`);
    if (!Array.isArray(commit.parents) || commit.parents.length > 16) throw invalid();
    for (const parent of commit.parents) this.sha(parent?.sha);
    this.sha(commit.tree?.sha);
    return commit as { tree: { sha: string }; parents: Array<{ sha: string }> };
  }
  private async entries(guard: HostedGithubRepositoryGuard, sha: string) {
    const commit = await this.commit(guard, sha), result = await guard.request(`/repos/${guard.repository}/git/trees/${commit.tree.sha}?recursive=1`);
    if (result.truncated !== false || !Array.isArray(result.tree) || result.tree.length > GITHUB_CODE_SYNC_LIMITS.maxFiles * 4) throw limit();
    const all: Entry[] = [], visible: Entry[] = [];
    let size = 0;
    for (const entry of result.tree) {
      if (entry?.type === "tree") continue;
      if (typeof entry?.path !== "string" || entry.path.length > 500 || !["blob", "commit"].includes(entry.type)
        || !["100644", "100755", "120000", "160000"].includes(entry.mode)) throw invalid();
      const regular = entry.type === "blob" && ["100644", "100755"].includes(entry.mode);
      if (regular && (!Number.isSafeInteger(entry.size) || entry.size < 0)) throw invalid();
      const row: Entry = { path: entry.path, sha: this.sha(entry.sha), mode: entry.mode, type: entry.type, size: regular ? entry.size : 0 };
      all.push(row); size += row.size;
      if (regular && eligible(row.path)) visible.push(row);
    }
    if (all.length > GITHUB_CODE_SYNC_LIMITS.maxFiles || size > GITHUB_CODE_SYNC_LIMITS.maxSnapshotBytes) throw limit();
    this.layout(all);
    return { tree_sha: commit.tree.sha, all, visible: visible.sort((a, b) => a.path.localeCompare(b.path)) };
  }
  private blob(value: any): Buffer {
    if (value?.encoding !== "base64" || typeof value.content !== "string" || value.content.length > 12 * 1024 * 1024) throw limit();
    const content = value.content.replace(/[\r\n]/gu, "");
    // A nested base64 repetition over multi-MiB files can exhaust V8's regexp stack.
    if (content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(content)) throw invalid();
    const bytes = Buffer.from(content, "base64");
    if (bytes.length > MAX_BROWSER_FILE_BYTES || bytes.toString("base64") !== content) throw limit();
    if (bytes.subarray(0, 200).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
      throw fail("file_unsupported", "Git LFS files must be opened through GitHub or native Git.", 422);
    }
    return bytes;
  }
  private layout(entries: Entry[]) {
    const paths = new Map<string, { path: string; file: boolean }>();
    for (const entry of entries) {
      const parts = entry.path.split("/");
      for (let index = 1; index <= parts.length; index++) {
        const path = parts.slice(0, index).join("/"), normalized = key(path), file = index === parts.length, old = paths.get(normalized);
        if (old && (old.path !== path || old.file || file)) throw conflict();
        paths.set(normalized, { path, file });
      }
    }
  }
  private transform(original: Entry[], operations: FileOperation[]): Entry[] {
    let entries = original.map(entry => ({ ...entry }));
    for (const operation of operations) {
      if (!eligible(operation.path) || (operation.type === "copy" || operation.type === "move") && !eligible(operation.destination)) {
        throw fail("file_unsupported", "Private, generated and workflow paths cannot be edited in the browser.", 422);
      }
      if (operation.type === "write") {
        const bytes = this.blob({ encoding: "base64", content: operation.content_base64 });
        if (containsCodeSyncSecret(bytes.toString("utf8"))) throw fail("file_secret", "Recognizable credentials cannot be written to source files.", 422);
        const previous = entries.find(entry => entry.path === operation.path);
        if (previous && (previous.type !== "blob" || !["100644", "100755"].includes(previous.mode))) throw conflict();
        entries = entries.filter(entry => entry.path !== operation.path);
        entries.push({ path: operation.path, type: "blob", mode: (operation.executable ?? previous?.mode === "100755") ? "100755" : "100644",
          sha: "0".repeat(40), size: bytes.length, content_base64: operation.content_base64 });
      } else {
        const source = entries.filter(entry => entry.path === operation.path || entry.path.startsWith(`${operation.path}/`));
        if (!source.length) throw fail("file_not_found", "The source file or folder no longer exists.", 404);
        if (source.some(entry => !eligible(entry.path) || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
          throw fail("file_unsupported", "This folder contains protected or unsupported files. Use native Git for this operation.", 422);
        }
        if (operation.type === "delete") entries = entries.filter(entry => !source.includes(entry));
        else {
          if (key(operation.path) === key(operation.destination) || key(operation.destination).startsWith(`${key(operation.path)}/`)
            || entries.some(entry => key(entry.path) === key(operation.destination) || key(entry.path).startsWith(`${key(operation.destination)}/`))) throw conflict();
          // Bound every intermediate tree before expanding it. A bounded batch of
          // nested copies must not grow exponentially before the final check.
          if (operation.type === "copy" && (entries.length + source.length > GITHUB_CODE_SYNC_LIMITS.maxFiles
            || entries.reduce((sum, entry) => sum + entry.size, 0) + source.reduce((sum, entry) => sum + entry.size, 0)
              > GITHUB_CODE_SYNC_LIMITS.maxSnapshotBytes)) throw limit();
          const copies = source.map(entry => ({ ...entry, path: operation.destination + entry.path.slice(operation.path.length) }));
          if (copies.some(entry => !eligible(entry.path))) {
            throw fail("file_unsupported", "A resulting path is private, generated, protected or too long. Choose another destination.", 422);
          }
          if (operation.type === "move") entries = entries.filter(entry => !source.includes(entry));
          entries.push(...copies);
        }
      }
      if (entries.length > GITHUB_CODE_SYNC_LIMITS.maxFiles || entries.reduce((sum, entry) => sum + entry.size, 0) > GITHUB_CODE_SYNC_LIMITS.maxSnapshotBytes) throw limit();
      this.layout(entries);
    }
    return entries;
  }
}
