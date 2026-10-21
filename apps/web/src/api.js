import { avatarImage } from "./avatars.js?v=20261018-tabs-2";
import { MockFileWorkspace } from "./file-workspace-mock.js";
import { FileBranchesResultSchema, FileTreeResultSchema, FileContentResultSchema,
  FileHistoryResultSchema, FileChangesResultSchema, FileMutationResultSchema, FileMutationInputSchema } from "@gatherthread/protocol";
import { HostedGithubStatusSchema, HostedGithubAuthorizationSchema, HostedGithubConnectionSchema, HostedGithubDisconnectionSchema,
  HostedGithubTaskSchema, HostedGithubTaskListSchema, HostedAgentAcceptedSchema, HostedAgentPausedSchema,
  ProjectInvitationPreviewSchema, DeleteMessageResultSchema, CloudApiStatusSchema, CloudApiSavedSchema,
  HostedAgentSelectionSchema,
  SaveAgentShareInputSchema, ControlAgentShareInputSchema, SharedAgentRequestInputSchema,
  AgentSharesResponseSchema, AgentShareResponseSchema, SharedAgentRequestAcceptedSchema, AgentShareSourcesResponseSchema,
  ClaimAgentShareJobInputSchema, AgentShareJobResponseSchema } from "@gatherthread/protocol";
import {
  createIdempotencyKey,
  isExecutionRuntime,
  normalizeInvitation,
  normalizeSnapshotRequest,
} from "./domain.js?v=20261018-tabs-2";

const TITLE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

const HOSTED_AGENT_RESPONSE_ERROR = "Cloud Agent response is invalid. Refresh and try again.";
const PERSONAL_API_RESPONSE_ERROR = "Personal API response is invalid. Refresh and try again.";

async function hostedResponse(schema, request, errorMessage = "Cloud GitHub response is invalid. Refresh and try again.") {
  const parsed = schema.safeParse(await request);
  if (!parsed.success) throw new Error(errorMessage);
  return parsed.data;
}

function sharingInput(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError("Shared Agent input is invalid. Review the settings and try again.", { status: 422, code: "validation_error" });
  return parsed.data;
}

async function sharingResponse(schema, request, { projectId, sessionId, shareId, shareRevision, executionProfile } = {}) {
  let body;
  try { body = await request; }
  catch (error) {
    throw new ApiError("Shared Agent request failed. Refresh and try again.", {
      status: error instanceof ApiError ? error.status : 0,
      code: error instanceof ApiError && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code) ? error.code : "network_error",
    });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success || (projectId && (parsed.data.share?.project_id !== undefined && parsed.data.share.project_id !== projectId
    || parsed.data.shares?.some(share => share.project_id !== projectId)))
    || (shareId && parsed.data.share && parsed.data.share.id !== shareId)
    || (sessionId && (parsed.data.event?.session_id !== sessionId || parsed.data.job?.session_id !== sessionId
      || parsed.data.event?.type !== "agent_request" || parsed.data.job?.request_event_id !== parsed.data.event?.id
      || parsed.data.job?.id !== parsed.data.event?.payload?.shared_agent?.job_id
      || parsed.data.job?.share_id !== shareId || parsed.data.job?.share_revision !== shareRevision
      || parsed.data.event?.payload?.shared_agent?.share_id !== shareId
      || parsed.data.event?.payload?.shared_agent?.share_revision !== shareRevision
      || parsed.data.event?.shared_execution?.job_id !== parsed.data.job?.id
      || parsed.data.event?.shared_execution?.share_id !== shareId
      || parsed.data.event?.shared_execution?.share_revision !== shareRevision
      || JSON.stringify(parsed.data.event?.shared_execution?.execution_profile) !== JSON.stringify(parsed.data.job?.execution_profile)
      || executionProfile && JSON.stringify(executionProfile) !== JSON.stringify(parsed.data.job?.execution_profile)))) {
    throw new ApiError("Shared Agent response is invalid. Refresh and try again.", { status: 502, code: "invalid_agent_share_response" });
  }
  return parsed.data;
}

