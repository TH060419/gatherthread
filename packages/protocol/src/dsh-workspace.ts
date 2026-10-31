import { z } from "zod";
import { FilePathSchema, FileProviderSchema, FileBranchesResultSchema, FileTreeResultSchema, FileHistoryResultSchema, FileChangesResultSchema, FileMutationInputSchema, FileMutationResultSchema, FileTreeInputSchema, FileContentInputSchema, FileHistoryInputSchema, FileChangesInputSchema } from "./file-workspace.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const scope = { connectionId: id, projectId: id, sessionId: id };
const selection = z.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200), reasoningEffort: z.string().min(1).max(80).optional() }).strict();
const avatarId = z.enum(["cat", "fox", "bear", "rabbit", "penguin", "owl"]).nullable();
const revision = z.number().int().nonnegative();
const requestRef = { requestId: id, requestSequence: z.number().int().positive(), contentRevision: revision };
export const DshFileOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("localTree") }).strict(),
  z.object({ operation: z.literal("localRead"), path: FilePathSchema }).strict(),
  z.object({ operation: z.literal("localChanges") }).strict(),
  z.object({ operation: z.literal("localDiff"), path: FilePathSchema }).strict(),
  z.object({ operation: z.literal("baseline") }).strict(),
  z.object({ operation: z.literal("native") }).strict(),
  z.object({ operation: z.literal("branches"), provider: FileProviderSchema }).strict(),
  z.object({ operation: z.literal("tree"), input: FileTreeInputSchema }).strict(),
  z.object({ operation: z.literal("content"), input: FileContentInputSchema }).strict(),
  z.object({ operation: z.literal("history"), input: FileHistoryInputSchema }).strict(),
  z.object({ operation: z.literal("changes"), input: FileChangesInputSchema }).strict(),
  z.object({ operation: z.literal("save"), input: FileMutationInputSchema.superRefine((value, ctx) => {
    const operation = value.operations[0];
    const encoded = operation?.type === "write" ? operation.content_base64 : "";
    const bytes = encoded.length * 3 / 4 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (value.operations.length !== 1 || operation?.type !== "write"
      || bytes > 65536) ctx.addIssue({ code: "custom", message: "Workspace saves one text file up to 64 KiB" });
  }) }).strict(),
]);
const localText = z.string().max(65536);
const localEntry = z.object({ path: FilePathSchema, size: z.number().int().nonnegative() }).strict();
export const DshFileResultSchema = z.union([
  z.object({ kind: z.literal("localTree"), directory: z.string().max(4096), entries: z.array(localEntry).max(300), truncated: z.boolean(), busy: z.boolean() }).strict(),
  z.object({ kind: z.literal("text"), path: FilePathSchema, text: localText }).strict(),
  z.object({ kind: z.literal("localChanges"), baseline: z.string().max(80).nullable(), requestId: id.nullable(), incomplete: z.boolean(), files: z.array(z.object({ path: FilePathSchema, status: z.enum(["added", "modified", "deleted"]) }).strict()).max(300) }).strict(),
  z.object({ kind: z.literal("diff"), path: FilePathSchema, before: localText, after: localText }).strict(),
  z.object({ kind: z.literal("native"), sessionId: id }).strict(),
  z.object({ kind: z.literal("branches"), value: FileBranchesResultSchema }).strict(),
  z.object({ kind: z.literal("tree"), value: FileTreeResultSchema, truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal("history"), value: FileHistoryResultSchema }).strict(),
  z.object({ kind: z.literal("changes"), value: FileChangesResultSchema }).strict(),
  z.object({ kind: z.literal("saved"), value: FileMutationResultSchema }).strict(),
]);
export const DshWorkspaceInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("files"), ...scope, request: DshFileOperationSchema }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("sessions"), connectionId: id, projectId: id }).strict(),
  z.object({ action: z.literal("read"), ...scope, afterSequence: z.number().int().nonnegative(), contentRevision: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal("context"), ...scope }).strict(),
  z.object({ action: z.literal("message"), ...scope, eventId: id, sequence: z.number().int().positive(), contentRevision: revision }).strict(),
  z.object({ action: z.literal("discardEmptySolo"), ...scope }).strict(),
  z.object({ action: z.literal("createSession"), connectionId: id, projectId: id, title: z.string().trim().min(1).max(200), mode: z.enum(["multi", "solo"]), idempotencyKey: id }).strict(),
  z.object({ action: z.literal("renameSession"), ...scope, title: z.string().trim().min(1).max(200), idempotencyKey: id }).strict(),
  z.object({ action: z.literal("pause"), ...scope, ...requestRef }).strict(),
  z.object({ action: z.literal("resume"), ...scope, ...requestRef, idempotencyKey: id }).strict(),
  z.object({ action: z.literal("send"), ...scope, kind: z.enum(["chat", "agent"]), content: z.string().trim().min(1).max(8000),
    idempotencyKey: id, runtimeId: id.optional(), selection: selection.optional(), replyTo: id.optional(), contentRevision: revision.optional() }).strict(),
]);
export type DshWorkspaceInput = z.infer<typeof DshWorkspaceInputSchema>;
export const DSH_WORKSPACE_MAX_RESPONSE_BYTES = 256 * 1024;

