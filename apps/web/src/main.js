import { HttpCollaborationApi, MockCollaborationApi } from "./api.js";
import {
  canAppend,
  createIdempotencyKey,
  eventLabel,
  formatTimestamp,
  initials,
  invitationStatusLabel,
  normalizeInvitation,
  runtimeLabel,
} from "./domain.js";
import { SessionSync } from "./realtime.js";

const query = new URLSearchParams(location.search);
const configuredApiUrl = query.get("api") ?? "";
const mockEnabled = query.get("mock") === "1";
const api = mockEnabled
  ? new MockCollaborationApi()
  : new HttpCollaborationApi({ baseUrl: configuredApiUrl });
const sync = new SessionSync(api);

elementAfterReady(
  "token-help",
  mockEnabled
    ? "Mock mode is enabled for this tab. Use demo-token."
    : `Connects to ${configuredApiUrl || "this owner host"}. The token is kept only in memory and is cleared on reload.`,
);

function elementAfterReady(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

const state = {
  currentUser: null,
  sessions: [],
  session: null,
  invitations: [],
  sync: sync.snapshot(),
};

let createdInvitationSecret = "";

const element = (id) => document.getElementById(id);
const authView = element("auth-view");
const workspace = element("workspace");
const loginForm = element("login-form");
const claimInvitationForm = element("claim-invitation-form");
const loginError = element("login-error");
const sessionList = element("session-list");
const sessionView = element("session-view");
const emptyState = element("empty-state");
const timeline = element("event-timeline");
const timelineRegion = element("timeline-region");
const timelineEmpty = element("timeline-empty");
const messageInput = element("message-input");
const sendChatButton = element("send-chat-button");
const sendAgentButton = element("send-agent-button");
const sendError = element("send-error");
const createDialog = element("create-session-dialog");
const createForm = element("create-session-form");
const memberPanel = element("member-panel");
const acceptInvitationForm = element("accept-invitation-form");
const createInvitationForm = element("create-invitation-form");
const invitationList = element("invitation-list");

clearSensitiveInputs();
window.addEventListener("pagehide", () => {
  api.clearCredential?.();
  clearCreatedInvitationSecret();
  clearSensitiveInputs();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  sync.disconnect();
  state.currentUser = null;
  state.sessions = [];
  state.session = null;
  state.invitations = [];
  workspace.hidden = true;
  authView.hidden = false;
  clearSensitiveInputs();
  element("token").focus();
});

sync.subscribe((snapshot) => {
  const previousCount = state.sync.events.length;
  state.sync = snapshot;
  renderSyncState();
  renderTimeline();
  renderComposerPermissions();
  if (snapshot.phase === "live" && snapshot.events.length > previousCount && previousCount > 0) {
    const latest = snapshot.events.at(-1);
    announce(`${eventLabel(latest.type)} from ${latest.actor.username}`);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const token = new FormData(loginForm).get("token")?.toString() ?? "";
  const submit = loginForm.querySelector("button[type='submit']");
  submit.disabled = true;
  submit.textContent = "Checking…";
  try {
    state.currentUser = await api.authenticate(token);
    loginForm.reset();
    await enterWorkspace();
  } catch (error) {
    loginError.textContent = error.message ?? "Unable to sign in.";
    element("token").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Continue →";
  }
});

claimInvitationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(claimInvitationForm);
  const errorNode = element("claim-invite-error");
  const submit = claimInvitationForm.querySelector("button[type='submit']");
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Joining…";
  try {
    const result = await api.claimInvitation({
      inviteToken: data.get("invite-secret")?.toString().trim() ?? "",
      displayName: data.get("display-name")?.toString().trim() ?? "",
      deviceName: data.get("device-name")?.toString().trim() ?? "",
    });
    state.currentUser = result.actor;
    claimInvitationForm.reset();
    element("claim-device-name").value = "This browser";
    await enterWorkspace(result.invitation.sessionId);
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to claim this invitation.";
    element("claim-invite-secret").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Join workspace";
  }
});

