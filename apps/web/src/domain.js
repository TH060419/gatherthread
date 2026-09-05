export const SESSION_MODES = Object.freeze(["solo", "multi"]);
export const MEMBER_ROLES = Object.freeze(["owner", "participant", "viewer"]);
export const INVITATION_ROLES = Object.freeze(["participant", "viewer"]);
export const INVITATION_TTLS = Object.freeze(["1h", "24h", "7d"]);
export const SNAPSHOT_STATUSES = Object.freeze(["queued", "claimed", "importing", "compacting", "completed", "failed"]);
export const CONNECTOR_STATUSES = Object.freeze(["synced", "offline", "reconciling", "rebuilding", "local_fork"]);
export const CODEX_CONNECT_PACKAGE_SPEC = "@gatherthread/codex-connect@0.1.0-beta.1";

const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 128_000;

export function projectCodexConnectionCommands({
  baseUrl,
  projectId,
  model = DEFAULT_CODEX_MODEL,
  contextWindowTokens = DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS,
}) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || /[\u0000-\u001f\u007f]/.test(baseUrl)) {
    throw new Error("A valid GatherThread server URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("A valid GatherThread server URL is required.");
  }
  const isLoopbackHttp = parsed.protocol === "http:"
    && new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname);
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if ((parsed.protocol !== "https:" && !isLoopbackHttp)
    || (normalizedPath !== "" && normalizedPath !== "/v1")
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("The GatherThread server URL is not safe for a connector command.");
  }
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) {
    throw new Error("The GatherThread project ID is not safe for a connector command.");
  }
  if (typeof model !== "string" || !model.trim() || model.length > 120
    || model.startsWith("-") || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error("The Codex model is not safe for a connector command.");
  }
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 4_096 || contextWindowTokens > 2_000_000) {
    throw new Error("The Codex context window is not safe for a connector command.");
  }
  const normalizedBaseUrl = parsed.toString().replace(/\/$/, "");
  const posixQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const powerShellQuote = (value) => `'${value.replaceAll("'", "''")}'`;
  const optionalArguments = (quote) => [
    ...(model === DEFAULT_CODEX_MODEL ? [] : ["--model", quote(model)]),
    ...(contextWindowTokens === DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS
      ? []
      : ["--context-window-tokens", String(contextWindowTokens)]),
  ];
  return Object.freeze({
    posix: [
      "npx", "--yes", CODEX_CONNECT_PACKAGE_SPEC,
      "--url", posixQuote(normalizedBaseUrl),
      "--project", posixQuote(projectId),
      "--create-workspace",
      ...optionalArguments(posixQuote),
    ].join(" "),
    powershell: [
      "npx.cmd", "--yes", CODEX_CONNECT_PACKAGE_SPEC,
      "--url", powerShellQuote(normalizedBaseUrl),
      "--project", powerShellQuote(projectId),
      "--create-workspace",
      ...optionalArguments(powerShellQuote),
    ].join(" "),
  });
}