function normalizeMockTitle(value, label) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > 200 || TITLE_CONTROL_CHARACTERS.test(value)) {
    throw new ApiError(`${label} name must be between 1 and 200 characters without control characters.`, {
      status: 422,
      code: "invalid_name",
    });
  }
  return title;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = "unknown" } = {}) {
    super(code === "connector_update_required" ? "Update and reconnect your Agent connector before continuing."
      : code === "context_changed" ? "Shared history changed. Start a new Agent request with the current history." : message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class HttpCollaborationApi {
  constructor({ baseUrl = "", sharingDeadlineMs = 8000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sharingDeadlineMs = sharingDeadlineMs;
    this.actors = new Map();
    this.sessionHeads = new Map();
  }

  async request(path, options = {}) {
    const target = `${this.baseUrl}${path}`;
    // A shared ?api= link must never redirect a browser-entered credential to
    // another origin. Development uses the same-origin loopback proxy too.
    if (globalThis.location?.href) {
      const url = new URL(target, globalThis.location.href);
      if (url.origin !== globalThis.location.origin || url.username || url.password
        || !["http:", "https:"].includes(url.protocol)) {
        throw new ApiError("Open this server's GatherThread application to sign in. Browser API requests must use the same origin.", {
          status: 400, code: "invalid_api_origin",
        });
      }
    }
    const response = await fetch(target, {
      ...options,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(body.error?.message ?? body.message ?? `Request failed (${response.status})`, {
        status: response.status,
        code: body.error?.code ?? body.code ?? "http_error",
      });
    }
    if (response.status === 204) return undefined;
    const body = await response.json();
    return body.data ?? body;
  }

  async restoreSession() {
    try {
      const actor = await this.request("/v1/me");
      this.actors.set(actor.id, actor.username);
      return actor;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  async logout() {
    try {
      await this.request("/v1/browser-sessions/current", { method: "DELETE" });
    } finally {
      this.clearCredential();
    }
  }

  async #readAvatar(path) {
    // Keep the existing Safari 15 / Chrome 100 baseline; timeout() is newer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Avatar read timed out", "TimeoutError")), 4_000);
    timer.unref?.();
    try { return await this.request(path, { signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async getAccountAvatar() {
    const actor = await this.#readAvatar("/v1/me");
    return { user_id: actor.id, avatar_id: actor.avatar_id ?? null };
  }

  async setAccountAvatar(avatarId) {
    return this.request("/v1/me/avatar", { method: "PUT", body: JSON.stringify({ avatar_id: avatarId }) });
  }

  async listAvatarProfiles(sessionId) {
    const { profiles } = await this.#readAvatar(`/v1/sessions/${encodeURIComponent(sessionId)}/avatar-profiles`);
    return profiles;
  }

  async accountDeletionPreview() {
    return this.request("/v1/account/deletion-preview");
  }

  async transferProjectOwnership(projectId, targetUserId, idempotencyKey) {
    const { project } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/transfer-ownership`, {
      method: "POST",
      body: JSON.stringify({ target_user_id: targetUserId, idempotency_key: idempotencyKey }),
    });
    return project;
  }

  async deleteAccount() {
    return this.request("/v1/account", {
      method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }),
    });
  }

  clearCredential() {
  }

  async listSessions() {
    const { sessions } = await this.request("/v1/sessions");
    return sessions.map((session) => {
      this.sessionHeads.set(session.id, session.current_sequence);
      return {
        id: session.id,
        projectId: session.project_id,
        ownerUserId: session.owner_user_id,
        name: session.title,
        mode: session.mode,
        description: session.state === "archived" ? "Archived shared session" : "Active shared session",
        updatedAt: session.updated_at,
        memberCount: Number(session.member_count ?? 0),
        role: session.role,
        currentSequence: session.current_sequence,
        contentRevision: session.content_revision ?? 0,
      };
    });
  }

  async listProjects() {
    const { projects } = await this.request("/v1/projects");
    return projects.map((project) => ({
      id: project.id,
      name: project.title,
      state: project.state,
      role: project.role,
      sessionCount: Number(project.session_count ?? 0),
      updatedAt: project.updated_at,
    }));
  }

  async createProject(input) {
    const { project } = await this.request("/v1/projects", {
      method: "POST",
      body: JSON.stringify({
        title: input.name,
        idempotency_key: input.idempotencyKey,
      }),
    });
    return {
      id: project.id,
      name: project.title,
      state: project.state,
      role: "owner",
      sessionCount: Number(project.session_count ?? 0),
      updatedAt: project.updated_at,
    };
  }

  async renameProject(projectId, input) {
    const { project } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: input.name,
        idempotency_key: input.idempotencyKey,
      }),
    });
    return {
      id: project.id,
      name: project.title,
      state: project.state,
      updatedAt: project.updated_at,
    };
  }

  async deleteProject(projectId) {
    await this.request(`/v1/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    this.sessionHeads.clear();
  }

  async leaveProject(projectId, userId) {
    await this.removeProjectMember(projectId, userId, {});
  }

  async removeProjectMember(projectId, userId, decision = {}) {
    await this.request(`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE", body: JSON.stringify(decision),
    });
    this.sessionHeads.clear();
  }

  async getProject(projectId) {
    const { project, role } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}`);
    return {
      id: project.id,
      name: project.title,
      state: project.state,
      role,
      updatedAt: project.updated_at,
    };
  }

  async getProjectCode(projectId) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/code`);
  }

  async fileRequest(projectId, action, schema, { signal, ...input } = {}, mutation = false) {
    const query = new URLSearchParams();
    if (!mutation) for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
    const path = `/v1/projects/${encodeURIComponent(projectId)}/files/${action}${mutation ? "" : `?${query}`}`;
    const parsed = mutation ? FileMutationInputSchema.safeParse(input) : null;
    if (parsed && !parsed.success) throw new ApiError("Invalid file operation. Check file sizes and paths before retrying.", { status: 422, code: "validation_error" });
    const value = await this.request(path, mutation ? { method: "POST", body: JSON.stringify(parsed.data), signal } : { signal });
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError("File response is invalid. Refresh files and try again.", { status: 502, code: "invalid_file_response" });
    return result.data;
  }
  getFileBranches(projectId, input) { return this.fileRequest(projectId, "branches", FileBranchesResultSchema, input); }
  getFileTree(projectId, input) { return this.fileRequest(projectId, "tree", FileTreeResultSchema, input); }
  getFileContent(projectId, input) { return this.fileRequest(projectId, "content", FileContentResultSchema, input); }
  getFileHistory(projectId, input) { return this.fileRequest(projectId, "history", FileHistoryResultSchema, input); }
  getFileChanges(projectId, input) { return this.fileRequest(projectId, "changes", FileChangesResultSchema, input); }
  mutateFiles(projectId, input, { signal } = {}) { return this.fileRequest(projectId, "mutations", FileMutationResultSchema, { ...input, signal }, true); }

  async getProjectGithub(projectId) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/github`);
  }

  async putProjectGithub(projectId, input) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/github`, { method: "PUT", body: JSON.stringify(input) });
  }

  listProjectMentions(projectId, beforeId) {
    const query = beforeId ? `?before_event_id=${encodeURIComponent(beforeId)}` : "";
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/mentions${query}`);
  }

  async getCodeStorage() {
    return this.request("/v1/code-storage");
  }

  async clearDetachedCodeBranch(projectId, input) {
    return this.request(`/v1/code-storage/detached-branches/${encodeURIComponent(projectId)}/clear`, {
      method: "POST", body: JSON.stringify(input),
    });
  }

  async clearOwnCodeBranch(projectId, input) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/code/clear-branch`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async clearProjectCode(projectId, input) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/code/clear-project`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async mutateProjectCode(projectId, operation, input) {
    if (!["enable", "disable", "review", "merge", "update"].includes(operation)) throw new Error("Unknown code operation.");
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/code/${operation}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getProjectCodeSnapshot(projectId, branchId) {
    const query = new URLSearchParams({ branch_id: branchId });
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/code/snapshot?${query}`);
  }

  async listProjectSessions(projectId) {
    const { sessions } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/sessions`);
    return sessions.map((session) => {
      this.sessionHeads.set(session.id, session.current_sequence);
      return {
        id: session.id,
        projectId: session.project_id,
        ownerUserId: session.owner_user_id,
        name: session.title,
        mode: session.mode,
        description: session.state === "archived" ? "Archived shared session" : "Active shared session",
        updatedAt: session.updated_at,
        memberCount: Number(session.member_count ?? 0),
        role: session.role,
        currentSequence: session.current_sequence,
        contentRevision: session.content_revision ?? 0,
      };
    });
  }

  async listProjectMembers(projectId) {
    const { members } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/members`);
    return members.map((member) => ({
      id: member.user_id,
      userId: member.user_id,
      username: member.display_name,
      avatar_id: member.avatar_id ?? null,
      role: member.role,
      runtime: null,
    }));
  }

  async createSession(projectId, input) {
    const { session } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        title: input.name,
        mode: input.mode,
        idempotency_key: input.idempotencyKey,
      }),
    });
    return this.#sessionDetail(session, "owner");
  }

  async getSession(sessionId) {
    const { session, role } = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`);
    return this.#sessionDetail(session, role);
  }

  async updateSession(sessionId, input) {
    const { session } = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: input.name,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        idempotency_key: input.idempotencyKey,
      }),
    });
    return this.#sessionDetail(session, "owner");
  }

  async renameSession(sessionId, input) {
    return this.updateSession(sessionId, input);
  }

  async deleteSession(sessionId) {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    this.sessionHeads.delete(sessionId);
  }

  async listMembers(sessionId) {
    const { members } = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/members`);
    return members.map((member) => {
      this.actors.set(member.user_id, member.display_name);
      return {
        id: member.user_id,
        userId: member.user_id,
        username: member.display_name,
        avatar_id: member.avatar_id ?? null,
        role: member.role,
        runtime: member.runtime ? {
          id: member.runtime.id,
          status: member.runtime.status,
          harness: member.runtime.harness,
          provider: member.runtime.provider,
          model: member.runtime.model,
          fidelity: member.runtime.capture_fidelity,
          purpose: member.runtime.purpose ?? null,
        } : null,
      };
    });
  }

  async listSessionRuntimes(sessionId) {
    const { runtimes } = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/runtimes`);
    return runtimes.map((runtime) => ({
      id: runtime.id,
      deviceId: runtime.device_id,
      ...(runtime.user_id === undefined ? {} : { userId: runtime.user_id }),
      ...(runtime.purpose === undefined ? {} : { purpose: runtime.purpose }),
      harness: runtime.harness,
      provider: runtime.provider,
      model: runtime.model,
      status: runtime.status,
      lastSeenAt: runtime.last_seen_at,
      ...(runtime.context_deletion_version === undefined ? {} : { contextDeletionVersion: runtime.context_deletion_version }),
      ...(runtime.sharing_capability === undefined ? {} : { sharingCapability: runtime.sharing_capability }),
      ...(Array.isArray(runtime.execution_profiles) ? {
        executionProfiles: runtime.execution_profiles.map((profile) => ({
          provider: profile.provider,
          model: profile.model,
          reasoningEfforts: profile.reasoning_efforts ?? [],
          ...(profile.default_reasoning_effort === undefined ? {} : {
            defaultReasoningEffort: profile.default_reasoning_effort,
          }),
        })),
      } : {}),
    }));
  }

  async createSnapshotRequest(sessionId, kind = "immutable", targetRuntimeId) {
    const result = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/snapshot-requests`, {
      method: "POST",
      body: JSON.stringify({ kind, ...(targetRuntimeId ? { target_runtime_id: targetRuntimeId } : {}) }),
    });
    return normalizeSnapshotRequest(result);
  }

  async getSnapshotRequest(requestId) {
    const result = await this.request(`/v1/snapshot-requests/${encodeURIComponent(requestId)}`);
    return normalizeSnapshotRequest(result);
  }

  async listSnapshotRequests({ sessionId, limit = 40 } = {}) {
    const query = new URLSearchParams();
    if (sessionId) query.set("session_id", sessionId);
    query.set("limit", String(limit));
    const result = await this.request(`/v1/snapshot-requests?${query}`);
    return (result.snapshot_requests ?? result.requests ?? [])
      .map(normalizeSnapshotRequest)
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createInvitation(projectId, { role, ttl = "24h" }) {
    const result = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/invitations`, {
      method: "POST",
      body: JSON.stringify({ role, ttl }),
    });
    return {
      invitation: normalizeInvitation(result.invitation),
      inviteToken: result.invite_token,
    };
  }

  async listInvitations(projectId) {
    const { invitations } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/invitations`);
    return invitations.map(normalizeInvitation);
  }

  async revokeInvitation(projectId, invitationId) {
    const { invitation } = await this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
    return normalizeInvitation(invitation);
  }

  async setProjectMemberRole(projectId, userId, role) {
    const { member } = await this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ role, idempotency_key: createIdempotencyKey("project-role") }),
      },
    );
    return member;
  }

  createDeviceAuthorization() { return this.request("/v1/device-authorizations", { method: "POST" }); }
  createCodexLauncherAuthorization(input) {
    return this.request("/v1/codex-launcher-authorizations", { method: "POST", body: JSON.stringify(input) });
  }
  revokeDeviceAuthorization(id) { return this.request(`/v1/device-authorizations/${encodeURIComponent(id)}`, { method: "DELETE" }); }

  registrationStatus() { return this.request("/v1/registration"); }

  sendRegistration(input) { return this.request("/v1/registration/send", { method: "POST", body: JSON.stringify(input) }); }

  async verifyRegistration(input) {
    const result = await this.request("/v1/registration/verify", { method: "POST", body: JSON.stringify(input) });
    const actor = { id: result.actor.user_id, username: result.actor.display_name,
      device_id: result.actor.device_id, can_create_projects: result.actor.can_create_projects === true };
    this.actors.set(actor.id, actor.username);
    return { actor };
  }

  prepareEmailLogin() { return this.request("/v1/email-login"); }
  passwordResetStatus() { return this.request("/v1/password-reset"); }
  sendPasswordReset(input) { return this.request("/v1/password-reset/send", { method: "POST", body: JSON.stringify(input) }); }
  verifyPasswordReset(input) { return this.request("/v1/password-reset/verify", { method: "POST", body: JSON.stringify(input) }); }

  async loginWithEmail(input) {
    const result = await this.request("/v1/email-login", { method: "POST", body: JSON.stringify(input) });
    const actor = { id: result.actor.user_id, username: result.actor.display_name, device_id: result.actor.device_id, can_create_projects: result.actor.can_create_projects === true };
    this.actors.set(actor.id, actor.username);
    return { actor };
  }

  async previewInvitation(inviteToken, { signal } = {}) {
    const response = await this.request("/v1/invitations/preview", {
      method: "POST", signal, body: JSON.stringify({ invite_token: inviteToken }),
    });
    const parsed = ProjectInvitationPreviewSchema.safeParse(response);
    if (!parsed.success) throw new ApiError("Invitation response is invalid. Try again.", { code: "invalid_response" });
    return parsed.data;
  }

  async acceptInvitation(inviteToken, { signal } = {}) {
    const result = await this.request("/v1/invitations/accept", {
      method: "POST",
      signal,
      body: JSON.stringify({ invite_token: inviteToken }),
    });
    return { ...result, invitation: normalizeInvitation(result.invitation) };
  }

  async listDevices() {
    const { devices } = await this.request("/v1/devices");
    return devices;
  }

  async renameDevice(deviceId, name) {
    const { device } = await this.request(`/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    return device;
  }

  async revokeDevice(deviceId) {
    await this.request(`/v1/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  }

  async approveDshPairing(userCode) {
    const { pairing } = await this.request("/v1/dsh-pairings/approve", {
      method: "POST",
      body: JSON.stringify({ user_code: userCode }),
    });
    return pairing;
  }

  async replayEvents(sessionId, { afterSequence, limit = 100 }) {
    const query = new URLSearchParams({
      after_sequence: String(afterSequence),
      limit: String(limit),
    });
    const page = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/events?${query}`);
    return {
      events: page.events.map((event) => this.#event(event)),
      head_sequence: this.sessionHeads.get(sessionId) ?? page.cursor,
      next_after_sequence: page.cursor,
      has_more: page.has_more,
      content_revision: page.content_revision ?? 0,
    };
  }

  async deleteMessage(sessionId, eventId, input) {
    const result = await hostedResponse(DeleteMessageResultSchema,
      this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}/delete`, {
        method: "POST", body: JSON.stringify({ idempotency_key: input.idempotencyKey }),
      }), "Deletion response is invalid. Refresh the history and try again.");
    if (result.target_event_id !== eventId || result.event.session_id !== sessionId || result.event.type !== "message_deleted"
      || result.event.payload?.target_event_id !== eventId || result.event.payload?.content_revision !== result.content_revision) {
      throw new Error("Deletion response is invalid. Refresh the history and try again.");
    }
    return { event: this.#event(result.event), targetEventId: result.target_event_id, contentRevision: result.content_revision,
      affectedEventIds: result.affected_event_ids, affectedTruncated: result.affected_truncated };
  }

  appendHumanChat(sessionId, input) {
    return this.#append(sessionId, "human_chat", input);
  }

  appendAgentRequest(sessionId, input) {
    return this.#append(sessionId, "agent_request", input);
  }

  async sharingRequest(path, { signal, ...options } = {}) {
    const controller = new AbortController();
    let timer, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => {
      rejectAbort(new ApiError("Shared Agent request interrupted.", { code: "request_aborted" }));
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) { abort(); return await aborted; }
      return await Promise.race([this.request(path, { ...options, signal: controller.signal }), aborted,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new ApiError("Shared Agent acknowledgement timed out.", { code: "request_timeout" }));
            controller.abort();
          }, this.sharingDeadlineMs);
        })]);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  listAgentShares(projectId, { signal } = {}) {
    return sharingResponse(AgentSharesResponseSchema,
      this.sharingRequest(`/v1/projects/${encodeURIComponent(projectId)}/agent-shares`, { signal }), { projectId });
  }

  async listAgentSharingSources(projectId, { signal } = {}) {
    const result = await sharingResponse(AgentShareSourcesResponseSchema,
      this.sharingRequest(`/v1/projects/${encodeURIComponent(projectId)}/agent-sharing-sources`, { signal }));
    return result.runtimes.map(runtime => ({ id: runtime.id, sessionId: runtime.session_id, projectId, deviceId: runtime.device_id,
      purpose: runtime.purpose, harness: runtime.harness, provider: runtime.provider, model: runtime.model, status: runtime.status,
      ...(runtime.sharing_capability ? { sharingCapability: runtime.sharing_capability } : {}),
      ...(runtime.sharing_availability ? { sharingAvailability: runtime.sharing_availability } : {}),
      ...(runtime.execution_profiles ? { executionProfiles: runtime.execution_profiles.map(profile => ({ provider: profile.provider,
        model: profile.model, reasoningEfforts: profile.reasoning_efforts ?? [],
        ...(profile.default_reasoning_effort ? { defaultReasoningEffort: profile.default_reasoning_effort } : {}) })) } : {}) }));
  }

  saveAgentShare(projectId, input, { signal } = {}) {
    return sharingResponse(AgentShareResponseSchema,
      this.sharingRequest(`/v1/projects/${encodeURIComponent(projectId)}/agent-shares`, {
        method: "POST", body: JSON.stringify(sharingInput(SaveAgentShareInputSchema, input)), signal,
      }), { projectId, shareId: input.share_id });
  }

  controlAgentShare(projectId, shareId, input, { signal } = {}) {
    return sharingResponse(AgentShareResponseSchema,
      this.sharingRequest(`/v1/projects/${encodeURIComponent(projectId)}/agent-shares/${encodeURIComponent(shareId)}/control`, {
        method: "POST", body: JSON.stringify(sharingInput(ControlAgentShareInputSchema, input)), signal,
      }), { projectId, shareId });
  }

  startSharedAgentRequest(sessionId, input, { signal } = {}) {
    const body = sharingInput(SharedAgentRequestInputSchema, input);
    return sharingResponse(SharedAgentRequestAcceptedSchema,
      this.sharingRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/shared-agent-requests`, {
        method: "POST", body: JSON.stringify(body), signal,
      }), { sessionId, shareId: body.share_id, shareRevision: body.share_revision, executionProfile: body.execution_profile });
  }

  cancelSharedAgentRequest(sessionId, requestId, input, { signal } = {}) {
    return sharingResponse(AgentShareJobResponseSchema,
      this.sharingRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/shared-agent-requests/${encodeURIComponent(requestId)}/cancel`, {
        method: "POST", body: JSON.stringify(sharingInput(ClaimAgentShareJobInputSchema, input)), signal,
      })).then(result => {
        if (result.job.session_id !== sessionId || result.job.request_event_id !== requestId) {
          throw new ApiError("Shared Agent response is invalid. Refresh and try again.", { status: 502, code: "invalid_agent_share_response" });
        }
        return result;
      });
  }

  getHostedGithubStatus(projectId) { return hostedResponse(HostedGithubStatusSchema, this.request(`/v1/projects/${encodeURIComponent(projectId)}/hosted-github`)); }
  authorizeHostedGithub() { return hostedResponse(HostedGithubAuthorizationSchema, this.request("/v1/hosted-github/authorize", { method: "POST", body: "{}" })); }
  completeHostedGithub(input) { return hostedResponse(HostedGithubConnectionSchema, this.request("/v1/hosted-github/complete", { method: "POST", body: JSON.stringify(input) })); }
  disconnectHostedGithub() { return hostedResponse(HostedGithubDisconnectionSchema, this.request("/v1/hosted-github/account", { method: "DELETE" })); }
  bindHostedGithub(projectId, input) { return hostedResponse(HostedGithubStatusSchema, this.request(`/v1/projects/${encodeURIComponent(projectId)}/hosted-github/repository`, { method: "POST", body: JSON.stringify(input) })); }
  listHostedGithubTasks(projectId) { return hostedResponse(HostedGithubTaskListSchema, this.request(`/v1/projects/${encodeURIComponent(projectId)}/hosted-github/tasks`)); }
  startHostedGithubTask(sessionId, input) { return hostedResponse(HostedGithubTaskSchema, this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/hosted-github-tasks`, { method: "POST", body: JSON.stringify(input) })); }
  getHostedGithubTask(id) { return hostedResponse(HostedGithubTaskSchema, this.request(`/v1/hosted-github/tasks/${encodeURIComponent(id)}`)); }
  publishHostedGithub(id, input) { return hostedResponse(HostedGithubTaskSchema, this.request(`/v1/hosted-github/tasks/${encodeURIComponent(id)}/pull-request`, { method: "POST", body: JSON.stringify(input) })); }
  deleteHostedGithubTask(id) { return this.request(`/v1/hosted-github/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }); }

  getCloudApi() { return hostedResponse(CloudApiStatusSchema, this.request("/v1/cloud-api"), PERSONAL_API_RESPONSE_ERROR); }
  putCloudApi(id, input) { return hostedResponse(CloudApiSavedSchema, this.request(`/v1/cloud-api/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify(input),
  }), PERSONAL_API_RESPONSE_ERROR); }
  deleteCloudApi(id, input) { return this.request(`/v1/cloud-api/${encodeURIComponent(id)}`, {
    method: "DELETE", body: JSON.stringify(input),
  }); }
  getHostedAgentSelection(sessionId, requestId) {
    return hostedResponse(HostedAgentSelectionSchema, this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/hosted-agent-requests/${encodeURIComponent(requestId)}/selection`), PERSONAL_API_RESPONSE_ERROR);
  }

  getHostedAgentStatus() {
    return this.request("/v1/hosted-agent");
  }

  async appendHostedAgentRequest(sessionId, input) {
    return hostedResponse(HostedAgentAcceptedSchema, this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/hosted-agent-requests`, {
      method: "POST",
      body: JSON.stringify({ profile_id: input.profileId ?? "default", content: input.content, include_code: input.includeCode === true,
        idempotency_key: input.idempotencyKey, reply_to_event_id: input.replyTo ?? null,
        ...(input.continueFromEventId ? { continue_from_event_id: input.continueFromEventId } : {}),
        ...(input.contentRevision === undefined ? {} : { content_revision: input.contentRevision }),
        ...(input.apiConfigRevision === undefined ? {} : { api_config_revision: input.apiConfigRevision }) }),
    }), HOSTED_AGENT_RESPONSE_ERROR);
  }

  pauseAgentRequest(sessionId, requestId) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/agent-requests/${encodeURIComponent(requestId)}/pause`, {
      method: "POST", body: JSON.stringify({}),
    });
  }

  async pauseHostedAgentRequest(sessionId, requestId) {
    return hostedResponse(HostedAgentPausedSchema, this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/hosted-agent-requests/${encodeURIComponent(requestId)}/pause`, {
      method: "POST", body: "{}",
    }), HOSTED_AGENT_RESPONSE_ERROR);
  }

  async createHistorySummary(sessionId, input) {
    if (input.executionProfile?.harness === "opencode") {
      const receipt = await hostedResponse(HostedAgentAcceptedSchema, this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/hosted-history-summaries`, {
        method: "POST", body: JSON.stringify({ profile_id: input.executionProfile.cloudProfileId,
          ...(input.executionProfile.apiConfigRevision === undefined ? {} : { api_config_revision: input.executionProfile.apiConfigRevision }),
          source_event_ids: input.sourceEventIds, idempotency_key: input.idempotencyKey,
          ...(input.continueFromEventId ? { continue_from_event_id: input.continueFromEventId } : {}),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }) }),
      }), HOSTED_AGENT_RESPONSE_ERROR);
      return this.#event(receipt.request_event);
    }
    const { historySummaryExecutionWire } = await import("./history-summaries.js?v=20261018-tabs-2");
    const { event } = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/history-summaries`, {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: input.idempotencyKey,
        source_event_ids: input.sourceEventIds,
        execution_profile: historySummaryExecutionWire(input.executionProfile),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      }),
    });
    return this.#event(event);
  }

  getProjectContextPolicy(projectId) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/context-policy`);
  }

  setProjectContextPolicy(projectId, mode) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/context-policy`, {
      method: "PUT", body: JSON.stringify({ mode }),
    });
  }

  #append(sessionId, type, input) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify({
        type,
        visibility: "session",
        payload: {
          content: input.content,
          ...(input.mentions?.length ? { mentions: input.mentions } : {}),
          ...(type === "agent_request" && input.executionProfile ? {
            execution_profile: {
              harness: input.executionProfile.harness,
              ...(input.executionProfile.provider === undefined ? {} : {
                provider: input.executionProfile.provider,
              }),
              model: input.executionProfile.model,
              ...(input.executionProfile.reasoningEffort === undefined ? {} : {
                reasoning_effort: input.executionProfile.reasoningEffort,
              }),
              ...(input.executionProfile.runtimeId === undefined ? {} : {
                runtime_id: input.executionProfile.runtimeId,
              }),
            },
          } : {}),
        },
        idempotency_key: input.idempotencyKey,
        reply_to_event_id: input.replyTo ?? null,
        ...(input.contentRevision === undefined ? {} : { content_revision: input.contentRevision }),
      }),
    }).then(({ event }) => this.#event(event));
  }

  async openRealtime({ sessionId, afterSequence, onEvent, onCursor, onState }) {
    // Browsers cannot attach an Authorization header to WebSocket handshakes.
    // Production integration therefore obtains a one-use, short-lived ticket.
    const { ticket, websocket_url: websocketUrl } = await this.request("/v1/realtime-ticket", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    });
    const socketUrl = new URL(websocketUrl, this.baseUrl || globalThis.location?.origin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl, ["gatherthread-v1", `gatherthread-ticket.${ticket}`]);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", session_id: sessionId, after_sequence: afterSequence }));
    });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "event") onEvent(this.#event(message.event));
      if (message.type === "replay") {
        for (const event of message.events) onEvent(this.#event(event));
        onCursor?.(message.cursor);
      }
      if (message.type === "cursor") onCursor?.(message.cursor);
      if (message.type === "subscribed") {
        onCursor?.(message.cursor);
        onState("live");
      }
    });
    socket.addEventListener("close", () => onState("offline"));
    socket.addEventListener("error", () => onState("offline"));
    return { close: () => socket.close() };
  }

  #sessionDetail(session, role) {
    return {
      id: session.id,
      projectId: session.project_id,
      ownerUserId: session.owner_user_id,
      name: session.title,
      mode: session.mode,
      description: session.state === "archived" ? "Archived shared session" : "Active shared session",
      role,
      updatedAt: session.updated_at,
      connectorState: session.connector_state ?? session.connectorState ?? null,
      contentRevision: session.content_revision ?? 0,
    };
  }

  #event(event) {
    const username = event.actor_display_name
      ?? event.actor_username
      ?? this.actors.get(event.actor_user_id)
      ?? event.actor_user_id;
    const provenance = event.runtime_provenance;
    return {
      id: event.id,
      sessionId: event.session_id,
      sequence: event.sequence,
      type: event.type,
      visibility: event.visibility,
      idempotencyKey: event.idempotency_key,
      actor: { id: event.actor_user_id, username },
      createdAt: event.created_at,
      replyTo: event.reply_to_event_id ?? null,
      payload: event.payload,
      ...(event.content_revision === undefined ? {} : { contentRevision: event.content_revision }),
      ...(event.deleted ? { deleted: event.deleted } : {}),
      ...(event.shared_execution ? { sharedExecution: event.shared_execution } : {}),
      provenance: provenance ? {
        username: event.shared_execution?.executor_owner_display_name ?? username,
        runtimeId: provenance.runtime_id,
        harness: provenance.harness,
        provider: provenance.provider,
        model: provenance.model,
        reasoningEffort: provenance.reasoning_effort,
        fidelity: provenance.capture_fidelity,
      } : null,
    };
  }
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const users = {
  avery: { id: "user-avery", username: "Avery Chen" },
  maya: { id: "user-maya", username: "Maya Ortiz" },
  jon: { id: "user-jon", username: "Jon Bell" },
};

