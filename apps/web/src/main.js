import { HttpCollaborationApi, MockCollaborationApi } from "./api.js";
import {
  canAppend,
  createIdempotencyKey,
  createSelectionGuard,
  eventContent,
  eventLabel,
  formatTimestamp,
  initials,
  hasOnlineSnapshotConnector,
  isExecutionRuntime,
  isTimelineEventVisible,
  normalizeConnectorState,
  pendingAgentRequests,
  projectCodexConnectionCommands,
  invitationStatusLabel,
  invitationRolePolicy,
  normalizeInvitation,
  runtimeLabel,
  sessionMetadataFromEvent,
  sessionDeliveryMode,
  snapshotStatusView,
} from "./domain.js?v=20260825-6";
import { SessionSync } from "./realtime.js";

const query = new URLSearchParams(location.search);
const configuredApiUrl = query.get("api") ?? "";
const mockEnabled = query.get("mock") === "1";
const api = mockEnabled
  ? new MockCollaborationApi()
  : new HttpCollaborationApi({ baseUrl: configuredApiUrl });
const sync = new SessionSync(api);
const projectSelectionGuard = createSelectionGuard();

elementAfterReady(
  "token-help",
  mockEnabled
    ? "Mock mode is enabled for this tab. Use demo-token."
    : `Connects to ${configuredApiUrl || "this owner host"}. The token is exchanged for a secure browser session and is never stored by the page.`,
);

