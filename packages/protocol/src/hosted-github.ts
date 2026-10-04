import { z } from "zod";
import { isCodeSyncPathAllowed } from "./code-sync.js";

const Key = z.string().min(8).max(200);
export const HostedGithubRepositoryInputSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).max(140),
  base_branch: z.string().min(1).max(200).refine((v) => !/[\s~^:?*\[\\]/u.test(v)
    && !v.includes("..") && !v.startsWith("-") && !v.endsWith("/") && !v.endsWith(".lock")),
}).strict();
export const HostedGithubTaskInputSchema = z.object({
  content: z.string().trim().min(1).max(6000),
  profile_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
  idempotency_key: Key,
  continue_task_id: z.string().regex(/^gh-task-[a-f0-9]{32}$/u).optional(),
  reply_to_event_id: z.string().min(1).max(128).nullable().optional(),
}).strict();
export const HostedGithubCompleteInputSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), code: z.string().min(1).max(500),
}).strict();
export const HostedGithubPrInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(6000),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type HostedGithubTaskInput = z.infer<typeof HostedGithubTaskInputSchema>;
export type HostedGithubPrInput = z.infer<typeof HostedGithubPrInputSchema>;
export type HostedGithubRepositoryInput = z.infer<typeof HostedGithubRepositoryInputSchema>;

const Login = z.string().regex(/^[A-Za-z0-9-]{1,39}$/u);
const TaskId = z.string().regex(/^gh-task-[a-f0-9]{32}$/u);
const Sha = z.string().regex(/^[a-f0-9]{40}$/u).nullable();
const Revision = z.string().regex(/^[a-f0-9]{64}$/u).nullable();
const PullUrl = z.string().max(2048).regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u).nullable();
export const HostedGithubBindingSchema = HostedGithubRepositoryInputSchema;
export const HostedGithubStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), connected: z.boolean(), login: Login.nullable(), binding: HostedGithubBindingSchema.nullable(),
    installation_url: z.string().max(2048).regex(/^https:\/\/github\.com\/apps\/[A-Za-z0-9_.-]+\/installations\/new$/u) }).strict()
    .refine((v) => v.connected ? v.login !== null : v.login === null && v.binding === null),
]);
export const HostedGithubAuthorizationSchema = z.object({ authorization_url: z.string().max(4096).refine((value) => {
  try { const url = new URL(value); return url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize"
    && !url.username && !url.password && !url.hash && /^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("state") ?? "")
    && [...url.searchParams.keys()].every((key) => ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "prompt"].includes(key));
  } catch { return false; }
}) }).strict();
export const HostedGithubConnectionSchema = z.object({ connected: z.literal(true), login: Login }).strict();
export const HostedGithubDisconnectionSchema = z.object({ connected: z.literal(false) }).strict();
export const HostedGithubTaskSummarySchema = z.object({
  id: TaskId, session_id: z.string().min(1).max(128), profile_id: HostedGithubTaskInputSchema.shape.profile_id,
  resumable: z.boolean(), state: z.enum(["running", "completed", "failed", "interrupted"]),
  repository: HostedGithubRepositoryInputSchema.shape.repository, base_branch: HostedGithubRepositoryInputSchema.shape.base_branch,
  base_sha: Sha, revision: Revision, error_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u).nullable(),
  pull_request_url: PullUrl, expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const bytes = (value: string) => value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
const Source = z.string().max(2_796_204).regex(/^[A-Za-z0-9+/]*={0,2}$/u)
  .refine((value) => value.length % 4 === 0 && bytes(value) <= 2 * 1024 * 1024).nullable();
export const HostedGithubChangeSchema = z.object({
  path: z.string().max(4096).refine(isCodeSyncPathAllowed), before_base64: Source, after_base64: Source,
  before_executable: z.boolean().nullable(), after_executable: z.boolean().nullable(),
}).strict().refine((v) => (v.before_base64 === null) === (v.before_executable === null)
  && (v.after_base64 === null) === (v.after_executable === null) && (v.before_base64 !== null || v.after_base64 !== null));
export const HostedGithubTaskSchema = HostedGithubTaskSummarySchema.extend({
  answer: z.string().max(14_000).nullable(), changes: z.array(HostedGithubChangeSchema).max(2000),
}).strict().refine((v) => {
  if (new Set(v.changes.map((c) => c.path)).size !== v.changes.length) return false;
  for (const side of ["before_base64", "after_base64"] as const) {
    const values = v.changes.map((c) => c[side]).filter((s): s is string => s !== null);
    if (values.length > 1000 || values.reduce((sum, s) => sum + bytes(s), 0) > 8 * 1024 * 1024) return false;
  }
  return !v.resumable || v.state !== "running" && v.pull_request_url === null;
});
export const HostedGithubTaskListSchema = z.object({ tasks: z.array(HostedGithubTaskSummarySchema).max(10) }).strict();
export type HostedGithubStatus = z.infer<typeof HostedGithubStatusSchema>;
export type HostedGithubBinding = z.infer<typeof HostedGithubBindingSchema>;
export type HostedGithubAuthorization = z.infer<typeof HostedGithubAuthorizationSchema>;
export type HostedGithubConnection = z.infer<typeof HostedGithubConnectionSchema>;
export type HostedGithubDisconnection = z.infer<typeof HostedGithubDisconnectionSchema>;
export type HostedGithubTaskSummary = z.infer<typeof HostedGithubTaskSummarySchema>;
export type HostedGithubTask = z.infer<typeof HostedGithubTaskSchema>;
export type HostedGithubTaskList = z.infer<typeof HostedGithubTaskListSchema>;