const name = z.string().max(200);
const role = z.enum(["owner", "participant", "viewer"]);
const message = z.object({
  id, sequence: z.number().int().nonnegative(), type: z.enum(["human_chat", "agent_request", "agent_progress", "agent_response"]),
  actorId: id, ownerId: id, author: name, timestamp: z.string().max(80), content: z.string().max(32000),
  truncated: z.boolean(), deleted: z.boolean(), status: z.enum(["failed", "timeout", "cancelled", "paused"]).nullable(),
  replyTo: id.nullable(), controllable: z.boolean(),
}).strict();
const responseScope = { connectionId: id, projectId: id, sessionId: id };
const sessionInfo = z.object({ id, name, mode: z.enum(["solo", "multi"]) }).strict();
const sessionMutation = z.object({ connectionId: id, projectId: id, sessionId: id, session: sessionInfo }).strict();
export const DshWorkspaceResponseSchemas = {
  files: z.object({ ...responseScope, result: DshFileResultSchema }).strict(),
  list: z.object({ connectionId: id, webUrl: z.string().url().max(2000), actor: z.object({ id, name }).strict(),
    projects: z.array(z.object({ id, name, role }).strict()).max(1000) }).strict(),
  sessions: z.object({ connectionId: id, projectId: id,
    sessions: z.array(sessionInfo).max(1000) }).strict(),
  message: z.object({ ...responseScope, contentRevision: revision, message }).strict(),
  read: z.object({ ...responseScope, messages: z.array(message).max(20), cursor: z.number().int().nonnegative(),
    contentRevision: z.number().int().nonnegative(), hasMore: z.boolean(), reset: z.boolean(), canWrite: z.boolean(), canManage: z.boolean(),
    target: z.object({ runtimeId: id, provider: name, model: name,
      profiles: z.array(z.object({ provider: name, model: name, reasoningEfforts: z.array(z.string().max(80)).max(20), defaultReasoningEffort: z.string().max(80).optional() }).strict()).max(200) }).strict().nullable(),
    avatars: z.array(z.object({ user_id: id, avatar_id: avatarId }).strict()).max(1000),
    members: z.array(z.object({ userId: id.optional(), name, role, online: z.boolean() }).strict()).max(1000) }).strict(),
  context: z.object({ ...responseScope, view: z.enum(["summary", "original"]),
    throughSequence: z.number().int().nonnegative(), contentRevision: z.number().int().nonnegative(), totalItems: z.number().int().nonnegative(),
    truncated: z.boolean(), items: z.array(z.object({ id, actorId: id, type: z.enum(["summary", "original"]),
      content: z.string().max(2000), truncated: z.boolean() }).strict()).max(30) }).strict(),
  send: z.object({ ...responseScope, message }).strict(),
  createSession: sessionMutation,
  discardEmptySolo: z.object({ ...responseScope, discarded: z.boolean() }).strict(),
  renameSession: sessionMutation,
  pause: z.object({ ...responseScope, requestId: id, status: z.literal("paused") }).strict(),
  resume: z.object({ ...responseScope, message }).strict(),
} as const;