function elementAfterReady(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

const state = {
  currentUser: null,
  projects: [],
  project: null,
  projectMembers: [],
  sessions: [],
  session: null,
  invitations: [],
  snapshotRequests: [],
  sync: sync.snapshot(),
};

let createdInvitationSecret = "";
let newDeviceAccessToken = "";
let authenticationGeneration = 0;
let memberRefreshTimer;
let memberRefreshInFlight = false;
let snapshotPollTimer;
let snapshotPollGeneration = 0;
let selectedSessionGeneration = 0;

const element = (id) => document.getElementById(id);
const authView = element("auth-view");
const workspace = element("workspace");
const loginForm = element("login-form");
const claimInvitationForm = element("claim-invitation-form");
const loginError = element("login-error");
const sessionList = element("session-list");
const projectSelect = element("project-select");
const sessionView = element("session-view");
const emptyState = element("empty-state");
const timeline = element("event-timeline");
const timelineRegion = element("timeline-region");
const timelineEmpty = element("timeline-empty");
const messageInput = element("message-input");
const sendChatButton = element("send-chat-button");
const sendAgentButton = element("send-agent-button");
const sendError = element("send-error");
const composer = element("composer");
const downloadCodexButton = element("download-codex-button");
const snapshotRequestList = element("snapshot-request-list");
const createDialog = element("create-session-dialog");
const createForm = element("create-session-form");
const createProjectDialog = element("create-project-dialog");
const createProjectForm = element("create-project-form");
const renameSessionDialog = element("rename-session-dialog");
const renameSessionForm = element("rename-session-form");
const connectCodexDialog = element("connect-codex-dialog");
const connectCodexButton = element("connect-codex-button");
const memberPanel = element("member-panel");
const acceptInvitationForm = element("accept-invitation-form");
const createInvitationForm = element("create-invitation-form");
const invitationList = element("invitation-list");
const deviceCredentialDialog = element("device-credential-dialog");
let connectCodexReturnFocus = null;
let renameSessionReturnFocus = null;

clearSensitiveInputs();
window.addEventListener("pagehide", () => {
  authenticationGeneration += 1;
  projectSelectionGuard.invalidate();
  selectedSessionGeneration += 1;
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  api.clearCredential?.();
  clearCreatedInvitationSecret();
  clearNewDeviceAccessToken();
  clearSensitiveInputs();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  resetWorkspaceToAuth();
  void restoreBrowserSession();
});

void restoreBrowserSession();

sync.subscribe((snapshot) => {
  const previousCount = state.sync.events.length;
  applySessionMetadataEvents(snapshot.events.slice(previousCount));
  state.sync = snapshot;
  renderSyncState();
  renderTimeline();
  renderComposerPermissions();
  renderSessionDeliveryControls();
  if (snapshot.phase === "live" && snapshot.events.length > previousCount && previousCount > 0) {
    const latest = snapshot.events.at(-1);
    announce(`${eventLabel(latest.type)} from ${latest.actor.username}`);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const generation = ++authenticationGeneration;
  loginError.textContent = "";
  const token = new FormData(loginForm).get("token")?.toString() ?? "";
  const submit = loginForm.querySelector("button[type='submit']");
  submit.disabled = true;
  submit.textContent = "Checking…";
  try {
    const actor = await api.authenticate(token);
    if (generation !== authenticationGeneration) return;
    state.currentUser = actor;
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
  const generation = ++authenticationGeneration;
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
    if (generation !== authenticationGeneration) return;
    state.currentUser = result.actor;
    showNewDeviceAccessToken(result.accessToken);
    claimInvitationForm.reset();
    element("claim-device-name").value = "This browser";
    await enterWorkspace(result.invitation.projectId);
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to claim this invitation.";
    element("claim-invite-secret").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Join workspace";
  }
});

element("logout-button").addEventListener("click", async () => {
  authenticationGeneration += 1;
  const button = element("logout-button");
  button.disabled = true;
  try {
    await api.logout?.();
  } catch {
    loginError.textContent = "The server could not confirm logout. If it is offline, close this browser tab to end the local session.";
  } finally {
    resetWorkspaceToAuth();
    button.disabled = false;
    element("token").focus();
  }
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
    state.projects = await api.listProjects();
    await selectProject(result.invitation.projectId);
    announce("Invitation accepted. You joined the project.");
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
  if (!state.project) return;
  const data = new FormData(createInvitationForm);
  const rolePolicy = invitationRolePolicy();
  const requestedRole = data.get("role")?.toString() ?? "";
  const errorNode = element("create-invitation-error");
  const submit = createInvitationForm.querySelector("button[type='submit']");
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Creating…";
  clearCreatedInvitationSecret();
  try {
    const result = await api.createInvitation(state.project.id, {
      role: rolePolicy.allowedRoles.includes(requestedRole) ? requestedRole : rolePolicy.defaultRole,
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

element("copy-device-access-token-button").addEventListener("click", async () => {
  const status = element("copy-device-access-token-status");
  if (!newDeviceAccessToken) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(newDeviceAccessToken);
    status.textContent = "Copied to clipboard.";
  } catch {
    status.textContent = "Clipboard access is unavailable. Select and copy the token manually.";
  }
});
element("acknowledge-device-access-token-button").addEventListener("click", () => {
  clearNewDeviceAccessToken();
});
deviceCredentialDialog.addEventListener("cancel", (event) => event.preventDefault());

element("new-session-button").addEventListener("click", openCreateDialog);
element("empty-create-button").addEventListener("click", () => {
  if (state.project) openCreateDialog();
  else openCreateProjectDialog();
});
element("cancel-create-button").addEventListener("click", () => createDialog.close());
element("dialog-cancel-button").addEventListener("click", () => createDialog.close());
element("new-project-button").addEventListener("click", openCreateProjectDialog);
element("cancel-create-project-button").addEventListener("click", () => createProjectDialog.close());
element("dialog-cancel-project-button").addEventListener("click", () => createProjectDialog.close());
element("rename-session-button").addEventListener("click", openRenameSessionDialog);
element("cancel-rename-session-button").addEventListener("click", () => renameSessionDialog.close());
element("dialog-cancel-rename-session-button").addEventListener("click", () => renameSessionDialog.close());
renameSessionDialog.addEventListener("close", () => {
  const returnFocus = renameSessionReturnFocus;
  renameSessionReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
});
connectCodexButton.addEventListener("click", openConnectCodexDialog);
element("close-connect-codex-button").addEventListener("click", () => connectCodexDialog.close());
element("done-connect-codex-button").addEventListener("click", () => connectCodexDialog.close());
connectCodexDialog.addEventListener("close", () => {
  const returnFocus = connectCodexReturnFocus;
  connectCodexReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
});
for (const button of connectCodexDialog.querySelectorAll("button[data-copy-command]")) {
  button.addEventListener("click", () => void copyCodexCommand(button.dataset.copyCommand));
}
projectSelect.addEventListener("change", () => void selectProject(projectSelect.value));

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorNode = element("create-error");
  const submit = createForm.querySelector("button[type='submit']");
  const data = new FormData(createForm);
  errorNode.textContent = "";
  submit.disabled = true;
  try {
    if (!state.project) throw new Error("Create a project first.");
    const created = await api.createSession(state.project.id, {
      name: data.get("name")?.toString() ?? "",
      mode: data.get("mode")?.toString() ?? "multi",
      idempotencyKey: createIdempotencyKey("create-session"),
    });
    state.sessions = await api.listProjectSessions(state.project.id);
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

createProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorNode = element("create-project-error");
  const submit = createProjectForm.querySelector("button[type='submit']");
  const data = new FormData(createProjectForm);
  errorNode.textContent = "";
  submit.disabled = true;
  try {
    const created = await api.createProject({
      name: data.get("name")?.toString() ?? "",
      idempotencyKey: createIdempotencyKey("create-project"),
    });
    state.projects = await api.listProjects();
    createProjectDialog.close();
    createProjectForm.reset();
    await selectProject(created.id);
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to create the project.";
  } finally {
    submit.disabled = false;
  }
});

renameSessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const sessionId = state.session?.id;
  if (!sessionId) return;
  const errorNode = element("rename-session-error");
  const submit = renameSessionForm.querySelector("button[type='submit']");
  const name = new FormData(renameSessionForm).get("name")?.toString() ?? "";
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Saving…";
  try {
    const renamed = await api.renameSession(sessionId, {
      name,
      idempotencyKey: createIdempotencyKey("rename-session"),
    });
    if (state.session?.id !== sessionId) return;
    updateSessionName(sessionId, renamed.name);
    renameSessionDialog.close();
    announce(`Session renamed to ${renamed.name}.`);
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to rename the session.";
    element("rename-session-name").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Save name";
  }
});

sendChatButton.addEventListener("click", () => sendMessage("human_chat"));
sendAgentButton.addEventListener("click", () => sendMessage("agent_request"));
downloadCodexButton.addEventListener("click", () => void createSnapshotDownload());
snapshotRequestList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='retry-snapshot']");
  if (button) void createSnapshotDownload();
});
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

