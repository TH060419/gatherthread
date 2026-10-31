import { createHash } from "node:crypto";
import { CollaborationHttpError, HttpCollaborationClient, type CanonicalEvent } from "@gatherthread/bridge";
import { DshWorkspaceInputSchema, DshWorkspaceResponseSchemas, DSH_WORKSPACE_MAX_RESPONSE_BYTES } from "@gatherthread/protocol";
import type { DshNativeGrant } from "./native-connection.js";
import type { DshRuntimeExecutionProfile } from "./types.js";
import { cloudFileAction, DshWorkspaceFiles, WorkspaceFileError } from "./workspace-files.js";

export class DshWorkspaceError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface DshWorkspaceOptions {
  grant: DshNativeGrant;
  signal: AbortSignal;
  fetch?: typeof fetch;
  assertCurrent(): void;
  runtime(projectId: string, sessionId: string): string | undefined;
  profiles?(): readonly DshRuntimeExecutionProfile[] | undefined;
  files?(projectId: string, sessionId: string): { files: DshWorkspaceFiles; nativeSessionId: string } | undefined;
}
const label = (text: string) => text.slice(0, 200);
function localRequest(event: CanonicalEvent, actorId: string, runtimeId: string | undefined): boolean {
  const p = event.payload as Record<string, any> | null;
  return event.type === "agent_request" && !event.deleted && event.actorId === actorId && !!runtimeId
    && p?.execution_profile?.harness === "deepseek-harness" && p.execution_profile.runtime_id === runtimeId
    && !p.agent_team && !p.shared_agent && !p.github_task_id && !p.history_summary;
}
function message(event: CanonicalEvent, actorId = "", runtimeId?: string, limit = 4000) {
  // Only canonical visible message text crosses this UI boundary. Never expose
  // raw runtime provenance, provider requests, tool payloads or native IDs.
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const visible = ["human_chat", "agent_request", "agent_progress", "agent_response"].includes(event.type);
  const text = event.deleted || !visible ? "" : typeof payload.content === "string" ? payload.content
    : typeof payload.text === "string" ? payload.text : "";
  // Only the server's readonly execution proof may attribute a shared reply.
  const owner = event.type === "agent_response" && event.sharedExecution;
  return { id: event.id, sequence: event.sequence, type: event.type, actorId: event.actorId,
    ownerId: owner ? owner.executor_owner_user_id : event.actorId,
    author: label(owner ? owner.executor_owner_display_name : event.actorDisplayName ?? event.actorId), timestamp: event.timestamp,
    content: text.slice(0, limit), truncated: text.length > limit, deleted: !!event.deleted,
    replyTo: event.replyTo ?? null, controllable: localRequest(event, actorId, runtimeId),
    status: event.deleted ? null : payload.outcome === "timeout" ? "timeout"
      : payload.status === "failed" ? "failed" : payload.status === "cancelled" ? "cancelled" : payload.status === "paused" ? "paused" : null };
}
export async function dshWorkspaceAction(value: unknown, options: DshWorkspaceOptions): Promise<unknown> {
  const parsed = DshWorkspaceInputSchema.safeParse(value);
  if (!parsed.success) throw new DshWorkspaceError("workspace_invalid_input");
  const input = parsed.data, { grant } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(18000)]);
  const current = () => { signal.throwIfAborted(); options.assertCurrent(); };
  current();
  const connectionId = createHash("sha256").update(`${grant.serverUrl}\0${grant.deviceId}\0${grant.token}`).digest("hex").slice(0, 32);
  if (input.action !== "list" && input.connectionId !== connectionId) throw new DshWorkspaceError("workspace_connection_changed");
  const client = new HttpCollaborationClient({ baseUrl: grant.apiUrl, bearerToken: grant.token, signal,
    requestTimeoutMs: 12000, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const actor = await client.getCurrentActor(); current();
  if (actor.deviceId !== grant.deviceId) throw new DshWorkspaceError("workspace_connection_changed");
  let result: unknown;
  if (input.action === "list") {
    const projects = await client.listProjects(); current();
    result = { connectionId, webUrl: new URL("/app/", grant.serverUrl).toString(), actor: { id: actor.id, name: label(actor.displayName) },
      projects: projects.filter(p => p.state === "active").map(p => ({ id: p.id, name: label(p.name), role: p.role })) };
  } else {
    // Recheck project/session visibility on every action; no cached role grants.
    const projects = await client.listProjects(); current();
    const project = projects.find(p => p.id === input.projectId && p.state === "active");
    if (!project) throw new DshWorkspaceError("workspace_access_denied");
    const sessions = await client.listProjectSessions(project.id); current();
    const active = sessions.filter(s => s.state === "active");
    if (input.action === "sessions") {
      result = { connectionId, projectId: project.id, sessions: active.map(s => ({ id: s.id, name: label(s.name ?? s.id), mode: s.mode })) };
    } else if (input.action === "createSession") {
      if (!["owner", "participant"].includes(project.role)) throw new DshWorkspaceError("workspace_read_only");
      const created = await client.createSession(project.id, { title: input.title, mode: input.mode,
        ...(input.mode === "solo" ? { visibility: "private" as const } : {}), idempotencyKey: input.idempotencyKey }); current();
      result = { connectionId, projectId: project.id, sessionId: created.id,
        session: { id: created.id, name: label(created.name ?? created.id), mode: created.mode } };
    } else {
      const session = active.find(s => s.id === input.sessionId && s.projectId === project.id);
      if (!session) throw new DshWorkspaceError("workspace_access_denied");
      const canWrite = ["owner", "participant"].includes(project.role)
        && (session.role === "owner" || session.role === "participant")
        && (session.mode === "multi" || (session.mode === "solo" && session.ownerUserId === actor.id));
      const targetId = options.runtime(project.id, session.id);
      const profiles = (options.profiles?.() ?? (grant.route ? [grant.route] : [])).map(p => ({ provider: p.provider, model: p.model,
        reasoningEfforts: [...("reasoningEfforts" in p ? p.reasoningEfforts ?? [] : [])],
        ...("defaultReasoningEffort" in p && p.defaultReasoningEffort ? { defaultReasoningEffort: p.defaultReasoningEffort } : {}) }));
      const target = grant.route && targetId ? { runtimeId: targetId, provider: grant.route.provider, model: grant.route.model, profiles } : null;
      const canManage = canWrite && (session.mode === "solo" ? session.ownerUserId === actor.id : session.role === "owner");
      const executionProfile = (selected: { provider: string; model: string; reasoningEffort?: string | undefined }) => {
        const profile = profiles.find(p => p.provider === selected.provider && p.model === selected.model);
        if (!target || !profile || (selected.reasoningEffort !== undefined && !profile.reasoningEfforts.includes(selected.reasoningEffort))) {
          throw new DshWorkspaceError("workspace_model_unavailable");
        }
        return { harness: "deepseek-harness", provider: profile.provider, model: profile.model, runtime_id: target.runtimeId,
          ...(selected.reasoningEffort ? { reasoning_effort: selected.reasoningEffort } : {}) };
      };
      if (input.action === "discardEmptySolo") {
        if (!canWrite || session.mode !== "solo" || session.ownerUserId !== actor.id) throw new DshWorkspaceError("workspace_read_only");
        // The server rechecks ownership and all canonical events atomically.
        // Never replace a missing/unsupported endpoint with ordinary deletion.
        const discarded = await client.discardEmptySolo(session.id); current();
        result = { connectionId, projectId: project.id, sessionId: session.id, discarded };
      } else if (input.action === "files") {
        const request = input.request;
        let fileResult: unknown;
        if (["branches", "tree", "content", "history", "changes", "save"].includes(request.operation)) {
          if (request.operation === "save" && !canWrite) throw new DshWorkspaceError("workspace_read_only");
          current();
          fileResult = await cloudFileAction(request, { apiUrl: grant.apiUrl, token: grant.token, projectId: project.id, signal,
            ...(options.fetch ? { fetch: options.fetch } : {}) });
        } else {
          // Local paths and native identities come only from the active owner.
          if (!canWrite) throw new DshWorkspaceError("workspace_read_only");
          const local = options.files?.(project.id, session.id);
          if (!local) throw new DshWorkspaceError("workspace_file_local_unavailable");
          switch (request.operation) {
            case "localTree": fileResult = await local.files.tree(); break;
            case "localRead": fileResult = await local.files.read(request.path); break;
            case "localChanges": fileResult = await local.files.changes(); break;
            case "localDiff": fileResult = await local.files.diff(request.path); break;
            case "baseline":
              if (local.files.isBusy()) throw new DshWorkspaceError("workspace_file_busy");
              await local.files.capture(); fileResult = await local.files.changes(); break;
            case "native": fileResult = { kind: "native", sessionId: local.nativeSessionId }; break;
          }
        }
        current(); result = { connectionId, projectId: project.id, sessionId: session.id, result: fileResult };
      } else if (input.action === "message") {
        const page = await client.readEvents(session.id, input.sequence - 1, 1); current();
        if ((page.contentRevision ?? session.contentRevision ?? 0) !== input.contentRevision) throw new DshWorkspaceError("workspace_conflict");
        const found = page.events.find(e => e.id === input.eventId && e.sequence === input.sequence
          && ["human_chat", "agent_request", "agent_progress", "agent_response"].includes(e.type));
        if (!found) throw new DshWorkspaceError("workspace_request_unavailable");
        result = { connectionId, projectId: project.id, sessionId: session.id, contentRevision: input.contentRevision,
          message: message(found, actor.id, targetId, 32000) };
      } else if (input.action === "read") {
        let page = await client.readEvents(session.id, input.afterSequence, 20); current();
        const revision = page.contentRevision ?? session.contentRevision ?? 0;
        const reset = input.afterSequence > 0 && revision !== input.contentRevision;
        if (reset) { page = await client.readEvents(session.id, 0, 20); current(); }
        const members = await client.listSessionMembers(session.id); current();
        // Older servers can omit the optional avatar endpoint; access errors must propagate.
        const avatars = await client.listSessionAvatarProfiles(session.id).catch(error => {
          if (error instanceof CollaborationHttpError && error.status === 404) return [];
          throw error;
        }); current();
        result = { connectionId, projectId: project.id, sessionId: session.id,
          messages: page.events.filter(e => ["human_chat", "agent_request", "agent_progress", "agent_response"].includes(e.type)).map(e => message(e, actor.id, targetId)),
          cursor: page.nextSequence, hasMore: page.hasMore, reset, contentRevision: page.contentRevision ?? revision, canWrite, canManage, target,
          avatars, members: members.map(m => ({ ...(m.userId ? { userId: m.userId } : {}), name: label(m.displayName), role: m.role, online: m.runtime?.status === "online" })) };
      } else if (input.action === "context") {
        const context = await client.readContext(session.id); current();
        const items = context.items.slice(-30).map(item => ({ id: item.event_id, actorId: item.actor_user_id, type: item.kind,
          content: item.content.slice(0, 2000), truncated: item.content.length > 2000 }));
        result = { connectionId, projectId: project.id, sessionId: session.id, view: context.view,
          throughSequence: context.through_sequence, contentRevision: context.content_revision ?? 0, totalItems: context.items.length, items,
          truncated: context.items.length > items.length || items.some(item => item.truncated) };
      } else if (input.action === "renameSession") {
        if (!canManage) throw new DshWorkspaceError("workspace_read_only");
        const renamed = await client.updateSession(session.id, { title: input.title, idempotencyKey: input.idempotencyKey }); current();
        result = { connectionId, projectId: project.id, sessionId: session.id,
          session: { id: renamed.id, name: label(renamed.name ?? renamed.id), mode: renamed.mode } };
      } else if (input.action === "pause" || input.action === "resume") {
        if (!canWrite) throw new DshWorkspaceError("workspace_read_only");
        // Resolve an exact canonical request, not a browser-supplied payload.
        let history = await client.readEvents(session.id, input.requestSequence - 1, 100); current();
        const request = history.events.find(e => e.id === input.requestId && e.sequence === input.requestSequence);
        if (!request || !localRequest(request, actor.id, targetId)) throw new DshWorkspaceError("workspace_request_unavailable");
        if (history.contentRevision !== input.contentRevision) throw new DshWorkspaceError("workspace_conflict");
        if (input.action === "pause") {
          await client.pauseAgentRequest(session.id, request.id); current();
          result = { connectionId, projectId: project.id, sessionId: session.id, requestId: request.id, status: "paused" };
        } else {
          const linked: CanonicalEvent[] = [];
          for (let count = 0; ; count++) {
            linked.push(...history.events.filter(e => e.replyTo === request.id));
            if (!history.hasMore) break;
            if (count >= 9) throw new DshWorkspaceError("workspace_request_unavailable");
            history = await client.readEvents(session.id, history.nextSequence, 100); current();
            if (history.contentRevision !== input.contentRevision) throw new DshWorkspaceError("workspace_conflict");
          }
          if (linked.some(e => e.type === "agent_response") || !linked.some(e => e.type === "agent_progress" && (e.payload as any)?.status === "paused")) {
            throw new DshWorkspaceError("workspace_request_unavailable");
          }
          const original = request.payload as Record<string, any>, profile = original.execution_profile;
          const exact = executionProfile({ provider: profile.provider, model: profile.model,
            ...(profile.reasoning_effort ? { reasoningEffort: profile.reasoning_effort } : {}) });
          if (typeof original.content !== "string" || !original.content.trim() || original.content.length > 8000) throw new DshWorkspaceError("workspace_request_unavailable");
          const event = await client.appendEvent(session.id, { type: "agent_request", idempotencyKey: input.idempotencyKey,
            visibility: "session", contentRevision: input.contentRevision, ...(request.replyTo ? { replyTo: request.replyTo } : {}),
            payload: { content: original.content, execution_profile: exact, ...(original.mentions ? { mentions: original.mentions } : {}) } }); current();
          result = { connectionId, projectId: project.id, sessionId: session.id, message: message(event, actor.id, targetId) };
        }
      } else {
        if (!canWrite) throw new DshWorkspaceError("workspace_read_only");
        if (input.kind === "agent" && (!target || target.runtimeId !== input.runtimeId)) throw new DshWorkspaceError("workspace_agent_unavailable");
        current();
        const event = await client.appendEvent(session.id, { type: input.kind === "chat" ? "human_chat" : "agent_request",
          idempotencyKey: input.idempotencyKey, visibility: "session", ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          ...(input.contentRevision === undefined ? {} : { contentRevision: input.contentRevision }), payload: { content: input.content,
            ...(input.kind === "agent" && target ? { execution_profile: executionProfile(input.selection ?? target) } : {}) } });
        current(); result = { connectionId, projectId: project.id, sessionId: session.id, message: message(event, actor.id, targetId) };
      }
    }
  }
  current();
  if (Buffer.byteLength(JSON.stringify(result)) > DSH_WORKSPACE_MAX_RESPONSE_BYTES) throw new DshWorkspaceError("workspace_response_too_large");
  const checked = DshWorkspaceResponseSchemas[input.action].safeParse(result);
  if (!checked.success) throw new DshWorkspaceError("workspace_invalid_response");
  return checked.data;
}
export function workspaceErrorCode(error: unknown): string {
  if (error instanceof WorkspaceFileError) return error.code;
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "workspace_file_missing";
  if (error instanceof DshWorkspaceError) return error.code;
  if (error instanceof CollaborationHttpError) {
    if ([401, 403, 404].includes(error.status)) return "workspace_access_denied";
    if (error.status === 409) return "workspace_conflict";
    if (error.status === 429) return "workspace_rate_limited";
  }
  return "workspace_unavailable";
}
