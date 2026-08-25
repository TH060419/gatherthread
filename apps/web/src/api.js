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
    const response = await fetch(`${this.baseUrl}${path}`, {
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

  async authenticate(token = this.token) {
    this.token = token;
    try {
      const { actor } = await this.request("/v1/browser-sessions", { method: "POST" });
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

  async listProjectSessions(projectId) {
    const { sessions } = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/sessions`);
    return sessions.map((session) => {
      this.sessionHeads.set(session.id, session.current_sequence);
      return {
        id: session.id,
        projectId: session.project_id,
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

  async renameSession(sessionId, input) {
    const { session } = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: input.name,
        idempotency_key: input.idempotencyKey,
      }),
    });
    return this.#sessionDetail(session, "owner");
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

  async createSnapshotRequest(sessionId) {
    const result = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/snapshot-requests`, {
      method: "POST",
      body: JSON.stringify({}),
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

  async claimInvitation({ inviteToken, displayName, deviceName, userId, deviceId }) {
    const result = await this.request("/v1/invitations/claim", {
      method: "POST",
      headers: { "X-GatherThread-Browser-Session": "1" },
      body: JSON.stringify({
        invite_token: inviteToken,
        display_name: displayName,
        device_name: deviceName,
        ...(userId ? { user_id: userId } : {}),
        ...(deviceId ? { device_id: deviceId } : {}),
      }),
    });
    const actor = {
      id: result.actor.user_id,
      username: result.actor.display_name,
      device_id: result.actor.device_id,
    };
    this.actors.set(actor.id, actor.username);
    return { actor, invitation: normalizeInvitation(result.invitation), accessToken: result.token };
  }

  async acceptInvitation(inviteToken) {
    const result = await this.request("/v1/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ invite_token: inviteToken }),
    });
    return { ...result, invitation: normalizeInvitation(result.invitation) };
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

  #append(sessionId, type, input) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify({
        type,
        visibility: "session",
        payload: { content: input.content },
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
      actor: { id: event.actor_user_id, username },
      createdAt: event.created_at,
      replyTo: event.reply_to_event_id ?? null,
      payload: event.payload,
      provenance: provenance ? {
        username,
        harness: provenance.harness,
        provider: provenance.provider,
        model: provenance.model,
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
    this.currentUser = users.avery;
    this.listeners = new Map();
    this.idempotentEvents = new Map();
    this.invitations = new Map();
    this.snapshotRequests = new Map();
    this.credential = "";
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

  async authenticate(token) {
    await this.#wait();
    if (token !== "demo-token") throw new ApiError("That preview token is not valid.", { status: 401, code: "unauthorized" });
    return structuredClone(this.currentUser);
  }

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
    const id = `session-${createIdempotencyKey("new").split(":").at(-1)}`;
    const session = {
      id,
      projectId,
      name: title,
      mode,
      description: mode === "solo" ? "Owner-led thread with read-only observers" : "Shared human and agent collaboration",
      updatedAt: new Date().toISOString(),
      members: [
        {
          ...this.currentUser,
          userId: this.currentUser.id,
          role: "owner",
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
    const project = this.projects.find((item) => item.id === projectId);
    if (project) project.sessionCount += 1;
    this.events.set(id, []);
    return this.#summary(session);
  }

  async getSession(sessionId) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    return structuredClone(session);
  }

  async renameSession(sessionId, { name, idempotencyKey }) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const member = session.members.find((item) => item.userId === this.currentUser.id);
    if (member?.role !== "owner") {
      throw new ApiError("Only the project owner can rename sessions.", { status: 403, code: "forbidden" });
    }
    const title = normalizeMockTitle(name, "Session");
    const key = `${sessionId}:${idempotencyKey}`;
    const existing = this.idempotentEvents.get(key);
    if (existing) {
      if (existing.type !== "session_state_change" || existing.payload?.title !== title) {
        throw new ApiError("Idempotency key already used for another request.", { status: 409, code: "idempotency_conflict" });
      }
      return this.#summary(session);
    }
    session.name = title;
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
      payload: { action: "renamed", title },
    };
    bucket.push(event);
    this.events.set(sessionId, bucket);
    this.idempotentEvents.set(key, event);
    this.#publish(sessionId, event);
    return this.#summary(session);
  }

  async listMembers(sessionId) {
    await this.#wait();
    return structuredClone(this.#findSession(sessionId).members);
  }

  async createSnapshotRequest(sessionId) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    const id = `snapshot-${createIdempotencyKey("mock").split(":").at(-1)}`;
    const request = {
      id,
      sessionId,
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
    request.status = ["claimed", "importing", "compacting", "completed"][Math.min(request.pollCount - 1, 3)];
    if (request.status === "completed") request.localTaskName = `GatherThread · ${request.sessionName}`;
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
    const actor = { id: `user-${createIdempotencyKey("mock").split(":").at(-1)}`, username: displayName.trim() };
    this.currentUser = actor;
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
    setTimeout(() => {
      const response = this.#makeEvent(sessionId, "agent_response", {
        content: "Mock agent acknowledged the request. Connect the server and local bridge for a real harness response.",
        actor: this.currentUser,
        idempotencyKey: createIdempotencyKey("mock-response"),
        replyTo: request.id,
        provenance: {
          userId: this.currentUser.id,
          username: this.currentUser.username,
          deviceId: "device-demo",
          harness: "Codex",
          provider: "OpenAI",
          model: "gpt-5",
          localSessionId: "local-demo",
          fidelity: "harness_transcript",
        },
      });
      this.#publish(sessionId, response);
    }, 650);
    return request;
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
    if (!member || member.role === "viewer" || (session.mode === "solo" && member.role !== "owner")) {
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
    });
    this.idempotentEvents.set(`${sessionId}:${input.idempotencyKey}`, event);
    this.#publish(sessionId, event);
    return structuredClone(event);
  }

  #makeEvent(sessionId, type, { content, actor, idempotencyKey, provenance, replyTo = null }) {
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
      payload: { content },
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

  #wait() {
    return new Promise((resolve) => setTimeout(resolve, this.latency));
  }
}