export class MockCollaborationApi {
  async listAgentShares() { return { shares: [] }; }
  async listAgentSharingSources() { return []; }
  async getCloudApi() { return { enabled: false, providers: [], configurations: [] }; }
  async getHostedAgentStatus() { return { enabled: false }; }
  async getHostedGithubStatus() { return { enabled: false }; }

  constructor({ latency = 90 } = {}) {
    this.latency = latency;
    this.currentUser = { ...users.avery, avatar_id: "cat", can_create_projects: true };
    this.avatarProfiles = new Map([[users.avery.id, "cat"], [users.maya.id, "fox"], [users.jon.id, "bear"]]);
    this.rememberedAccounts = [];
    this.listeners = new Map();
    this.idempotentEvents = new Map();
    this.projectMutations = new Map();
    this.invitations = new Map();
    this.snapshotRequests = new Map();
    this.localAutomaticUpload = new Map();
    this.codeRepositories = new Map();
    this.codeAutomaticUpload = new Map();
    this.githubConnections = new Map();
    this.githubAutomaticUpload = new Map();
    this.credential = "";
    this.deviceName = "Safari · macOS";
    this.dshDeviceName = "DeepSeek Harness · macOS";
    this.dshRevoked = false;
    this.projects = [{
      id: "project-orbit",
      name: "Project Orbit",
      state: "active",
      role: "owner",
      sessionCount: 2,
      updatedAt: isoMinutesAgo(1),
    }];
    this.sessions = [
      {
        id: "session-orbit",
        projectId: "project-orbit",
        ownerUserId: users.avery.id,
        name: "Project Orbit",
        mode: "multi",
        description: "Launch brief and implementation handoff",
        updatedAt: isoMinutesAgo(1),
        members: [
          {
            ...users.avery,
            userId: users.avery.id,
            role: "owner",
            runtime: {
              status: "online",
              harness: "Codex",
              provider: "OpenAI",
              model: "gpt-5",
            },
          },
          {
            ...users.maya,
            userId: users.maya.id,
            role: "participant",
            runtime: {
              status: "online",
              harness: "Claude Code",
              provider: "Anthropic",
              model: "Claude Sonnet",
            },
          },
          { ...users.jon, userId: users.jon.id, role: "viewer", runtime: null },
        ],
      },
      {
        id: "session-notes",
        projectId: "project-orbit",
        ownerUserId: users.avery.id,
        name: "Research notes",
        mode: "solo",
        description: "Owner-led thread with read-only observers",
        updatedAt: isoMinutesAgo(45),
        members: [
          {
            ...users.avery,
            userId: users.avery.id,
            role: "owner",
            runtime: {
              status: "offline",
              harness: "Claude Code",
              provider: "Anthropic",
              model: "Claude Sonnet",
            },
          },
          { ...users.maya, userId: users.maya.id, role: "participant", runtime: null },
          { ...users.jon, userId: users.jon.id, role: "viewer", runtime: null },
        ],
      },
    ];
    this.events = new Map([
      [
        "session-orbit",
        [
          this.#seedEvent(1, "human_chat", users.maya, "I mapped the launch risks and added the open questions.", 34),
          this.#seedEvent(2, "human_chat", users.avery, "Perfect. Let’s turn the unknowns into a short implementation pass.", 31),
          this.#seedEvent(3, "agent_request", users.avery, "Review the current plan and identify the highest-risk integration assumption.", 29),
          {
            ...this.#seedEvent(4, "agent_response", users.avery, "The highest risk is replay continuity across a reconnect. Treat socket delivery as advisory and advance the cursor only through contiguous committed events.", 28),
            replyTo: "evt-seed-3",
            provenance: {
              userId: users.avery.id,
              username: users.avery.username,
              deviceId: "device-demo",
              harness: "Codex",
              provider: "OpenAI",
              model: "gpt-5",
              localSessionId: "local-demo",
              fidelity: "harness_transcript",
            },
          },
          this.#seedEvent(5, "human_chat", users.maya, "Agreed. I’ll keep the client gap state visible instead of silently jumping ahead.", 25),
        ],
      ],
      [
        "session-notes",
        [this.#seedEvent(1, "context_snapshot", users.maya, "Shared summary approved through sequence 12.", 60, "session-notes")],
      ],
    ]);
  }

  async getAccountAvatar() {
    await this.#wait();
    return { user_id: this.currentUser.id, avatar_id: this.avatarProfiles.get(this.currentUser.id) ?? null };
  }

  async setAccountAvatar(avatarId) {
    await this.#wait();
    if (avatarId !== null && !avatarImage(avatarId)) throw new ApiError("Choose an official avatar", { status: 400 });
    this.avatarProfiles.set(this.currentUser.id, avatarId);
    this.currentUser.avatar_id = avatarId;
    return { user_id: this.currentUser.id, avatar_id: avatarId };
  }

  async listAvatarProfiles(sessionId) {
    await this.#wait();
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) throw new ApiError("Session not found", { status: 404 });
    const ids = new Set([...session.members.map((member) => member.userId),
      ...(this.events.get(sessionId) ?? []).map((event) => event.actor.id)]);
    return [...ids].map((userId) => ({ user_id: userId, avatar_id: this.avatarProfiles.get(userId) ?? null }));
  }

