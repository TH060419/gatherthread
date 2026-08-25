export const SESSION_MODES = Object.freeze(["solo", "multi"]);
export const MEMBER_ROLES = Object.freeze(["owner", "participant", "viewer"]);
export const INVITATION_ROLES = Object.freeze(["participant", "viewer"]);
export const INVITATION_TTLS = Object.freeze(["1h", "24h", "7d"]);

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
  if (session.mode === "solo" && membership.role !== "owner") {
    return { allowed: false, reason: "Only the owner can write in a solo session." };
  }
  if (kind === "agent_request" && membership.runtime?.status !== "online") {
    return { allowed: false, reason: "Connect your local runtime to request an agent." };
  }
  return { allowed: true, reason: "" };
}

export function invitationRolePolicy(sessionMode) {
  if (sessionMode === "solo") {
    return {
      allowedRoles: ["viewer"],
      defaultRole: "viewer",
      locked: true,
      help: "Solo sessions allow read-only viewer invitations only.",
    };
  }
  return {
    allowedRoles: ["participant", "viewer"],
    defaultRole: "participant",
    locked: false,
    help: "Multi sessions can invite participants or read-only viewers.",
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
    agent_response: "Agent response",
    tool_call: "Tool call",
    tool_result: "Tool result",
    attachment: "Attachment",
    context_snapshot: "Context snapshot",
    membership_change: "Membership",
    session_state_change: "Session update",
  }[type] ?? type.replaceAll("_", " ");
}

export function isTimelineEventVisible(event) {
  const isControlEvent = event?.type === "membership_change" || event?.type === "session_state_change";
  const content = event?.payload?.content;
  return !isControlEvent || (typeof content === "string" && content.trim().length > 0);
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