async function restoreBrowserSession() {
  if (mockEnabled) return;
  const generation = ++authenticationGeneration;
  try {
    const actor = await api.restoreSession();
    if (generation !== authenticationGeneration || !actor) return;
    state.currentUser = actor;
    await enterWorkspace();
  } catch (error) {
    if (generation !== authenticationGeneration) return;
    resetWorkspaceToAuth();
    loginError.textContent = error.message ?? "Unable to restore this browser session.";
  }
}

function resetWorkspaceToAuth() {
  if (connectCodexDialog.open) connectCodexDialog.close();
  if (renameSessionDialog.open) renameSessionDialog.close();
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  selectedSessionGeneration += 1;
  projectSelectionGuard.invalidate();
  api.clearCredential?.();
  state.currentUser = null;
  state.projects = [];
  state.project = null;
  state.projectMembers = [];
  state.sessions = [];
  state.session = null;
  state.invitations = [];
  state.snapshotRequests = [];
  clearCreatedInvitationSecret();
  clearNewDeviceAccessToken();
  clearSensitiveInputs();
  workspace.hidden = true;
  authView.hidden = false;
  loginForm.reset();
}

async function enterWorkspace(preferredProjectId) {
  authView.hidden = true;
  workspace.hidden = false;
  element("current-username").textContent = state.currentUser.username;
  element("current-user-avatar").textContent = initials(state.currentUser.username);
  state.projects = await api.listProjects();
  renderProjectSelect();
  if (state.projects.length) {
    const requested = new URLSearchParams(location.hash.slice(1)).get("project");
    const initial = state.projects.find((project) => project.id === preferredProjectId)
      ?? state.projects.find((project) => project.id === requested)
      ?? state.projects[0];
    await selectProject(initial.id);
  } else {
    state.sessions = [];
    state.project = null;
    renderSessionList();
    sessionView.hidden = true;
    emptyState.hidden = false;
    element("empty-state-title").textContent = "Create your first project.";
    element("empty-create-button").textContent = "Create project";
    element("new-session-button").hidden = true;
    element("owner-invitations").hidden = true;
  }
}