  async prepareEmailLogin() { return { enabled: true }; }

  async loginWithEmail({ email, password, device_name }) {
    await this.#wait();
    if (email !== "demo@example.invalid" || password !== "isolated demo password") {
      throw new ApiError("Email or password is incorrect.", { status: 401, code: "email_login_invalid" });
    }
    this.deviceName = device_name;
    return { actor: structuredClone({ ...this.currentUser, device_id: "device-demo", can_create_projects: true }) };
  }

  async createDeviceAuthorization() { throw new ApiError("Device authorization unavailable in the isolated example", { status: 403 }); }
  async createCodexLauncherAuthorization() { throw new ApiError("Launcher authorization unavailable in the isolated example", { status: 403 }); }
  async revokeDeviceAuthorization() {}

  async registrationStatus() { return { enabled: false, site_key: null, challenge_binding: null }; }

  async restoreSession() {
    await this.#wait();
    return null;
  }

  async logout() {
    await this.#wait();
    this.clearCredential();
  }

  clearCredential() {
    this.credential = "";
  }

  async listSessions() {
    await this.#wait();
    return this.sessions.map((session) => this.#summary(session));
  }

  async listProjects() {
    await this.#wait();
    return structuredClone(this.projects);
  }

  async createProject({ name }) {
    await this.#wait();
    if (!this.currentUser.can_create_projects) {
      throw new ApiError("This account can join invited projects but cannot create projects.", { status: 403, code: "forbidden" });
    }
    const title = normalizeMockTitle(name, "Project");
    const projectId = `project-${createIdempotencyKey("new").split(":").at(-1)}`;
    const now = new Date().toISOString();
    const project = {
      id: projectId,
      name: title,
      state: "active",
      role: "owner",
      sessionCount: 0,
      updatedAt: now,
    };
    this.projects.unshift(project);
    return structuredClone(project);
  }

  async renameProject(projectId, { name, idempotencyKey }) {
    await this.#wait();
    const project = this.projects.find((item) => item.id === projectId);
    if (!project || project.role !== "owner") {
      throw new ApiError("Project not found.", { status: 404, code: "not_found" });
    }
    const title = normalizeMockTitle(name, "Project");
    const key = `${projectId}:${idempotencyKey}`;
    const existing = this.projectMutations.get(key);
    if (existing !== undefined && existing !== title) {
      throw new ApiError("Idempotency key already used for another request.", { status: 409, code: "idempotency_conflict" });
    }
    if (existing === undefined) {
      this.projectMutations.set(key, title);
      project.name = title;
      project.updatedAt = new Date().toISOString();
    }
    return structuredClone(project);
  }

  async deleteProject(projectId) {
    await this.#wait();
    const project = this.projects.find((item) => item.id === projectId);
    if (!project || project.role !== "owner") {
      throw new ApiError("Project not found.", { status: 404, code: "not_found" });
    }
    const sessionIds = new Set(this.sessions.filter((session) => session.projectId === projectId).map((session) => session.id));
    this.projects = this.projects.filter((item) => item.id !== projectId);
    this.sessions = this.sessions.filter((session) => session.projectId !== projectId);
    for (const sessionId of sessionIds) this.#discardSessionCloudState(sessionId);
    for (const [invitationId, invitation] of this.invitations) {
      if (invitation.projectId === projectId) this.invitations.delete(invitationId);
    }
  }

  async leaveProject(projectId, userId) {
    await this.#wait();
    const project = this.projects.find((item) => item.id === projectId);
    if (!project || !this.currentUser || this.currentUser.id !== userId || project.role === "owner") {
      throw new ApiError("Only invited members can leave their own project.", { status: 403, code: "forbidden" });
    }
    this.projects = this.projects.filter((item) => item.id !== projectId);
    this.sessions = this.sessions.filter((item) => item.projectId !== projectId);
  }

  async removeProjectMember(projectId, userId) {
    await this.#wait();
    const project = this.projects.find((item) => item.id === projectId);
    if (this.currentUser?.id === userId) return this.leaveProject(projectId, userId);
    if (!project || project.role !== "owner") {
      throw new ApiError("Only the owner can remove another member.", { status: 403, code: "forbidden" });
    }
    for (const session of this.sessions.filter((item) => item.projectId === projectId)) {
      session.members = session.members.filter((member) => member.userId !== userId);
    }
    const code = this.codeRepositories.get(projectId);
    if (code) code.branches = code.branches.filter((branch) => branch.user_id !== userId);
  }

  async getProject(projectId) {
    await this.#wait();
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new ApiError("Project not found.", { status: 404, code: "not_found" });
    return structuredClone(project);
  }

  async listProjectSessions(projectId) {
    await this.#wait();
    return this.sessions.filter((session) => session.projectId === projectId).map((session) => this.#summary(session));
  }

  async getProjectCode(projectId) {
    await this.getProject(projectId);
    return structuredClone(this.codeRepositories.get(projectId) ?? {
      repository: { enabled: false, main_commit: null }, branches: [], own_branch_id: null,
    });
  }

  // Match HTTP's transport boundary: AbortSignal is not a protocol field.
  getFileBranches(projectId, { signal, ...input } = {}) { return (this.fileWorkspace ??= new MockFileWorkspace(this)).branches(projectId, input); }
  getFileTree(projectId, { signal, ...input } = {}) { return (this.fileWorkspace ??= new MockFileWorkspace(this)).tree(projectId, input); }
  getFileContent(projectId, { signal, ...input } = {}) { return (this.fileWorkspace ??= new MockFileWorkspace(this)).content(projectId, input); }
  getFileHistory(projectId, { signal, ...input } = {}) { return (this.fileWorkspace ??= new MockFileWorkspace(this)).history(projectId, input); }
  getFileChanges(projectId, { signal, ...input } = {}) { return (this.fileWorkspace ??= new MockFileWorkspace(this)).changes(projectId, input); }
  mutateFiles(projectId, input) { return (this.fileWorkspace ??= new MockFileWorkspace(this)).mutate(projectId, input); }

  async getProjectGithub(projectId) {
    const project = await this.getProject(projectId);
    return { connection: structuredClone(this.githubConnections.get(projectId) ?? null),
      branch: `gatherthread/demo-project/demo-user`, can_configure: project.role === "owner",
      can_write: ["owner", "participant"].includes(project.role) };
  }

  async putProjectGithub(projectId, input) {
    const status = await this.getProjectGithub(projectId);
    if (!status.can_configure) throw new ApiError("Only the owner can configure GitHub.", { status: 403, code: "forbidden" });
    if (input.expected_revision !== (status.connection?.revision ?? null)) throw new ApiError("GitHub configuration changed.", { status: 409, code: "github_revision_conflict" });
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(input.repository)
      || !input.base_branch || input.base_branch.startsWith("gatherthread/") || typeof input.enabled !== "boolean") throw new ApiError("Invalid GitHub configuration.", { status: 400, code: "invalid_request" });
    this.githubConnections.set(projectId, { repository: input.repository, base_branch: input.base_branch,
      enabled: input.enabled, revision: createIdempotencyKey("github") });
    return this.getProjectGithub(projectId);
  }

  async getCodeStorage() {
    const projects = [];
    for (const project of this.projects) {
      const status = await this.getProjectCode(project.id);
      const own = status.branches.find((branch) => branch.id === status.own_branch_id);
      projects.push({
        project_id: project.id,
        project_title: project.name,
        repository_enabled: status.repository.enabled,
        main_commit: status.repository.main_commit,
        main_bytes: status.repository.main_commit ? 1024 : 0,
        own_branch_id: status.own_branch_id,
        own_branch_head_commit: own?.head_commit ?? null,
        own_branch_bytes: own ? 1024 : 0,
        branch_count: status.branches.length,
        can_clear_project: project.role === "owner",
      });
    }
    return { limit_bytes: 128 * 1024 * 1024, detached_branches: [],
      used_bytes: projects.reduce((total, project) => total + project.own_branch_bytes + (project.can_clear_project ? project.main_bytes : 0), 0),
      projects };
  }

  async clearDetachedCodeBranch() { throw new ApiError("No detached branch in preview.", { status: 404, code: "not_found" }); }

  async clearOwnCodeBranch(projectId, input) {
    const status = await this.getProjectCode(projectId);
    const branch = status.branches.find((item) => item.id === status.own_branch_id);
    if (!branch || branch.head_commit !== input.expected_head_commit) throw new ApiError("Cloud branch changed", { status: 409, code: "conflict" });
    status.branches = status.branches.filter((item) => item.id !== branch.id);
    status.own_branch_id = null;
    this.codeRepositories.set(projectId, structuredClone(status));
    return { status, released_bytes: 1024 };
  }

  async clearProjectCode(projectId, input) {
    const project = await this.getProject(projectId);
    if (project.role !== "owner") throw new ApiError("Forbidden", { status: 403, code: "forbidden" });
    const status = await this.getProjectCode(projectId);
    if (status.repository.main_commit !== input.expected_main_commit
      || JSON.stringify(status.branches.map((branch) => ({ branch_id: branch.id, head_commit: branch.head_commit })).sort((a, b) => a.branch_id.localeCompare(b.branch_id)))
        !== JSON.stringify([...input.expected_branches].sort((a, b) => a.branch_id.localeCompare(b.branch_id)))) {
      throw new ApiError("Cloud repository changed", { status: 409, code: "conflict" });
    }
    status.repository = { enabled: false, main_commit: null };
    status.branches = [];
    status.own_branch_id = null;
    this.codeRepositories.set(projectId, structuredClone(status));
    return { status, released_bytes: 2048 };
  }

  async mutateProjectCode(projectId, operation, input) {
    const project = await this.getProject(projectId);
    if ((project.role === "viewer" && operation !== "disable") || (["enable", "disable", "merge"].includes(operation) && project.role !== "owner")) {
      throw new ApiError("Forbidden", { status: 403, code: "forbidden" });
    }
    const key = `code:${projectId}:${input.idempotency_key}`;
    const prior = this.projectMutations.get(key);
    if (prior) return structuredClone(prior);
    let status = await this.getProjectCode(projectId);
    if (operation === "enable") {
      status = { ...status, repository: { enabled: true, main_commit: status.repository.main_commit ?? "1".repeat(40) } };
    } else if (operation === "disable") {
      if (!status.repository.enabled) throw new ApiError("Code storage is already off", { status: 409, code: "code_not_enabled" });
      status = { ...status, repository: { ...status.repository, enabled: false } };
    } else {
      const own = status.branches.find((branch) => branch.id === status.own_branch_id);
      const selected = status.branches.find((branch) => branch.id === input.branch_id);
      if (!status.repository.enabled || (operation === "review" && own?.head_commit !== input.head_commit)
        || (operation === "merge" && (selected?.head_commit !== input.expected_head_commit || status.repository.main_commit !== input.expected_main_commit))) {
        throw new ApiError("Conflict", { status: 409, code: "conflict" });
      }
      if (operation === "review") own.review_status = "requested";
      if (operation === "merge") { status.repository.main_commit = selected.head_commit; selected.review_status = "merged"; }
      if (operation === "update" && own) { own.head_commit = status.repository.main_commit; own.review_status = "draft"; }
    }
    this.codeRepositories.set(projectId, structuredClone(status));
    const result = { status, commit: status.repository.main_commit };
    this.projectMutations.set(key, structuredClone(result));
    return result;
  }

  async getProjectCodeSnapshot(projectId, branchId) {
    const status = await this.getProjectCode(projectId);
    const commit = branchId === "main" ? status.repository.main_commit : status.branches.find((branch) => branch.id === branchId)?.head_commit;
    if (!commit) throw new ApiError("Not found", { status: 404, code: "not_found" });
    return { snapshot: { branch_id: branchId, commit, files: commit === "1".repeat(40) ? [] : [
      { path: "README.md", content_base64: btoa("# Example project\n\nShared code checkpoint.\n"), executable: false },
    ] } };
  }

  async listProjectMembers(projectId) {
    await this.#wait();
    const members = new Map();
    for (const session of this.sessions.filter((item) => item.projectId === projectId)) {
      for (const member of session.members) {
        if (!members.has(member.userId)) members.set(member.userId, { ...member, runtime: null });
      }
    }
    const project = this.projects.find((item) => item.id === projectId);
    if (members.size === 0 && project?.role === "owner" && this.currentUser) {
      members.set(this.currentUser.id, { ...this.currentUser, userId: this.currentUser.id, role: "owner", runtime: null });
    }
    return structuredClone([...members.values()]);
  }

  async createSession(projectId, { name, mode }) {
    await this.#wait();
    const title = normalizeMockTitle(name, "Session");
    if (!new Set(["solo", "multi"]).has(mode)) throw new ApiError("Choose solo or multi.", { status: 422, code: "invalid_mode" });
    const project = this.projects.find((item) => item.id === projectId);
    if (!project || project.role === "viewer" || (project.role === "participant" && mode !== "solo")) {
      throw new ApiError("Your project role cannot create this session.", { status: 403, code: "forbidden" });
    }
    const id = `session-${createIdempotencyKey("new").split(":").at(-1)}`;
    const session = {
      id,
      projectId,
      ownerUserId: this.currentUser.id,
      name: title,
      mode,
      description: mode === "solo" ? "Creator-led thread with read-only observers" : "Shared human and agent collaboration",
      updatedAt: new Date().toISOString(),
      members: [
        {
          ...this.currentUser,
          userId: this.currentUser.id,
          role: project.role,
          runtime: {
            status: "online",
            harness: "Codex",
            provider: "OpenAI",
            model: "gpt-5",
          },
        },
      ],
    };
    this.sessions.unshift(session);
    if (project) project.sessionCount += 1;
    this.events.set(id, []);
    return this.#summary(session);
  }

  async getSession(sessionId) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    return structuredClone(session);
  }