element("logout-button").addEventListener("click", () => {
  sync.disconnect();
  api.clearCredential?.();
  state.currentUser = null;
  state.sessions = [];
  state.session = null;
  state.invitations = [];
  clearCreatedInvitationSecret();
  workspace.hidden = true;
  authView.hidden = false;
  loginForm.reset();
  element("token").focus();
});

acceptInvitationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorNode = element("accept-invite-error");
  const submit = acceptInvitationForm.querySelector("button[type='submit']");
  const inviteSecret = new FormData(acceptInvitationForm).get("invite-secret")?.toString().trim() ?? "";
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Accepting…";
  try {
    const result = await api.acceptInvitation(inviteSecret);
    acceptInvitationForm.reset();
    state.sessions = await api.listSessions();
    renderSessionList();
    await selectSession(result.invitation.sessionId);
    announce("Invitation accepted. You joined the session.");
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to accept this invitation.";
    element("accept-invite-secret").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Accept invitation";
  }
});

createInvitationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.session) return;
  const data = new FormData(createInvitationForm);
  const errorNode = element("create-invitation-error");
  const submit = createInvitationForm.querySelector("button[type='submit']");
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Creating…";
  clearCreatedInvitationSecret();
  try {
    const result = await api.createInvitation(state.session.id, {
      role: data.get("role")?.toString() ?? "participant",
      ttl: data.get("ttl")?.toString() ?? "24h",
    });
    createdInvitationSecret = result.inviteToken;
    element("created-invite-secret").textContent = createdInvitationSecret;
    element("created-invitation").hidden = false;
    state.invitations = [result.invitation, ...state.invitations.filter((item) => item.id !== result.invitation.id)];
    renderInvitations();
    announce("Invitation created. Copy the secret now.");
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to create an invitation.";
  } finally {
    submit.disabled = false;
    submit.textContent = "Create invitation";
  }
});

element("refresh-invitations-button").addEventListener("click", () => loadInvitations());
element("copy-invite-secret-button").addEventListener("click", async () => {
  const status = element("copy-invite-status");
  if (!createdInvitationSecret) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(createdInvitationSecret);
    status.textContent = "Copied to clipboard.";
    announce("Invitation secret copied.");
  } catch {
    status.textContent = "Clipboard access is unavailable. Select and copy the secret manually.";
  }
});

element("new-session-button").addEventListener("click", openCreateDialog);
element("empty-create-button").addEventListener("click", openCreateDialog);
element("cancel-create-button").addEventListener("click", () => createDialog.close());
element("dialog-cancel-button").addEventListener("click", () => createDialog.close());

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorNode = element("create-error");
  const submit = createForm.querySelector("button[type='submit']");
  const data = new FormData(createForm);
  errorNode.textContent = "";
  submit.disabled = true;
  try {
    const created = await api.createSession({
      name: data.get("name")?.toString() ?? "",
      mode: data.get("mode")?.toString() ?? "multi",
      idempotencyKey: createIdempotencyKey("create-session"),
    });
    state.sessions = await api.listSessions();
    renderSessionList();
    createDialog.close();
    createForm.reset();
    await selectSession(created.id);
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to create the session.";
  } finally {
    submit.disabled = false;
  }
});

sendChatButton.addEventListener("click", () => sendMessage("human_chat"));
sendAgentButton.addEventListener("click", () => sendMessage("agent_request"));
element("retry-sync-button").addEventListener("click", () => sync.retry());

element("mobile-members-button").addEventListener("click", () => {
  memberPanel.classList.add("member-panel-open");
  element("mobile-members-button").setAttribute("aria-expanded", "true");
  element("close-members-button").focus();
});

element("close-members-button").addEventListener("click", closeMembersPanel);

function closeMembersPanel() {
  memberPanel.classList.remove("member-panel-open");
  element("mobile-members-button").setAttribute("aria-expanded", "false");
  element("mobile-members-button").focus();
}

