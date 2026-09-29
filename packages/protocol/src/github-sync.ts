import { z } from "zod";

/** Only a github.com owner/repository slug, never a URL or credential. */
export const GitHubRepositorySchema = z.string().max(140).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => {
    const repository = value.split("/")[1]!;
    return repository !== "." && repository !== ".." && !repository.toLowerCase().endsWith(".git");
  }, "Use owner/repository without a .git suffix");

/** Deliberately narrower than Git ref syntax; safe for display and argv use. */
export function isGitHubBranchAllowed(value: string): boolean {
  return value.length > 0 && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.includes("..") && value.split("/").every((part) => !!part && !part.startsWith(".")
      && !part.endsWith(".") && !part.toLowerCase().endsWith(".lock")) && value !== "HEAD";
}
export const GitHubBranchSchema = z.string().refine(isGitHubBranchAllowed, "Unsafe GitHub branch name");
export const GitHubBaseBranchSchema = GitHubBranchSchema.refine(
  (value) => !value.startsWith("gatherthread/"), "The shared base cannot use the GatherThread personal branch namespace",
);
export const GitHubPersonalBranchSchema = z.string().regex(/^gatherthread\/[a-f0-9]{24}\/[a-f0-9]{24}$/);
export const GitHubConnectionSchema = z.object({
  repository: GitHubRepositorySchema,
  base_branch: GitHubBaseBranchSchema,
  enabled: z.boolean(),
  revision: z.string().uuid(),
}).strict();
export const GitHubProjectStatusSchema = z.object({
  connection: GitHubConnectionSchema.nullable(),
  branch: GitHubPersonalBranchSchema,
  can_configure: z.boolean(),
  // GatherThread membership only. GitHub permissions must be checked locally.
  can_write: z.boolean(),
}).strict();
export const GitHubConnectionInputSchema = z.object({
  repository: GitHubRepositorySchema,
  base_branch: GitHubBaseBranchSchema,
  enabled: z.boolean(),
  expected_revision: z.string().uuid().nullable(),
}).strict();
export type GitHubConnection = z.infer<typeof GitHubConnectionSchema>;
export type GitHubProjectStatus = z.infer<typeof GitHubProjectStatusSchema>;
export type GitHubConnectionInput = z.infer<typeof GitHubConnectionInputSchema>;
export const githubCodeSyncRequestKinds = [
  "github_auth_connect",
  "github_code_sync_status", "github_code_upload", "github_code_download", "github_code_recover",
  "github_code_auto_upload_enable", "github_code_auto_upload_disable", "github_code_update",
] as const;
export function isGitHubCodeSyncRequestKind(kind: string): boolean {
  return (githubCodeSyncRequestKinds as readonly string[]).includes(kind);
}
