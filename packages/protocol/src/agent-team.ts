import { z } from "zod";
import { PersonalCloudRevisionSchema, hasValidPersonalCloudRevision } from "./cloud-api.js";
import { MessageMentionsSchema } from "./index.js";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const key = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
const line = (maximum: number) => z.string().trim().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
const text = (maximum: number) => z.string().trim().max(maximum).refine(value => !value.includes("\0"));
// Submitted task text and its UTF-16 mention ranges share one exact string.
const taskText = z.string().max(3000).refine(value => !value.includes("\0") && value.trim().length > 0);
export const AgentTeamTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), runtime_id: id, harness: z.enum(["codex", "deepseek-harness"]),
    provider: line(80), model: line(160), reasoning_effort: line(80).optional() }).strict(),
  z.object({ kind: z.literal("shared"), share_id: id, share_revision: z.number().int().positive(),
    harness: z.enum(["codex", "deepseek-harness"]), provider: line(80), model: line(160),
    reasoning_effort: line(80).optional() }).strict(),
  z.object({ kind: z.literal("cloud"), profile_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
    provider: line(80), model: line(160), include_code: z.boolean().default(false), api_config_revision: PersonalCloudRevisionSchema })
    .strict().refine(hasValidPersonalCloudRevision, "Personal cloud team targets require their exact configuration revision"),
]);
export const AgentTeamNodeSchema = z.object({ id, label: line(120), role: text(1000).default(""), prompt: text(2000).optional(),
  x: z.number().finite().min(0).max(10000), y: z.number().finite().min(0).max(10000), target: AgentTeamTargetSchema }).strict();
export const AgentTeamEdgeSchema = z.object({ id, source: id, target: id,
  direction: z.enum(["one_way", "bidirectional"]) }).strict();
export const AgentTeamPlanSchema = z.object({ name: line(120), team_prompt: text(2000).default(""),
  entry_node_id: id.optional(), nodes: z.array(AgentTeamNodeSchema).min(1).max(16), edges: z.array(AgentTeamEdgeSchema).max(32) }).strict()
  .superRefine((plan, context) => {
    const nodes = new Set(plan.nodes.map(node => node.id));
    if (plan.entry_node_id && !nodes.has(plan.entry_node_id)) context.addIssue({ code: "custom", path: ["entry_node_id"], message: "First Agent must exist in the saved team" });
    if (nodes.size !== plan.nodes.length) context.addIssue({ code: "custom", path: ["nodes"], message: "Node IDs must be unique" });
    const edges = new Set<string>();
    const routes = new Set<string>();
    for (const [index, edge] of plan.edges.entries()) {
      const directed = [`${edge.source}\0${edge.target}`, ...(edge.direction === "bidirectional" ? [`${edge.target}\0${edge.source}`] : [])];
      if (edge.source === edge.target || !nodes.has(edge.source) || !nodes.has(edge.target) || edges.has(edge.id) || directed.some(route => routes.has(route))) {
        context.addIssue({ code: "custom", path: ["edges", index], message: "Edges require existing nodes and unique IDs and routes" });
      }
      edges.add(edge.id); directed.forEach(route => routes.add(route));
    }
    if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > 65536) {
      context.addIssue({ code: "custom", message: "Team plan exceeds 64 KiB" });
    }
  });
export type AgentTeamPlan = z.infer<typeof AgentTeamPlanSchema>;
export type AgentTeamNode = z.infer<typeof AgentTeamNodeSchema>;
export type AgentTeamTarget = z.infer<typeof AgentTeamTargetSchema>;
export const SaveAgentTeamPlanInputSchema = z.object({ plan: AgentTeamPlanSchema,
  expected_revision: z.number().int().positive().nullable() }).strict();
export const AgentTeamPlanResponseSchema = z.object({ plan: AgentTeamPlanSchema.nullable(),
  revision: z.number().int().positive().nullable() }).strict().refine(value => (value.plan === null) === (value.revision === null), "Plan and revision must exist together");
export const StartAgentTeamRunInputSchema = z.object({ plan: AgentTeamPlanSchema, entry_node_id: id,
  content: taskText, max_calls: z.number().int().min(1).max(48).default(12),
  max_duration_minutes: z.number().int().min(1).max(120).default(30), idempotency_key: key,
  content_revision: z.number().int().nonnegative().optional(), solo_transfer_ack: z.boolean().optional(),
  reply_to_event_id: id.nullable().optional(), mentions: z.lazy(() => MessageMentionsSchema).optional() }).strict()
  .refine(input => input.plan.nodes.some(node => node.id === input.entry_node_id), { path: ["entry_node_id"], message: "Select a node in this team" });