async function enterWorkspace(preferredSessionId) {
  authView.hidden = true;
  workspace.hidden = false;
  element("current-username").textContent = state.currentUser.username;
  element("current-user-avatar").textContent = initials(state.currentUser.username);
  state.sessions = await api.listSessions();
  renderSessionList();
  if (state.sessions.length) {
    const requested = new URLSearchParams(location.hash.slice(1)).get("session");
    const initial = state.sessions.find((session) => session.id === preferredSessionId)
      ?? state.sessions.find((session) => session.id === requested)
      ?? state.sessions[0];
    await selectSession(initial.id);
  } else {
    sessionView.hidden = true;
    emptyState.hidden = false;
  }
}

async function selectSession(sessionId) {
  sendError.textContent = "";
  element("accept-invite-error").textContent = "";
  clearCreatedInvitationSecret();
  closeMembersPanelWithoutFocus();
  const [session, members] = await Promise.all([
    api.getSession(sessionId),
    api.listMembers(sessionId),
  ]);
  state.session = { ...session, members };
  location.hash = new URLSearchParams({ session: sessionId }).toString();
  emptyState.hidden = true;
  sessionView.hidden = false;
  renderSessionHeader();
  renderSessionList();
  renderMembers();
  await renderInvitationControls();
  renderComposerPermissions();
  element("session-title").focus({ preventScroll: true });
  await sync.connect(sessionId);
}

function renderSessionList() {
  sessionList.replaceChildren();
  for (const session of state.sessions) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const description = document.createElement("small");
    const badge = document.createElement("span");

    button.type = "button";
    button.className = "session-button";
    if (session.id === state.session?.id) {
      button.classList.add("session-button-active");
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => selectSession(session.id));
    title.textContent = session.name;
    description.textContent = `${session.memberCount} member${session.memberCount === 1 ? "" : "s"} · ${session.role}`;
    badge.className = `mode-badge mode-${session.mode}`;
    badge.textContent = session.mode;
    copy.append(title, description);
    button.append(copy, badge);
    item.append(button);
    sessionList.append(item);
  }
}

function renderSessionHeader() {
  const session = state.session;
  element("session-title").textContent = session.name;
  element("session-mode").textContent = session.mode;
  element("session-mode").className = `mode-badge mode-${session.mode}`;
  const membership = session.members.find((member) => member.userId === state.currentUser.id);
  element("session-subtitle").textContent = `${session.description} · You are ${membership?.role ?? "viewer"}`;
}

function renderMembers() {
  const list = element("member-list");
  list.replaceChildren();
  for (const member of state.session?.members ?? []) {
    const item = document.createElement("li");
    item.className = "member-row";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = initials(member.username);
    avatar.setAttribute("aria-hidden", "true");

    const details = document.createElement("span");
    details.className = "member-copy";
    const name = document.createElement("strong");
    name.textContent = member.username;
    const role = document.createElement("small");
    role.textContent = member.role;
    details.append(name, role);

    const presence = document.createElement("span");
    presence.className = `presence presence-${member.runtime?.status ?? "none"}`;
    presence.textContent = member.runtime?.status === "online" ? "Online" : member.runtime ? "Offline" : "No runtime";
    item.append(avatar, details, presence);

    if (member.runtime) {
      const runtime = document.createElement("p");
      runtime.className = "member-runtime";
      runtime.textContent = runtimeLabel(member.runtime);
      item.append(runtime);
    }
    list.append(item);
  }
}

async function renderInvitationControls() {
  const membership = state.session?.members.find((member) => member.userId === state.currentUser?.id);
  const ownerControls = element("owner-invitations");
  ownerControls.hidden = membership?.role !== "owner";
  state.invitations = [];
  invitationList.replaceChildren();
  element("invitation-list-status").textContent = "";
  if (membership?.role === "owner") await loadInvitations();
}

