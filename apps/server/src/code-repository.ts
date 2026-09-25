import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import {
  CodeBranchSchema, CodeCheckpointInputSchema, CodeClearBranchInputSchema, CodeClearProjectInputSchema,
  CodeDisableInputSchema, CodeEnableInputSchema, CodeFilesSchema, CodeMergeInputSchema,
  CodeReviewInputSchema, CodeUpdateInputSchema, containsCodeSyncSecret, type CodeBranch, type CodeFile,
  type CodeClearResult, type CodeMutationResult, type CodeSnapshotResult, type CodeStatus, type CodeStorageSummary,
} from "@gatherthread/protocol";
import type { Actor, CollaborationDatabase } from "./database.js";
import { ApiError, forbidden, idempotencyConflict, notFound } from "./errors.js";
import { CodeStorageBudget } from "./code-storage-budget.js";

const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_USER_CODE_BYTES = 128 * 1024 * 1024;
const MAX_MUTATIONS = 4096;
const INVALIDATED_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SERVER_MERGE_ATTRIBUTES = "* conflict-marker-size=7\n";
interface RepoRow { main_commit: string; enabled: number; charged_bytes: number; main_logical_bytes: number }
interface Receipt { user_id: string; operation: string; payload_hash: string; result_json: string; invalidated_at: string | null }

/** Standard bare Git object storage; SQLite is the atomic ref/ACL/retry authority. */
export class CodeRepository {
  private readonly diskBudget: CodeStorageBudget;
  constructor(private readonly database: CollaborationDatabase, private readonly root: string) {
    this.diskBudget = new CodeStorageBudget(root);
  }

  repairAfterMembershipRemoval(projectId: string): void { this.repairRefs(projectId); }

  status(actor: Actor, projectId: string): CodeStatus {
    this.authorize(actor, projectId);
    return this.readStatus(actor, projectId);
  }

  storageSummary(actor: Actor): CodeStorageSummary {
    this.database.assertActiveDevice(actor);
    const sql = this.database.sqlite;
    sql.exec("BEGIN IMMEDIATE");
    try {
      const visible = sql.prepare(`SELECT r.project_id FROM code_repositories r
        JOIN project_memberships m ON m.project_id=r.project_id WHERE m.user_id=?`)
        .all(actor.user_id) as Array<{ project_id: string }>;
      for (const row of visible) this.hydrateProjectUsage(row.project_id);
      // A former member's branch remains charged until it is explicitly cleared.
      this.hydrateUserUsage(actor.user_id);
      const rows = sql.prepare(`
        SELECT p.id AS project_id, p.title AS project_title, p.owner_user_id, r.enabled, r.main_commit,
          r.main_logical_bytes AS main_bytes, b.id AS own_branch_id, b.head_commit AS own_branch_head_commit,
          COALESCE(b.logical_bytes, 0) AS own_branch_bytes,
          (SELECT COUNT(*) FROM code_branches all_branches WHERE all_branches.project_id=p.id) AS branch_count
        FROM project_memberships m JOIN projects p ON p.id=m.project_id
        JOIN code_repositories r ON r.project_id=p.id
        LEFT JOIN code_branches b ON b.project_id=p.id AND b.user_id=m.user_id
        WHERE m.user_id=? ORDER BY p.title, p.id
      `).all(actor.user_id) as Array<{
        project_id: string; project_title: string; owner_user_id: string; enabled: number; main_commit: string;
        main_bytes: number; own_branch_id: string | null; own_branch_head_commit: string | null;
        own_branch_bytes: number; branch_count: number;
      }>;
      const projects = rows.map((row) => ({
        project_id: row.project_id, project_title: row.project_title, repository_enabled: row.enabled === 1,
        main_commit: row.main_commit, main_bytes: row.main_bytes, own_branch_id: row.own_branch_id,
        own_branch_head_commit: row.own_branch_head_commit, own_branch_bytes: row.own_branch_bytes,
        branch_count: row.branch_count, can_clear_project: row.owner_user_id === actor.user_id,
      }));
      const detachedBranches = sql.prepare(`SELECT b.project_id,p.title AS project_title,
        b.head_commit AS own_branch_head_commit,b.logical_bytes AS own_branch_bytes
        FROM code_branches b JOIN projects p ON p.id=b.project_id
        WHERE b.user_id=? AND NOT EXISTS (SELECT 1 FROM project_memberships m
          WHERE m.project_id=b.project_id AND m.user_id=b.user_id)
        ORDER BY p.title,p.id`).all(actor.user_id) as CodeStorageSummary["detached_branches"];
      const result: CodeStorageSummary = { limit_bytes: MAX_USER_CODE_BYTES,
        used_bytes: this.userUsageBytes(actor.user_id), projects, detached_branches: detachedBranches };
      sql.exec("COMMIT");
      return result;
    } catch (error) { if (sql.isTransaction) sql.exec("ROLLBACK"); throw error; }
  }