async function selectProject(projectId) {
  const selection = projectSelectionGuard.begin(projectId);
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  selectedSessionGeneration += 1;
  state.session = null;
  clearCreatedInvitationSecret();
  const project = await api.getProject(projectId);
  if (!projectSelectionGuard.isCurrent(selection)) return;
  state.project = project;
  state.projects = state.projects.map((item) => item.id === project.id ? { ...item, ...project } : item);
  const [sessions, projectMembers] = await Promise.all([
    api.listProjectSessions(projectId),
    api.listProjectMembers(projectId),
  ]);
  if (!projectSelectionGuard.isCurrent(selection)) return;
  state.sessions = sessions;
  state.projectMembers = projectMembers;
  renderProjectSelect();
  renderSessionList();
  renderProjectPermissions();
  await renderInvitationControls(selection);
  if (!projectSelectionGuard.isCurrent(selection)) return;
  const requestedSessionId = new URLSearchParams(location.hash.slice(1)).get("session");
  const initial = state.sessions.find((session) => session.id === requestedSessionId) ?? state.sessions[0];
  if (initial) {
    await selectSession(initial.id);
    if (!projectSelectionGuard.isCurrent(selection)) return;
    return;
  }
  location.hash = new URLSearchParams({ project: projectId }).toString();
  sessionView.hidden = true;
  emptyState.hidden = false;
  element("empty-state-title").textContent = "Start a shared thread.";
  element("empty-create-button").textContent = "Create your first session";
  renderMembers();
}

async function selectSession(sessionId) {
  const generation = ++selectedSessionGeneration;
  sendError.textContent = "";
  element("accept-invite-error").textContent = "";
  clearCreatedInvitationSecret();
  closeMembersPanelWithoutFocus();
  stopSnapshotPolling();
  state.snapshotRequests = [];
  renderSnapshotRequests();
  downloadCodexButton.disabled = true;
  const [session, members] = await Promise.all([
    api.getSession(sessionId),
    api.listMembers(sessionId),
  ]);
  if (generation !== selectedSessionGeneration) return;
  state.session = { ...session, members };
  startMemberRefresh(sessionId);
  location.hash = new URLSearchParams({ project: state.project.id, session: sessionId }).toString();
  emptyState.hidden = true;
  sessionView.hidden = false;
  renderSessionHeader();
  renderSessionList();
  renderMembers();
  renderComposerPermissions();
  renderSessionDeliveryControls();
  downloadCodexButton.disabled = false;
  element("session-title").focus({ preventScroll: true });
  const membership = members.find((member) => member.userId === state.currentUser?.id);
  if (sessionDeliveryMode({ role: membership?.role ?? session.role, mode: session.mode }) === "snapshot") {
    void restoreSnapshotRequests(sessionId, generation);
  }
  await sync.connect(sessionId);
}

function renderProjectSelect() {
  projectSelect.replaceChildren();
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    option.selected = project.id === state.project?.id;
    projectSelect.append(option);
  }
  projectSelect.disabled = state.projects.length < 2;
  connectCodexButton.hidden = !state.project;
}

function renderProjectPermissions() {
  const isOwner = state.project?.role === "owner";
  element("new-session-button").hidden = !isOwner;
  element("empty-create-button").hidden = !isOwner;
}

function startMemberRefresh(sessionId) {
  stopMemberRefresh();
  memberRefreshTimer = setInterval(() => void refreshMembers(sessionId), 5_000);
  memberRefreshTimer.unref?.();
}

function stopMemberRefresh() {
  if (memberRefreshTimer !== undefined) clearInterval(memberRefreshTimer);
  memberRefreshTimer = undefined;
  memberRefreshInFlight = false;
}

async function refreshMembers(sessionId) {
  if (memberRefreshInFlight || state.session?.id !== sessionId) return;
  memberRefreshInFlight = true;
  try {
    const members = await api.listMembers(sessionId);
    if (state.session?.id !== sessionId) return;
    state.session = { ...state.session, members };
    renderMembers();
    renderTimeline();
    renderComposerPermissions();
    renderSessionDeliveryControls();
  } catch (error) {
    if (error?.status === 403 || error?.status === 404) {
      sync.disconnect();
      stopMemberRefresh();
      stopSnapshotPolling();
      selectedSessionGeneration += 1;
      state.session = null;
      location.hash = "";
      announce("Your access to the open collaboration was removed.");
      try {
        await enterWorkspace();
      } catch (refreshError) {
        resetWorkspaceToAuth();
        loginError.textContent = refreshError?.message ?? "Unable to refresh your remaining projects.";
      }
    }
    // Transient presence failures retry without discarding confirmed history.
  } finally {
    memberRefreshInFlight = false;
  }
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
  element("rename-session-button").hidden = membership?.role !== "owner";
  element("session-subtitle").textContent = `${session.description} · You are ${membership?.role ?? "viewer"}`;
}

