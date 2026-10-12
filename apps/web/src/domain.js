export const SESSION_MODES = Object.freeze(["solo", "multi"]);
export const MEMBER_ROLES = Object.freeze(["owner", "participant", "viewer"]);
export const INVITATION_ROLES = Object.freeze(["participant", "viewer"]);
export const INVITATION_TTLS = Object.freeze(["1h", "24h", "7d"]);
export const SNAPSHOT_STATUSES = Object.freeze(["queued", "claimed", "importing", "compacting", "completed", "failed"]);
export const CONNECTOR_STATUSES = Object.freeze(["synced", "offline", "reconciling", "rebuilding", "local_fork"]);
// A placeholder for this server's downloaded TGZ, not an older npm release.
export const CODEX_CONNECT_PACKAGE_SPEC = "/absolute/path/to/LOCAL_CODEX_CONNECTOR.tgz";
export const CODEX_LAUNCHER_ORIGIN = "https://gatherthread.cn";
export const CODEX_LAUNCHER_LINK_VERSION = "1";
export const CODEX_LAUNCHER_ORIGINS = Object.freeze([CODEX_LAUNCHER_ORIGIN, "https://test.gatherthread.cn"]);

export function normalizeLauncherEmail(value) {
  if (typeof value !== "string" || value.length > 254) throw new Error("Check your account email.");
  const email = value.trim().toLowerCase();
  const valid = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(email);
  if (!valid || email.split("@")[0].length > 64 || email.split("@")[1].split(".").some(part => part.length > 63)) {
    throw new Error("Check your account email.");
  }
  return email;
}

export function canOpenCodexLauncher({ origin, platform, maxTouchPoints = 0 }) {
  if (!CODEX_LAUNCHER_ORIGINS.includes(origin) || typeof platform !== "string") return false;
  if (/^(?:windows|win32|win64)$/i.test(platform)) return true;
  return /^(?:macos|macintel|macintosh|macppc|mac68k)$/i.test(platform) && maxTouchPoints <= 1;
}

export function emptyProjectState(canCreateProjects) {
  return canCreateProjects
    ? {
      title: "Create your first project.",
      description: "Create a project to organize your sessions and invite collaborators.",
      canCreateProjects: true,
    }
    : {
      title: "No invited projects are available. Ask a project owner for an invitation.",
      description: "Once invited, your projects will appear here. A project invitation does not let you create projects.",
      canCreateProjects: false,
    };
}

const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_VISIBLE_HISTORY_SYNC = "first-connect";

export function projectCodexConnectionCommands({
  baseUrl,
  projectId,
  model = DEFAULT_CODEX_MODEL,
  contextWindowTokens = DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS,
  visibleHistorySync = DEFAULT_VISIBLE_HISTORY_SYNC,
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
  if (!["first-connect", "never"].includes(visibleHistorySync)) {
    throw new Error("The Codex visible history sync mode is not safe for a connector command.");
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
      "npx", "--yes", "--package", posixQuote(CODEX_CONNECT_PACKAGE_SPEC), "gatherthread-codex-connect",
      "--url", posixQuote(normalizedBaseUrl),
      "--project", posixQuote(projectId),
      "--create-workspace",
      "--plugin-hooks",
      "--visible-history-sync", visibleHistorySync,
      ...optionalArguments(posixQuote),
    ].join(" "),
    powershell: [
      "npx.cmd", "--yes", "--package", powerShellQuote("C:/path/to/LOCAL_CODEX_CONNECTOR.tgz"), "gatherthread-codex-connect",
      "--url", powerShellQuote(normalizedBaseUrl),
      "--project", powerShellQuote(projectId),
      "--create-workspace",
      "--plugin-hooks",
      "--visible-history-sync", visibleHistorySync,
      ...optionalArguments(powerShellQuote),
    ].join(" "),
  });
}