  enable(actor: Actor, projectId: string, value: unknown): CodeMutationResult {
    const input = CodeEnableInputSchema.parse(value);
    return this.mutate(actor, projectId, "enable", input, "owner", () => {
      const existing = this.repo(projectId);
      if (existing) {
        this.diskBudget.reserve(this.repoPath(projectId), 64 * 1024);
        this.database.sqlite.prepare("UPDATE code_repositories SET enabled=1 WHERE project_id=?").run(projectId);
        return existing.main_commit;
      }
      this.prepareRoot();
      this.diskBudget.reserve(this.repoPath(projectId), 1024 * 1024);
      const path = this.repoPath(projectId);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      this.git(projectId, ["init", "--bare", "--initial-branch=main", path]);
      const tree = this.git(projectId, ["mktree"], "").toString().trim();
      const commit = this.createCommit(projectId, tree, [], "Initialize GatherThread code repository", actor);
      this.database.sqlite.prepare("INSERT INTO code_repositories(project_id,main_commit,created_at) VALUES(?,?,?)")
        .run(projectId, commit, new Date().toISOString());
      return commit;
    });
  }

  disable(actor: Actor, projectId: string, value: unknown): CodeMutationResult {
    const input = CodeDisableInputSchema.parse(value);
    return this.mutate(actor, projectId, "disable", input, "owner", () => {
      const repo = this.requireRepo(projectId);
      this.database.sqlite.prepare("UPDATE code_repositories SET enabled=0 WHERE project_id=?").run(projectId);
      return repo.main_commit;
    });
  }