export type StartAgentTeamRunInput = z.infer<typeof StartAgentTeamRunInputSchema>;
export const AgentTeamRunStatuses = ["running", "paused", "completed", "failed", "stopped", "timed_out", "call_limit"] as const;
// Public diagnostics contain only a stable category and the requester's own
// frozen module label. Provider messages, credentials and raw errors stay out.
export const AgentTeamRunIssueSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u), node_id: id.nullable(), node_label: line(120).nullable(),
  target_kind: z.enum(["local", "shared", "cloud"]).nullable(), retry_at: z.string().datetime().nullable(),
}).strict();
export type AgentTeamRunIssue = z.infer<typeof AgentTeamRunIssueSchema>;
export const AgentTeamActionIssueDetailsSchema = z.object({
  issue_code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).optional(), node_id: id.optional(),
  node_label: line(120).optional(), target_kind: z.enum(["local", "shared", "cloud"]).optional(),
  retry_after_seconds: z.number().finite().min(0).max(86400).optional(),
}).strict();
export const AgentTeamRunSummarySchema = z.object({ id, session_id: id, status: z.enum(AgentTeamRunStatuses),
  purpose: z.enum(["task", "test"]).optional(), definition_id: id.nullable().optional(),
  created_at: z.string().datetime(), deadline_at: z.string().datetime(), finished_at: z.string().datetime().nullable(),
  calls_used: z.number().int().min(0).max(48), max_calls: z.number().int().min(1).max(48),
  max_duration_minutes: z.number().int().min(1).max(120), current_node_id: id.nullable(), current_step_id: id.nullable(),
  error_code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).nullable(), issue: AgentTeamRunIssueSchema.optional() }).strict().refine(value => value.calls_used <= value.max_calls, "Accepted calls cannot exceed the run limit");
export const AgentTeamStepSchema = z.object({ id, node_id: id, node_label: line(120),
  status: z.enum(["pending", "running", "completed", "failed", "paused", "timed_out"]),
  request_event_id: id.nullable(), response_event_id: id.nullable(), created_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(), parent_step_id: id.nullable() }).strict();
export const AgentTeamRunDetailSchema = AgentTeamRunSummarySchema.safeExtend({ plan: AgentTeamPlanSchema,
  content: taskText, steps: z.array(AgentTeamStepSchema).max(49) }).strict();
export type AgentTeamRunDetail = z.infer<typeof AgentTeamRunDetailSchema>;
export type AgentTeamRunSummary = z.infer<typeof AgentTeamRunSummarySchema>;
export const AgentTeamRunsResponseSchema = z.object({ runs: z.array(AgentTeamRunSummarySchema).max(50) }).strict();
export const AgentTeamRunResponseSchema = z.object({ run: AgentTeamRunDetailSchema }).strict();
export const AgentTeamRunAcceptedSchema = AgentTeamRunResponseSchema.extend({ replayed: z.boolean() }).strict();
export const ControlAgentTeamRunInputSchema = z.object({ action: z.enum(["pause", "resume", "stop", "continue"]), idempotency_key: key }).strict();
export type ControlAgentTeamRunInput = z.infer<typeof ControlAgentTeamRunInputSchema>;
export const AgentTeamRequestMetadataSchema = z.object({ run_id: id, step_id: id, node_id: id,
  node_label: line(120), task_content: taskText, purpose: z.enum(["task", "test"]).optional(),
  clarification_event_id: id.optional(), start_idempotency_key: key.optional() }).strict();
export type AgentTeamRequestMetadata = z.infer<typeof AgentTeamRequestMetadataSchema>;
export const AgentTeamDirectiveSchema = z.discriminatedUnion("action", [
  z.object({ version: z.literal(1), step_id: id, action: z.literal("complete") }).strict(),
  z.object({ version: z.literal(1), step_id: id, action: z.literal("clarify") }).strict(),
  z.object({ version: z.literal(1), step_id: id, action: z.literal("delegate"), target_node_id: id,
    task: text(3000).refine(value => value.length > 0) }).strict(),
]);
export type AgentTeamDirective = z.infer<typeof AgentTeamDirectiveSchema>;
