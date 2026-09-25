import {
  createIdempotencyKey,
  isExecutionRuntime,
  normalizeInvitation,
  normalizeSnapshotRequest,
} from "./domain.js";

const TITLE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

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
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class HttpCollaborationApi {
  constructor({ baseUrl = "", token = "" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
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
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
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

  async authenticate(token = this.token, { rememberDevice = false, displayName, deviceName } = {}) {
    this.token = token;
    try {
      const { actor } = await this.request("/v1/browser-sessions", {
        method: "POST",
        body: JSON.stringify({
          remember_device: rememberDevice,
          ...(displayName ? { display_name: displayName } : {}),
          ...(deviceName ? { device_name: deviceName } : {}),
        }),
      });
      this.actors.set(actor.id, actor.username);
      return actor;
    } finally {
      this.token = "";
    }
  }

  async restoreSession() {
    try {
      const actor = await this.request("/v1/me");
      this.actors.set(actor.id, actor.username);
      try {
        await this.request("/v1/remembered-accounts/adopt-current-session", {
          method: "POST", body: JSON.stringify({}),
        });
      } catch {
        // Optional legacy quick-login migration must not prevent session restore.
      }
      return actor;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  async listRememberedAccounts() {
    try {
      const { accounts } = await this.request("/v1/remembered-accounts");
      return accounts;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return [];
      throw error;
    }
  }

  async activateRememberedAccount(id, { displayName, deviceName }) {
    const { actor } = await this.request(`/v1/remembered-accounts/${encodeURIComponent(id)}/activate`, {
      method: "POST",
      body: JSON.stringify({ display_name: displayName, device_name: deviceName }),
    });
    this.actors.set(actor.id, actor.username);
    return actor;
  }

  async forgetRememberedAccount(id) {
    await this.request(`/v1/remembered-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async logout() {
    try {
      await this.request("/v1/browser-sessions/current", { method: "DELETE" });
    } finally {
      this.clearCredential();
    }
  }

  clearCredential() {
    this.token = "";
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
      };
    });
  }

  async listProjectMembers(projectId) {
    const { members } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/members`);
    return members.map((member) => ({
      id: member.user_id,
      userId: member.user_id,
      username: member.display_name,
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

  async claimInvitation({ inviteToken, displayName, deviceName, userId, deviceId, rememberDevice = false }) {
    const result = await this.request("/v1/invitations/claim", {
      method: "POST",
      headers: { "X-GatherThread-Browser-Session": "1" },
      body: JSON.stringify({
        invite_token: inviteToken,
        display_name: displayName,
        device_name: deviceName,
        remember_device: rememberDevice,
        ...(userId ? { user_id: userId } : {}),
        ...(deviceId ? { device_id: deviceId } : {}),
      }),
    });
    const actor = {
      id: result.actor.user_id,
      username: result.actor.display_name,
      device_id: result.actor.device_id,
      can_create_projects: result.actor.can_create_projects === true,
    };
    this.actors.set(actor.id, actor.username);
    return { actor, invitation: normalizeInvitation(result.invitation), accessToken: result.token };
  }

  async claimTestAccess({ accessToken, displayName, deviceName, rememberDevice = false }) {
    const result = await this.request("/v1/test-access/claim", {
      method: "POST",
      headers: { "X-GatherThread-Browser-Session": "1" },
      body: JSON.stringify({
        access_token: accessToken,
        display_name: displayName,
        device_name: deviceName,
        remember_device: rememberDevice,
      }),
    });
    const actor = {
      id: result.actor.user_id,
      username: result.actor.display_name,
      device_id: result.actor.device_id,
      can_create_projects: result.actor.can_create_projects === true,
    };
    this.actors.set(actor.id, actor.username);
    return { actor, accessToken: result.token };
  }

  async acceptInvitation(inviteToken) {
    const result = await this.request("/v1/invitations/accept", {
      method: "POST",
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
    };
  }

  appendHumanChat(sessionId, input) {
    return this.#append(sessionId, "human_chat", input);
  }

  appendAgentRequest(sessionId, input) {
    return this.#append(sessionId, "agent_request", input);
  }

  async createHistorySummary(sessionId, input) {
    const { historySummaryExecutionWire } = await import("./history-summaries.js");
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
      provenance: provenance ? {
        username,
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
  constructor({ latency = 90 } = {}) {
    this.latency = latency;
    this.currentUser = { ...users.avery, can_create_projects: true };
    this.rememberedAccounts = [];
    this.listeners = new Map();
    this.idempotentEvents = new Map();
    this.projectMutations = new Map();
    this.invitations = new Map();
    this.snapshotRequests = new Map();
    this.localAutomaticUpload = new Map();
    this.codeRepositories = new Map();
    this.codeAutomaticUpload = new Map();
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

  async authenticate(token, { rememberDevice = false, displayName, deviceName } = {}) {
    await this.#wait();
    if (token !== "demo-token") throw new ApiError("That preview token is not valid.", { status: 401, code: "unauthorized" });
    if (displayName) this.currentUser.username = displayName;
    if (deviceName) this.deviceName = deviceName;
    if (rememberDevice) {
      this.rememberedAccounts = [{ id: "mock-remembered-account", display_name: this.currentUser.username,
        device_name: this.deviceName ?? "This browser" }];
    }
    return structuredClone({ ...this.currentUser, device_id: "device-demo" });
  }

  async restoreSession() {
    await this.#wait();
    return null;
  }

  async listRememberedAccounts() {
    await this.#wait();
    return structuredClone(this.rememberedAccounts);
  }

  async activateRememberedAccount(id, { displayName, deviceName }) {
    await this.#wait();
    const account = this.rememberedAccounts.find((entry) => entry.id === id);
    if (!account) throw new ApiError("No remembered account is available in this preview.", { status: 401, code: "unauthorized" });
    this.currentUser.username = displayName;
    this.deviceName = deviceName;
    account.display_name = displayName;
    account.device_name = deviceName;
    return structuredClone({ ...this.currentUser, device_id: "device-demo" });
  }

  async forgetRememberedAccount(id) {
    await this.#wait();
    this.rememberedAccounts = this.rememberedAccounts.filter((entry) => entry.id !== id);
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
    const inviteToken = `mock-invite-${createIdempotencyKey("secret")}`;
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
    this.invitations.set(id, { ...invitation, inviteToken });
    return { invitation: structuredClone(invitation), inviteToken };
  }

  async listInvitations(projectId) {
    await this.#wait();
    return [...this.invitations.values()]
      .filter((invitation) => invitation.projectId === projectId)
      .map(({ inviteToken: _inviteToken, ...invitation }) => structuredClone(normalizeInvitation(invitation)));
  }

  async revokeInvitation(projectId, invitationId) {
    await this.#wait();
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.projectId !== projectId) throw new ApiError("Invitation not found.", { status: 404, code: "not_found" });
    if (invitation.status !== "pending") throw new ApiError("Only pending invitations can be revoked.", { status: 409, code: "conflict" });
    invitation.revokedAt = new Date().toISOString();
    return structuredClone(normalizeInvitation(invitation));
  }

  async claimInvitation({ inviteToken, displayName, deviceName }) {
    await this.#wait();
    const invitation = [...this.invitations.values()].find((item) => item.inviteToken === inviteToken);
    if (!invitation || normalizeInvitation(invitation).status !== "pending") {
      throw new ApiError("Invitation is invalid or unavailable.", { status: 401, code: "unauthorized" });
    }
    if (!displayName?.trim() || !deviceName?.trim()) throw new ApiError("Name and device name are required.", { status: 422, code: "invalid_claim" });
    const actor = {
      id: `user-${createIdempotencyKey("mock").split(":").at(-1)}`,
      username: displayName.trim(),
      device_id: "device-demo",
      can_create_projects: false,
    };
    this.currentUser = actor;
    this.projects = this.projects.filter((project) => project.id === invitation.projectId);
    this.deviceName = deviceName.trim();
    this.credential = `mock-device-${createIdempotencyKey("token")}`;
    for (const session of this.sessions.filter((item) => item.projectId === invitation.projectId)) {
      session.members.push({ ...actor, userId: actor.id, role: invitation.role, runtime: null });
    }
    invitation.claimedAt = new Date().toISOString();
    invitation.claimedByUserId = actor.id;
    const accessToken = this.credential;
    this.credential = "";
    return {
      actor: structuredClone(actor),
      invitation: structuredClone(normalizeInvitation(invitation)),
      accessToken,
    };
  }

  async claimTestAccess({ accessToken, displayName, deviceName }) {
    await this.#wait();
    if (accessToken !== "demo-test-access") {
      throw new ApiError("Test access token is invalid or unavailable.", { status: 401, code: "unauthorized" });
    }
    if (!displayName?.trim() || !deviceName?.trim()) {
      throw new ApiError("Name and device name are required.", { status: 422, code: "invalid_claim" });
    }
    this.currentUser = {
      id: `user-${createIdempotencyKey("mock").split(":").at(-1)}`,
      username: displayName.trim(),
      device_id: "device-demo",
      can_create_projects: true,
    };
    this.deviceName = deviceName.trim();
    this.projects = [];
    return { actor: structuredClone(this.currentUser), accessToken: `mock-device-${createIdempotencyKey("token")}` };
  }

  async acceptInvitation(inviteToken) {
    await this.#wait();
    const invitation = [...this.invitations.values()].find((item) => item.inviteToken === inviteToken);
    if (!invitation || normalizeInvitation(invitation).status !== "pending") {
      throw new ApiError("Invitation is invalid or unavailable.", { status: 401, code: "unauthorized" });
    }
    const projectSessions = this.sessions.filter((item) => item.projectId === invitation.projectId);
    if (projectSessions.some((session) => session.members.some((member) => member.userId === this.currentUser.id))) {
      throw new ApiError("You are already a member of this project.", { status: 409, code: "conflict" });
    }
    for (const session of projectSessions) {
      session.members.push({ ...this.currentUser, userId: this.currentUser.id, role: invitation.role, runtime: null });
    }
    invitation.claimedAt = new Date().toISOString();
    invitation.claimedByUserId = this.currentUser.id;
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
    };
  }

  appendHumanChat(sessionId, input) {
    return this.#append(sessionId, "human_chat", input);
  }

  async appendAgentRequest(sessionId, input) {
    const request = await this.#append(sessionId, "agent_request", input);
    for (const [delay, content] of [
      [220, "Inspecting the shared context…"],
      [430, "Preparing a **Markdown** response."],
    ]) {
      setTimeout(() => {
        const progress = this.#makeEvent(sessionId, "agent_progress", {
          content,
          actor: this.currentUser,
          idempotencyKey: createIdempotencyKey("mock-progress"),
          replyTo: request.id,
          provenance: {
            userId: this.currentUser.id,
            username: this.currentUser.username,
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
      const response = this.#makeEvent(sessionId, "agent_response", {
        content: "## Done\n\nMock Agent acknowledged the request. Connect the server and local bridge for a real harness response.\n\n- Progress is folded above\n- Final output supports `Markdown`\n- Inline math: $E = mc^2$\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
        actor: this.currentUser,
        idempotencyKey: createIdempotencyKey("mock-response"),
        replyTo: request.id,
        provenance: {
          userId: this.currentUser.id,
          username: this.currentUser.username,
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

  async createHistorySummary(sessionId, input) {
    const existing = this.idempotentEvents.get(`${sessionId}:${input.idempotencyKey}`);
    if (existing) return structuredClone(existing);
    const { historyWireEvents, historySummaryExecutionWire } = await import("./history-summaries.js");
    const { selectHistorySummarySources, historySummarySourceJson, buildHistorySummaryPrompt } = await import("./history-summary-policy.js");
    historySummaryExecutionWire(input.executionProfile);
    let sources;
    try { sources = selectHistorySummarySources(historyWireEvents(this.events.get(sessionId) ?? []), input.sourceEventIds); }
    catch (error) { throw new ApiError(error.message, { status: 400, code: error.code }); }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(historySummarySourceJson(sources)));
    const marker = { version: 1, source_event_ids: sources.map((event) => event.id),
      source_digest: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
    return this.appendAgentRequest(sessionId, { ...input,
      content: buildHistorySummaryPrompt(sources, input.instructions), historySummary: marker });
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
    const event = this.#makeEvent(sessionId, type, {
      content: input.content,
      actor: this.currentUser,
      idempotencyKey: input.idempotencyKey,
      executionProfile: input.executionProfile,
      historySummary: input.historySummary,
    });
    this.idempotentEvents.set(`${sessionId}:${input.idempotencyKey}`, event);
    this.#publish(sessionId, event);
    return structuredClone(event);
  }

  #makeEvent(sessionId, type, { content, actor, idempotencyKey, provenance, replyTo = null, executionProfile, historySummary }) {
    const bucket = this.events.get(sessionId) ?? [];
    const event = {
      id: `evt-${sessionId}-${bucket.length + 1}`,
      sessionId,
      sequence: (bucket.at(-1)?.sequence ?? 0) + 1,
      idempotencyKey,
      type,
      actor: structuredClone(actor),
      createdAt: new Date().toISOString(),
      visibility: "session",
      replyTo,
      payload: {
        content,
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
