import { z } from "zod";
import { CLOUD_CODE_SYNC_LIMITS, GITHUB_CODE_SYNC_LIMITS, isCodeSyncPathAllowed } from "./code-sync.js";

export const FileProviderSchema = z.enum(["gt-cloud", "github"]);
export const FileCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const FileBranchIdSchema = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const FilePathSchema = z.string().refine(isCodeSyncPathAllowed, "Unsafe or private code path");
const Revision = z.union([z.number().int().positive(), z.string().min(1).max(128)]);
const Selection = { provider: FileProviderSchema, branch_id: FileBranchIdSchema,
  connection_revision: Revision.optional() };
const CommitSelection = { ...Selection, commit: FileCommitSchema.optional() };
// Repeated-group base64 regexes overflow V8's stack at valid multi-megabyte sizes.
function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return !/[^A-Za-z0-9+/]/u.test(value.slice(0, value.length - padding));
}
const Base64 = z.string().max(4 * Math.ceil(GITHUB_CODE_SYNC_LIMITS.maxFileBytes / 3)).refine(isBase64, "Invalid base64 content");

export const FileBranchesInputSchema = z.object({ provider: FileProviderSchema,
  connection_revision: Revision.optional() }).strict();
export const FileTreeInputSchema = z.object(CommitSelection).strict();
export const FileContentInputSchema = z.object({ ...CommitSelection, path: FilePathSchema }).strict();
export const FileHistoryInputSchema = z.object({ ...CommitSelection,
  path: FilePathSchema.optional(), cursor: FileCommitSchema.optional(), limit: z.number().int().min(1).max(100).default(30) }).strict();
export const FileChangesInputSchema = z.object({ ...CommitSelection, base_commit: FileCommitSchema.optional() }).strict();
export const FileOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), path: FilePathSchema, content_base64: Base64, executable: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("copy"), path: FilePathSchema, destination: FilePathSchema }).strict(),
  z.object({ type: z.literal("move"), path: FilePathSchema, destination: FilePathSchema }).strict(),
  z.object({ type: z.literal("delete"), path: FilePathSchema }).strict(),
]);
export const FileMutationInputSchema = z.object({ ...Selection, base_commit: FileCommitSchema,
  operations: z.array(FileOperationSchema).min(1).max(100),
  message: z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/u),
  idempotency_key: z.string().min(8).max(200),
}).strict().superRefine((input, context) => {
  const limits = input.provider === "gt-cloud" ? CLOUD_CODE_SYNC_LIMITS : GITHUB_CODE_SYNC_LIMITS;
  const maxWriteBytes = input.provider === "gt-cloud" ? limits.maxFileBytes : 8 * 1024 * 1024;
  let total = 0;
  for (const [index, operation] of input.operations.entries()) {
    if (operation.type !== "write") continue;
    const encoded = operation.content_base64;
    const bytes = encoded.length * 3 / 4 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    total += bytes;
    if (bytes > maxWriteBytes) context.addIssue({ code: "custom", path: ["operations", index, "content_base64"], message: "File exceeds provider limit" });
  }
  if (total > 8 * 1024 * 1024) context.addIssue({ code: "custom", path: ["operations"], message: "Writes exceed request limit" });
});

const ResultSelection = { provider: FileProviderSchema, branch_id: FileBranchIdSchema,
  connection_revision: Revision.optional() };
const Entry = z.object({ path: FilePathSchema, size: z.number().int().nonnegative(), executable: z.boolean().optional() }).strict();
export const FileBranchesResultSchema = z.object({ provider: FileProviderSchema,
  branches: z.array(z.object({ id: FileBranchIdSchema, name: z.string().min(1).max(512),
    user_id: z.string().max(128).nullable(), head_commit: FileCommitSchema, can_write: z.boolean() }).strict()).max(1000),
  default_branch_id: FileBranchIdSchema, connection_revision: Revision.optional() }).strict();
export const FileTreeResultSchema = z.object({ ...ResultSelection, commit: FileCommitSchema,
  head_commit: FileCommitSchema, can_write: z.boolean(), entries: z.array(Entry).max(GITHUB_CODE_SYNC_LIMITS.maxFiles) }).strict();
export const FileContentResultSchema = z.object({ ...ResultSelection, commit: FileCommitSchema,
  path: FilePathSchema, content_base64: Base64, size: z.number().int().nonnegative(), executable: z.boolean().optional() }).strict();
export const FileHistoryResultSchema = z.object({ ...ResultSelection,
  commits: z.array(z.object({ id: FileCommitSchema, parent_ids: z.array(FileCommitSchema).max(16),
    message: z.string().max(10000), author_name: z.string().max(512), created_at: z.string().datetime() }).strict()).max(100),
  next_cursor: FileCommitSchema.optional() }).strict();
export const FileChangesResultSchema = z.object({ ...ResultSelection, base_commit: FileCommitSchema.nullable(),
  commit: FileCommitSchema, files: z.array(z.object({ path: FilePathSchema,
    status: z.enum(["added", "modified", "deleted"]), previous_path: FilePathSchema.optional() }).strict()).max(GITHUB_CODE_SYNC_LIMITS.maxFiles * 2) }).strict();
export const FileMutationResultSchema = z.object({ ...ResultSelection, commit: FileCommitSchema, replayed: z.boolean().optional() }).strict();

export type FileProvider = z.infer<typeof FileProviderSchema>;
export type FileBranchesInput = z.infer<typeof FileBranchesInputSchema>;
export type FileTreeInput = z.infer<typeof FileTreeInputSchema>;
export type FileContentInput = z.infer<typeof FileContentInputSchema>;
export type FileHistoryInput = z.infer<typeof FileHistoryInputSchema>;
export type FileChangesInput = z.infer<typeof FileChangesInputSchema>;
export type FileMutationInput = z.infer<typeof FileMutationInputSchema>;
export type FileOperation = z.infer<typeof FileOperationSchema>;
export type FileBranchesResult = z.infer<typeof FileBranchesResultSchema>;
export type FileTreeResult = z.infer<typeof FileTreeResultSchema>;
export type FileContentResult = z.infer<typeof FileContentResultSchema>;
export type FileHistoryResult = z.infer<typeof FileHistoryResultSchema>;
export type FileChangesResult = z.infer<typeof FileChangesResultSchema>;
export type FileMutationResult = z.infer<typeof FileMutationResultSchema>;