async function loadInvitations() {
  if (!state.session) return;
  const sessionId = state.session.id;
  const status = element("invitation-list-status");
  const refresh = element("refresh-invitations-button");
  status.textContent = "Loading invitations…";
  refresh.disabled = true;
  try {
    const invitations = await api.listInvitations(sessionId);
    if (state.session?.id !== sessionId) return;
    state.invitations = invitations.map(normalizeInvitation);
    renderInvitations();
  } catch (error) {
    status.textContent = error.message ?? "Unable to load invitations.";
  } finally {
    refresh.disabled = false;
  }
}

function renderInvitations() {
  invitationList.replaceChildren();
  const status = element("invitation-list-status");
  status.textContent = state.invitations.length ? "" : "No invitations have been created for this session.";
  for (const invitation of state.invitations) {
    const normalized = normalizeInvitation(invitation);
    const item = document.createElement("li");
    const heading = document.createElement("div");
    const role = document.createElement("strong");
    const badge = document.createElement("span");
    const expiry = document.createElement("p");
    item.className = "invitation-row";
    heading.className = "invitation-row-heading";
    role.textContent = normalized.role;
    badge.className = `invitation-status invitation-status-${normalized.status}`;
    badge.textContent = invitationStatusLabel(normalized.status);
    expiry.textContent = normalized.status === "pending"
      ? `Expires ${formatDateTime(normalized.expiresAt)}`
      : `Created ${formatDateTime(normalized.createdAt)}`;
    heading.append(role, badge);
    item.append(heading, expiry);
    if (normalized.status === "pending") {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "text-button";
      revoke.textContent = "Revoke";
      revoke.setAttribute("aria-label", `Revoke ${normalized.role} invitation expiring ${formatDateTime(normalized.expiresAt)}`);
      revoke.addEventListener("click", () => revokeInvitation(normalized, revoke));
      item.append(revoke);
    }
    invitationList.append(item);
  }
}

async function revokeInvitation(invitation, button) {
  if (!state.session) return;
  const sessionId = state.session.id;
  button.disabled = true;
  element("create-invitation-error").textContent = "";
  try {
    const revoked = await api.revokeInvitation(sessionId, invitation.id);
    if (state.session?.id !== sessionId) return;
    state.invitations = state.invitations.map((item) => item.id === revoked.id ? revoked : item);
    renderInvitations();
    announce("Invitation revoked.");
  } catch (error) {
    element("create-invitation-error").textContent = error.message ?? "Unable to revoke the invitation.";
    button.disabled = false;
  }
}

function clearCreatedInvitationSecret() {
  createdInvitationSecret = "";
  element("created-invite-secret").textContent = "";
  element("copy-invite-status").textContent = "";
  element("created-invitation").hidden = true;
}

