import { z } from "zod";

export const CODE_SYNC_MAX_FILES = 1_000;
export const CODE_SYNC_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const CODE_SYNC_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const CODE_SYNC_MAX_BODY_BYTES = 12 * 1024 * 1024;

const Key = z.string().min(8).max(200);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const BranchId = z.string().regex(/^branch-[a-f0-9]{24}$/);
const pathEncoder = new TextEncoder();
// HFS ignores these formatting characters when comparing path components.
const hfsIgnoredCharacters = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;
function portablePathKey(path: string): string {
  return path.normalize("NFC").replace(hfsIgnoredCharacters, "").toLowerCase();
}

/** Reject recognizable credentials without modifying the uploaded source bytes. */
export function containsCodeSyncSecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:gh[pousr]|github_pat|glpat|sk|xox[baprs])[-_][A-Za-z0-9_-]{16,}|\b(?:gt[abidp]|acp(?:i|d)?)_[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b/u.test(text);
}

/** Portable paths only. Private connector/harness state is never code. */
export function isCodeSyncPathAllowed(path: string): boolean {
  // Lone UTF-16 surrogates encode as U+FFFD and could overwrite a different path.
  if (!path || path.length > 500 || path.startsWith("/") || /[\\\u0000-\u001f\u007f\ud800-\udfff:<>"|?*]/u.test(path)) return false;
  const components = path.split("/");
  return components.every((part) => {
    const lower = portablePathKey(part);
    if (!part || pathEncoder.encode(part).byteLength > 255 || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ")) return false;
    if (!lower || lower === "." || lower === ".." || lower.endsWith(".") || lower.endsWith(" ")) return false;
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(lower)) return false;
    // An 8.3-shaped name may alias an existing private directory on NTFS.
    if (/^[^.~]{1,6}~[1-9][0-9]*(?:\.[^.]*)?$/u.test(lower)) return false;
    if ([".git", ".codex", ".dsh", ".ssh", ".npmrc", ".netrc", ".ds_store"].includes(lower)) return false;
    if (lower.startsWith(".gatherthread")) return false;
    if ((lower === ".env" || lower.startsWith(".env.")) && ![".env.example", ".env.sample", ".env.template"].includes(lower)) return false;
    return !/\.(?:pem|p12|pfx|key)$/iu.test(lower) && !/^(?:id_rsa|id_ed25519)(?:\.|$)/iu.test(lower);
  });
}

export const CodeFileSchema = z.object({
  path: z.string().refine(isCodeSyncPathAllowed, "Unsafe or private code path"),
  content_base64: z.string().max(4 * Math.ceil(CODE_SYNC_MAX_FILE_BYTES / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  executable: z.boolean(),
}).strict();
export type CodeFile = z.infer<typeof CodeFileSchema>;

export const CodeFilesSchema = z.array(CodeFileSchema).max(CODE_SYNC_MAX_FILES).superRefine((files, context) => {
  let size = 0;
  const names = new Set<string>();
  for (const [index, file] of files.entries()) {
    const bytes = file.content_base64.length * 3 / 4 - (file.content_base64.endsWith("==") ? 2 : file.content_base64.endsWith("=") ? 1 : 0);
    size += bytes;
    const normalized = portablePathKey(file.path);
    if (bytes > CODE_SYNC_MAX_FILE_BYTES || names.has(normalized)) context.addIssue({ code: "custom", path: [index], message: "File limit or duplicate portable path" });
    names.add(normalized);
  }
  if (size > CODE_SYNC_MAX_SNAPSHOT_BYTES) context.addIssue({ code: "custom", message: "Code snapshot exceeds 8 MiB" });
  for (const name of names) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join("/"))) context.addIssue({ code: "custom", message: "File and directory paths overlap" });
      parts.pop();
    }
  }
});
export const CodeEnableInputSchema = z.object({ idempotency_key: Key }).strict();
export const CodeDisableInputSchema = z.object({ idempotency_key: Key }).strict();
export const CodeCheckpointInputSchema = z.object({
  base_commit: Commit.nullable(), files: CodeFilesSchema,
  message: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/u), idempotency_key: Key,
}).strict();
export const CodeReviewInputSchema = z.object({ head_commit: Commit, idempotency_key: Key }).strict();
export const CodeMergeInputSchema = z.object({ branch_id: BranchId, expected_main_commit: Commit, expected_head_commit: Commit, idempotency_key: Key }).strict();
export const CodeUpdateInputSchema = z.object({ base_commit: Commit, expected_main_commit: Commit, idempotency_key: Key }).strict();
export const CodeClearBranchInputSchema = z.object({ expected_head_commit: Commit, idempotency_key: Key }).strict();
export const CodeClearProjectInputSchema = z.object({
  expected_main_commit: Commit,
  expected_branches: z.array(z.object({ branch_id: BranchId, head_commit: Commit }).strict()).max(128),
  idempotency_key: Key,
}).strict();
export const CodeBranchSchema = z.object({
  id: BranchId, name: z.string().max(80), user_id: z.string().max(128), head_commit: Commit,
  review_status: z.enum(["draft", "requested", "merged"]),
}).strict();
export const CodeStatusSchema = z.object({
  repository: z.object({ enabled: z.boolean(), main_commit: Commit.nullable() }).strict(),
  branches: z.array(CodeBranchSchema).max(128), own_branch_id: BranchId.nullable(),
}).strict();
export const CodeMutationResultSchema = z.object({ status: CodeStatusSchema, commit: Commit }).strict();
export const CodeClearResultSchema = z.object({ status: CodeStatusSchema, released_bytes: z.number().int().nonnegative() }).strict();
export const DetachedCodeClearResultSchema = z.object({ released_bytes: z.number().int().nonnegative() }).strict();
export const CodeStorageSummarySchema = z.object({
  limit_bytes: z.number().int().positive(), used_bytes: z.number().int().nonnegative(),
  detached_branches: z.array(z.object({
    project_id: z.string().max(128), project_title: z.string().max(200),
    own_branch_head_commit: Commit, own_branch_bytes: z.number().int().nonnegative(),
  }).strict()),
  projects: z.array(z.object({
    project_id: z.string().max(128), project_title: z.string().max(200), repository_enabled: z.boolean(),
    main_commit: Commit, main_bytes: z.number().int().nonnegative(),
    own_branch_id: BranchId.nullable(), own_branch_head_commit: Commit.nullable(), own_branch_bytes: z.number().int().nonnegative(),
    branch_count: z.number().int().nonnegative(), can_clear_project: z.boolean(),
  }).strict()),
}).strict();
export const CodeSnapshotResultSchema = z.object({ snapshot: z.object({
  branch_id: z.union([z.literal("main"), BranchId]), commit: Commit, files: CodeFilesSchema,
}).strict() }).strict();
export type CodeStatus = z.infer<typeof CodeStatusSchema>;
export type CodeBranch = z.infer<typeof CodeBranchSchema>;
export type CodeMutationResult = z.infer<typeof CodeMutationResultSchema>;
export type CodeClearResult = z.infer<typeof CodeClearResultSchema>;
export type DetachedCodeClearResult = z.infer<typeof DetachedCodeClearResultSchema>;
export type CodeStorageSummary = z.infer<typeof CodeStorageSummarySchema>;
export type CodeSnapshotResult = z.infer<typeof CodeSnapshotResultSchema>;
export type CodeCheckpointInput = z.infer<typeof CodeCheckpointInputSchema>;
export type CodeMergeInput = z.infer<typeof CodeMergeInputSchema>;
export type CodeUpdateInput = z.infer<typeof CodeUpdateInputSchema>;
export const codeSyncRequestKinds = ["code_sync_status", "code_upload", "code_download", "code_recover", "code_auto_upload_enable", "code_auto_upload_disable"] as const;
export function isCodeSyncRequestKind(kind: string): boolean { return (codeSyncRequestKinds as readonly string[]).includes(kind); }