export function createSelectionGuard() {
  let generation = 0;
  return {
    begin(key) {
      return Object.freeze({ key, generation: ++generation });
    },
    isCurrent(selection) {
      return selection?.generation === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}

export function sessionDeliveryMode({ role, mode, ownerUserId, currentUserId }) {
  if (role === "viewer") return "snapshot";
  if (mode === "solo") {
    return ownerUserId === undefined ? role === "owner" ? "live" : "snapshot"
      : ownerUserId === currentUserId ? "live" : "snapshot";
  }
  return role === "owner" || role === "participant" ? "live" : "snapshot";
}

export function isExecutionRuntime(runtime) {
  return runtime?.status === "online" && (runtime.purpose == null || runtime.purpose === "execution");
}

export function hasOnlineSnapshotConnector(members = []) {
  return members.some((member) => member.runtime?.status === "online" && member.runtime?.purpose === "snapshot_connector");
}

export function normalizeSnapshotRequest(payload) {
  const request = payload?.snapshot_request ?? payload?.request ?? payload ?? {};
  const wireStatus = request.status ?? payload?.job?.status;
  const status = wireStatus === "pending" ? "queued" : SNAPSHOT_STATUSES.includes(wireStatus) ? wireStatus : "failed";
  const result = request.result ?? payload?.job?.result ?? null;
  const failure = request.failure ?? request.error ?? payload?.job?.failure ?? payload?.job?.error ?? null;
  const localTaskName = [
    request.localTaskName,
    request.local_task_name,
    payload?.job?.localTaskName,
    payload?.job?.local_task_name,
    result?.threadName,
    result?.thread_name,
    result?.task_name,
    result?.task?.name,
    result?.threadId,
    result?.thread_id,
  ].find((value) => typeof value === "string" && value.length > 0) ?? "";
  return {
    id: request.id,
    sessionId: request.session_id ?? request.sessionId ?? null,
    throughSequence: Number(request.through_sequence ?? request.throughSequence ?? 0),
    status,
    createdAt: request.created_at ?? request.createdAt ?? new Date().toISOString(),
    localTaskName,
    failureMessage: typeof failure === "string" ? failure : failure?.message ?? "",
  };
}

export function snapshotStatusView(request) {
  const views = {
    queued: { label: "Queued", detail: "Waiting for a local Codex connector.", retryable: false, terminal: false },
    claimed: { label: "Claimed", detail: "A local Codex connector claimed this frozen copy.", retryable: false, terminal: false },
    importing: { label: "Importing", detail: "Importing the frozen history into a local Codex task.", retryable: false, terminal: false },
    compacting: { label: "Compacting", detail: "Preparing the local task for use.", retryable: false, terminal: false },
    completed: { label: "Completed", detail: request.localTaskName || "Local Codex task created.", retryable: false, terminal: true },
    failed: { label: "Failed", detail: request.failureMessage || "The local Codex import failed.", retryable: true, terminal: true },
  };
  return views[request.status] ?? views.failed;
}

export function normalizeConnectorState(value, syncSnapshot = {}) {
  const fallback = {
    live: "synced",
    offline: "offline",
    recovering: "reconciling",
    connecting: "rebuilding",
    replaying: "rebuilding",
    blocked: "rebuilding",
    idle: "offline",
  }[syncSnapshot.phase] ?? "offline";
  const rawStatus = value?.status ?? value?.state ?? fallback;
  const status = CONNECTOR_STATUSES.includes(rawStatus) ? rawStatus : fallback;
  const pendingCount = Number(value?.pending_count ?? value?.pendingCount ?? value?.bufferedCount ?? syncSnapshot.bufferedCount ?? 0);
  const label = {
    synced: "Synced",
    offline: pendingCount > 0 ? `Offline · ${pendingCount} pending` : "Offline",
    reconciling: "Reconciling",
    rebuilding: "Rebuilding",
    local_fork: "Local fork",
  }[status];
  return { status, pendingCount, label };
}

export function invitationStatus(invitation, now = Date.now()) {
  if (invitation.revokedAt ?? invitation.revoked_at) return "revoked";
  if (invitation.claimedAt ?? invitation.claimed_at) return "claimed";
  if (invitation.expiredAt ?? invitation.expired_at) return "expired";
  const expiresAt = invitation.expiresAt ?? invitation.expires_at;
  if (expiresAt && new Date(expiresAt).getTime() <= now) return "expired";
  return "pending";
}

export function normalizeInvitation(invitation) {
  const normalized = {
    id: invitation.id,
    projectId: invitation.project_id ?? invitation.projectId ?? null,
    sessionId: invitation.session_id ?? invitation.sessionId,
    inviterUserId: invitation.inviter_user_id ?? invitation.inviterUserId,
    role: invitation.role,
    createdAt: invitation.created_at ?? invitation.createdAt,
    expiresAt: invitation.expires_at ?? invitation.expiresAt,
    revokedAt: invitation.revoked_at ?? invitation.revokedAt ?? null,
    expiredAt: invitation.expired_at ?? invitation.expiredAt ?? null,
    claimedAt: invitation.claimed_at ?? invitation.claimedAt ?? null,
    claimedByUserId: invitation.claimed_by_user_id ?? invitation.claimedByUserId ?? null,
  };
  return { ...normalized, status: invitationStatus(normalized) };
}

export function invitationStatusLabel(status) {
  return {
    pending: "Pending",
    claimed: "Accepted",
    revoked: "Revoked",
    expired: "Expired",
  }[status] ?? "Unknown";
}

export function canAppend({ session, currentUser, connectionPhase, kind }) {
  if (!session || !currentUser) return { allowed: false, reason: "Choose a session first." };
  if (connectionPhase !== "live") {
    return { allowed: false, reason: "Sending pauses until shared history is fully synced." };
  }

  const membership = session.members.find((member) => member.userId === currentUser.id);
  if (!membership || membership.role === "viewer") {
    return { allowed: false, reason: "Your viewer role is read only." };
  }
  if (session.mode === "solo" && (session.ownerUserId === undefined
    ? membership.role !== "owner"
    : session.ownerUserId !== currentUser.id)) {
    return { allowed: false, reason: "Only the solo creator can write in this session." };
  }
  if (kind === "agent_request" && !isExecutionRuntime(membership.runtime)) {
    return { allowed: false, reason: "Connect your local runtime to request an agent." };
  }
  return { allowed: true, reason: "" };
}

export function invitationRolePolicy() {
  return {
    allowedRoles: ["participant", "viewer"],
    defaultRole: "participant",
    locked: false,
    help: "Participants edit multi sessions and read solo sessions. Viewers are read only everywhere.",
  };
}

export function createIdempotencyKey(prefix = "web") {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}:${random}`;
}

export function initials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

export function eventLabel(type) {
  return {
    human_chat: "Chat",
    agent_request: "Agent request",
    agent_progress: "Working",
    agent_response: "Agent response",
    tool_call: "Tool call",
    tool_result: "Tool result",
    attachment: "Attachment",
    context_snapshot: "Context snapshot",
    membership_change: "Membership",
    session_state_change: "Session update",
  }[type] ?? type.replaceAll("_", " ");
}

export function eventContent(event) {
  const content = event?.payload?.content;
  if (typeof content === "string") return content;
  const importedText = event?.payload?.text;
  return typeof importedText === "string" ? importedText : "";
}

export function pendingAgentRequests(events) {
  const answeredRequestIds = new Set(
    (events ?? [])
      .filter((event) => event?.type === "agent_response")
      .map((event) => event.replyTo ?? event.reply_to_event_id ?? event?.payload?.reply_to_event_id)
      .filter((eventId) => typeof eventId === "string" && eventId.length > 0),
  );
  return (events ?? []).filter((event) =>
    event?.type === "agent_request"
    && typeof event.id === "string"
    && !answeredRequestIds.has(event.id),
  );
}

export function isTimelineEventVisible(event) {
  const isControlEvent = event?.type === "membership_change" || event?.type === "session_state_change";
  const content = event?.payload?.content;
  return !isControlEvent || (typeof content === "string" && content.trim().length > 0);
}

export function sessionMetadataFromEvent(event) {
  const title = event?.payload?.title;
  if (
    event?.type !== "session_state_change"
    || !new Set(["renamed", "updated"]).has(event?.payload?.action)
    || typeof title !== "string"
    || title.trim().length === 0
    || title.length > 200
  ) return null;
  return {
    sessionId: event.sessionId ?? event.session_id,
    name: title,
  };
}

export function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function runtimeLabel(runtime) {
  if (!runtime) return "No runtime available";
  return [runtime.harness, runtime.provider, runtime.model].filter(Boolean).join(" · ");
}

export function provenanceSummary(provenance, formatReasoning = (effort) => effort) {
  if (!provenance) return "";
  const harness = /^codex$/iu.test(provenance.harness ?? "") ? "Codex" : provenance.harness;
  const reasoning = provenance.reasoningEffort ? formatReasoning(provenance.reasoningEffort) : "";
  return [provenance.username, harness, provenance.model, reasoning].filter(Boolean).join(" · ");
}

export function normalizeReplayPage(page) {
  const events = [...(page.events ?? [])].sort((a, b) => a.sequence - b.sequence);
  return {
    events,
    headSequence: Number(page.headSequence ?? page.head_sequence ?? 0),
    nextAfterSequence: Number(
      page.nextAfterSequence ?? page.next_after_sequence ?? page.cursor ?? events.at(-1)?.sequence ?? 0,
    ),
    hasMore: Boolean(page.hasMore ?? page.has_more),
  };
}