function clearSensitiveInputs() {
  for (const id of ["token", "claim-invite-secret", "accept-invite-secret"]) {
    element(id).value = "";
  }
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderSyncState() {
  const { phase, cursor, detail, bufferedCount } = state.sync;
  const banner = element("sync-banner");
  const title = {
    idle: "Not connected",
    connecting: "Connecting",
    replaying: "Syncing history",
    live: "Live",
    recovering: "Recovering a gap",
    offline: "Offline",
    blocked: "History incomplete",
  }[phase];
  banner.dataset.state = phase;
  element("sync-title").textContent = title;
  element("sync-detail").textContent = bufferedCount
    ? `${detail} ${bufferedCount} later event${bufferedCount === 1 ? " is" : "s are"} buffered.`
    : detail;
  element("retry-sync-button").hidden = !new Set(["offline", "blocked"]).has(phase);
  timelineRegion.setAttribute("aria-busy", String(new Set(["connecting", "replaying", "recovering"]).has(phase)));
  element("sequence-label").textContent = `Contiguous through sequence #${cursor}`;
  element("global-connection").dataset.state = phase;
  element("global-connection-label").textContent = phase === "live" ? `Live · #${cursor}` : title;
}

function renderTimeline() {
  timeline.replaceChildren();
  const events = state.sync.events;
  timelineEmpty.hidden = events.length > 0;

  for (const event of events) {
    const item = document.createElement("li");
    const article = document.createElement("article");
    const header = document.createElement("header");
    const identity = document.createElement("div");
    const avatar = document.createElement("span");
    const meta = document.createElement("div");
    const actor = document.createElement("strong");
    const type = document.createElement("span");
    const sequence = document.createElement("span");
    const time = document.createElement("time");
    const body = document.createElement("p");

    article.className = `event-card event-${event.type}`;
    article.setAttribute("aria-labelledby", `event-${event.id}-actor`);
    avatar.className = "avatar";
    avatar.textContent = event.type.includes("agent") ? "✦" : initials(event.actor.username);
    avatar.setAttribute("aria-hidden", "true");
    actor.id = `event-${event.id}-actor`;
    actor.textContent = event.actor.username;
    type.className = "event-type";
    type.textContent = eventLabel(event.type);
    sequence.className = "event-sequence";
    sequence.textContent = `#${event.sequence}`;
    time.dateTime = event.createdAt;
    time.textContent = formatTimestamp(event.createdAt);
    meta.append(actor, type);
    identity.className = "event-identity";
    identity.append(avatar, meta);
    header.append(identity, sequence, time);
    body.textContent = event.payload?.content ?? "No visible content";
    article.append(header, body);

    if (event.provenance) {
      const provenance = document.createElement("footer");
      provenance.className = "provenance";
      for (const value of [
        event.provenance.username,
        event.provenance.harness,
        event.provenance.provider,
        event.provenance.model,
        event.provenance.fidelity?.replaceAll("_", " "),
      ].filter(Boolean)) {
        const tag = document.createElement("span");
        tag.textContent = value;
        provenance.append(tag);
      }
      article.append(provenance);
    }

    item.append(article);
    timeline.append(item);
  }

  if (events.length && timelineRegion.scrollHeight - timelineRegion.scrollTop - timelineRegion.clientHeight < 180) {
    requestAnimationFrame(() => timelineRegion.scrollTo({ top: timelineRegion.scrollHeight, behavior: "smooth" }));
  }
}

function renderComposerPermissions() {
  const common = { session: state.session, currentUser: state.currentUser, connectionPhase: state.sync.phase };
  const chat = canAppend({ ...common, kind: "human_chat" });
  const agent = canAppend({ ...common, kind: "agent_request" });
  const membership = state.session?.members.find((member) => member.userId === state.currentUser?.id);
  sendChatButton.disabled = !chat.allowed;
  sendAgentButton.disabled = !agent.allowed;
  messageInput.disabled = !chat.allowed && !agent.allowed;
  element("composer-permission").textContent = chat.allowed ? "" : chat.reason;
  element("agent-target-label").textContent = agent.allowed
    ? runtimeLabel(membership.runtime)
    : agent.reason;
}

async function sendMessage(kind) {
  const content = messageInput.value.trim();
  if (!content || !state.session) {
    sendError.textContent = content ? "Choose a session first." : "Write a message first.";
    messageInput.focus();
    return;
  }
  sendError.textContent = "";
  const button = kind === "human_chat" ? sendChatButton : sendAgentButton;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const input = { content, idempotencyKey: createIdempotencyKey(kind) };
    if (kind === "human_chat") await api.appendHumanChat(state.session.id, input);
    else await api.appendAgentRequest(state.session.id, input);
    messageInput.value = "";
    messageInput.focus();
  } catch (error) {
    sendError.textContent = error.message ?? "The event was not accepted.";
  } finally {
    button.textContent = original;
    renderComposerPermissions();
  }
}

function openCreateDialog() {
  element("create-error").textContent = "";
  createDialog.showModal();
  requestAnimationFrame(() => element("session-name").focus());
}

function announce(message) {
  element("announcement").textContent = "";
  requestAnimationFrame(() => {
    element("announcement").textContent = message;
  });
}

function closeMembersPanelWithoutFocus() {
  memberPanel.classList.remove("member-panel-open");
  element("mobile-members-button").setAttribute("aria-expanded", "false");
}
