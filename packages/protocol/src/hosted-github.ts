import { z } from "zod";

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