  checkpoint(actor: Actor, projectId: string, value: unknown): CodeMutationResult {
    const input = CodeCheckpointInputSchema.parse(value);
    return this.mutate(actor, projectId, "checkpoint", input, "writer", () => {
      const repo = this.requireRepo(projectId);
      const branch = this.ownBranch(projectId, actor.user_id);
      const base = branch?.head_commit ?? repo.main_commit;
      if (input.base_commit !== base && !(input.base_commit === null && !branch && this.files(projectId, base).length === 0)) {
        throw this.stale();
      }
      if (!branch && this.branches(projectId).length >= 128) throw this.quota();
      this.validateSecrets(input.files);
      this.hydrateUserUsage(actor.user_id);
      const logicalBytes = input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content_base64, "base64"), 0);
      this.assertUserQuota(actor.user_id, logicalBytes - this.ownBranchBytes(projectId, actor.user_id));
      const bytes = input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content_base64, "base64"), 0) + 4096;
      this.charge(projectId, bytes);
      // Reserve before writing. Failed Git work keeps its reservation until reconciliation.
      this.reserveTreeWrite(projectId, input.files.map((file) => file.path), (bytes - 4096) * 3, input.files.length);
      const tree = this.writeTree(projectId, input.files);
      const previousTree = this.git(projectId, ["rev-parse", `${base}^{tree}`]).toString().trim();
      const commit = tree === previousTree ? base : this.createCommit(projectId, tree, [base], input.message, actor);
      const id = this.branchId(actor.user_id);
      this.database.sqlite.prepare(`INSERT INTO code_branches(project_id,id,name,user_id,head_commit,review_status,logical_bytes)
        VALUES(?,?,?,?,?,'draft',?) ON CONFLICT(project_id,id) DO UPDATE SET head_commit=excluded.head_commit,logical_bytes=excluded.logical_bytes,
        review_status=CASE WHEN code_branches.head_commit=excluded.head_commit THEN code_branches.review_status ELSE 'draft' END`)
        .run(projectId, id, `gt/${id.slice(7)}`, actor.user_id, commit, logicalBytes);
      return commit;
    });
  }

  snapshot(actor: Actor, projectId: string, branchId: string): CodeSnapshotResult {
    this.authorize(actor, projectId);
    const repo = this.requireRepo(projectId);
    const branch = branchId === "main" ? undefined : this.branches(projectId).find((entry) => entry.id === branchId);
    if (branchId !== "main" && !branch) throw notFound("Code branch");
    const commit = branch?.head_commit ?? repo.main_commit;
    return { snapshot: { branch_id: branchId, commit, files: this.files(projectId, commit) } };
  }

  review(actor: Actor, projectId: string, value: unknown): CodeMutationResult {
    const input = CodeReviewInputSchema.parse(value);
    return this.mutate(actor, projectId, "review", input, "writer", () => {
      this.requireRepo(projectId);
      const branch = this.requireOwnBranch(projectId, actor.user_id);
      if (branch.head_commit !== input.head_commit) throw this.stale();
      this.diskBudget.reserve(this.repoPath(projectId), 64 * 1024);
      this.database.sqlite.prepare("UPDATE code_branches SET review_status='requested' WHERE project_id=? AND id=?")
        .run(projectId, branch.id);
      return branch.head_commit;
    });
  }

  merge(actor: Actor, projectId: string, value: unknown): CodeMutationResult {
    const input = CodeMergeInputSchema.parse(value);
    return this.mutate(actor, projectId, "merge", input, "owner", () => {
      const repo = this.requireRepo(projectId);
      const branch = this.branches(projectId).find((entry) => entry.id === input.branch_id);
      if (!branch) throw notFound("Code branch");
      if (repo.main_commit !== input.expected_main_commit || branch.head_commit !== input.expected_head_commit) throw this.stale();
      if (branch.review_status !== "requested") throw new ApiError(409, "code_review_required", "Submit this branch for review before merging");
      this.charge(projectId, 4096);
      const commit = this.mergeCommits(projectId, repo.main_commit, branch.head_commit, actor, "Merge reviewed collaborator work");
      this.hydrateUserUsage(actor.user_id);
      const mainBytes = this.headBytes(projectId, commit);
      this.assertUserQuota(actor.user_id, mainBytes - this.mainBytes(projectId));
      this.database.sqlite.prepare("UPDATE code_repositories SET main_commit=?,main_logical_bytes=? WHERE project_id=?").run(commit, mainBytes, projectId);
      this.database.sqlite.prepare("UPDATE code_branches SET review_status='merged' WHERE project_id=? AND id=?").run(projectId, branch.id);
      return commit;
    });
  }

  update(actor: Actor, projectId: string, value: unknown): CodeMutationResult {
    const input = CodeUpdateInputSchema.parse(value);
    return this.mutate(actor, projectId, "update", input, "writer", () => {
      const repo = this.requireRepo(projectId);
      const branch = this.requireOwnBranch(projectId, actor.user_id);
      if (branch.head_commit !== input.base_commit || repo.main_commit !== input.expected_main_commit) throw this.stale();
      this.charge(projectId, 4096);
      const commit = this.mergeCommits(projectId, branch.head_commit, repo.main_commit, actor, "Bring shared main into collaborator branch");
      this.hydrateUserUsage(actor.user_id);
      const branchBytes = this.headBytes(projectId, commit);
      this.assertUserQuota(actor.user_id, branchBytes - this.ownBranchBytes(projectId, actor.user_id));
      this.database.sqlite.prepare("UPDATE code_branches SET head_commit=?,review_status='draft',logical_bytes=? WHERE project_id=? AND id=?")
        .run(commit, branchBytes, projectId, branch.id);
      return commit;
    });
  }

  clearBranch(actor: Actor, projectId: string, value: unknown): CodeClearResult {
    const input = CodeClearBranchInputSchema.parse(value);
    return this.clearMutation(actor, projectId, "clear_branch", input, () => {
      const branch = this.requireOwnBranch(projectId, actor.user_id);
      if (branch.head_commit !== input.expected_head_commit) throw this.stale();
      this.hydrateUserUsage(actor.user_id);
      const released = this.ownBranchBytes(projectId, actor.user_id);
      this.database.sqlite.prepare("DELETE FROM code_branches WHERE project_id=? AND user_id=?")
        .run(projectId, actor.user_id);
      return released;
    }, undefined, "actor");
  }

  clearDetachedBranch(actor: Actor, projectId: string, value: unknown): { released_bytes: number } {
    const input = CodeClearBranchInputSchema.parse(value);
    this.database.assertActiveDevice(actor);
    const sql = this.database.sqlite;
    sql.exec("BEGIN IMMEDIATE");
    try {
      if (this.database.projectMembershipRole(projectId, actor.user_id)) throw notFound("Detached cloud branch");
      const operation = "clear_detached_branch";
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const receipt = sql.prepare("SELECT * FROM code_mutations WHERE project_id=? AND idempotency_key=?")
        .get(projectId, input.idempotency_key) as unknown as Receipt | undefined;
      if (receipt) {
        if (receipt.user_id !== actor.user_id || receipt.operation !== operation || receipt.payload_hash !== hash) throw idempotencyConflict();
        if (receipt.invalidated_at !== null) throw new ApiError(409, "code_data_cleared", "Cloud code data was cleared; refresh before retrying");
        sql.exec("COMMIT");
        return JSON.parse(receipt.result_json) as { released_bytes: number };
      }
      const branch = sql.prepare("SELECT head_commit FROM code_branches WHERE project_id=? AND user_id=?")
        .get(projectId, actor.user_id) as { head_commit: string } | undefined;
      if (!branch) throw notFound("Detached cloud branch");
      if (branch.head_commit !== input.expected_head_commit) throw this.stale();
      this.hydrateUserUsage(actor.user_id);
      const result = { released_bytes: this.ownBranchBytes(projectId, actor.user_id) };
      sql.prepare("DELETE FROM code_branches WHERE project_id=? AND user_id=?").run(projectId, actor.user_id);
      sql.prepare("UPDATE code_mutations SET invalidated_at=? WHERE project_id=? AND user_id=? AND invalidated_at IS NULL")
        .run(new Date().toISOString(), projectId, actor.user_id);
      sql.prepare("INSERT INTO code_mutations(project_id,idempotency_key,user_id,operation,payload_hash,result_json) VALUES(?,?,?,?,?,?)")
        .run(projectId, input.idempotency_key, actor.user_id, operation, hash, JSON.stringify(result));
      sql.exec("COMMIT");
      this.repairRefs(projectId);
      return result;
    } catch (error) { if (sql.isTransaction) sql.exec("ROLLBACK"); throw error; }
  }

  clearProject(actor: Actor, projectId: string, value: unknown): CodeClearResult {
    const input = CodeClearProjectInputSchema.parse(value);
    return this.clearMutation(actor, projectId, "clear_project", input, () => {
      const repo = this.repo(projectId);
      if (!repo) throw notFound("Code repository");
      const currentBranches = this.branches(projectId)
        .map((branch) => ({ branch_id: branch.id, head_commit: branch.head_commit }))
        .sort((a, b) => a.branch_id.localeCompare(b.branch_id));
      const expectedBranches = [...input.expected_branches].sort((a, b) => a.branch_id.localeCompare(b.branch_id));
      if (repo.main_commit !== input.expected_main_commit || JSON.stringify(currentBranches) !== JSON.stringify(expectedBranches)) throw this.stale();
      this.hydrateProjectUsage(projectId);
      const branchUsage = this.database.sqlite.prepare(
        "SELECT COALESCE(SUM(logical_bytes),0) AS bytes FROM code_branches WHERE project_id=?",
      ).get(projectId) as { bytes: number };
      const released = this.mainBytes(projectId) + branchUsage.bytes;
      this.diskBudget.reserve(this.repoPath(projectId), 1024 * 1024);
      const tree = this.git(projectId, ["mktree"], "").toString().trim();
      const freshRoot = this.createCommit(projectId, tree, [], "Reset GatherThread cloud code repository", actor);
      this.database.sqlite.prepare("DELETE FROM code_branches WHERE project_id=?").run(projectId);
      this.database.sqlite.prepare("UPDATE code_repositories SET main_commit=?,main_logical_bytes=0,charged_bytes=0,enabled=0 WHERE project_id=?")
        .run(freshRoot, projectId);
      return released;
    }, "owner", "project");
  }

  private clearMutation(actor: Actor, projectId: string, operation: string, input: { idempotency_key: string }, apply: () => number,
    permission: "owner" | undefined, invalidate: "actor" | "project"): CodeClearResult {
    const sql = this.database.sqlite;
    sql.exec("BEGIN IMMEDIATE");
    try {
      // Cleanup remains available when a project is archived or Git is paused.
      this.authorize(actor, projectId, permission, true);
      this.pruneExpiredReceipts(projectId);
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const receipt = sql.prepare("SELECT * FROM code_mutations WHERE project_id=? AND idempotency_key=?")
        .get(projectId, input.idempotency_key) as unknown as Receipt | undefined;
      if (receipt) {
        if (receipt.user_id !== actor.user_id || receipt.operation !== operation || receipt.payload_hash !== hash) throw idempotencyConflict();
        if (receipt.invalidated_at !== null) throw new ApiError(409, "code_data_cleared", "Cloud code data was cleared; refresh status before retrying");
        sql.exec("COMMIT");
        return JSON.parse(receipt.result_json) as CodeClearResult;
      }
      const count = sql.prepare("SELECT COUNT(*) AS count FROM code_mutations WHERE project_id=? AND invalidated_at IS NULL")
        .get(projectId) as { count: number };
      if (count.count >= MAX_MUTATIONS + 128) throw this.quota();
      const released_bytes = apply();
      if (invalidate === "project") {
        sql.prepare("UPDATE code_mutations SET invalidated_at=? WHERE project_id=? AND invalidated_at IS NULL")
          .run(new Date().toISOString(), projectId);
      } else {
        sql.prepare("UPDATE code_mutations SET invalidated_at=? WHERE project_id=? AND user_id=? AND invalidated_at IS NULL")
          .run(new Date().toISOString(), projectId, actor.user_id);
      }
      const result: CodeClearResult = { status: this.readStatus(actor, projectId), released_bytes };
      sql.prepare("INSERT INTO code_mutations(project_id,idempotency_key,user_id,operation,payload_hash,result_json) VALUES(?,?,?,?,?,?)")
        .run(projectId, input.idempotency_key, actor.user_id, operation, hash, JSON.stringify(result));
      sql.exec("COMMIT");
      // SQLite heads/ACLs are authoritative. Repair the derived Git refs only
      // after commit, as with other mutations; a ref failure cannot roll back
      // a successful clear or expose an old head through the API.
      this.repairRefs(projectId);
      return result;
    } catch (error) { if (sql.isTransaction) sql.exec("ROLLBACK"); throw error; }
  }

  private mutate(actor: Actor, projectId: string, operation: string, input: { idempotency_key: string }, permission: "owner" | "writer", apply: () => string): CodeMutationResult {
    const sql = this.database.sqlite;
    sql.exec("BEGIN IMMEDIATE");
    try {
      this.authorize(actor, projectId, permission);
      this.pruneExpiredReceipts(projectId);
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const receipt = sql.prepare("SELECT * FROM code_mutations WHERE project_id=? AND idempotency_key=?")
        .get(projectId, input.idempotency_key) as unknown as Receipt | undefined;
      if (receipt) {
        if (receipt.user_id !== actor.user_id || receipt.operation !== operation || receipt.payload_hash !== hash) throw idempotencyConflict();
        if (receipt.invalidated_at !== null) throw new ApiError(409, "code_data_cleared", "Cloud code data was cleared; refresh status before retrying");
        sql.exec("COMMIT");
        return JSON.parse(receipt.result_json) as CodeMutationResult;
      }
      const count = sql.prepare("SELECT COUNT(*) AS count FROM code_mutations WHERE project_id=? AND invalidated_at IS NULL")
        .get(projectId) as { count: number };
      if (count.count >= MAX_MUTATIONS) throw this.quota();
      const commit = apply();
      const result: CodeMutationResult = { status: this.readStatus(actor, projectId), commit };
      const resultJson = JSON.stringify(result);
      // Retry receipts include a bounded branch view; charge their cumulative bytes too.
      this.charge(projectId, Buffer.byteLength(resultJson) + 256);
      sql.prepare("INSERT INTO code_mutations(project_id,idempotency_key,user_id,operation,payload_hash,result_json) VALUES(?,?,?,?,?,?)")
        .run(projectId, input.idempotency_key, actor.user_id, operation, hash, resultJson);
      sql.exec("COMMIT");
      // Ref repair is a derived cache: a crash here cannot lose an acknowledged DB head.
      this.repairRefs(projectId);
      return result;
    } catch (error) {
      if (sql.isTransaction) sql.exec("ROLLBACK");
      throw error;
    }
  }

  private authorize(actor: Actor, projectId: string, permission?: "owner" | "writer", allowArchived = false): void {
    this.database.assertActiveDevice(actor);
    const project = this.database.requireProject(projectId);
    const role = this.database.projectMembershipRole(projectId, actor.user_id);
    if (!role) throw notFound("Project");
    if (permission && !allowArchived && project.state !== "active") throw forbidden("Archived projects cannot change code");
    if (permission === "owner" && role !== "owner") throw forbidden("Only the project owner can perform this code operation");
    if (permission === "writer" && role === "viewer") throw forbidden("Viewers cannot upload code");
  }
  private pruneExpiredReceipts(projectId: string): void {
    this.database.sqlite.prepare("DELETE FROM code_mutations WHERE project_id=? AND invalidated_at < ?")
      .run(projectId, new Date(Date.now() - INVALIDATED_RECEIPT_RETENTION_MS).toISOString());
  }
  private repo(projectId: string): RepoRow | undefined {
    return this.database.sqlite.prepare("SELECT main_commit,enabled,charged_bytes,main_logical_bytes FROM code_repositories WHERE project_id=?").get(projectId) as unknown as RepoRow | undefined;
  }
  private requireRepo(projectId: string): RepoRow {
    const row = this.repo(projectId);
    if (!row || row.enabled !== 1) throw new ApiError(409, "code_not_enabled", "Enable project code collaboration first");
    return row;
  }
  private branches(projectId: string): CodeBranch[] {
    return this.database.sqlite.prepare("SELECT id,name,user_id,head_commit,review_status FROM code_branches WHERE project_id=? ORDER BY name")
      .all(projectId).map((row) => CodeBranchSchema.parse(row));
  }
  private ownBranch(projectId: string, userId: string): CodeBranch | undefined { return this.branches(projectId).find((branch) => branch.user_id === userId); }
  private requireOwnBranch(projectId: string, userId: string): CodeBranch {
    const branch = this.ownBranch(projectId, userId);
    if (!branch) throw notFound("Own code branch");
    return branch;
  }
  private branchId(userId: string): string { return `branch-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`; }
  private readStatus(actor: Actor, projectId: string): CodeStatus {
    const repo = this.repo(projectId);
    const branches = this.branches(projectId);
    return { repository: { enabled: repo?.enabled === 1, main_commit: repo?.main_commit ?? null }, branches, own_branch_id: branches.find((branch) => branch.user_id === actor.user_id)?.id ?? null };
  }
  private headBytes(projectId: string, commit: string): number {
    const entries = this.git(projectId, ["ls-tree", "-rlz", "--full-tree", commit]).toString("utf8").split("\0").filter(Boolean);
    let bytes = 0;
    for (const entry of entries) {
      const match = /^(?:100644|100755) blob [a-f0-9]{40} +(\d+)\t[\s\S]+$/u.exec(entry);
      if (!match) throw new ApiError(409, "code_unsupported_entry", "Only regular source files are supported");
      const size = Number(match[1]);
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(bytes + size)) throw this.quota();
      bytes += size;
    }
    return bytes;
  }
  private hydrateUserUsage(userId: string): void {
    const sql = this.database.sqlite;
    const branches = sql.prepare(`SELECT b.project_id,b.id,b.head_commit FROM code_branches b
      WHERE b.user_id=? AND b.logical_bytes=-1`).all(userId) as Array<{ project_id: string; id: string; head_commit: string }>;
    for (const branch of branches) {
      sql.prepare("UPDATE code_branches SET logical_bytes=? WHERE project_id=? AND id=?")
        .run(this.headBytes(branch.project_id, branch.head_commit), branch.project_id, branch.id);
    }
    const mains = sql.prepare(`SELECT r.project_id,r.main_commit FROM code_repositories r
      JOIN projects p ON p.id=r.project_id
      WHERE p.owner_user_id=? AND r.main_logical_bytes=-1`).all(userId) as Array<{ project_id: string; main_commit: string }>;
    for (const main of mains) {
      sql.prepare("UPDATE code_repositories SET main_logical_bytes=? WHERE project_id=?")
        .run(this.headBytes(main.project_id, main.main_commit), main.project_id);
    }
  }
  private hydrateProjectUsage(projectId: string): void {
    const sql = this.database.sqlite;
    const branches = sql.prepare("SELECT id,head_commit FROM code_branches WHERE project_id=? AND logical_bytes=-1")
      .all(projectId) as Array<{ id: string; head_commit: string }>;
    for (const branch of branches) {
      sql.prepare("UPDATE code_branches SET logical_bytes=? WHERE project_id=? AND id=?")
        .run(this.headBytes(projectId, branch.head_commit), projectId, branch.id);
    }
    const repo = this.repo(projectId);
    if (repo && repo.main_logical_bytes < 0) {
      sql.prepare("UPDATE code_repositories SET main_logical_bytes=? WHERE project_id=?")
        .run(this.headBytes(projectId, repo.main_commit), projectId);
    }
  }
  private ownBranchBytes(projectId: string, userId: string): number {
    const row = this.database.sqlite.prepare("SELECT logical_bytes AS bytes FROM code_branches WHERE project_id=? AND user_id=?")
      .get(projectId, userId) as { bytes: number } | undefined;
    if (row && row.bytes < 0) throw new ApiError(503, "code_storage_unavailable", "Code usage has not been reconciled");
    return row?.bytes ?? 0;
  }
  private mainBytes(projectId: string): number {
    const row = this.repo(projectId);
    if (!row || row.main_logical_bytes < 0) throw new ApiError(503, "code_storage_unavailable", "Code usage has not been reconciled");
    return row.main_logical_bytes;
  }
  private userUsageBytes(userId: string): number {
    const sql = this.database.sqlite;
    const own = sql.prepare(`SELECT COALESCE(SUM(b.logical_bytes),0) AS bytes FROM code_branches b
      WHERE b.user_id=?`)
      .get(userId) as { bytes: number };
    const mains = sql.prepare(`SELECT COALESCE(SUM(r.main_logical_bytes),0) AS bytes FROM code_repositories r
      JOIN projects p ON p.id=r.project_id
      WHERE p.owner_user_id=?`).get(userId) as { bytes: number };
    if (own.bytes < 0 || mains.bytes < 0) throw new ApiError(503, "code_storage_unavailable", "Code usage has not been reconciled");
    return own.bytes + mains.bytes;
  }
  private assertUserQuota(userId: string, delta: number): void {
    if (this.userUsageBytes(userId) + delta > MAX_USER_CODE_BYTES) throw this.quota();
  }
  private repoPath(projectId: string): string { return join(this.root, `${createHash("sha256").update(projectId).digest("hex")}.git`); }
  private prepareRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new ApiError(503, "code_storage_unavailable", "Code storage must be a private directory");
  }
  protected git(projectId: string, args: string[], input?: string | Buffer, extraEnv?: Record<string, string>, allowConflict = false): Buffer {
    // Git for Windows understands NUL, while Node's \\.\nul spelling is not
    // accepted consistently by its config and attributes file readers.
    const gitNull = process.platform === "win32" ? "NUL" : devNull;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitNull, GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: gitNull,
      GIT_CONFIG_KEY_1: "core.autocrlf", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "core.attributesFile", GIT_CONFIG_VALUE_2: gitNull,
      ...extraEnv,
    };
    // A bounded 1000-file batch can exceed 15 seconds on a busy Windows host.
    // Keep the longer deadline limited to the two batch-write commands.
    const timeout = args[0] === "hash-object" || args[0] === "update-index" ? 30_000 : 15_000;
    const result = spawnSync("git", [`--git-dir=${this.repoPath(projectId)}`, ...args], {
      env, input, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (allowConflict && result.status === 1) throw new ApiError(409, "code_merge_conflict", "These branches conflict. Resolve the files locally and upload a new checkpoint; neither branch was changed.");
    if (result.error || result.status !== 0) throw new ApiError(503, "code_git_unavailable", "The server Git operation failed. Verify Git 2.38+ and code storage access.");
    return result.stdout;
  }
  private writeTree(projectId: string, files: CodeFile[]): string {
    this.prepareRoot();
    const temporary = mkdtempSync(join(this.root, ".index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temporary, "index") };
      this.git(projectId, ["read-tree", "--empty"], undefined, env);
      const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
      // One Git process for all blobs, not one subprocess per source file.
      // Opaque temporary names keep untrusted source paths out of filesystem writes.
      const paths = ordered.map((file, index) => {
        const path = join(temporary, `blob-${index}`);
        writeFileSync(path, Buffer.from(file.content_base64, "base64"), { flag: "wx", mode: 0o600 });
        return JSON.stringify(path);
      });
      const objects = paths.length ? this.git(projectId, ["hash-object", "-w", "--no-filters", "--stdin-paths"], `${paths.join("\n")}\n`).toString().trim().split("\n") : [];
      if (objects.length !== ordered.length || objects.some((object) => !/^[a-f0-9]{40}$/u.test(object))) throw new ApiError(503, "code_git_unavailable", "Git returned invalid source objects");
      const lines = ordered.map((file, index) => `${file.executable ? "100755" : "100644"} ${objects[index]}\t${file.path}\0`);
      this.git(projectId, ["update-index", "-z", "--index-info"], lines.join(""), env);
      return this.git(projectId, ["write-tree"], undefined, env).toString().trim();
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  private createCommit(projectId: string, tree: string, parents: string[], message: string, actor: Actor): string {
    const name = actor.display_name.replace(/[<>\r\n\u0000]/gu, "").slice(0, 120) || "GatherThread collaborator";
    return this.git(projectId, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], `${message}\n`, {
      GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: "GatherThread", GIT_AUTHOR_EMAIL: `${this.branchId(actor.user_id)}@gatherthread.invalid`, GIT_COMMITTER_EMAIL: "server@gatherthread.invalid",
    }).toString().trim();
  }
  private files(projectId: string, commit: string): CodeFile[] {
    const entries = this.git(projectId, ["ls-tree", "-rz", "--full-tree", commit]).toString("utf8").split("\0").filter(Boolean);
    const metadata = entries.map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry);
      if (!match) throw new ApiError(409, "code_unsupported_entry", "Only regular source files are supported");
      return { path: match[3]!, object: match[2]!, executable: match[1] === "100755" };
    });
    const content = metadata.length ? this.git(projectId, ["cat-file", "--batch"], `${metadata.map((entry) => entry.object).join("\n")}\n`) : Buffer.alloc(0);
    let offset = 0;
    const files = metadata.map((entry) => {
      const end = content.indexOf(10, offset);
      const header = end === -1 ? null : /^([a-f0-9]{40}) blob (\d+)$/u.exec(content.subarray(offset, end).toString());
      if (!header || header[1] !== entry.object) throw new ApiError(503, "code_git_unavailable", "Git returned invalid snapshot objects");
      const size = Number(header[2]);
      const start = end + 1;
      if (!Number.isSafeInteger(size) || start + size >= content.length || content[start + size] !== 10) throw new ApiError(503, "code_git_unavailable", "Git returned a truncated snapshot object");
      offset = start + size + 1;
      return { path: entry.path, content_base64: content.subarray(start, start + size).toString("base64"), executable: entry.executable };
    });
    if (offset !== content.length) throw new ApiError(503, "code_git_unavailable", "Git returned extra snapshot data");
    return CodeFilesSchema.parse(files);
  }
  private mergeCommits(projectId: string, base: string, other: string, actor: Actor, message: string): string {
    if (base === other) {
      this.diskBudget.reserve(this.repoPath(projectId), 64 * 1024);
      return base;
    }
    this.reserveMergeWrite(projectId, base, other);
    this.ensureMergeAttributes(projectId);
    const output = this.git(projectId, ["merge-tree", "--write-tree", base, other], undefined, undefined, true).toString("utf8");
    const tree = output.split("\n")[0]!;
    if (!/^[a-f0-9]{40}$/u.test(tree)) throw new ApiError(503, "code_git_unavailable", "Git returned an invalid merge result");
    const commit = this.createCommit(projectId, tree, [base, other], message, actor);
    // Merges must respect the same bounded portable snapshot contract as uploads.
    this.validateSecrets(this.files(projectId, commit));
    return commit;
  }
  private ensureMergeAttributes(projectId: string): void {
    // Git 2.43 honors in-tree .gitattributes during bare merge-tree. A source
    // file can otherwise request huge conflict markers and bypass our bounded
    // merge-object reservation. info/attributes has precedence over the tree.
    const path = join(this.repoPath(projectId), "info", "attributes");
    try {
      writeFileSync(path, SERVER_MERGE_ATTRIBUTES, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST"
        || !lstatSync(path).isFile()
        || readFileSync(path, "utf8") !== SERVER_MERGE_ATTRIBUTES) {
        throw new ApiError(503, "code_git_unavailable", "The server Git merge attributes are unavailable");
      }
    }
  }
  private validateSecrets(files: CodeFile[]): void {
    for (const file of files) {
      const text = Buffer.from(file.content_base64, "base64").toString("utf8");
      if (containsCodeSyncSecret(text)) {
        throw new ApiError(400, "code_secret_detected", "A source file appears to contain a credential or private key. Remove it before sharing.");
      }
    }
  }
  private charge(projectId: string, bytes: number): void {
    // Disable receipts still consume storage after the repository is paused.
    // Every other mutation validates the active repository in its operation.
    const repo = this.repo(projectId);
    if (!repo) throw new ApiError(409, "code_not_enabled", "Enable project code collaboration first");
    const total = this.database.sqlite.prepare("SELECT COALESCE(SUM(charged_bytes),0) AS bytes FROM code_repositories").get() as { bytes: number };
    if (repo.charged_bytes + bytes > MAX_PROJECT_BYTES || total.bytes + bytes > MAX_TOTAL_BYTES) throw this.quota();
    this.database.sqlite.prepare("UPDATE code_repositories SET charged_bytes=charged_bytes+? WHERE project_id=?").run(bytes, projectId);
  }
  private reserveTreeWrite(projectId: string, paths: string[], contentBytes: number, temporaryFiles = 0): void {
    // Covers loose-object headers/compression, tree/index entries, object buckets,
    // directory metadata, temporary source files, and derived ref lock files.
    // Counting repeated parent components intentionally errs on the conservative side.
    const parents = paths.reduce((sum, path) => sum + path.split("/").length - 1, 0);
    const pathBytes = paths.reduce((sum, path) => sum + Buffer.byteLength(path), 0);
    this.diskBudget.reserve(this.repoPath(projectId), 1024 * 1024 + contentBytes
      + (paths.length + parents + temporaryFiles) * 8192 + pathBytes * 8);
  }
  private reserveMergeWrite(projectId: string, left: string, right: string): void {
    const ancestor = this.git(projectId, ["merge-base", left, right]).toString().trim();
    const entries = (commit: string) => {
      const result = new Map<string, { object: string; size: number }>();
      for (const entry of this.git(projectId, ["ls-tree", "-rlz", "--full-tree", commit]).toString().split("\0").filter(Boolean)) {
        const match = /^(?:100644|100755) blob ([a-f0-9]{40}) +(\d+)\t([\s\S]+)$/u.exec(entry);
        if (!match) throw new ApiError(409, "code_unsupported_entry", "Only regular source files are supported");
        result.set(match[3]!, { object: match[1]!, size: Number(match[2]) });
      }
      return result;
    };
    const previous = entries(ancestor), ours = entries(left), theirs = entries(right);
    const paths = [...new Set([...previous.keys(), ...ours.keys(), ...theirs.keys()])];
    let newContent = 0;
    for (const path of paths) {
      const a = previous.get(path), b = ours.get(path), c = theirs.get(path);
      // Unilateral changes reuse existing blobs. Concurrent edits can create a
      // merged blob, including conflict markers even when the operation fails.
      if (b?.object !== a?.object && c?.object !== a?.object && b?.object !== c?.object) {
        newContent += (a?.size ?? 0) + (b?.size ?? 0) + (c?.size ?? 0);
      }
    }
    // A deliberately high expansion ceiling includes tiny-line conflict marker
    // amplification. Very large concurrent rewrites may require local resolution.
    this.reserveTreeWrite(projectId, paths, newContent * 128);
  }
  private repairRefs(projectId: string): void {
    try {
      const repo = this.repo(projectId);
      if (!repo) return;
      const branches = this.branches(projectId);
      const desired = new Set(["refs/heads/main", ...branches.map((branch) => `refs/heads/${branch.name}`)]);
      const current = this.git(projectId, ["for-each-ref", "--format=%(refname)", "refs/heads"]).toString().trim().split("\n").filter(Boolean);
      const lines = [
        `update refs/heads/main ${repo.main_commit}`,
        ...branches.map((branch) => `update refs/heads/${branch.name} ${branch.head_commit}`),
        ...current.filter((ref) => !desired.has(ref)).map((ref) => `delete ${ref}`),
      ];
      this.git(projectId, ["update-ref", "--stdin"], `${lines.join("\n")}\n`);
    } catch {
      // DB heads remain authoritative, reads never trust a stale ref.
    }
  }
  private stale(): ApiError { return new ApiError(409, "code_stale_head", "Cloud code changed. Download or reconcile it before uploading; no files were overwritten."); }
  private quota(): ApiError { return new ApiError(507, "code_storage_quota_exceeded", "Code storage, branch, or checkpoint quota exceeded"); }
}