function applySessionMetadataEvents(events) {
  for (const event of events) {
    const metadata = sessionMetadataFromEvent(event);
    if (metadata?.sessionId) updateSessionName(metadata.sessionId, metadata.name);
  }
}

function updateSessionName(sessionId, name) {
  state.sessions = state.sessions.map((session) => session.id === sessionId ? { ...session, name } : session);
  if (state.session?.id === sessionId) {
    state.session = { ...state.session, name };
    renderSessionHeader();
  }
  renderSessionList();
}

function renderMembers() {
  const list = element("member-list");
  list.replaceChildren();
  const sessionMembers = state.session?.members ?? [];
  const members = state.projectMembers.map((projectMember) => {
    const sessionMember = sessionMembers.find((member) => member.userId === projectMember.userId);
    return sessionMember ? { ...projectMember, runtime: sessionMember.runtime } : projectMember;
  });
  for (const member of members) {
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
    details.append(name);
    if (state.project?.role === "owner" && member.role !== "owner") {
      const roleSelect = document.createElement("select");
      roleSelect.className = "member-role-select";
      roleSelect.setAttribute("aria-label", `Role for ${member.username}`);
      for (const value of ["participant", "viewer"]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = value === member.role;
        roleSelect.append(option);
      }
      roleSelect.addEventListener("change", () => void changeProjectMemberRole(member, roleSelect));
      details.append(roleSelect);
    } else {
      const role = document.createElement("small");
      role.textContent = member.role;
      details.append(role);
    }

    const presence = document.createElement("span");
    presence.className = `presence presence-${member.runtime?.status ?? "none"}`;
    if (member.runtime?.purpose === "snapshot_connector") {
      presence.textContent = member.runtime.status === "online" ? "Snapshot connector" : "Connector offline";
    } else {
      presence.textContent = isExecutionRuntime(member.runtime) ? "Agent online" : member.runtime ? "Offline" : "No runtime";
    }
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

async function changeProjectMemberRole(member, select) {
  if (!state.project) return;
  const previousRole = member.role;
  select.disabled = true;
  try {
    await api.setProjectMemberRole(state.project.id, member.userId, select.value);
    state.projectMembers = await api.listProjectMembers(state.project.id);
    if (state.session) {
      state.session = { ...state.session, members: await api.listMembers(state.session.id) };
      renderMembers();
      renderComposerPermissions();
    }
    state.sessions = await api.listProjectSessions(state.project.id);
    renderSessionList();
    announce(`${member.username} is now a ${select.value}.`);
  } catch (error) {
    select.value = previousRole;
    select.disabled = false;
    announce(error.message ?? "Unable to update the project role.");
  }
}

async function renderInvitationControls(selection) {
  if (selection && !projectSelectionGuard.isCurrent(selection)) return;
  const ownerControls = element("owner-invitations");
  renderInvitationRoleControl();
  ownerControls.hidden = state.project?.role !== "owner";
  state.invitations = [];
  invitationList.replaceChildren();
  element("invitation-list-status").textContent = "";
  if (state.project?.role === "owner") await loadInvitations(selection);
}

function renderInvitationRoleControl() {
  const roleSelect = element("invitation-role");
  const policy = invitationRolePolicy();
  for (const option of roleSelect.options) {
    const allowed = policy.allowedRoles.includes(option.value);
    option.disabled = !allowed;
    option.hidden = !allowed;
  }
  roleSelect.value = policy.defaultRole;
  roleSelect.disabled = policy.locked;
  element("invitation-role-help").textContent = policy.help;
}

async function loadInvitations(selection) {
  if (selection && !projectSelectionGuard.isCurrent(selection)) return;
  if (!state.project) return;
  const projectId = state.project.id;
  const status = element("invitation-list-status");
  const refresh = element("refresh-invitations-button");
  status.textContent = "Loading invitations…";
  refresh.disabled = true;
  try {
    const invitations = await api.listInvitations(projectId);
    if (state.project?.id !== projectId || (selection && !projectSelectionGuard.isCurrent(selection))) return;
    state.invitations = invitations.map(normalizeInvitation);
    renderInvitations();
  } catch (error) {
    if (!selection || projectSelectionGuard.isCurrent(selection)) {
      status.textContent = error.message ?? "Unable to load invitations.";
    }
  } finally {
    if (!selection || projectSelectionGuard.isCurrent(selection)) refresh.disabled = false;
  }
}

function renderInvitations() {
  invitationList.replaceChildren();
  const status = element("invitation-list-status");
  status.textContent = state.invitations.length ? "" : "No invitations have been created for this project.";
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
  if (!state.project) return;
  const projectId = state.project.id;
  button.disabled = true;
  element("create-invitation-error").textContent = "";
  try {
    const revoked = await api.revokeInvitation(projectId, invitation.id);
    if (state.project?.id !== projectId) return;
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

function showNewDeviceAccessToken(token) {
  newDeviceAccessToken = token;
  element("new-device-access-token").textContent = token;
  element("copy-device-access-token-status").textContent = "";
  if (!deviceCredentialDialog.open) deviceCredentialDialog.showModal();
}

function clearNewDeviceAccessToken() {
  newDeviceAccessToken = "";
  element("new-device-access-token").textContent = "";
  element("copy-device-access-token-status").textContent = "";
  if (deviceCredentialDialog.open) deviceCredentialDialog.close();
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
  const membership = state.session?.members.find((member) => member.userId === state.currentUser?.id);
  const isLive = sessionDeliveryMode({ role: membership?.role ?? state.session?.role, mode: state.session?.mode }) === "live";
  element("sync-title").textContent = isLive ? title : phase === "live" ? "Read-only history" : title;
  element("sync-detail").textContent = bufferedCount
    ? `${detail} ${bufferedCount} later event${bufferedCount === 1 ? " is" : "s are"} buffered.`
    : detail;
  element("retry-sync-button").hidden = !new Set(["offline", "blocked"]).has(phase);
  timelineRegion.setAttribute("aria-busy", String(new Set(["connecting", "replaying", "recovering"]).has(phase)));
  element("sequence-label").textContent = `Contiguous through sequence #${cursor}`;
  element("global-connection").dataset.state = phase;
  element("global-connection-label").textContent = phase === "live"
    ? isLive ? `Live · #${cursor}` : `Read only · #${cursor}`
    : title;
}

function renderTimeline() {
  timeline.replaceChildren();
  const events = state.sync.events.filter(isTimelineEventVisible);
  const pendingRequestIds = new Set(pendingAgentRequests(state.sync.events).map((event) => event.id));
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
    const content = eventContent(event);
    article.append(header);
    if (content) {
      body.textContent = content;
      article.append(body);
    }

    if (event.provenance) {
      const provenance = document.createElement("footer");
      provenance.className = "provenance";
      for (const value of [
        event.provenance.username,
        event.provenance.harness,
        event.provenance.provider,
        event.provenance.model,
        event.provenance.reasoningEffort,
        event.provenance.fidelity?.replaceAll("_", " "),
      ].filter(Boolean)) {
        const tag = document.createElement("span");
        tag.textContent = value;
        provenance.append(tag);
      }
      article.append(provenance);
    }

    item.append(article);
    if (pendingRequestIds.has(event.id)) {
      item.append(renderAgentPendingStatus(event));
    }
    timeline.append(item);
  }

  if (events.length && timelineRegion.scrollHeight - timelineRegion.scrollTop - timelineRegion.clientHeight < 180) {
    requestAnimationFrame(() => timelineRegion.scrollTo({ top: timelineRegion.scrollHeight, behavior: "smooth" }));
  }
}

function renderAgentPendingStatus(request) {
  const member = state.session?.members.find((candidate) => candidate.userId === request.actor.id);
  const online = isExecutionRuntime(member?.runtime);
  const status = document.createElement("div");
  const dots = document.createElement("span");
  const label = document.createElement("span");
  status.className = "agent-pending-status";
  status.dataset.state = online ? "answering" : "queued";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-label", online ? "Agent is responding" : "Agent request is queued");
  dots.className = "agent-thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) dots.append(document.createElement("i"));
  const runtime = member?.runtime;
  const agentName = runtime?.harness || "Agent";
  label.textContent = online
    ? `${agentName} is responding…`
    : `${agentName} request is queued until the local runtime reconnects.`;
  status.append(dots, label);
  return status;
}

function renderSessionDeliveryControls() {
  const membership = state.session?.members.find((member) => member.userId === state.currentUser?.id);
  const isLive = sessionDeliveryMode({
    role: membership?.role ?? state.session?.role,
    mode: state.session?.mode,
  }) === "live";
  downloadCodexButton.hidden = isLive;
  element("snapshot-download-panel").hidden = isLive;
  element("connector-status").hidden = !isLive;
  composer.hidden = !isLive;
  timelineEmpty.querySelector("p").textContent = isLive
    ? "No events yet. Start the conversation below."
    : "No shared events are available yet.";

  if (isLive) {
    const connector = normalizeConnectorState(state.session?.connectorState, state.sync);
    const detail = {
      synced: "Local execution history matches the canonical session.",
      offline: connector.pendingCount > 0
        ? `${connector.pendingCount} local change${connector.pendingCount === 1 ? " is" : "s are"} waiting to reconcile.`
        : "The local execution connector is offline.",
      reconciling: "Local changes are being reconciled with canonical history.",
      rebuilding: "The local execution projection is being rebuilt.",
      local_fork: "Local work diverged and is preserved as a separate fork.",
    }[connector.status];
    const node = element("connector-status");
    node.dataset.state = connector.status;
    element("connector-status-label").textContent = connector.label;
    element("connector-status-detail").textContent = detail;
  } else {
    const connectorOnline = hasOnlineSnapshotConnector(state.session?.members);
    element("snapshot-connector-hint").textContent = connectorOnline
      ? "A local snapshot connector is online. Each request still creates a separate frozen task."
      : "No local snapshot connector is online. Requests remain Queued until one connects.";
    renderSnapshotRequests();
  }
}

async function restoreSnapshotRequests(sessionId, generation) {
  const errorNode = element("snapshot-request-error");
  try {
    const requests = await api.listSnapshotRequests({ sessionId, limit: 40 });
    if (generation !== selectedSessionGeneration || state.session?.id !== sessionId) return;
    const restoredIds = new Set(requests.map((request) => request.id));
    state.snapshotRequests = [
      ...requests,
      ...state.snapshotRequests.filter((request) => !restoredIds.has(request.id)),
    ];
    errorNode.textContent = "";
    renderSnapshotRequests();
    const activeStatuses = new Set(["queued", "claimed", "importing", "compacting"]);
    if (requests.some((request) => activeStatuses.has(request.status))) startSnapshotPolling();
  } catch (error) {
    if (generation !== selectedSessionGeneration || state.session?.id !== sessionId) return;
    errorNode.textContent = error.message ?? "Unable to restore recent Codex snapshots.";
  }
}

async function createSnapshotDownload() {
  if (!state.session || downloadCodexButton.hidden) return;
  const sessionId = state.session.id;
  const errorNode = element("snapshot-request-error");
  errorNode.textContent = "";
  downloadCodexButton.disabled = true;
  downloadCodexButton.setAttribute("aria-busy", "true");
  try {
    const request = await api.createSnapshotRequest(state.session.id);
    if (state.session?.id !== sessionId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderSnapshotRequests();
    announce(`Snapshot queued through sequence ${request.throughSequence}.`);
    startSnapshotPolling();
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to queue this Codex snapshot.";
  } finally {
    downloadCodexButton.disabled = false;
    downloadCodexButton.removeAttribute("aria-busy");
  }
}

function renderSnapshotRequests() {
  snapshotRequestList.replaceChildren();
  element("snapshot-request-empty").hidden = state.snapshotRequests.length > 0;
  for (const request of state.snapshotRequests) {
    const view = snapshotStatusView(request);
    const item = document.createElement("li");
    const copy = document.createElement("div");
    const label = document.createElement("strong");
    const detail = document.createElement("span");
    const sequence = document.createElement("small");
    item.className = `snapshot-request snapshot-request-${request.status}`;
    item.dataset.state = request.status;
    label.textContent = view.label;
    detail.textContent = view.detail;
    sequence.textContent = `Frozen through sequence #${request.throughSequence}`;
    copy.append(label, detail, sequence);
    item.append(copy);
    if (view.retryable) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.textContent = "Retry with a new snapshot";
      retry.setAttribute("data-action", "retry-snapshot");
      item.append(retry);
    }
    snapshotRequestList.append(item);
  }
}

function startSnapshotPolling() {
  stopSnapshotPolling();
  const generation = snapshotPollGeneration;
  void pollSnapshotRequests(generation);
}

function stopSnapshotPolling() {
  snapshotPollGeneration += 1;
  if (snapshotPollTimer !== undefined) clearTimeout(snapshotPollTimer);
  snapshotPollTimer = undefined;
}

async function pollSnapshotRequests(generation) {
  const activeStatuses = new Set(["queued", "claimed", "importing", "compacting"]);
  const active = state.snapshotRequests.filter((request) => activeStatuses.has(request.status));
  if (generation !== snapshotPollGeneration || active.length === 0) return;
  const sessionId = state.session?.id;
  const settled = await Promise.allSettled(active.map((request) => api.getSnapshotRequest(request.id)));
  if (generation !== snapshotPollGeneration || state.session?.id !== sessionId) return;
  const updates = new Map();
  for (const result of settled) {
    if (result.status === "fulfilled") updates.set(result.value.id, result.value);
  }
  state.snapshotRequests = state.snapshotRequests.map((request) => updates.get(request.id) ?? request);
  renderSnapshotRequests();
  if (settled.some((result) => result.status === "rejected")) {
    element("snapshot-request-error").textContent = "Snapshot status is temporarily unavailable. Polling will retry.";
  } else {
    element("snapshot-request-error").textContent = "";
  }
  const stillActive = state.snapshotRequests.some((request) => activeStatuses.has(request.status));
  if (!stillActive) return;
  snapshotPollTimer = setTimeout(() => void pollSnapshotRequests(generation), mockEnabled ? 120 : 1_800);
  snapshotPollTimer.unref?.();
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
  if (state.project?.role !== "owner") return;
  element("create-error").textContent = "";
  createDialog.showModal();
  requestAnimationFrame(() => element("session-name").focus());
}

function openCreateProjectDialog() {
  element("create-project-error").textContent = "";
  createProjectDialog.showModal();
  requestAnimationFrame(() => element("project-name").focus());
}

function openRenameSessionDialog() {
  const membership = state.session?.members.find((member) => member.userId === state.currentUser?.id);
  if (!state.session || membership?.role !== "owner") return;
  renameSessionReturnFocus = document.activeElement;
  element("rename-session-error").textContent = "";
  element("rename-session-name").value = state.session.name;
  renameSessionDialog.showModal();
  requestAnimationFrame(() => element("rename-session-name").select());
}

function openConnectCodexDialog() {
  if (!state.project) return;
  const errorNode = element("connect-codex-error");
  errorNode.textContent = "";
  for (const status of connectCodexDialog.querySelectorAll("[data-copy-status]")) status.textContent = "";
  try {
    const commands = projectCodexConnectionCommands({
      baseUrl: location.origin,
      projectId: state.project.id,
    });
    element("connect-codex-project-name").textContent = state.project.name;
    element("connect-codex-posix-command").textContent = commands.posix;
    element("connect-codex-powershell-command").textContent = commands.powershell;
    for (const button of connectCodexDialog.querySelectorAll("button[data-copy-command]")) button.disabled = false;
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to create a safe connector command.";
    for (const button of connectCodexDialog.querySelectorAll("button[data-copy-command]")) button.disabled = true;
  }
  connectCodexReturnFocus = document.activeElement;
  connectCodexDialog.showModal();
  requestAnimationFrame(() => element("close-connect-codex-button").focus());
}

async function copyCodexCommand(platform) {
  const commandNode = element(`connect-codex-${platform}-command`);
  const status = element(`copy-${platform}-command-status`);
  const command = commandNode.textContent;
  if (!command) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(commandNode);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand?.("copy")) throw new Error("Clipboard unavailable");
      selection.removeAllRanges();
    }
    status.textContent = "Copied.";
    announce(`${platform === "posix" ? "Shell" : "PowerShell"} connector command copied.`);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(commandNode);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = "Clipboard access is unavailable. The command is selected for manual copy.";
  }
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
