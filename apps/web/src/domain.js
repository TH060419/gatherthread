export const SESSION_MODES = Object.freeze(["solo", "multi"]);
export const MEMBER_ROLES = Object.freeze(["owner", "participant", "viewer"]);

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
      page.nextAfterSequence ?? page.next_after_sequence ?? events.at(-1)?.sequence ?? 0,
    ),
    hasMore: Boolean(page.hasMore ?? page.has_more),
  };
}
