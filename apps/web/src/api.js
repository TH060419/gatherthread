import { createIdempotencyKey } from "./domain.js";

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
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
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
    const actor = await this.request("/v1/me");
    this.actors.set(actor.id, actor.username);
    return actor;
  }

  async listSessions() {
    const { sessions } = await this.request("/v1/sessions");
    return sessions.map((session) => {
      this.sessionHeads.set(session.id, session.current_sequence);
      return {
        id: session.id,
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

  async createSession(input) {
    const { session } = await this.request("/v1/sessions", {
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
        } : null,
      };
    });
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
    socketUrl.searchParams.set("ticket", ticket);
    const socket = new WebSocket(socketUrl);
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
      name: session.title,
      mode: session.mode,
      description: session.state === "archived" ? "Archived shared session" : "Active shared session",
      role,
      updatedAt: session.updated_at,
    };
  }

  #event(event) {
    const username = this.actors.get(event.actor_user_id) ?? event.actor_user_id;
    const provenance = event.runtime_provenance;
    return {
      id: event.id,
      sessionId: event.session_id,
      sequence: event.sequence,
      type: event.type,
      actor: { id: event.actor_user_id, username },
      createdAt: event.created_at,
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
    this.sessions = [
      {
        id: "session-orbit",
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
        name: "Research notes",
        mode: "solo",
        description: "Owner-led thread with read-only observers",
        updatedAt: isoMinutesAgo(45),
        members: [
          {
            ...users.maya,
            userId: users.maya.id,
            role: "owner",
            runtime: {
              status: "offline",
              harness: "Claude Code",
              provider: "Anthropic",
              model: "Claude Sonnet",
            },
          },
          { ...users.avery, userId: users.avery.id, role: "viewer", runtime: null },
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

  async listSessions() {
    await this.#wait();
    return this.sessions.map((session) => this.#summary(session));
  }

  async createSession({ name, mode }) {
    await this.#wait();
    if (!name?.trim()) throw new ApiError("Session name is required.", { status: 422, code: "invalid_name" });
    if (!new Set(["solo", "multi"]).has(mode)) throw new ApiError("Choose solo or multi.", { status: 422, code: "invalid_mode" });
    const id = `session-${createIdempotencyKey("new").split(":").at(-1)}`;
    const session = {
      id,
      name: name.trim(),
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
    this.events.set(id, []);
    return this.#summary(session);
  }

  async getSession(sessionId) {
    await this.#wait();
    const session = this.#findSession(sessionId);
    return structuredClone(session);
  }

  async listMembers(sessionId) {
    await this.#wait();
    return structuredClone(this.#findSession(sessionId).members);
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
    if (type === "agent_request" && member.runtime?.status !== "online") {
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

  #makeEvent(sessionId, type, { content, actor, idempotencyKey, provenance }) {
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
      replyTo: null,
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