  async updateSession(sessionId, { name, mode, idempotencyKey }) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const member = session.members.find((item) => item.userId === this.currentUser.id);
    const project = this.projects.find((item) => item.id === session.projectId);
    const mayRename = session.mode === "solo"
      ? member?.role !== "viewer" && session.ownerUserId === this.currentUser.id
      : member?.role === "owner";
    if (!mayRename) {
      throw new ApiError("You cannot rename this session.", { status: 403, code: "forbidden" });
    }
    if (mode !== undefined && !new Set(["solo", "multi"]).has(mode)) {
      throw new ApiError("Choose solo or multi.", { status: 422, code: "invalid_mode" });
    }
    const mayChangeMode = project?.role === "owner" && session.ownerUserId === this.currentUser.id;
    if (mode !== undefined && mode !== session.mode && !mayChangeMode) {
      throw new ApiError("Only the project creator can change this session mode.", { status: 403, code: "forbidden" });
    }
    const title = normalizeMockTitle(name, "Session");
    const payload = {
      action: mode === undefined ? "renamed" : "updated",
      title,
      ...(mode === undefined ? {} : { mode }),
    };
    const key = `${sessionId}:${idempotencyKey}`;
    const existing = this.idempotentEvents.get(key);
    if (existing) {
      if (existing.type !== "session_state_change" || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
        throw new ApiError("Idempotency key already used for another request.", { status: 409, code: "idempotency_conflict" });
      }
      return this.#summary(session);
    }
    session.name = title;
    if (mode !== undefined) session.mode = mode;
    session.updatedAt = new Date().toISOString();
    const bucket = this.events.get(sessionId) ?? [];
    const event = {
      id: `evt-${sessionId}-${bucket.length + 1}`,
      sessionId,
      sequence: (bucket.at(-1)?.sequence ?? 0) + 1,
      idempotencyKey,
      type: "session_state_change",
      actor: structuredClone(this.currentUser),
      createdAt: session.updatedAt,
      visibility: "session",
      replyTo: null,
      payload,
    };
    bucket.push(event);
    this.events.set(sessionId, bucket);
    this.idempotentEvents.set(key, event);
    this.#publish(sessionId, event);
    return this.#summary(session);
  }

  async renameSession(sessionId, input) {
    return this.updateSession(sessionId, input);
  }

  async deleteSession(sessionId) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const project = this.projects.find((item) => item.id === session.projectId);
    if (session.ownerUserId !== this.currentUser.id && project?.role !== "owner") {
      throw new ApiError("Session not found.", { status: 404, code: "not_found" });
    }
    this.sessions = this.sessions.filter((item) => item.id !== sessionId);
    if (project) project.sessionCount = Math.max(0, project.sessionCount - 1);
    this.#discardSessionCloudState(sessionId);
  }

  async listMembers(sessionId) {
    await this.#wait();
    return structuredClone(this.#findSession(sessionId).members);
  }

  async listSessionRuntimes(sessionId) {
    await this.#wait();
    this.#findSession(sessionId);
    return [
      {
        id: `runtime-codex-${sessionId}`,
        deviceId: "device-avery",
        harness: "codex",
        provider: "openai",
        model: "gpt-5.6-sol",
        status: "online",
        lastSeenAt: new Date().toISOString(),
      },
      ...(this.dshRevoked ? [] : [{
        id: `runtime-dsh-${sessionId}`,
        deviceId: "dsh-device-demo",
        harness: "deepseek-harness",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        status: "online",
        lastSeenAt: new Date().toISOString(),
        executionProfiles: [
          {
            provider: "deepseek-official",
            model: "deepseek-v4-flash",
            reasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "max",
          },
          {
            provider: "deepseek-official",
            model: "deepseek-v4",
            reasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "max",
          },
        ],
      }]),
    ];
  }

  async createSnapshotRequest(sessionId, kind = "immutable", targetRuntimeId) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const id = `snapshot-${createIdempotencyKey("mock").split(":").at(-1)}`;
    const request = {
      id,
      sessionId,
      kind,
      targetRuntimeId: targetRuntimeId ?? null,
      throughSequence: this.events.get(sessionId)?.at(-1)?.sequence ?? 0,
      status: "queued",
      createdAt: new Date().toISOString(),
      localTaskName: "",
      failureMessage: "",
      pollCount: 0,
      sessionName: session.name,
    };
    this.snapshotRequests.set(id, request);
    return structuredClone(request);
  }

  async getSnapshotRequest(requestId) {
    await this.#wait();
    const request = this.snapshotRequests.get(requestId);
    if (!request) throw new ApiError("Snapshot request not found.", { status: 404, code: "not_found" });
    request.pollCount += 1;
    if (request.kind.startsWith("github_code_") || request.kind === "github_auth_connect") {
      request.status = request.pollCount === 1 ? "claimed" : "completed";
      if (request.status === "completed" && !request.result) {
        const projectId = this.#findSession(request.sessionId).projectId;
        const status = await this.getProjectGithub(projectId);
        const connection = status.connection;
        if (!status.can_write || !connection || (!connection.enabled && !["github_auth_connect", "github_code_sync_status", "github_code_auto_upload_disable"].includes(request.kind))) {
          request.status = "failed"; request.failureCode = "github_code_sync_disabled";
          return structuredClone(request);
        }
        const key = `${projectId}:${request.targetRuntimeId}`;
        if (request.kind === "github_code_auto_upload_enable") this.githubAutomaticUpload.set(key, true);
        if (request.kind === "github_code_auto_upload_disable") this.githubAutomaticUpload.set(key, false);
        request.result = request.kind === "github_auth_connect" ? { provider: "github", connected: true } : { kind: request.kind, provider: "github", repository: connection.repository,
          branch: status.branch, base_branch: connection.base_branch, enabled: true,
          automatic_upload: this.githubAutomaticUpload.get(key) ?? true,
          local_changes: 0, file_count: 1, excluded_count: 0, base_commit: "1".repeat(40),
          cloud_commit: "1".repeat(40), needs_download: false,
          ...(request.kind === "github_code_recover" ? { recovery_directory: "gatherthread-github-recovery-demo" } : {}),
        };
      }
      return structuredClone(request);
    }
    if (request.kind.startsWith("code_")) {
      request.status = request.pollCount === 1 ? "claimed" : "completed";
      if (request.status === "completed" && !request.result) {
        const projectId = this.#findSession(request.sessionId).projectId;
        const status = this.codeRepositories.get(projectId);
        const key = `${projectId}:${request.targetRuntimeId}`;
        if (request.kind === "code_auto_upload_enable") this.codeAutomaticUpload.set(key, true);
        if (request.kind === "code_auto_upload_disable") this.codeAutomaticUpload.set(key, false);
        if (request.kind === "code_upload" && status && !status.own_branch_id) {
          status.own_branch_id = "branch-demo";
          status.branches.push({ id: "branch-demo", name: "gt/avery", user_id: this.currentUser.id, head_commit: "2".repeat(40), review_status: "draft" });
        }
        const own = status?.branches.find((branch) => branch.id === status.own_branch_id);
        request.result = {
          kind: request.kind, enabled: true, automatic_upload: this.codeAutomaticUpload.get(key) ?? false,
          local_changes: own ? 0 : 1, file_count: 1, excluded_count: 0,
          base_commit: own?.head_commit ?? status?.repository.main_commit ?? null,
          cloud_commit: own?.head_commit ?? status?.repository.main_commit ?? null,
          branch_id: own?.id ?? null, needs_download: false,
          ...(request.kind === "code_recover" ? { recovery_directory: "gatherthread-recovery-demo" } : {}),
        };
      }
      return structuredClone(request);
    }
    const localControl = new Set([
      "local_sync_status",
      "local_auto_upload_enable",
      "local_auto_upload_disable",
      "local_turn_upload",
    ]).has(request.kind);
    request.status = localControl
      ? ["claimed", "completed"][Math.min(request.pollCount - 1, 1)]
      : ["claimed", "importing", "compacting", "completed"][Math.min(request.pollCount - 1, 3)];
    if (request.status === "completed" && localControl) {
      const key = `${request.sessionId}:${request.targetRuntimeId}`;
      if (request.kind === "local_auto_upload_enable") this.localAutomaticUpload.set(key, true);
      if (request.kind === "local_auto_upload_disable") this.localAutomaticUpload.set(key, false);
      const automaticUpload = this.localAutomaticUpload.get(key) ?? true;
      request.result = {
        kind: request.kind,
        session_id: request.sessionId,
        local_session_id: `mock-codex:${request.sessionId}`,
        automatic_upload: automaticUpload,
        pending_local_turns: 0,
        uploadable_local_turns: 0,
        ...(request.kind === "local_turn_upload"
          ? { discovered_local_turns: 0, uploaded_local_turns: 0 }
          : {}),
      };
    } else if (request.status === "completed") {
      request.localTaskName = `GatherThread · ${request.sessionName} · history #${request.throughSequence}`;
      if (request.kind === "visible_history_replace") {
        request.result = {
          thread_name: request.localTaskName,
          previous_task_retained: true,
        };
      }
    }
    return structuredClone(request);
  }

  async listSnapshotRequests({ sessionId, limit = 40 } = {}) {
    await this.#wait();
    return [...this.snapshotRequests.values()]
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((request) => structuredClone(request));
  }

  async createInvitation(projectId, { role, ttl = "24h" }) {
    await this.#wait();
    const project = this.projects.find((item) => item.id === projectId);
    if (project?.role !== "owner") throw new ApiError("Only the owner can create invitations.", { status: 403, code: "forbidden" });
    const ttlMs = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 }[ttl];
    if (!new Set(["participant", "viewer"]).has(role) || !ttlMs) {
      throw new ApiError("Choose a valid role and expiry.", { status: 422, code: "invalid_invitation" });
    }
    const id = `invite-${createIdempotencyKey("mock").split(":").at(-1)}`;
    const inviteToken = `gti_mock_${createIdempotencyKey("secret").split(":").at(-1)}`;
    const invitation = normalizeInvitation({
      id,
      project_id: projectId,
      inviter_user_id: this.currentUser.id,
      role,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      revoked_at: null,
      expired_at: null,
      claimed_at: null,
      claimed_by_user_id: null,
    });
    this.invitations.set(id, { ...invitation, inviteToken, inviterDisplayName: this.currentUser.username });
    return { invitation: structuredClone(invitation), inviteToken };
  }

  async listInvitations(projectId) {
    await this.#wait();
    return [...this.invitations.values()]
      .filter((invitation) => invitation.projectId === projectId)
      .map(({ inviteToken: _inviteToken, inviterDisplayName: _inviterName, ...invitation }) => structuredClone(normalizeInvitation(invitation)));
  }

  async revokeInvitation(projectId, invitationId) {
    await this.#wait();
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.projectId !== projectId) throw new ApiError("Invitation not found.", { status: 404, code: "not_found" });
    if (invitation.status !== "pending") throw new ApiError("Only pending invitations can be revoked.", { status: 409, code: "conflict" });
    invitation.revokedAt = new Date().toISOString();
    return structuredClone(normalizeInvitation(invitation));
  }

  async previewInvitation(inviteToken) {
    await this.#wait();
    const invitation = [...this.invitations.values()].find(item => item.inviteToken === inviteToken);
    const project = this.projects.find(item => item.id === invitation?.projectId);
    const status = invitation && normalizeInvitation(invitation).status;
    const member = Boolean(project?.role);
    if (!project || project.state !== "active" || !invitation || invitation.expiresAt <= new Date().toISOString()
      || !["pending", "claimed"].includes(status)
      || (status === "claimed" && !(member && invitation.claimedByUserId === this.currentUser.id))) {
      throw new ApiError("Invitation is invalid or unavailable.", { status: 410, code: "invitation_unavailable" });
    }
    return ProjectInvitationPreviewSchema.parse({
      project: { id: project.id, title: project.name }, inviter_display_name: invitation.inviterDisplayName ?? "Project owner",
      role: invitation.role, created_at: invitation.createdAt, expires_at: invitation.expiresAt, already_member: member,
    });
  }

  async acceptInvitation(inviteToken) {
    await this.#wait();
    const invitation = [...this.invitations.values()].find((item) => item.inviteToken === inviteToken);
    if (!invitation || normalizeInvitation(invitation).status !== "pending") {
      throw new ApiError("Invitation is invalid or unavailable.", { status: 401, code: "unauthorized" });
    }
    const projectSessions = this.sessions.filter((item) => item.projectId === invitation.projectId);
    const project = this.projects.find(item => item.id === invitation.projectId);
    if (!project || project.state !== "active") throw new ApiError("Invitation is invalid or unavailable.", { status: 401, code: "unauthorized" });
    if (project.role || projectSessions.some((session) => session.members.some((member) => member.userId === this.currentUser.id))) {
      throw new ApiError("You are already a member of this project.", { status: 409, code: "conflict" });
    }
    for (const session of projectSessions) {
      session.members.push({ ...this.currentUser, userId: this.currentUser.id, role: invitation.role, runtime: null });
    }
    invitation.claimedAt = new Date().toISOString();
    invitation.claimedByUserId = this.currentUser.id;
    project.role = invitation.role;
    return { actor: structuredClone(this.currentUser), invitation: structuredClone(normalizeInvitation(invitation)) };
  }

  async listDevices() {
    await this.#wait();
    return [
      { id: "device-demo", user_id: this.currentUser.id, name: this.deviceName },
      ...(!this.dshRevoked ? [{ id: "dsh-device-demo", user_id: this.currentUser.id, name: this.dshDeviceName }] : []),
    ];
  }

  async renameDevice(deviceId, name) {
    await this.#wait();
    if (!new Set(["device-demo", "dsh-device-demo"]).has(deviceId) || (deviceId === "dsh-device-demo" && this.dshRevoked)) {
      throw new ApiError("Device not found.", { status: 404, code: "not_found" });
    }
    const normalized = name?.trim() ?? "";
    if (!normalized || normalized.length > 120) throw new ApiError("Choose a device name between 1 and 120 characters.", { status: 422, code: "validation_error" });
    if (deviceId === "device-demo") this.deviceName = normalized;
    else this.dshDeviceName = normalized;
    return { id: deviceId, user_id: this.currentUser.id, name: normalized };
  }

  async revokeDevice(deviceId) {
    await this.#wait();
    if (deviceId !== "dsh-device-demo" || this.dshRevoked) {
      throw new ApiError("Device not found.", { status: 404, code: "not_found" });
    }
    this.dshRevoked = true;
  }

  async approveDshPairing(userCode) {
    await this.#wait();
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(userCode)) {
      throw new ApiError("DSH pairing is invalid, expired, or already consumed.", { status: 404, code: "pairing_unavailable" });
    }
    return {
      pairing_id: "mock-pairing",
      user_code: userCode,
      device_name: this.dshDeviceName,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      status: "approved",
    };
  }

  async setProjectMemberRole(projectId, userId, role) {
    await this.#wait();
    for (const session of this.sessions.filter((item) => item.projectId === projectId)) {
      const member = session.members.find((item) => item.userId === userId);
      if (member && member.role !== "owner") member.role = role;
    }
    return { user_id: userId, role };
  }

  async replayEvents(sessionId, { afterSequence, limit = 100 }) {
    await this.#wait();
    this.#findSession(sessionId);
    const all = this.events.get(sessionId) ?? [];
    const pageEvents = all.filter((event) => event.sequence > afterSequence).slice(0, limit);
    const headSequence = all.at(-1)?.sequence ?? 0;
    const nextAfterSequence = pageEvents.at(-1)?.sequence ?? afterSequence;
    return {
      events: structuredClone(pageEvents),
      headSequence,
      nextAfterSequence,
      hasMore: nextAfterSequence < headSequence,
      contentRevision: this.#findSession(sessionId).contentRevision ?? 0,
    };
  }

  async deleteMessage(sessionId, eventId, input) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const member = session.members.find(item => item.userId === this.currentUser.id);
    const events = this.events.get(sessionId) ?? [];
    const target = events.find(event => event.id === eventId);
    if (!member || member.role === "viewer" || target?.actor?.id !== this.currentUser.id
      || !["human_chat", "agent_request", "agent_response"].includes(target?.type)
      || (session.mode === "solo" && session.ownerUserId !== this.currentUser.id)) {
      throw new ApiError("Only the author may delete a writable message.", { status: 403, code: "forbidden" });
    }
    this.deletionReceipts ??= new Map();
    const key = `${sessionId}:${this.currentUser.id}:${input.idempotencyKey}`;
    const previous = this.deletionReceipts.get(key);
    if (previous) {
      if (previous.targetEventId !== eventId) throw new ApiError("Deletion retry conflicts.", { status: 409, code: "idempotency_conflict" });
      return structuredClone(previous);
    }
    if (target.deleted) throw new ApiError("This message was already deleted.", { status: 409, code: "message_deleted" });
    const reasons = new Map([[eventId, "author"]]);
    const includeLinked = (requestId, reason) => {
      for (const event of events) if (event.id !== eventId && event.replyTo === requestId
        && ["agent_response", "agent_progress", "tool_call", "tool_result"].includes(event.type)) reasons.set(event.id, reason);
    };
    if (target.type === "agent_request") includeLinked(eventId, "request");
    if (target.type === "agent_response" && target.replyTo) includeLinked(target.replyTo, "request");
    reasons.set(eventId, "author");
    // Match the real service's conservative invalidation of old generated work.
    // An independently authored request/chat is retained, never impersonated.
    for (const event of events) if (event.type === "agent_request" && event.sequence > target.sequence) includeLinked(event.id, "request");
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const event of events) {
        if (reasons.has(event.id) || !event.payload?.history_summary?.source_event_ids?.some(id => reasons.has(id))) continue;
        reasons.set(event.id, "summary_invalidated"); includeLinked(event.id, "summary_invalidated"); expanded = true;
      }
    }
    session.contentRevision = (session.contentRevision ?? 0) + 1;
    const deletedAt = new Date().toISOString();
    for (const event of events) if (reasons.has(event.id)) {
      event.payload = { content: "[Message deleted]" }; event.provenance = null;
      event.contentRevision = session.contentRevision;
      event.deleted = { deleted_at: deletedAt, reason: reasons.get(event.id) };
    }
    for (const request of [...events]) {
      if (request.type !== "agent_request" || request.deleted
        || events.some(event => event.replyTo === request.id && event.type === "agent_response" && !event.deleted)) continue;
      const terminal = this.#makeEvent(sessionId, "agent_response", { actor: request.actor, replyTo: request.id,
        idempotencyKey: createIdempotencyKey("mock-context-changed") });
      terminal.payload = { content: "Shared history changed. Start a new Agent request with the current history.",
        status: "failed", error: { code: "context_changed" } };
      this.#publish(sessionId, terminal);
    }
    const marker = this.#makeEvent(sessionId, "message_deleted", { actor: this.currentUser, idempotencyKey: input.idempotencyKey });
    marker.payload = { target_event_id: eventId, content_revision: session.contentRevision };
    const receipt = { event: marker, targetEventId: eventId, contentRevision: session.contentRevision,
      affectedEventIds: [...reasons.keys()].slice(0, 256), affectedTruncated: reasons.size > 256 };
    this.deletionReceipts.set(key, receipt);
    this.#publish(sessionId, marker);
    return structuredClone(receipt);
  }

  appendHumanChat(sessionId, input) {
    return this.#append(sessionId, "human_chat", input);
  }

  async appendAgentRequest(sessionId, input) {
    const existing = this.idempotentEvents.get(`${sessionId}:${input.idempotencyKey}`);
    const request = await this.#append(sessionId, "agent_request", input);
    if (existing) return request;
    const actor = structuredClone(this.currentUser);
    const settled = () => !this.sessions.some((session) => session.id === sessionId)
      || (this.events.get(sessionId) ?? []).some(event => event.id === request.id && event.deleted)
      || (this.events.get(sessionId) ?? []).some((event) => event.replyTo === request.id
        && (event.type === "agent_response" || event.payload?.status === "paused"));
    for (const [delay, content] of [
      [220, "Inspecting the shared context…"],
      [430, "Preparing a **Markdown** response."],
    ]) {
      setTimeout(() => {
        if (settled()) return;
        const progress = this.#makeEvent(sessionId, "agent_progress", {
          content,
          actor,
          idempotencyKey: createIdempotencyKey("mock-progress"),
          replyTo: request.id,
          provenance: {
            userId: actor.id,
            username: actor.username,
            deviceId: "device-demo",
            harness: input.executionProfile?.harness ?? "codex",
            provider: input.executionProfile?.harness === "deepseek-harness" ? "deepseek-official" : "OpenAI",
            model: input.executionProfile?.model ?? "gpt-5",
            localSessionId: "local-demo",
            fidelity: "harness_transcript",
          },
        });
        this.#publish(sessionId, progress);
      }, delay);
    }
    setTimeout(() => {
      if (settled()) return;
      const response = this.#makeEvent(sessionId, "agent_response", {
        content: "## Done\n\nMock Agent acknowledged the request. Connect the server and local bridge for a real harness response.\n\n- Progress is folded above\n- Final output supports `Markdown`\n- Inline math: $E = mc^2$\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
        actor,
        idempotencyKey: createIdempotencyKey("mock-response"),
        replyTo: request.id,
        provenance: {
          userId: actor.id,
          username: actor.username,
          deviceId: "device-demo",
          harness: input.executionProfile?.harness ?? "codex",
          provider: input.executionProfile?.harness === "deepseek-harness" ? "deepseek-official" : "OpenAI",
          model: input.executionProfile?.model ?? "gpt-5",
          ...(input.executionProfile?.reasoningEffort ? { reasoningEffort: input.executionProfile.reasoningEffort } : {}),
          localSessionId: "local-demo",
          fidelity: "harness_transcript",
        },
      });
      this.#publish(sessionId, response);
    }, 650);
    return request;
  }

  async pauseAgentRequest(sessionId, requestId) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const member = session.members.find((item) => item.userId === this.currentUser.id);
    const events = this.events.get(sessionId) ?? [];
    const request = events.find((event) => event.id === requestId && event.type === "agent_request");
    if (!member || member.role === "viewer" || request?.actor.id !== this.currentUser.id
      || (session.mode === "solo" && session.ownerUserId !== this.currentUser.id)) {
      throw new ApiError("Only the author may pause a writable Agent request.", { status: 403 });
    }
    const linked = events.filter((event) => event.replyTo === requestId);
    if (linked.some((event) => event.type === "agent_response")) throw new ApiError("This Agent request already completed.", { status: 409 });
    if (!linked.some((event) => event.type === "agent_progress")) throw new ApiError("The Agent has not started this request.", { status: 409 });
    if (!linked.some((event) => event.payload?.status === "paused")) {
      const marker = this.#makeEvent(sessionId, "agent_progress", { content: "The author paused this Agent request.",
        actor: this.currentUser, replyTo: requestId, idempotencyKey: createIdempotencyKey("mock-pause") });
      marker.payload.phase = "lifecycle";
      marker.payload.status = "paused";
      this.#publish(sessionId, marker);
    }
    return { request_event_id: requestId, status: "paused" };
  }

  async createHistorySummary(sessionId, input) {
    const existing = this.idempotentEvents.get(`${sessionId}:${input.idempotencyKey}`);
    if (existing) return structuredClone(existing);
    const contentRevision = this.#findSession(sessionId).contentRevision ?? 0;
    const { historyWireEvents, historySummaryExecutionWire } = await import("./history-summaries.js?v=20261018-tabs-2");
    const { selectHistorySummarySources, historySummarySourceJson, buildHistorySummaryPrompt } = await import("./history-summary-policy.js");
    historySummaryExecutionWire(input.executionProfile);
    let sources;
    try { sources = selectHistorySummarySources(historyWireEvents(this.events.get(sessionId) ?? []), input.sourceEventIds); }
    catch (error) { throw new ApiError(error.message, { status: 400, code: error.code }); }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(historySummarySourceJson(sources)));
    const marker = { version: 1, source_event_ids: sources.map((event) => event.id),
      source_digest: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
    return this.appendAgentRequest(sessionId, { ...input,
      contentRevision, content: buildHistorySummaryPrompt(sources, input.instructions), historySummary: marker });
  }

  async getProjectContextPolicy(projectId) {
    await this.#wait();
    this.contextPolicies ??= new Map();
    return { mode: this.contextPolicies.get(`${this.currentUser.id}:${projectId}`) ?? "summary" };
  }

  async setProjectContextPolicy(projectId, mode) {
    await this.#wait();
    if (!["summary", "original"].includes(mode)) throw new ApiError("Invalid context policy.", { status: 400 });
    this.contextPolicies ??= new Map();
    this.contextPolicies.set(`${this.currentUser.id}:${projectId}`, mode);
    return { mode };
  }

  async openRealtime({ sessionId, afterSequence, onEvent, onState }) {
    await this.#wait();
    this.#findSession(sessionId);
    const listener = { afterSequence, onEvent, onState, closed: false };
    const bucket = this.listeners.get(sessionId) ?? new Set();
    bucket.add(listener);
    this.listeners.set(sessionId, bucket);
    onState("live");
    return {
      close: () => {
        listener.closed = true;
        bucket.delete(listener);
      },
    };
  }

  async #append(sessionId, type, input) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const member = session.members.find((item) => item.userId === this.currentUser.id);
    if (!member || member.role === "viewer" || (session.mode === "solo" && session.ownerUserId !== this.currentUser.id)) {
      throw new ApiError("This session is read only for your role.", { status: 403, code: "forbidden" });
    }
    if (type === "agent_request" && !isExecutionRuntime(member.runtime)) {
      throw new ApiError("Your local runtime is offline.", { status: 409, code: "runtime_offline" });
    }
    const existing = this.idempotentEvents.get(`${sessionId}:${input.idempotencyKey}`);
    if (existing) return structuredClone(existing);
    if (type === "agent_request" && ((input.contentRevision !== undefined && input.contentRevision !== (session.contentRevision ?? 0))
      || ((session.contentRevision ?? 0) > 0 && input.contentRevision === undefined))) {
      throw new ApiError("Shared history changed.", { status: 409, code: "context_changed" });
    }
    if (input.replyTo && (this.events.get(sessionId) ?? []).find(event => event.id === input.replyTo)?.deleted) {
      throw new ApiError("The quoted message was deleted.", { status: 409, code: "message_deleted" });
    }
    const event = this.#makeEvent(sessionId, type, {
      content: input.content,
      actor: this.currentUser,
      idempotencyKey: input.idempotencyKey,
      executionProfile: input.executionProfile,
      historySummary: input.historySummary,
      replyTo: input.replyTo,
      mentions: input.mentions,
    });
    this.idempotentEvents.set(`${sessionId}:${input.idempotencyKey}`, event);
    this.#publish(sessionId, event);
    return structuredClone(event);
  }

  async listProjectMentions(projectId, beforeId) {
    await this.#wait();
    const sessions = this.sessions.filter((session) => session.projectId === projectId);
    const entries = sessions.flatMap((session) => (this.events.get(session.id) ?? [])
      .filter((event) => event.payload?.mentions?.some((mention) => mention.user_id === this.currentUser.id))
      .map((event) => ({ id: event.id, session_id: session.id, session_title: session.name,
        actor_display_name: event.actor.username, sequence: event.sequence, created_at: event.createdAt,
        excerpt: String(event.payload.content ?? "").slice(0, 180) }))).reverse();
    const start = beforeId ? entries.findIndex((event) => event.id === beforeId) + 1 : 0;
    return { mentions: entries.slice(start, start + 50), next_before_id: entries[start + 50] ? entries[start + 49].id : null };
  }

  #makeEvent(sessionId, type, { content, actor, idempotencyKey, provenance, replyTo = null, executionProfile, historySummary, mentions }) {
    const bucket = this.events.get(sessionId) ?? [];
    const event = {
      id: `evt-${sessionId}-${bucket.length + 1}`,
      sessionId,
      sequence: (bucket.at(-1)?.sequence ?? 0) + 1,
      idempotencyKey,
      type,
      contentRevision: this.#findSession(sessionId).contentRevision ?? 0,
      actor: structuredClone(actor),
      createdAt: new Date().toISOString(),
      visibility: "session",
      replyTo,
      payload: {
        content,
        ...(mentions?.length ? { mentions } : {}),
        ...(historySummary ? { history_summary: historySummary } : {}),
        ...(type === "agent_request" && executionProfile ? {
          execution_profile: {
            harness: executionProfile.harness,
            ...(executionProfile.provider === undefined ? {} : {
              provider: executionProfile.provider,
            }),
            model: executionProfile.model,
            ...(executionProfile.reasoningEffort === undefined ? {} : {
              reasoning_effort: executionProfile.reasoningEffort,
            }),
            ...(executionProfile.runtimeId === undefined ? {} : {
              runtime_id: executionProfile.runtimeId,
            }),
          },
        } : {}),
      },
      ...(provenance ? { provenance } : {}),
    };
    bucket.push(event);
    this.events.set(sessionId, bucket);
    return event;
  }

  #publish(sessionId, event) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      if (!listener.closed && event.sequence > listener.afterSequence) listener.onEvent(structuredClone(event));
    }
  }

  #seedEvent(sequence, type, actor, content, minutesAgo, sessionId = "session-orbit") {
    return {
      id: `evt-seed-${sequence}`,
      sessionId,
      sequence,
      idempotencyKey: `seed:${sequence}`,
      type,
      actor: structuredClone(actor),
      createdAt: isoMinutesAgo(minutesAgo),
      visibility: "session",
      replyTo: null,
      payload: { content },
    };
  }

  #summary(session) {
    const membership = session.members.find((member) => member.userId === this.currentUser.id);
    return {
      id: session.id,
      projectId: session.projectId,
      ownerUserId: session.ownerUserId,
      name: session.name,
      mode: session.mode,
      description: session.description,
      updatedAt: session.updatedAt,
      memberCount: session.members.length,
      role: membership?.role ?? "viewer",
      latestSequence: this.events.get(session.id)?.at(-1)?.sequence ?? 0,
      contentRevision: session.contentRevision ?? 0,
    };
  }

  #findSession(sessionId) {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) throw new ApiError("Session not found.", { status: 404, code: "not_found" });
    return session;
  }

  #discardSessionCloudState(sessionId) {
    this.events.delete(sessionId);
    for (const [key, event] of this.idempotentEvents) {
      if (event.sessionId === sessionId) this.idempotentEvents.delete(key);
    }
    for (const [requestId, request] of this.snapshotRequests) {
      if (request.sessionId === sessionId) this.snapshotRequests.delete(requestId);
    }
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener.closed = true;
      listener.onState("offline");
    }
    this.listeners.delete(sessionId);
  }

  #wait() {
    return new Promise((resolve) => setTimeout(resolve, this.latency));
  }
}
