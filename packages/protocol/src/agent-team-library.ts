import { z } from "zod";
import { AgentTeamEdgeSchema, AgentTeamNodeSchema, AgentTeamPlanSchema, AgentTeamTargetSchema } from "./agent-team.js";
import { MessageMentionsSchema } from "./index.js";

export const AGENT_TEAM_LIBRARY_LIMIT = 5;
export const AGENT_TEAM_FAVORITES_LIMIT = 5;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const key = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
const text = (limit: number) => z.string().max(limit).refine(value => !value.includes("\0"));
const name = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
export const AgentTeamDraftNodeSchema = AgentTeamNodeSchema.extend({ target: AgentTeamTargetSchema.nullable() });
export const AgentTeamDraftSchema = z.object({ name, team_prompt: text(2000).default(""), entry_node_id: id.optional(),
  nodes: z.array(AgentTeamDraftNodeSchema).max(16), edges: z.array(AgentTeamEdgeSchema).max(32) }).strict()
  .superRefine((draft, context) => {
    // Drafts may contain unbound modules; graph invariants still apply while saved.
    const placeholder = { kind: "local" as const, runtime_id: "unbound", harness: "codex" as const, provider: "unbound", model: "unbound" };
    const parsed = AgentTeamPlanSchema.safeParse({ ...draft, nodes: draft.nodes.length
      ? draft.nodes.map(node => ({ ...node, target: node.target ?? placeholder }))
      : [{ id: "empty-draft", label: "empty", role: "", x: 0, y: 0, target: placeholder }] });
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    if (!draft.nodes.length && (draft.edges.length || draft.entry_node_id)) context.addIssue({ code: "custom", message: "An empty draft has no entry or connections" });
    if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > 65536) context.addIssue({ code: "custom", message: "Team draft exceeds 64 KiB" });
  });
export type AgentTeamDraft = z.infer<typeof AgentTeamDraftSchema>;
export const AgentTeamModuleSnapshotSchema = z.object({ label: name, role: text(1000).default(""), prompt: text(2000).optional(),
  target: AgentTeamTargetSchema.nullable() }).strict();
export type AgentTeamModuleSnapshot = z.infer<typeof AgentTeamModuleSnapshotSchema>;
export const SaveAgentTeamDefinitionSchema = z.object({ draft: AgentTeamDraftSchema,
  max_calls: z.number().int().min(1).max(48).default(12), max_duration_minutes: z.number().int().min(1).max(120).default(30),
  expected_revision: z.number().int().positive().nullable(), idempotency_key: key }).strict();
export type SaveAgentTeamDefinition = z.infer<typeof SaveAgentTeamDefinitionSchema>;
export const AgentTeamDefinitionSchema = z.object({ id, revision: z.number().int().positive(), draft: AgentTeamDraftSchema,
  max_calls: z.number().int().min(1).max(48), max_duration_minutes: z.number().int().min(1).max(120), enabled: z.boolean(),
  tested_revision: z.number().int().positive().nullable(), test_run_id: id.nullable(), test_session_id: id.nullable(),
  test_status: z.enum(["not_tested", "running", "passed", "failed"]),
  updated_at: z.string().datetime() }).strict();
export type AgentTeamDefinition = z.infer<typeof AgentTeamDefinitionSchema>;
export const AgentTeamFavoriteSchema = z.object({ id, module: AgentTeamModuleSnapshotSchema, created_at: z.string().datetime() }).strict();
export const AgentTeamLibrarySchema = z.object({ teams: z.array(AgentTeamDefinitionSchema).max(5),
  modules: z.array(AgentTeamFavoriteSchema).max(5), team_limit: z.literal(5), module_limit: z.literal(5) }).strict();
export const AgentTeamDefinitionResponseSchema = z.object({ team: AgentTeamDefinitionSchema, replayed: z.boolean() }).strict();
export const SaveAgentTeamFavoriteSchema = z.object({ module: AgentTeamModuleSnapshotSchema, idempotency_key: key }).strict();
export const AgentTeamFavoriteResponseSchema = z.object({ favorite: AgentTeamFavoriteSchema, replayed: z.boolean() }).strict();
export const ControlAgentTeamDefinitionSchema = z.object({ enabled: z.boolean(), expected_revision: z.number().int().positive().optional(),
  idempotency_key: key }).strict().refine(input => !input.enabled || input.expected_revision !== undefined, "Enable requires the saved revision");
export const DeleteAgentTeamLibraryItemSchema = z.object({ idempotency_key: key }).strict();
export const TestAgentTeamDefinitionSchema = z.object({ expected_revision: z.number().int().positive(),
  content_revision: z.number().int().nonnegative(), solo_transfer_ack: z.boolean().default(false), idempotency_key: key }).strict();
export const StartSavedAgentTeamSchema = TestAgentTeamDefinitionSchema.extend({ content: text(3000).refine(value => value.trim().length > 0),
  reply_to_event_id: id.nullable().optional(), mentions: z.lazy(() => MessageMentionsSchema).optional() }).strict();