export function projectCodexLauncherUrl({
  baseUrl,
  projectId,
  model = DEFAULT_CODEX_MODEL,
  contextWindowTokens = DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS,
  visibleHistorySync = DEFAULT_VISIBLE_HISTORY_SYNC,
  email,
  authorizationId,
}) {
  // Reuse the connector command's origin and ID validation before crossing into
  // an OS protocol handler. Never put an auth token or browser cookie here.
  projectCodexConnectionCommands({ baseUrl, projectId, model, contextWindowTokens, visibleHistorySync });
  const accountLink = email !== undefined || authorizationId !== undefined;
  if (!CODEX_LAUNCHER_ORIGINS.includes(baseUrl) || !accountLink && baseUrl !== CODEX_LAUNCHER_ORIGIN) {
    throw new Error("The Launcher supports the official production and test sites only.");
  }
  if (accountLink && (typeof authorizationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(authorizationId))) {
    throw new Error("Open a new Launcher connection from the website.");
  }
  const parameters = new URLSearchParams({
    v: accountLink ? "2" : CODEX_LAUNCHER_LINK_VERSION,
    origin: baseUrl.replace(/\/$/, ""),
    project: projectId,
    model,
    context_window_tokens: String(contextWindowTokens),
    visible_history_sync: visibleHistorySync,
  });
  if (accountLink) {
    parameters.set("email", normalizeLauncherEmail(email));
    parameters.set("authorization_id", authorizationId.toLowerCase());
  }
  const link = `gatherthread-connect://connect?${parameters.toString()}`;
  if (new TextEncoder().encode(link).byteLength > 2048) throw new Error("Launcher connection is too long.");
  return link;
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

export function agentContextUpdateReason(runtime, contentRevision) {
  return runtime && contentRevision > 0 && runtime.contextDeletionVersion !== 1
    ? "Update and reconnect your Agent connector before continuing." : "";
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
  const kind = ["immutable", "visible_history_replace", "local_sync_status", "local_auto_upload_enable",
    "local_auto_upload_disable", "local_turn_upload", "code_sync_status", "code_upload", "code_download",
    "code_recover", "code_auto_upload_enable", "code_auto_upload_disable",
    "github_auth_connect", "github_code_sync_status", "github_code_upload", "github_code_download", "github_code_recover",
    "github_code_auto_upload_enable", "github_code_auto_upload_disable", "github_code_update"].includes(request.kind)
    ? request.kind
    : "immutable";
  return {
    id: request.id,
    sessionId: request.session_id ?? request.sessionId ?? null,
    kind,
    targetRuntimeId: request.target_runtime_id ?? request.targetRuntimeId ?? null,
    throughSequence: Number(request.through_sequence ?? request.throughSequence ?? 0),
    status,
    createdAt: request.created_at ?? request.createdAt ?? new Date().toISOString(),
    localTaskName,
    result,
    failureCode: typeof failure === "object" && failure !== null ? failure.code ?? "" : "",
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
  if (event?.deleted || event?.contentUnavailable) return "";
  const content = event?.payload?.content;
  if (typeof content === "string") return content;
  const importedText = event?.payload?.text;
  return typeof importedText === "string" ? importedText : "";
}

/**
 * Collapse a request's progress into the entries a reader actually sees.
 *
 * Snapshots replace earlier revisions of the same request and stream, including
 * when another stream appears between updates. Legacy fragments concatenate.
 * The first event keeps the visual anchor; actions retain a canonical event.
 * A legacy aggregate has a separate copy body and cannot be quoted as one event.
 */
export function mergeProgressFragments(progressEvents) {
  const entries = [];
  const streams = new Map();
  const seen = new Set();
  for (const [index, event] of (progressEvents ?? []).entries()) {
    if (event?.id && seen.has(event.id)) continue;
    if (event?.id) seen.add(event.id);
    const payload = event?.payload ?? {};
    const streamId = payload.stream_id;
    const snapshot = payload.stream_mode === "snapshot" && Number.isSafeInteger(payload.stream_revision) && payload.stream_revision >= 0;
    const streaming = payload.phase === "stream" && typeof streamId === "string" && streamId.length > 0
      && (snapshot || payload.stream_mode === undefined);
    const key = streaming ? JSON.stringify([event.replyTo ?? event.reply_to_event_id ?? null, snapshot ? "snapshot" : "fragments", streamId]) : event?.id;
    const previous = streaming ? streams.get(key) : undefined;
    if (previous) {
      previous.sourceIds.push(event.id);
      if (snapshot) {
        if (payload.stream_revision < previous.streamRevision
          || (payload.stream_revision === previous.streamRevision && (event.sequence ?? 0) <= (previous.event.sequence ?? 0))) continue;
        previous.content = eventContent(event);
        previous.event = event;
        previous.streamRevision = payload.stream_revision;
        previous.streamState = payload.stream_state;
        previous.streamKind = payload.stream_kind;
        previous.title = payload.title;
        previous.plan = Array.isArray(payload.plan) ? payload.plan : [];
      } else {
        previous.content += eventContent(event);
        previous.copyEvent = { ...previous.event, payload: { ...previous.event.payload, content: previous.content } };
        previous.quoteable = false;
      }
      previous.updatedIndex = index;
      continue;
    }
    const content = eventContent(event);
    const entry = {
      id: event?.id,
      key,
      createdAt: event?.createdAt,
      streamId: streaming ? streamId : undefined,
      streamKind: streaming ? payload.stream_kind ?? "answer" : undefined,
      streamRevision: snapshot ? payload.stream_revision : undefined,
      streamState: snapshot ? payload.stream_state : undefined,
      title: payload.title,
      plan: Array.isArray(payload.plan) ? payload.plan : [],
      content,
      event,
      quoteable: true,
      sourceIds: [event?.id],
      updatedIndex: index,
    };
    entries.push(entry);
    if (streaming) streams.set(key, entry);
  }
  return entries;
}

/**
 * A failed execution may leave only its last running snapshot. Settle that
 * unfinished section from its canonical response, not from the folded worklog.
 * Earlier completed tools and explicit failures keep their own terminal state.
 */
export function progressStreamState(entry, { live = false, paused = false, terminalResponse } = {}) {
  if (entry?.streamState === "completed" || entry?.streamState === "failed") return entry.streamState;
  if (paused) return "paused";
  const requestId = responseTargetId(entry?.event);
  const linkedResponse = terminalResponse?.type === "agent_response"
    && typeof requestId === "string" && requestId.length > 0
    && responseTargetId(terminalResponse) === requestId;
  if (linkedResponse && ["failed", "cancelled", "canceled"].includes(terminalResponse.payload?.status)) return "failed";
  return live ? "running" : "completed";
}

/**
 * The newest public text a request has streamed, for the compact line a reader
 * sees without opening the work log. This is the tail, not the head: while a
 * message is being written, its newest words are the informative part.
 * Tool details, plans, and exposed thinking have their own sections.
 */
export function latestStreamedText(progressEvents, limit = 140) {
  const streamed = mergeProgressFragments(progressEvents)
    .filter((entry) => entry.streamId !== undefined && entry.streamKind === "answer")
    .sort((left, right) => right.updatedIndex - left.updatedIndex)[0];
  if (!streamed) return "";
  const text = streamed.content.replace(/\s+/gu, " ").trim();
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/**
 * Conversation bubble role for timeline presentation: the signed-in author's
 * messages read as "self", everyone else's human messages keep the default
 * card, and agent-produced output reads as "agent". Non-conversation control
 * events stay "default" and are styled exactly as before.
 *
 * `agent_progress` is classified as "agent" for completeness, but the timeline
 * skips those events before it builds a card — they render as the worklog
 * disclosure under their request — so no progress update carries a tint today.
 */
export function eventBubbleRole(event, currentUserId) {
  const type = event?.type ?? "";
  if (type === "agent_response" || type === "agent_progress") return "agent";
  if (type === "human_chat" || type === "agent_request") {
    const actorId = event?.actor?.id;
    return typeof actorId === "string" && actorId === currentUserId ? "self" : "peer";
  }
  return "default";
}

function responseTargetId(event) {
  return event?.replyTo ?? event?.reply_to_event_id ?? event?.payload?.reply_to_event_id;
}

/**
 * The request a lifecycle marker belongs to, when the marker ends that request's
 * life. A pause is terminal for its request — the author stopped it, and asking
 * again is a new request — so a paused agent must not keep displaying as queued.
 */
function isTerminalAgentMarker(event) {
  return event?.type === "agent_progress" && event?.payload?.status === "paused";
}

export function pendingAgentRequests(events) {
  const settledRequestIds = new Set(
    (events ?? [])
      .filter((event) => event?.type === "agent_response" || isTerminalAgentMarker(event))
      .map(responseTargetId)
      .filter((eventId) => typeof eventId === "string" && eventId.length > 0),
  );
  return (events ?? []).filter((event) =>
    event?.type === "agent_request"
    && !event.deleted && !event.contentUnavailable
    && typeof event.id === "string"
    && !settledRequestIds.has(event.id),
  );
}

/**
 * An `agent_response` that reports a failed execution rather than an answer. The
 * server raises one when it gives up on a request no runtime could finish, and a
 * harness raises one when its own execution terminates. Both belong in the
 * timeline as a failure, not as an ordinary reply that happens to read oddly.
 */
export function isFailedAgentResponse(event) {
  return event?.type === "agent_response" && event?.payload?.status === "failed";
}

/** The original request a response points at, when it is still in the timeline. */
export function failedRequestFor(events, responseEvent) {
  const requestId = responseEvent?.replyTo
    ?? responseEvent?.reply_to_event_id
    ?? responseEvent?.payload?.reply_to_event_id;
  if (typeof requestId !== "string" || requestId.length === 0) return undefined;
  return (events ?? []).find((event) => event?.type === "agent_request" && event.id === requestId);
}

/** A retry is a new request by the original author, never an impersonation. */
export function canRetryFailedAgentRequest(request, currentUser) {
  return !request?.deleted && !request?.contentUnavailable && typeof request?.actor?.id === "string"
    && typeof currentUser?.id === "string"
    && request.actor.id === currentUser.id;
}

/**
 * The append input that re-runs a failed request against the exact target it
 * originally named. Replaying the recorded profile keeps runtime selection exact
 * and fail-closed: a retry can never quietly land on a different harness,
 * device, provider, or model than the user chose.
 */
export function retryAgentRequestInput(request, idempotencyKey) {
  if (request?.deleted || request?.contentUnavailable) throw new Error("This message was deleted or its history is being refreshed.");
  const content = eventContent(request);
  const profile = request?.payload?.execution_profile;
  if (profile === null || typeof profile !== "object") return { content, idempotencyKey };
  return {
    content,
    idempotencyKey,
    executionProfile: {
      harness: profile.harness,
      ...(profile.provider === undefined ? {} : { provider: profile.provider }),
      model: profile.model,
      ...(profile.reasoning_effort === undefined ? {} : { reasoningEffort: profile.reasoning_effort }),
      ...(profile.runtime_id === undefined ? {} : { runtimeId: profile.runtime_id }),
    },
  };
}

export function isTimelineEventVisible(event) {
  if (event?.type === "message_deleted") return false;
  const isControlEvent = event?.type === "membership_change" || event?.type === "session_state_change";
  const content = event?.payload?.content;
  return !isControlEvent || (typeof content === "string" && content.trim().length > 0);
}

export function sessionMetadataFromEvent(event) {
  const title = event?.payload?.title;
  const mode = event?.payload?.mode;
  if (
    event?.type !== "session_state_change"
    || !new Set(["renamed", "updated"]).has(event?.payload?.action)
  ) return null;
  if (title !== undefined && (typeof title !== "string" || title.trim().length === 0 || title.length > 200)) return null;
  if (mode !== undefined && !new Set(["solo", "multi"]).has(mode)) return null;
  if (title === undefined && mode === undefined) return null;
  return {
    sessionId: event.sessionId ?? event.session_id,
    ...(title === undefined ? {} : { name: title }),
    ...(mode === undefined ? {} : { mode }),
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
  const contentRevision = page.contentRevision ?? page.content_revision ?? 0;
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 0) throw new Error("History revision is invalid.");
  return {
    events,
    headSequence: Number(page.headSequence ?? page.head_sequence ?? 0),
    nextAfterSequence: Number(
      page.nextAfterSequence ?? page.next_after_sequence ?? page.cursor ?? events.at(-1)?.sequence ?? 0,
    ),
    hasMore: Boolean(page.hasMore ?? page.has_more),
    contentRevision,
  };
}
