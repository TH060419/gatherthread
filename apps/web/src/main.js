import { HttpCollaborationApi, MockCollaborationApi } from "./api.js?v=20260906-2";
import {
  canAppend,
  canRetryFailedAgentRequest,
  createIdempotencyKey,
  createSelectionGuard,
  eventContent,
  eventLabel,
  failedRequestFor,
  formatTimestamp,
  initials,
  hasOnlineSnapshotConnector,
  isExecutionRuntime,
  isFailedAgentResponse,
  isTimelineEventVisible,
  normalizeConnectorState,
  pendingAgentRequests,
  projectCodexConnectionCommands,
  provenanceSummary,
  invitationStatusLabel,
  invitationRolePolicy,
  normalizeInvitation,
  retryAgentRequestInput,
  runtimeLabel,
  sessionMetadataFromEvent,
  sessionDeliveryMode,
  snapshotStatusView,
} from "./domain.js?v=20260829-3";
import { SessionSync } from "./realtime.js";
import { createAmbientCanvas } from "./ambient-canvas.js?v=20260829-14";
import { createLocalizer } from "./i18n.js?v=20260906-3";
import { automaticDeviceName } from "./device-name.js?v=20260830-1";
import {
  codexExecutionProfile,
  DSH_HARNESS,
  DSH_INSTALL_COMMAND,
  DSH_PINNED_START_COMMAND,
  DSH_START_COMMAND,
  DSH_VERSION_COMMAND,
  dshExecutionProfile,
  dshPairingCodeFromHash,
  dshRuntimeChoices,
  resolveCodexRuntime,
  resolveDshRuntime,
  withoutDshPairingHash,
} from "./dsh.js?v=20260906-3";
import { renderMarkdown } from "./markdown.js?v=20260829-1";
import { captureTimelineScroll, settleTimelineScroll } from "./timeline-scroll.js?v=20260917-1";
import {
  INITIAL_CONNECTION_NOTICE_STATE,
  advanceConnectionNotice,
  notificationPermissionNeeded,
} from "./notifications.js?v=20260918-1";
import {
  contextBudgetInputBytes,
  digitsOnly,
  numericPresetAction,
} from "./settings-controls.js?v=20260829-3";
import {
  addCustomCodexModel,
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  CONTEXT_BUDGET_MAX_BYTES,
  CONTEXT_BUDGET_MIN_BYTES,
  contextBudgetToTokenCeiling,
  createSettingsStore,
  DEFAULT_SETTINGS,
  effectiveContextBudget,
  normalizeCodexProfile,
  normalizeSettings,
  projectAgentHarness,
  projectCodexProfile,
  projectDshProfile,
  projectEnabledHarnesses,
  withProjectAgentHarness,
  withProjectCodexProfile,
  withProjectDshProfile,
  withProjectEnabledHarnesses,
} from "./settings.js?v=20260906-4";

const query = new URLSearchParams(location.search);
const configuredApiUrl = query.get("api") ?? "";
const mockEnabled = query.get("mock") === "1";
const api = mockEnabled
  ? new MockCollaborationApi()
  : new HttpCollaborationApi({ baseUrl: configuredApiUrl });
const sync = new SessionSync(api);
const projectSelectionGuard = createSelectionGuard();
const settingsStore = createSettingsStore();

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
  executionRuntimes: [],
  devices: [],
  sync: sync.snapshot(),
  settings: settingsStore.get(),
};

let createdInvitationSecret = "";
let newDeviceAccessToken = "";
let authenticationGeneration = 0;
let memberRefreshTimer;
let memberRefreshInFlight = false;
let snapshotPollTimer;
let snapshotPollGeneration = 0;
let dshRuntimePollTimer;
let dshRuntimePollGeneration = 0;
let dshRuntimeLoadInFlight = false;
let selectedSessionGeneration = 0;
let pendingDshPairingCode = dshPairingCodeFromHash(location.hash);
const expandedWorklogs = new Set();
const localSyncStatusRequestsInFlight = new Set();
const LOCAL_SYNC_REQUEST_KINDS = new Set([
  "local_sync_status",
  "local_auto_upload_enable",
  "local_auto_upload_disable",
  "local_turn_upload",
]);
let selectedCodexLocalRuntimeId = "";

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
const composerLayoutResizer = element("composer-layout-resizer");
const downloadCodexButton = element("download-codex-button");
const importVisibleHistoryButton = element("import-visible-history-button");
const snapshotRequestList = element("snapshot-request-list");
const codexLocalSyncControls = element("codex-local-sync-controls");
const codexLocalRuntimeField = element("codex-local-runtime-field");
const codexLocalRuntimeSelect = element("codex-local-runtime-select");
const codexAutoUploadToggle = element("codex-auto-upload-toggle");
const uploadLocalTurnsButton = element("upload-local-turns-button");
const codexLocalSyncStatus = element("codex-local-sync-status");
const createDialog = element("create-session-dialog");
const createForm = element("create-session-form");
const createProjectDialog = element("create-project-dialog");
const createProjectForm = element("create-project-form");
const renameSessionDialog = element("rename-session-dialog");
const renameSessionForm = element("rename-session-form");
const renameProjectDialog = element("rename-project-dialog");
const renameProjectForm = element("rename-project-form");
const deleteCloudDialog = element("delete-cloud-dialog");
const deleteCloudForm = element("delete-cloud-form");
const connectCodexDialog = element("connect-codex-dialog");
const connectCodexButton = element("connect-codex-button");
const connectDshDialog = element("connect-dsh-dialog");
const connectDshButton = element("connect-dsh-button");
const approveDshPairingDialog = element("approve-dsh-pairing-dialog");
const approveDshPairingForm = element("approve-dsh-pairing-form");
const memberPanel = element("member-panel");
const toggleSessionRailButton = element("toggle-session-rail-button");
const toggleMemberPanelButton = element("mobile-members-button");
const sessionContextDetails = element("session-context-details");
const compactWorkspaceQuery = window.matchMedia("(max-width: 1160px)");
const acceptInvitationForm = element("accept-invitation-form");
const createInvitationForm = element("create-invitation-form");
const invitationList = element("invitation-list");
const deviceCredentialDialog = element("device-credential-dialog");
const settingsDialog = element("settings-dialog");
const settingsForm = element("settings-form");
const agentModelSelect = element("agent-model-select");
const agentEffortSelect = element("agent-effort-select");
const agentHarnessSelect = element("agent-harness-select");
const agentDshRuntimeSelect = element("agent-dsh-runtime-select");
const attentionNotice = element("attention-notice");
const attentionNoticeMessage = element("attention-notice-message");
const ambientCanvas = createAmbientCanvas(element("ambient-canvas"));
const localizer = createLocalizer(document);
let connectCodexReturnFocus = null;
let connectDshReturnFocus = null;
let renameSessionReturnFocus = null;
let renameProjectReturnFocus = null;
let deleteCloudReturnFocus = null;
let pendingCloudDeletion = null;
let settingsReturnFocus = null;
let settingsPreview = state.settings;
let currentDeviceName = "";
let settingsDeviceLoadGeneration = 0;
let attentionNoticeTimer;
let connectionNoticeState = INITIAL_CONNECTION_NOTICE_STATE;

applyVisualSettings(state.settings);
setAutomaticClaimDeviceName({ force: true });
element("claim-device-name").addEventListener("input", () => {
  element("claim-device-name").dataset.automatic = "false";
});

clearSensitiveInputs();
window.addEventListener("pagehide", () => {
  authenticationGeneration += 1;
  projectSelectionGuard.invalidate();
  selectedSessionGeneration += 1;
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  stopDshRuntimePolling();
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
window.addEventListener("hashchange", () => {
  const code = dshPairingCodeFromHash(location.hash);
  if (!code) return;
  pendingDshPairingCode = code;
  maybeOpenPendingDshPairing();
});

void restoreBrowserSession();

sync.subscribe((snapshot) => {
  const previousCount = state.sync.events.length;
  const connectionTransition = advanceConnectionNotice(
    connectionNoticeState,
    snapshot,
    state.settings.notifications.connectionLost,
  );
  connectionNoticeState = connectionTransition.state;
  applySessionMetadataEvents(snapshot.events.slice(previousCount));
  state.sync = snapshot;
  renderSyncState();
  renderTimeline({ followNewEvents: snapshot.events.length > previousCount });
  renderComposerPermissions();
  renderSessionDeliveryControls();
  if (connectionTransition.notify) notifyConnectionLost();
  if (snapshot.phase === "live" && snapshot.events.length > previousCount && previousCount > 0) {
    const latest = snapshot.events.at(-1);
    announce(`${eventLabel(latest.type)} from ${latest.actor.username}`);
    maybeNotifyAgentCompletion(latest);
  }
});

element("dismiss-attention-notice").addEventListener("click", hideAttentionNotice);

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const generation = ++authenticationGeneration;
  loginError.textContent = "";
  const data = new FormData(loginForm);
  const token = data.get("token")?.toString() ?? "";
  const submit = loginForm.querySelector("button[type='submit']");
  submit.disabled = true;
  submit.textContent = "Checking…";
  try {
    const actor = await api.authenticate(token, { rememberDevice: data.get("remember-device") === "on" });
    if (generation !== authenticationGeneration) return;
    state.currentUser = actor;
    loginForm.reset();
    await enterWorkspace();
  } catch (error) {
    loginError.textContent = error.message ?? "Unable to sign in.";
    element("token").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = `${localizer.t("Continue")} →`;
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
      rememberDevice: data.get("remember-device") === "on",
    });
    if (generation !== authenticationGeneration) return;
    state.currentUser = result.actor;
    showNewDeviceAccessToken(result.accessToken);
    claimInvitationForm.reset();
    setAutomaticClaimDeviceName({ force: true });
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
element("rename-project-button").addEventListener("click", openRenameProjectDialog);
element("cancel-rename-project-button").addEventListener("click", () => renameProjectDialog.close());
element("dialog-cancel-rename-project-button").addEventListener("click", () => renameProjectDialog.close());
renameProjectDialog.addEventListener("close", () => {
  const returnFocus = renameProjectReturnFocus;
  renameProjectReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
});
element("rename-session-button").addEventListener("click", openRenameSessionDialog);
element("cancel-rename-session-button").addEventListener("click", () => renameSessionDialog.close());
element("dialog-cancel-rename-session-button").addEventListener("click", () => renameSessionDialog.close());
renameSessionDialog.addEventListener("close", () => {
  const returnFocus = renameSessionReturnFocus;
  renameSessionReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
});
element("delete-project-button").addEventListener("click", () => openDeleteCloudDialog("project"));
element("delete-session-button").addEventListener("click", () => openDeleteCloudDialog("session"));
element("close-delete-cloud-button").addEventListener("click", () => deleteCloudDialog.close());
element("cancel-delete-cloud-button").addEventListener("click", () => deleteCloudDialog.close());
deleteCloudDialog.addEventListener("close", () => {
  pendingCloudDeletion = null;
  element("delete-cloud-error").textContent = "";
  const returnFocus = deleteCloudReturnFocus;
  deleteCloudReturnFocus = null;
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
connectDshButton.addEventListener("click", openConnectDshDialog);
element("close-connect-dsh-button").addEventListener("click", () => connectDshDialog.close());
element("done-connect-dsh-button").addEventListener("click", () => connectDshDialog.close());
element("refresh-dsh-runtimes-button").addEventListener("click", () => void refreshDshRuntimes({ announceFailure: true }));
connectDshDialog.addEventListener("close", () => {
  const returnFocus = connectDshReturnFocus;
  connectDshReturnFocus = null;
  requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
});
for (const button of connectDshDialog.querySelectorAll("button[data-copy-dsh-command]")) {
  button.addEventListener("click", () => void copyDshCommand(button.dataset.copyDshCommand));
}
approveDshPairingForm.addEventListener("submit", approvePendingDshPairing);
for (const id of ["cancel-dsh-pairing-button", "decline-dsh-pairing-button"]) {
  element(id).addEventListener("click", cancelPendingDshPairing);
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

renameProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const projectId = state.project?.id;
  if (!projectId || state.project?.role !== "owner") return;
  const errorNode = element("rename-project-error");
  const submit = renameProjectForm.querySelector("button[type='submit']");
  const name = new FormData(renameProjectForm).get("name")?.toString() ?? "";
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Saving…";
  try {
    const renamed = await api.renameProject(projectId, {
      name,
      idempotencyKey: createIdempotencyKey("rename-project"),
    });
    if (state.project?.id !== projectId) return;
    state.project = { ...state.project, ...renamed };
    state.projects = state.projects.map((project) => project.id === projectId ? { ...project, ...renamed } : project);
    renderProjectSelect();
    renameProjectDialog.close();
    announce("Project renamed.");
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to rename the project.";
    element("rename-project-name").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Save name";
  }
});

renameSessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const sessionId = state.session?.id;
  if (!sessionId) return;
  const errorNode = element("rename-session-error");
  const submit = renameSessionForm.querySelector("button[type='submit']");
  const data = new FormData(renameSessionForm);
  const name = data.get("name")?.toString() ?? "";
  const modeField = element("rename-session-mode-field");
  const mode = modeField.hidden ? undefined : data.get("mode")?.toString();
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Saving…";
  try {
    const renamed = await api.updateSession(sessionId, {
      name,
      ...(mode === undefined ? {} : { mode }),
      idempotencyKey: createIdempotencyKey("session-settings"),
    });
    if (state.session?.id !== sessionId) return;
    updateSessionMetadata(sessionId, renamed);
    renameSessionDialog.close();
    announce("Session updated.");
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to rename the session.";
    element("rename-session-name").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Save changes";
  }
});

deleteCloudForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = pendingCloudDeletion;
  if (!target) return;
  const submit = element("confirm-delete-cloud-button");
  const errorNode = element("delete-cloud-error");
  errorNode.textContent = "";
  submit.disabled = true;
  try {
    if (target.type === "session") {
      await api.deleteSession(target.id);
      if (state.session?.id === target.id) {
        sync.disconnect();
        stopMemberRefresh();
        stopSnapshotPolling();
        selectedSessionGeneration += 1;
        state.session = null;
      }
      deleteCloudReturnFocus = null;
      deleteCloudDialog.close();
      state.projects = await api.listProjects();
      location.hash = new URLSearchParams({ project: target.projectId }).toString();
      await selectProject(target.projectId);
      announce("Session deleted from cloud. Local copies were not changed.");
    } else {
      await api.deleteProject(target.id);
      sync.disconnect();
      stopMemberRefresh();
      stopSnapshotPolling();
      selectedSessionGeneration += 1;
      projectSelectionGuard.invalidate();
      state.project = null;
      state.session = null;
      deleteCloudReturnFocus = null;
      deleteCloudDialog.close();
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      await enterWorkspace();
      announce("Project deleted from cloud. Local copies were not changed.");
    }
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to delete the cloud copy.";
  } finally {
    submit.disabled = false;
  }
});

sendChatButton.addEventListener("click", () => sendMessage("human_chat"));
sendAgentButton.addEventListener("click", () => sendMessage("agent_request"));
element("settings-button").addEventListener("click", openSettingsDialog);
element("close-settings-button").addEventListener("click", cancelSettingsDialog);
element("cancel-settings-button").addEventListener("click", cancelSettingsDialog);
element("reset-settings-button").addEventListener("click", resetSettingsPreview);
element("reset-layout-button").addEventListener("click", () => {
  element("settings-left-width").value = String(DEFAULT_SETTINGS.layout.leftRailPixels);
  element("settings-right-width").value = String(DEFAULT_SETTINGS.layout.rightPanelPixels);
  element("settings-composer-height").value = String(DEFAULT_SETTINGS.layout.composerPixels);
  updateSettingsPreviewFromForm();
});
element("add-custom-model-button").addEventListener("click", addCustomModelFromSettings);
settingsForm.addEventListener("input", handleSettingsControlInput);
settingsForm.addEventListener("change", handleSettingsControlChange);
settingsForm.addEventListener("submit", saveSettings);
settingsDialog.addEventListener("close", () => {
  const returnFocus = settingsReturnFocus;
  settingsReturnFocus = null;
  returnFocus?.focus?.();
});
agentModelSelect.addEventListener("change", () => updateComposerAgentProfile("model"));
agentEffortSelect.addEventListener("change", () => updateComposerAgentProfile("effort"));
agentHarnessSelect.addEventListener("change", updateComposerHarness);
agentDshRuntimeSelect.addEventListener("change", updateComposerDshRuntime);
messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  const behavior = state.settings.composer.enterBehavior;
  if (behavior === "newline") return;
  event.preventDefault();
  void sendMessage(behavior === "send_chat" ? "human_chat" : "agent_request");
});
installLayoutResizer(element("left-layout-resizer"), "left");
installLayoutResizer(element("right-layout-resizer"), "right");
installComposerLayoutResizer(composerLayoutResizer);
downloadCodexButton.addEventListener("click", () => void createSnapshotDownload());
importVisibleHistoryButton.addEventListener("click", () => void createVisibleHistoryImport());
codexLocalRuntimeSelect.addEventListener("change", () => {
  selectedCodexLocalRuntimeId = codexLocalRuntimeSelect.value;
  renderCodexLocalSyncControls();
  void ensureCodexLocalSyncStatus();
});
codexAutoUploadToggle.addEventListener("change", () => {
  void queueCodexLocalSyncAction(codexAutoUploadToggle.checked
    ? "local_auto_upload_enable"
    : "local_auto_upload_disable");
});
uploadLocalTurnsButton.addEventListener("click", () => void queueCodexLocalSyncAction("local_turn_upload"));
snapshotRequestList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='retry-snapshot']");
  if (button) void createSnapshotDownload();
});
timeline.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='retry-agent-request']");
  if (button) void retryAgentRequest(button.dataset.requestId);
});
element("retry-sync-button").addEventListener("click", () => sync.retry());

toggleSessionRailButton.addEventListener("click", toggleSessionRail);
toggleMemberPanelButton.addEventListener("click", toggleMemberPanel);
sessionContextDetails.addEventListener("toggle", updateSessionContextDisclosure);
const handleWorkspaceBreakpointChange = () => {
  memberPanel.classList.remove("member-panel-open");
  updateSidebarControls();
};
if (typeof compactWorkspaceQuery.addEventListener === "function") {
  compactWorkspaceQuery.addEventListener("change", handleWorkspaceBreakpointChange);
} else {
  compactWorkspaceQuery.addListener(handleWorkspaceBreakpointChange);
}

element("close-members-button").addEventListener("click", closeMembersPanel);

function closeMembersPanel() {
  memberPanel.classList.remove("member-panel-open");
  updateSidebarControls();
  toggleMemberPanelButton.focus();
}

function toggleSessionRail() {
  workspace.dataset.leftRailCollapsed = String(workspace.dataset.leftRailCollapsed !== "true");
  updateSidebarControls();
}

function toggleMemberPanel() {
  if (compactWorkspaceQuery.matches) {
    memberPanel.classList.toggle("member-panel-open");
  } else {
    workspace.dataset.rightPanelCollapsed = String(workspace.dataset.rightPanelCollapsed !== "true");
    memberPanel.classList.remove("member-panel-open");
  }
  updateSidebarControls();
}

function updateSidebarControls() {
  const sessionRailExpanded = workspace.dataset.leftRailCollapsed !== "true";
  const memberPanelExpanded = compactWorkspaceQuery.matches
    ? memberPanel.classList.contains("member-panel-open")
    : workspace.dataset.rightPanelCollapsed !== "true";
  updateIconDisclosure(toggleSessionRailButton, sessionRailExpanded, "Collapse session sidebar", "Expand session sidebar");
  updateIconDisclosure(toggleMemberPanelButton, memberPanelExpanded, "Collapse member sidebar", "Expand member sidebar");
}

function updateIconDisclosure(button, expanded, collapseLabel, expandLabel) {
  const label = localizer.t(expanded ? collapseLabel : expandLabel);
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", label);
  button.title = label;
}

function updateSessionContextDisclosure() {
  const summary = sessionContextDetails.querySelector("summary");
  const expanded = sessionContextDetails.open;
  const label = localizer.t(expanded ? "Hide session status details" : "Show session status details");
  summary.setAttribute("aria-expanded", String(expanded));
  summary.setAttribute("aria-label", label);
  summary.title = label;
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
  if (connectDshDialog.open) connectDshDialog.close();
  if (approveDshPairingDialog.open) approveDshPairingDialog.close();
  if (renameSessionDialog.open) renameSessionDialog.close();
  if (deleteCloudDialog.open) deleteCloudDialog.close();
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  stopDshRuntimePolling();
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
  state.executionRuntimes = [];
  state.devices = [];
  selectedCodexLocalRuntimeId = "";
  localSyncStatusRequestsInFlight.clear();
  currentDeviceName = "";
  settingsDeviceLoadGeneration += 1;
  expandedWorklogs.clear();
  clearCreatedInvitationSecret();
  clearNewDeviceAccessToken();
  clearSensitiveInputs();
  renderWorkspaceContext();
  workspace.hidden = true;
  authView.hidden = false;
  loginForm.reset();
  setAutomaticClaimDeviceName({ force: true });
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
  maybeOpenPendingDshPairing();
}

async function selectProject(projectId) {
  const selection = projectSelectionGuard.begin(projectId);
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  stopDshRuntimePolling();
  selectedSessionGeneration += 1;
  state.session = null;
  state.executionRuntimes = [];
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
  renderAgentProfileControls();
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
  if (state.session?.id !== sessionId) expandedWorklogs.clear();
  const generation = ++selectedSessionGeneration;
  sendError.textContent = "";
  element("accept-invite-error").textContent = "";
  clearCreatedInvitationSecret();
  closeMembersPanelWithoutFocus();
  sessionContextDetails.open = false;
  updateSessionContextDisclosure();
  stopSnapshotPolling();
  state.snapshotRequests = [];
  selectedCodexLocalRuntimeId = "";
  renderSnapshotRequests();
  downloadCodexButton.disabled = true;
  const [session, members] = await Promise.all([
    api.getSession(sessionId),
    api.listMembers(sessionId),
  ]);
  if (generation !== selectedSessionGeneration) return;
  state.session = { ...session, members };
  state.executionRuntimes = [];
  startMemberRefresh(sessionId);
  location.hash = new URLSearchParams({ project: state.project.id, session: sessionId }).toString();
  emptyState.hidden = true;
  sessionView.hidden = false;
  renderSessionHeader();
  renderSessionList();
  renderMembers();
  renderComposerPermissions();
  renderSessionDeliveryControls();
  await refreshDshRuntimes({ sessionId, generation });
  if (generation !== selectedSessionGeneration) return;
  startDshRuntimePolling();
  downloadCodexButton.disabled = false;
  element("session-title").focus({ preventScroll: true });
  void restoreSnapshotRequests(sessionId, generation);
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
  renderProjectAgentButtons();
  renderDshConnectionStatus();
  element("delete-project-button").hidden = state.project?.role !== "owner";
  element("rename-project-button").hidden = state.project?.role !== "owner";
  renderWorkspaceContext();
}

function renderProjectAgentButtons(settings = state.settings) {
  const enabled = state.project ? new Set(projectEnabledHarnesses(settings, state.project.id)) : new Set();
  connectCodexButton.hidden = !enabled.has("codex");
  connectDshButton.hidden = !enabled.has(DSH_HARNESS);
}

function renderProjectPermissions() {
  const mayCreate = state.project?.role === "owner" || state.project?.role === "participant";
  element("new-session-button").hidden = !mayCreate;
  element("empty-create-button").hidden = !mayCreate;
  element("delete-project-button").hidden = state.project?.role !== "owner";
  element("rename-project-button").hidden = state.project?.role !== "owner";
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

function startDshRuntimePolling() {
  stopDshRuntimePolling();
  const generation = dshRuntimePollGeneration;
  const poll = async () => {
    if (generation !== dshRuntimePollGeneration || !state.session) return;
    await refreshDshRuntimes();
    if (generation !== dshRuntimePollGeneration || !state.session) return;
    dshRuntimePollTimer = setTimeout(poll, mockEnabled ? 350 : 5_000);
    dshRuntimePollTimer.unref?.();
  };
  dshRuntimePollTimer = setTimeout(poll, mockEnabled ? 350 : 5_000);
  dshRuntimePollTimer.unref?.();
}

function stopDshRuntimePolling() {
  dshRuntimePollGeneration += 1;
  if (dshRuntimePollTimer !== undefined) clearTimeout(dshRuntimePollTimer);
  dshRuntimePollTimer = undefined;
  dshRuntimeLoadInFlight = false;
}

async function refreshDshRuntimes({ sessionId = state.session?.id, generation = selectedSessionGeneration, announceFailure = false } = {}) {
  if (!sessionId || dshRuntimeLoadInFlight) return;
  dshRuntimeLoadInFlight = true;
  try {
    const [runtimesResult, devicesResult] = await Promise.allSettled([
      api.listSessionRuntimes(sessionId),
      api.listDevices(),
    ]);
    if (generation !== selectedSessionGeneration || state.session?.id !== sessionId) return;
    if (runtimesResult.status === "rejected") throw runtimesResult.reason;
    state.executionRuntimes = runtimesResult.value;
    state.devices = devicesResult.status === "fulfilled" ? devicesResult.value : [];
    if (state.project
      && projectAgentHarness(state.settings, state.project.id) === DSH_HARNESS
      && projectDshProfile(state.settings, state.project.id) === null) {
      const resolved = resolveDshRuntime(state.executionRuntimes, state.devices, null);
      if (resolved.runtime) {
        state.settings = settingsStore.set(withProjectDshProfile(state.settings, state.project.id, resolved.runtime));
      }
    }
    element("connect-dsh-error").textContent = "";
  } catch (error) {
    if (generation !== selectedSessionGeneration || state.session?.id !== sessionId) return;
    state.executionRuntimes = [];
    if (announceFailure || connectDshDialog.open) {
      element("connect-dsh-error").textContent = error?.message ?? "Unable to refresh DeepSeek Harness status.";
    }
  } finally {
    dshRuntimeLoadInFlight = false;
    if (generation === selectedSessionGeneration && state.session?.id === sessionId) {
      renderAgentProfileControls();
      renderComposerPermissions();
      renderDshConnectionStatus();
      renderDshRuntimeList();
      renderCodexLocalSyncControls();
      void ensureCodexLocalSyncStatus();
    }
  }
}

function currentDshResolution(settings = state.settings) {
  const profile = state.project ? projectDshProfile(settings, state.project.id) : null;
  return resolveDshRuntime(state.executionRuntimes, state.devices, profile);
}

function currentCodexResolution() {
  return resolveCodexRuntime(state.executionRuntimes);
}

function renderDshConnectionStatus() {
  const choices = dshRuntimeChoices(state.executionRuntimes, state.devices);
  const online = choices.filter((runtime) => runtime.status === "online");
  element("connect-dsh-button-status").textContent = online.length
    ? `${online.length} online`
    : "Not connected";
  element("connect-dsh-runtime-status").textContent = online.length
    ? `${online.length} DeepSeek Harness runtime${online.length === 1 ? " is" : "s are"} online for this session.`
    : "No DeepSeek Harness runtime is online for this session yet. This page checks automatically.";
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
    title.title = session.name;
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
  element("session-title").title = session.name;
  element("session-mode").textContent = session.mode;
  element("session-mode").className = `mode-badge mode-${session.mode}`;
  const membership = session.members.find((member) => member.userId === state.currentUser.id);
  const mayRename = session.mode === "solo"
    ? membership?.role !== "viewer" && session.ownerUserId === state.currentUser?.id
    : membership?.role === "owner";
  element("rename-session-button").hidden = !mayRename;
  const mayDelete = session.ownerUserId === state.currentUser?.id || state.project?.role === "owner";
  element("delete-session-button").hidden = !mayDelete;
  element("session-subtitle").textContent = `${session.description} · You are ${membership?.role ?? "viewer"}`;
  element("session-access-note").hidden = session.mode !== "solo";
  renderWorkspaceContext();
}

function renderWorkspaceContext() {
  const context = element("topbar-session-context");
  const projectName = element("topbar-project-name");
  const sessionName = element("topbar-session-name");
  const separator = context.querySelector(".topbar-context-separator");
  context.hidden = !state.project;
  projectName.textContent = state.project?.name ?? "";
  sessionName.textContent = state.session?.name ?? "";
  sessionName.hidden = !state.session;
  separator.hidden = !state.session;
}

function applySessionMetadataEvents(events) {
  for (const event of events) {
    const metadata = sessionMetadataFromEvent(event);
    if (metadata?.sessionId) updateSessionMetadata(metadata.sessionId, metadata);
  }
}

function updateSessionMetadata(sessionId, metadata) {
  const patch = {
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.mode === undefined ? {} : { mode: metadata.mode }),
  };
  state.sessions = state.sessions.map((session) => session.id === sessionId ? { ...session, ...patch } : session);
  if (state.session?.id === sessionId) {
    state.session = { ...state.session, ...patch };
    renderSessionHeader();
    renderComposerPermissions();
    renderSessionDeliveryControls();
  }
  renderSessionList();
}

function updateSessionName(sessionId, name) {
  updateSessionMetadata(sessionId, { name });
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
  const isLive = sessionDeliveryMode({
    role: membership?.role ?? state.session?.role,
    mode: state.session?.mode,
    ownerUserId: state.session?.ownerUserId,
    currentUserId: state.currentUser?.id,
  }) === "live";
  element("sync-title").textContent = isLive ? title : phase === "live" ? "Read-only history" : title;
  element("sync-detail").textContent = bufferedCount
    ? `${detail} ${bufferedCount} later event${bufferedCount === 1 ? " is" : "s are"} buffered.`
    : detail;
  banner.hidden = phase === "live";
  element("retry-sync-button").hidden = !new Set(["offline", "blocked"]).has(phase);
  timelineRegion.setAttribute("aria-busy", String(new Set(["connecting", "replaying", "recovering"]).has(phase)));
  element("sequence-label").textContent = `Contiguous through sequence #${cursor}`;
  element("global-connection").dataset.state = phase;
  element("global-connection-label").textContent = phase === "live"
    ? isLive ? `Live · #${cursor}` : `Read only · #${cursor}`
    : title;
}

function renderTimeline({ followNewEvents = false } = {}) {
  const scrollSnapshot = captureTimelineScroll(timelineRegion, {
    automatic: state.settings.composer.autoScroll,
    followNewEvents,
  });
  timeline.replaceChildren();
  const events = state.sync.events.filter(isTimelineEventVisible);
  const progressByRequest = new Map();
  for (const event of events) {
    if (event.type !== "agent_progress" || !event.replyTo || !eventContent(event).trim()) continue;
    const progress = progressByRequest.get(event.replyTo) ?? [];
    progress.push(event);
    progressByRequest.set(event.replyTo, progress);
  }
  const pendingRequestIds = new Set(pendingAgentRequests(state.sync.events).map((event) => event.id));
  timelineEmpty.hidden = events.length > 0;

  for (const event of events) {
    if (event.type === "agent_progress") continue;
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

    article.className = `event-card event-${event.type}`;
    const failedResponse = isFailedAgentResponse(event);
    if (failedResponse) article.classList.add("event-agent_response-failed");
    article.setAttribute("aria-labelledby", `event-${event.id}-actor`);
    avatar.className = "avatar";
    avatar.textContent = event.type.includes("agent") ? "✦" : initials(event.actor.username);
    avatar.setAttribute("aria-hidden", "true");
    actor.id = `event-${event.id}-actor`;
    actor.textContent = event.actor.username;
    type.className = "event-type";
    type.textContent = localizer.t(eventLabel(event.type));
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
      if (event.type === "agent_response") {
        article.append(renderMarkdown(content));
      } else {
        const body = document.createElement("p");
        body.textContent = content;
        article.append(body);
      }
    }

    if (failedResponse) {
      // A failure that no runtime finished has to look like one, and it has to
      // offer the only action that can help: run the same request again.
      const notice = document.createElement("p");
      notice.className = "agent-failure-notice";
      notice.textContent = localizer.t("This Agent request failed before it produced an answer.");
      article.append(notice);
      const request = failedRequestFor(state.sync.events, event);
      if (request && canRetryFailedAgentRequest(request, state.currentUser)) {
        const retry = document.createElement("button");
        retry.className = "text-button agent-retry-button";
        retry.type = "button";
        retry.textContent = localizer.t("Retry Agent request");
        retry.setAttribute("data-action", "retry-agent-request");
        retry.setAttribute("data-request-id", request.id);
        // Mirror the composer's rule rather than letting a viewer press a button
        // the server is guaranteed to refuse.
        retry.disabled = !canAppend({
          session: state.session,
          currentUser: state.currentUser,
          connectionPhase: state.sync.phase,
          kind: "agent_request",
        }).allowed;
        article.append(retry);
      }
    }

    if (event.type === "agent_response" && event.replyTo && progressByRequest.has(event.replyTo)) {
      article.append(renderProgressDisclosure(progressByRequest.get(event.replyTo), false));
    }

    if (event.provenance) {
      const provenance = document.createElement("footer");
      provenance.className = "provenance";
      provenance.setAttribute("aria-label", localizer.t("Runtime details"));
      provenance.textContent = provenanceSummary(
        event.provenance,
        (effort) => localizer.t(effort),
      );
      if (provenance.textContent) article.append(provenance);
    }

    item.append(article);
    if (event.type === "agent_request" && pendingRequestIds.has(event.id) && progressByRequest.has(event.id)) {
      item.append(renderProgressDisclosure(progressByRequest.get(event.id), true));
    }
    if (pendingRequestIds.has(event.id)) {
      item.append(renderAgentPendingStatus(event));
    }
    timeline.append(item);
  }

  settleTimelineScroll(timelineRegion, {
    ...scrollSnapshot,
    follow: scrollSnapshot.follow && events.length > 0,
  });
}

function renderProgressDisclosure(progressEvents, live) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const list = document.createElement("ol");
  const worklogId = progressEvents[0]?.replyTo;
  details.className = `agent-worklog${live ? " agent-worklog-live" : ""}`;
  details.open = live || Boolean(worklogId && expandedWorklogs.has(worklogId));
  details.setAttribute("aria-live", live ? "polite" : "off");
  details.addEventListener("toggle", () => {
    if (live || !worklogId) return;
    if (details.open) expandedWorklogs.add(worklogId);
    else expandedWorklogs.delete(worklogId);
  });
  summary.textContent = `${localizer.t(live ? "Working" : "Work log")} (${progressEvents.length})`;
  list.className = "agent-worklog-list";
  for (const progress of progressEvents) {
    const item = document.createElement("li");
    const timestamp = document.createElement("time");
    timestamp.dateTime = progress.createdAt;
    timestamp.textContent = formatTimestamp(progress.createdAt);
    item.append(timestamp, renderMarkdown(localizer.t(eventContent(progress))));
    list.append(item);
  }
  details.append(summary, list);
  return details;
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
    ownerUserId: state.session?.ownerUserId,
    currentUserId: state.currentUser?.id,
  }) === "live";
  downloadCodexButton.hidden = isLive;
  element("snapshot-download-panel").hidden = isLive;
  element("connector-status").hidden = !isLive;
  composer.hidden = !isLive;
  composerLayoutResizer.hidden = !isLive;
  sessionView.classList.toggle("has-composer", isLive);
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
    element("connector-status-label").textContent = localizer.t(connector.label);
    element("connector-status-detail").textContent = localizer.t(detail);
    element("visible-history-controls").hidden = !currentProjectEnabledHarnesses().includes("codex");
    renderVisibleHistoryImportStatus();
    renderCodexLocalSyncControls();
  } else {
    element("visible-history-controls").hidden = true;
    codexLocalSyncControls.hidden = true;
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
    renderCodexLocalSyncControls();
    void ensureCodexLocalSyncStatus();
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
    const request = await api.createSnapshotRequest(state.session.id, "immutable");
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

async function createVisibleHistoryImport() {
  if (!state.session || importVisibleHistoryButton.disabled) return;
  const sessionId = state.session.id;
  const statusNode = element("visible-history-import-status");
  statusNode.textContent = "";
  importVisibleHistoryButton.disabled = true;
  importVisibleHistoryButton.setAttribute("aria-busy", "true");
  try {
    const request = await api.createSnapshotRequest(sessionId, "visible_history_replace");
    if (state.session?.id !== sessionId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderVisibleHistoryImportStatus();
    announce(`Visible Codex history import queued through sequence ${request.throughSequence}.`);
    startSnapshotPolling();
  } catch (error) {
    statusNode.textContent = error.message ?? localizer.t("Unable to queue visible Codex history import.");
  } finally {
    importVisibleHistoryButton.disabled = false;
    importVisibleHistoryButton.removeAttribute("aria-busy");
  }
}

function renderVisibleHistoryImportStatus() {
  const request = state.snapshotRequests.find((candidate) => candidate.kind === "visible_history_replace");
  const statusNode = element("visible-history-import-status");
  if (!request) {
    statusNode.textContent = localizer.t("Manual import creates a new local Codex task and never overwrites or archives the old task. After confirming the new task works, archive the old task yourself. Realtime context injection is unaffected.");
    return;
  }
  const labels = {
    queued: localizer.t("Queued until Codex reconnects."),
    claimed: localizer.t("Preparing history…"),
    importing: localizer.t("Importing history…"),
    compacting: localizer.t("Compacting history…"),
    completed: request.result?.previous_task_retained
      ? `${request.localTaskName
        ? `${localizer.t("Imported as")} ${request.localTaskName}.`
        : localizer.t("History imported as a new Codex task.")} ${localizer.t("The previous task is retained. After confirming the new task works, archive the previous task yourself. Realtime context injection is unaffected.")}`
      : request.localTaskName
        ? `${localizer.t("Imported as")} ${request.localTaskName}. ${localizer.t("Realtime context injection stays active.")}`
        : `${localizer.t("History imported.")} ${localizer.t("Realtime context injection stays active.")}`,
    failed: visibleHistoryImportFailureMessage(request.failureMessage),
  };
  statusNode.textContent = labels[request.status] ?? "";
}

function visibleHistoryImportFailureMessage(message) {
  return message || localizer.t("History import failed.");
}

function onlineCodexLocalRuntimes() {
  return state.executionRuntimes.filter((runtime) =>
    isExecutionRuntime(runtime) && String(runtime.harness).toLowerCase() === "codex",
  );
}

function codexLocalRuntimeLabel(runtime) {
  const deviceName = state.devices.find((device) => device.id === runtime.deviceId)?.name?.trim();
  const base = deviceName || localizer.t("Codex device");
  return runtime.model ? `${base} · ${runtime.model}` : base;
}

function codexLocalSyncRequests(runtimeId) {
  return state.snapshotRequests.filter((request) =>
    LOCAL_SYNC_REQUEST_KINDS.has(request.kind) && request.targetRuntimeId === runtimeId,
  );
}

function renderCodexLocalSyncControls() {
  const available = Boolean(state.session)
    && !composer.hidden
    && currentProjectEnabledHarnesses().includes("codex");
  codexLocalSyncControls.hidden = !available;
  if (!available) return;

  const runtimes = onlineCodexLocalRuntimes();
  if (!runtimes.some((runtime) => runtime.id === selectedCodexLocalRuntimeId)) {
    selectedCodexLocalRuntimeId = runtimes[0]?.id ?? "";
  }
  codexLocalRuntimeSelect.replaceChildren();
  for (const runtime of runtimes) {
    const option = document.createElement("option");
    option.value = runtime.id;
    option.textContent = codexLocalRuntimeLabel(runtime);
    option.selected = runtime.id === selectedCodexLocalRuntimeId;
    codexLocalRuntimeSelect.append(option);
  }
  codexLocalRuntimeField.hidden = runtimes.length < 2;
  codexLocalRuntimeSelect.disabled = runtimes.length < 2;

  if (!selectedCodexLocalRuntimeId) {
    codexAutoUploadToggle.checked = false;
    codexAutoUploadToggle.disabled = true;
    uploadLocalTurnsButton.disabled = true;
    codexLocalSyncStatus.textContent = localizer.t("No online Codex device is available.");
    return;
  }

  const requests = codexLocalSyncRequests(selectedCodexLocalRuntimeId);
  const latest = requests[0];
  const completed = requests.find((request) => request.status === "completed" && request.result);
  const active = latest && new Set(["queued", "claimed", "importing", "compacting"]).has(latest.status);
  const automaticUpload = latest?.kind === "local_auto_upload_enable" && active
    ? true
    : latest?.kind === "local_auto_upload_disable" && active
      ? false
      : Boolean(completed?.result?.automatic_upload);
  codexAutoUploadToggle.checked = automaticUpload;
  codexAutoUploadToggle.disabled = Boolean(active) || !completed;
  uploadLocalTurnsButton.disabled = Boolean(active) || !completed;

  if (!latest || active) {
    codexLocalSyncStatus.textContent = localizer.t("Reading local-to-cloud upload status…");
    return;
  }
  if (latest.status === "failed") {
    codexLocalSyncStatus.textContent = latest.failureMessage || localizer.t("Unable to read local-to-cloud upload status.");
    return;
  }
  const result = latest.result ?? completed?.result ?? {};
  if (latest.kind === "local_auto_upload_enable" || latest.kind === "local_auto_upload_disable") {
    codexLocalSyncStatus.textContent = localizer.t("Local-to-cloud automatic upload setting updated.");
    return;
  }
  if (latest.kind === "local_turn_upload") {
    const uploaded = Number(result.uploaded_local_turns ?? 0);
    codexLocalSyncStatus.textContent = uploaded > 0
      ? `${uploaded} ${localizer.t("local turns uploaded to cloud.")}`
      : localizer.t("No completed local turns need uploading to cloud.");
    return;
  }
  const pending = Number(result.pending_local_turns ?? result.uploadable_local_turns ?? 0);
  codexLocalSyncStatus.textContent = pending > 0
    ? `${pending} ${localizer.t(pending === 1 ? "local turn awaiting cloud upload" : "local turns awaiting cloud upload")}.`
    : localizer.t("No completed local turns need uploading to cloud.");
}

async function ensureCodexLocalSyncStatus() {
  const sessionId = state.session?.id;
  const runtimeId = selectedCodexLocalRuntimeId;
  if (!sessionId || codexLocalSyncControls.hidden || !runtimeId) return;
  if (codexLocalSyncRequests(runtimeId).length > 0) return;
  const key = `${sessionId}:${runtimeId}`;
  if (localSyncStatusRequestsInFlight.has(key)) return;
  localSyncStatusRequestsInFlight.add(key);
  try {
    const request = await api.createSnapshotRequest(sessionId, "local_sync_status", runtimeId);
    if (state.session?.id !== sessionId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderCodexLocalSyncControls();
    startSnapshotPolling();
  } catch (error) {
    if (state.session?.id === sessionId) {
      codexLocalSyncStatus.textContent = error?.message ?? localizer.t("Unable to read local-to-cloud upload status.");
    }
  } finally {
    localSyncStatusRequestsInFlight.delete(key);
  }
}

async function queueCodexLocalSyncAction(kind) {
  const sessionId = state.session?.id;
  const runtimeId = selectedCodexLocalRuntimeId;
  if (!sessionId || !runtimeId || !LOCAL_SYNC_REQUEST_KINDS.has(kind) || kind === "local_sync_status") return;
  codexAutoUploadToggle.disabled = true;
  uploadLocalTurnsButton.disabled = true;
  codexLocalSyncStatus.textContent = localizer.t("Reading local-to-cloud upload status…");
  try {
    const request = await api.createSnapshotRequest(sessionId, kind, runtimeId);
    if (state.session?.id !== sessionId || selectedCodexLocalRuntimeId !== runtimeId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderCodexLocalSyncControls();
    startSnapshotPolling();
  } catch (error) {
    if (state.session?.id === sessionId && selectedCodexLocalRuntimeId === runtimeId) {
      renderCodexLocalSyncControls();
      codexLocalSyncStatus.textContent = error?.message ?? localizer.t("Unable to update local-to-cloud upload settings.");
    }
  }
}

function renderSnapshotRequests() {
  snapshotRequestList.replaceChildren();
  const immutableRequests = state.snapshotRequests.filter((request) => request.kind === "immutable");
  element("snapshot-request-empty").hidden = immutableRequests.length > 0;
  for (const request of immutableRequests) {
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
  renderVisibleHistoryImportStatus();
  renderCodexLocalSyncControls();
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
  const harness = currentProjectHarness();
  const resolution = harness === DSH_HARNESS ? currentDshResolution() : currentCodexResolution();
  const agentAllowed = chat.allowed && resolution.runtime !== null;
  const agentReason = chat.allowed ? resolution.reason : chat.reason;
  sendChatButton.disabled = !chat.allowed;
  sendAgentButton.disabled = !agentAllowed;
  messageInput.disabled = !chat.allowed && !agentAllowed;
  element("composer-permission").textContent = chat.allowed ? "" : chat.reason;
  element("agent-target-label").textContent = agentAllowed
    ? harness === DSH_HARNESS
      ? `${resolution.runtime.deviceName} · ${resolution.runtime.provider} · ${resolution.runtime.model}`
      : `${resolution.runtime.harness} · ${resolution.runtime.provider} · ${agentModelSelect.value}`
    : agentReason;
  renderAgentProfileControls();
}

async function sendMessage(kind) {
  const content = messageInput.value.trim();
  if (!content || !state.session) {
    sendError.textContent = content ? "Choose a session first." : "Write a message first.";
    messageInput.focus();
    return;
  }
  sendError.textContent = "";
  if (kind === "agent_request" && state.settings.composer.confirmAgentRequest
    && !window.confirm("Start this Agent request with the selected harness and model?")) {
    messageInput.focus();
    return;
  }
  const button = kind === "human_chat" ? sendChatButton : sendAgentButton;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const input = { content, idempotencyKey: createIdempotencyKey(kind) };
    if (kind === "human_chat") await api.appendHumanChat(state.session.id, input);
    else {
      const harness = currentProjectHarness();
      const executionProfile = harness === DSH_HARNESS
        ? dshExecutionProfile(currentDshResolution().runtime)
        : codexExecutionProfile(currentCodexResolution().runtime, {
          model: agentModelSelect.value,
          reasoningEffort: agentEffortSelect.value,
        });
      await api.appendAgentRequest(state.session.id, { ...input, executionProfile });
    }
    messageInput.value = "";
    messageInput.focus();
  } catch (error) {
    sendError.textContent = error.message ?? "The event was not accepted.";
  } finally {
    button.textContent = original;
    renderComposerPermissions();
  }
}

/**
 * Re-run a failed request. The recorded execution profile is replayed verbatim,
 * so the retry targets the same harness, provider, model, and runtime the user
 * originally chose; it never falls back to a different target.
 */
async function retryAgentRequest(requestId) {
  const request = state.session
    ? state.sync.events.find((event) => event.type === "agent_request" && event.id === requestId)
    : undefined;
  if (!request || !state.session) return;
  sendError.textContent = "";
  try {
    await api.appendAgentRequest(
      state.session.id,
      retryAgentRequestInput(request, createIdempotencyKey("agent_request")),
    );
  } catch (error) {
    sendError.textContent = error.message ?? "The event was not accepted.";
  }
}

function openCreateDialog() {
  if (state.project?.role !== "owner" && state.project?.role !== "participant") return;
  element("create-error").textContent = "";
  const multi = createForm.querySelector("input[name='mode'][value='multi']");
  const solo = createForm.querySelector("input[name='mode'][value='solo']");
  const participant = state.project.role === "participant";
  multi.disabled = participant;
  if (participant) solo.checked = true;
  createDialog.showModal();
  requestAnimationFrame(() => element("session-name").focus());
}

function openCreateProjectDialog() {
  element("create-project-error").textContent = "";
  createProjectDialog.showModal();
  requestAnimationFrame(() => element("project-name").focus());
}

function openRenameProjectDialog() {
  if (!state.project || state.project.role !== "owner") return;
  renameProjectReturnFocus = document.activeElement;
  element("rename-project-error").textContent = "";
  element("rename-project-name").value = state.project.name;
  renameProjectDialog.showModal();
  requestAnimationFrame(() => element("rename-project-name").select());
}

function openRenameSessionDialog() {
  const membership = state.session?.members.find((member) => member.userId === state.currentUser?.id);
  if (!state.session) return;
  const mayRename = state.session.mode === "solo"
    ? membership?.role !== "viewer" && state.session.ownerUserId === state.currentUser?.id
    : membership?.role === "owner";
  if (!mayRename) return;
  renameSessionReturnFocus = document.activeElement;
  element("rename-session-error").textContent = "";
  element("rename-session-name").value = state.session.name;
  const mayChangeMode = state.project?.role === "owner"
    && state.session.ownerUserId === state.currentUser?.id;
  const modeField = element("rename-session-mode-field");
  const modeSelect = element("rename-session-mode");
  modeField.hidden = !mayChangeMode;
  modeSelect.disabled = !mayChangeMode;
  modeSelect.value = state.session.mode;
  renameSessionDialog.showModal();
  requestAnimationFrame(() => element("rename-session-name").select());
}

function openDeleteCloudDialog(type) {
  const target = type === "project" ? state.project : state.session;
  if (!target) return;
  const permitted = type === "project"
    ? state.project?.role === "owner"
    : state.session?.ownerUserId === state.currentUser?.id || state.project?.role === "owner";
  if (!permitted) return;
  pendingCloudDeletion = {
    type,
    id: target.id,
    name: target.name,
    projectId: type === "project" ? target.id : state.project.id,
  };
  deleteCloudReturnFocus = document.activeElement;
  element("delete-cloud-error").textContent = "";
  element("delete-cloud-description").textContent = type === "project"
    ? `Delete the cloud project “${target.name}” and all of its cloud sessions?`
    : `Delete the cloud session “${target.name}”?`;
  deleteCloudDialog.showModal();
  requestAnimationFrame(() => element("cancel-delete-cloud-button").focus());
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
      model: currentProjectProfile().model,
      contextWindowTokens: contextBudgetToTokenCeiling(state.settings),
      visibleHistorySync: state.settings.sync.visibleHistorySync,
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
    announce(platform === "posix" ? "Shell connector command copied."
      : platform === "powershell" ? "PowerShell connector command copied."
        : "Plugin install commands copied.");
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(commandNode);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = "Clipboard access is unavailable. The command is selected for manual copy.";
  }
}

function openConnectDshDialog() {
  if (!state.project) return;
  connectDshReturnFocus = document.activeElement;
  element("connect-dsh-start-command").textContent = DSH_START_COMMAND;
  element("connect-dsh-version-command").textContent = DSH_VERSION_COMMAND;
  element("connect-dsh-pinned-start-command").textContent = DSH_PINNED_START_COMMAND;
  element("connect-dsh-install-command").textContent = DSH_INSTALL_COMMAND;
  const configuredServer = api.baseUrl || location.origin;
  try {
    element("connect-dsh-server-url").textContent = new URL(configuredServer, location.origin).origin;
    element("connect-dsh-error").textContent = "";
  } catch {
    element("connect-dsh-server-url").textContent = "";
    element("connect-dsh-error").textContent = "The configured GatherThread server URL is invalid.";
  }
  for (const status of [element("copy-dsh-start-status"), element("copy-dsh-install-status")]) status.textContent = "";
  renderDshConnectionStatus();
  renderDshRuntimeList();
  if (!connectDshDialog.open) connectDshDialog.showModal();
  void refreshDshRuntimes({ announceFailure: true });
  requestAnimationFrame(() => element("close-connect-dsh-button").focus());
}

async function copyDshCommand(kind) {
  const node = element(kind === "install" ? "connect-dsh-install-command" : "connect-dsh-start-command");
  const status = element(kind === "install" ? "copy-dsh-install-status" : "copy-dsh-start-status");
  const value = node.textContent;
  if (!value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(value);
    status.textContent = "Copied.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = "Clipboard access is unavailable. The command is selected for manual copy.";
  }
}

function renderDshRuntimeList() {
  const list = element("connect-dsh-runtime-list");
  list.replaceChildren();
  const seenDevices = new Set();
  for (const runtime of dshRuntimeChoices(state.executionRuntimes, state.devices)) {
    if (seenDevices.has(runtime.deviceId)) continue;
    seenDevices.add(runtime.deviceId);
    const item = document.createElement("li");
    item.className = "dsh-runtime-row";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    const detail = document.createElement("small");
    name.textContent = runtime.deviceName;
    detail.textContent = `${runtime.status === "online" ? "Online" : "Offline"} · ${runtime.provider} · ${runtime.model} · last seen ${formatDateTime(runtime.lastSeenAt)}`;
    copy.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "dsh-runtime-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "text-button";
    rename.textContent = "Rename";
    rename.setAttribute("aria-label", `Rename ${runtime.deviceName}`);
    rename.addEventListener("click", () => void renameDshDevice(runtime));
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "text-button danger-text-button";
    revoke.textContent = "Revoke";
    revoke.setAttribute("aria-label", `Revoke ${runtime.deviceName}`);
    revoke.addEventListener("click", () => void revokeDshDevice(runtime));
    actions.append(rename, revoke);
    item.append(copy, actions);
    list.append(item);
  }
}

async function renameDshDevice(runtime) {
  const next = window.prompt(localizer.t("Choose a new name for this DeepSeek Harness device."), runtime.deviceName)?.trim();
  if (!next || next === runtime.deviceName) return;
  if (next.length > 120) {
    element("connect-dsh-error").textContent = "Choose a device name between 1 and 120 characters.";
    return;
  }
  try {
    await api.renameDevice(runtime.deviceId, next);
    await refreshDshRuntimes({ announceFailure: true });
    announce("DeepSeek Harness device renamed.");
  } catch (error) {
    element("connect-dsh-error").textContent = error?.message ?? "Unable to rename the DeepSeek Harness device.";
  }
}

async function revokeDshDevice(runtime) {
  if (!window.confirm(localizer.t(`Revoke ${runtime.deviceName}? Its DSH plugin must pair again before accepting requests.`))) return;
  try {
    await api.revokeDevice(runtime.deviceId);
    await refreshDshRuntimes({ announceFailure: true });
    announce("DeepSeek Harness device access revoked.");
  } catch (error) {
    element("connect-dsh-error").textContent = error?.message ?? "Unable to revoke the DeepSeek Harness device.";
  }
}

function maybeOpenPendingDshPairing() {
  if (!state.currentUser || !pendingDshPairingCode || approveDshPairingDialog.open) return;
  element("approve-dsh-pairing-code").textContent = pendingDshPairingCode;
  element("approve-dsh-pairing-error").textContent = "";
  approveDshPairingDialog.showModal();
  requestAnimationFrame(() => element("confirm-dsh-pairing-button").focus());
}

async function approvePendingDshPairing(event) {
  event.preventDefault();
  if (!pendingDshPairingCode || !state.currentUser) return;
  const submit = element("confirm-dsh-pairing-button");
  submit.disabled = true;
  element("approve-dsh-pairing-error").textContent = "";
  try {
    await api.approveDshPairing(pendingDshPairingCode);
    clearPendingDshPairing();
    approveDshPairingDialog.close();
    announce("DeepSeek Harness pairing approved. Waiting for the local plugin to come online.");
    openConnectDshDialog();
  } catch (error) {
    element("approve-dsh-pairing-error").textContent = error?.message ?? "Unable to approve this DeepSeek Harness pairing.";
  } finally {
    submit.disabled = false;
  }
}

function cancelPendingDshPairing() {
  clearPendingDshPairing();
  if (approveDshPairingDialog.open) approveDshPairingDialog.close();
}

function clearPendingDshPairing() {
  pendingDshPairingCode = "";
  element("approve-dsh-pairing-code").textContent = "";
  const remaining = withoutDshPairingHash(location.hash);
  history.replaceState(null, "", `${location.pathname}${location.search}${remaining ? `#${remaining}` : ""}`);
}

function announce(message) {
  element("announcement").textContent = "";
  requestAnimationFrame(() => {
    element("announcement").textContent = message;
  });
}

function showAttentionNotice(message) {
  clearTimeout(attentionNoticeTimer);
  attentionNoticeMessage.textContent = message;
  attentionNotice.hidden = false;
  attentionNoticeTimer = setTimeout(hideAttentionNotice, 8_000);
}

function hideAttentionNotice() {
  clearTimeout(attentionNoticeTimer);
  attentionNoticeTimer = undefined;
  attentionNotice.hidden = true;
}

function notifyConnectionLost() {
  const title = localizer.t("Live connection interrupted");
  const body = localizer.t("Trying to reconnect. Your draft is safe.");
  showAttentionNotice(`${title}. ${body}`);
  announce(`${title}. ${body}`);
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(`GatherThread · ${title}`, {
      body,
      tag: `gatherthread-connection-${state.sync.sessionId ?? "current"}`,
    });
  } catch {
    // The accessible in-page notice remains available when a system notification fails.
  }
}

function closeMembersPanelWithoutFocus() {
  memberPanel.classList.remove("member-panel-open");
  updateSidebarControls();
}

function applyVisualSettings(settings) {
  const normalized = normalizeSettings(settings);
  const root = document.documentElement;
  root.dataset.theme = normalized.appearance.theme;
  root.dataset.density = normalized.appearance.density;
  root.dataset.motion = normalized.appearance.motion;
  root.dataset.contrast = normalized.appearance.highContrast ? "high" : "standard";
  root.dataset.ambient = normalized.appearance.ambientCanvas;
  root.style.setProperty("--text-scale", String(normalized.appearance.textScalePercent / 100));
  root.style.setProperty("--left-rail-width", `${normalized.layout.leftRailPixels}px`);
  root.style.setProperty("--right-panel-width", `${normalized.layout.rightPanelPixels}px`);
  root.style.setProperty("--composer-height", `min(${normalized.layout.composerPixels}px, 44vh)`);
  composerLayoutResizer.setAttribute("aria-valuenow", String(normalized.layout.composerPixels));
  root.lang = normalized.general.locale;
  localizer.apply(normalized.general.locale);
  updateSidebarControls();
  updateSessionContextDisclosure();
  setAutomaticClaimDeviceName();
  ambientCanvas.apply(normalized);
}

function setAutomaticClaimDeviceName({ force = false } = {}) {
  const input = element("claim-device-name");
  const legacyAutomaticName = ["This browser", "当前浏览器", "此浏览器"].includes(input.value);
  if (!force && input.dataset.automatic === "false" && !legacyAutomaticName) return;
  input.value = automaticDeviceName();
  input.dataset.automatic = "true";
}

function renderModelOptions(select, selectedModel, settings = settingsPreview) {
  const models = [
    ...CODEX_MODELS.map((entry) => entry.id),
    ...settings.agents.customCodexModels.filter((model) => !CODEX_MODELS.some((entry) => entry.id === model)),
  ];
  select.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selectedModel;
    select.append(option);
  }
}

function effortOptionsForModel(model, settings = state.settings) {
  const known = CODEX_MODELS.find((entry) => entry.id === model);
  return known?.efforts ?? CODEX_REASONING_EFFORTS;
}

function updateEffortControl(modelSelect, effortSelect, requestedEffort, settings = state.settings) {
  const profile = normalizeCodexProfile({ model: modelSelect.value, effort: requestedEffort }, settings.agents.customCodexModels);
  effortSelect.replaceChildren();
  for (const effort of effortOptionsForModel(profile.model, settings)) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effort;
    option.selected = effort === profile.effort;
    effortSelect.append(option);
  }
}

function currentProjectProfile(settings = state.settings) {
  return state.project ? projectCodexProfile(settings, state.project.id) : normalizeCodexProfile(undefined);
}

function currentProjectHarness(settings = state.settings) {
  return state.project ? projectAgentHarness(settings, state.project.id) : "codex";
}

function currentProjectEnabledHarnesses(settings = state.settings) {
  return state.project ? projectEnabledHarnesses(settings, state.project.id) : ["codex"];
}

function renderDshRuntimeOptions(select, settings = state.settings) {
  const resolution = currentDshResolution(settings);
  select.replaceChildren();
  if (resolution.choices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No connected DSH runtime";
    select.append(option);
    select.disabled = true;
    return;
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = resolution.runtime ? "Choose a DSH runtime" : resolution.reason;
  placeholder.selected = resolution.runtime === null;
  select.append(placeholder);
  for (const runtime of resolution.choices) {
    const option = document.createElement("option");
    option.value = runtime.id;
    option.textContent = runtime.label;
    option.disabled = runtime.status !== "online";
    option.selected = runtime.id === resolution.runtime?.id;
    select.append(option);
  }
  select.disabled = false;
}

function renderAgentProfileControls() {
  const harness = currentProjectHarness();
  const enabledHarnesses = currentProjectEnabledHarnesses();
  const profile = currentProjectProfile();
  agentHarnessSelect.replaceChildren();
  for (const enabledHarness of enabledHarnesses) {
    const option = document.createElement("option");
    option.value = enabledHarness;
    option.textContent = enabledHarness === DSH_HARNESS ? "DeepSeek Harness" : "Codex";
    option.selected = enabledHarness === harness;
    agentHarnessSelect.append(option);
  }
  agentHarnessSelect.value = harness;
  renderModelOptions(agentModelSelect, profile.model, state.settings);
  updateEffortControl(agentModelSelect, agentEffortSelect, profile.effort, state.settings);
  renderDshRuntimeOptions(agentDshRuntimeSelect, state.settings);
  const disabled = !state.project;
  agentHarnessSelect.disabled = disabled;
  agentModelSelect.disabled = disabled;
  agentEffortSelect.disabled = disabled;
  element("codex-agent-profile-fields").hidden = harness !== "codex";
  element("dsh-agent-profile-fields").hidden = harness !== DSH_HARNESS;
}

function updateComposerAgentProfile(changed) {
  if (!state.project) return;
  const previous = currentProjectProfile();
  const requested = {
    model: agentModelSelect.value,
    effort: changed === "model" ? previous.effort : agentEffortSelect.value,
  };
  state.settings = settingsStore.set(withProjectCodexProfile(state.settings, state.project.id, requested));
  renderAgentProfileControls();
}

function updateComposerHarness() {
  if (!state.project) return;
  state.settings = settingsStore.set(withProjectAgentHarness(state.settings, state.project.id, agentHarnessSelect.value));
  if (agentHarnessSelect.value === DSH_HARNESS) {
    const resolution = currentDshResolution();
    if (resolution.runtime) {
      state.settings = settingsStore.set(withProjectDshProfile(state.settings, state.project.id, resolution.runtime));
    }
  }
  renderProjectAgentButtons();
  renderComposerPermissions();
}

function updateComposerDshRuntime() {
  if (!state.project || !agentDshRuntimeSelect.value) return;
  const selected = dshRuntimeChoices(state.executionRuntimes, state.devices)
    .find((runtime) => runtime.id === agentDshRuntimeSelect.value && runtime.status === "online");
  if (!selected) {
    renderComposerPermissions();
    return;
  }
  state.settings = settingsStore.set(withProjectDshProfile(state.settings, state.project.id, selected));
  renderProjectAgentButtons();
  renderComposerPermissions();
}

function settingsEnabledHarnesses() {
  return [
    ["settings-enabled-codex", "codex"],
    ["settings-enabled-dsh", DSH_HARNESS],
  ].filter(([id]) => element(id).checked).map(([, harness]) => harness);
}

function settingsAgentSummary(harness) {
  return harness === DSH_HARNESS
    ? "DeepSeek Harness supplies this project's runtime and handles new Agent requests by default."
    : "Codex supplies this project's connection command and handles new Agent requests by default.";
}

function syncSettingsAgentControls({ changedCheckbox } = {}) {
  const controls = [element("settings-enabled-codex"), element("settings-enabled-dsh")];
  let enabled = settingsEnabledHarnesses();
  if (enabled.length === 0) {
    changedCheckbox.checked = true;
    enabled = settingsEnabledHarnesses();
  }
  for (const control of controls) control.disabled = control.checked && enabled.length === 1;
  const harnessSelect = element("settings-agent-harness");
  for (const option of harnessSelect.options) {
    if (option.value === "codex" || option.value === DSH_HARNESS) option.disabled = !enabled.includes(option.value);
  }
  if (!enabled.includes(harnessSelect.value)) harnessSelect.value = enabled[0];
  const dsh = harnessSelect.value === DSH_HARNESS;
  element("settings-codex-agent-fields").hidden = dsh;
  element("settings-dsh-agent-fields").hidden = !dsh;
  element("settings-agent-summary").textContent = settingsAgentSummary(harnessSelect.value);
}

function populateSettingsForm(settings) {
  const normalized = normalizeSettings(settings);
  element("settings-locale").value = normalized.general.locale;
  element("settings-theme").value = normalized.appearance.theme;
  element("settings-text-scale").value = String(normalized.appearance.textScalePercent);
  element("settings-density").value = normalized.appearance.density;
  element("settings-motion").value = normalized.appearance.motion;
  element("settings-ambient-canvas").value = normalized.appearance.ambientCanvas;
  element("settings-high-contrast").checked = normalized.appearance.highContrast;
  element("settings-left-width").value = String(normalized.layout.leftRailPixels);
  element("settings-right-width").value = String(normalized.layout.rightPanelPixels);
  element("settings-composer-height").value = String(normalized.layout.composerPixels);
  element("settings-sync-mode").value = normalized.sync.mode;
  element("settings-visible-history-sync").value = normalized.sync.visibleHistorySync;
  const useMiB = normalized.sync.contextBudgetBytes >= 1024 * 1024 && normalized.sync.contextBudgetBytes % (1024 * 1024) === 0;
  element("settings-context-unit").value = useMiB ? "MiB" : "KiB";
  element("settings-context-budget").value = String(normalized.sync.contextBudgetBytes / (useMiB ? 1024 * 1024 : 1024));
  element("settings-enter-behavior").value = normalized.composer.enterBehavior;
  element("settings-confirm-agent").checked = normalized.composer.confirmAgentRequest;
  element("settings-auto-scroll").checked = normalized.composer.autoScroll;
  element("settings-notify-agent").checked = normalized.notifications.agentCompleted;
  element("settings-notify-connection").checked = normalized.notifications.connectionLost;
  const harness = currentProjectHarness(normalized);
  const enabledHarnesses = new Set(currentProjectEnabledHarnesses(normalized));
  element("settings-enabled-codex").checked = enabledHarnesses.has("codex");
  element("settings-enabled-dsh").checked = enabledHarnesses.has(DSH_HARNESS);
  element("settings-agent-harness").value = harness;
  const profile = currentProjectProfile(normalized);
  renderModelOptions(element("settings-default-model"), profile.model, normalized);
  updateEffortControl(element("settings-default-model"), element("settings-default-effort"), profile.effort, normalized);
  renderDshRuntimeOptions(element("settings-dsh-runtime"), normalized);
  syncSettingsAgentControls();
  syncAllNumericPresets();
  renderContextDiagnostic(normalized);
}

function readSettingsForm(baseSettings = settingsPreview) {
  const contextFactor = element("settings-context-unit").value === "MiB" ? 1024 * 1024 : 1024;
  let next = normalizeSettings({
    ...baseSettings,
    general: { locale: element("settings-locale").value },
    appearance: {
      theme: element("settings-theme").value,
      textScalePercent: Number(element("settings-text-scale").value),
      density: element("settings-density").value,
      motion: element("settings-motion").value,
      ambientCanvas: element("settings-ambient-canvas").value,
      highContrast: element("settings-high-contrast").checked,
    },
    layout: {
      leftRailPixels: Number(element("settings-left-width").value),
      rightPanelPixels: Number(element("settings-right-width").value),
      composerPixels: Number(element("settings-composer-height").value),
    },
    sync: {
      mode: element("settings-sync-mode").value,
      contextBudgetBytes: Math.round(Number(element("settings-context-budget").value) * contextFactor),
      visibleHistorySync: element("settings-visible-history-sync").value,
    },
    composer: {
      enterBehavior: element("settings-enter-behavior").value,
      confirmAgentRequest: element("settings-confirm-agent").checked,
      autoScroll: element("settings-auto-scroll").checked,
    },
    notifications: {
      agentCompleted: element("settings-notify-agent").checked,
      connectionLost: element("settings-notify-connection").checked,
    },
  });
  if (state.project) {
    next = withProjectCodexProfile(next, state.project.id, {
      model: element("settings-default-model").value,
      effort: element("settings-default-effort").value,
    });
    next = withProjectEnabledHarnesses(next, state.project.id, settingsEnabledHarnesses());
    next = withProjectAgentHarness(next, state.project.id, element("settings-agent-harness").value);
    if (element("settings-agent-harness").value === DSH_HARNESS) {
      const selected = dshRuntimeChoices(state.executionRuntimes, state.devices)
        .find((runtime) => runtime.id === element("settings-dsh-runtime").value && runtime.status === "online");
      if (selected) next = withProjectDshProfile(next, state.project.id, selected);
    }
  }
  return next;
}

function openSettingsDialog() {
  settingsReturnFocus = document.activeElement;
  settingsPreview = normalizeSettings(state.settings);
  populateSettingsForm(settingsPreview);
  applyVisualSettings(settingsPreview);
  const deviceInput = element("settings-device-name");
  deviceInput.value = currentDeviceName || automaticDeviceName();
  deviceInput.disabled = true;
  element("settings-device-status").textContent = localizer.t("Loading this device…");
  settingsDialog.showModal();
  void loadCurrentDeviceSettings();
  requestAnimationFrame(() => element("close-settings-button").focus());
}

async function loadCurrentDeviceSettings() {
  const generation = ++settingsDeviceLoadGeneration;
  const input = element("settings-device-name");
  const status = element("settings-device-status");
  try {
    const devices = await api.listDevices();
    if (generation !== settingsDeviceLoadGeneration || !settingsDialog.open) return;
    const current = devices.find((device) => device.id === state.currentUser?.device_id);
    if (!current) throw new Error(localizer.t("This device is unavailable."));
    currentDeviceName = current.name;
    input.value = current.name;
    input.disabled = false;
    status.textContent = "";
  } catch (error) {
    if (generation !== settingsDeviceLoadGeneration || !settingsDialog.open) return;
    input.disabled = true;
    status.textContent = error.message ?? localizer.t("Unable to load this device.");
  }
}

function cancelSettingsDialog() {
  settingsDeviceLoadGeneration += 1;
  applyVisualSettings(state.settings);
  settingsPreview = state.settings;
  if (settingsDialog.open) settingsDialog.close();
}

function resetSettingsPreview() {
  settingsPreview = normalizeSettings(DEFAULT_SETTINGS);
  populateSettingsForm(settingsPreview);
  applyVisualSettings(settingsPreview);
}

function updateSettingsPreviewFromForm() {
  if (!settingsDialog.open) return;
  settingsPreview = readSettingsForm(settingsPreview);
  applyVisualSettings(settingsPreview);
  renderContextDiagnostic(settingsPreview);
  syncAllNumericPresets();
}

function handleNumericPresetSelection(target, { focusCustom = false } = {}) {
  const action = numericPresetAction(target.id, target.value);
  if (action.kind === "preview") return false;
  if (action.kind === "focus") {
    if (focusCustom) element(action.inputId).focus();
    return true;
  }
  if (action.kind === "apply") {
    element(action.inputId).value = action.inputValue;
    if (action.unit) element("settings-context-unit").value = action.unit;
    updateSettingsPreviewFromForm();
  }
  return true;
}

function handleSettingsControlInput(event) {
  if (["settings-enabled-codex", "settings-enabled-dsh", "settings-agent-harness"].includes(event.target.id)) return;
  if (handleNumericPresetSelection(event.target)) return;
  if (event.target.classList?.contains("digits-only-input")) {
    const sanitized = digitsOnly(event.target.value);
    if (event.target.value !== sanitized) event.target.value = sanitized;
    if (!sanitized) {
      syncAllNumericPresets();
      if (event.target.id === "settings-context-budget") renderContextDiagnostic(settingsPreview);
      return;
    }
  }
  updateSettingsPreviewFromForm();
}

function handleSettingsControlChange(event) {
  if (event.target.id === "settings-default-model") {
    updateEffortControl(event.target, element("settings-default-effort"), element("settings-default-effort").value, settingsPreview);
  }
  if (event.target.id === "settings-enabled-codex" || event.target.id === "settings-enabled-dsh") {
    syncSettingsAgentControls({ changedCheckbox: event.target });
  }
  if (event.target.id === "settings-agent-harness") {
    const selectedCheckbox = event.target.value === DSH_HARNESS
      ? element("settings-enabled-dsh")
      : element("settings-enabled-codex");
    selectedCheckbox.checked = true;
    syncSettingsAgentControls();
  }
  if (handleNumericPresetSelection(event.target, { focusCustom: true })) return;
  updateSettingsPreviewFromForm();
}

async function saveSettings(event) {
  event.preventDefault();
  const contextBytes = contextBudgetInputBytes(
    element("settings-context-budget").value,
    element("settings-context-unit").value,
  );
  if (contextBytes == null || contextBytes < CONTEXT_BUDGET_MIN_BYTES || contextBytes > CONTEXT_BUDGET_MAX_BYTES) {
    renderContextDiagnostic(settingsPreview);
    element("settings-context-budget").focus();
    return;
  }
  element("settings-dsh-runtime-error").textContent = "";
  if (state.project
    && element("settings-agent-harness").value === DSH_HARNESS
    && !element("settings-dsh-runtime").value) {
    element("settings-dsh-runtime-error").textContent = "Connect and choose an online DeepSeek Harness runtime first.";
    element("settings-dsh-runtime").focus();
    return;
  }
  const deviceInput = element("settings-device-name");
  const deviceStatus = element("settings-device-status");
  const nextDeviceName = deviceInput.value.trim();
  if (!deviceInput.disabled && (!nextDeviceName || nextDeviceName.length > 120)) {
    deviceStatus.textContent = localizer.t("Choose a device name between 1 and 120 characters.");
    deviceInput.focus();
    return;
  }
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  const nextSettings = readSettingsForm(settingsPreview);
  const permissionRequest = notificationPermissionNeeded(nextSettings.notifications)
    ? ensureNotificationPermission()
    : Promise.resolve();
  try {
    await permissionRequest;
    if (!deviceInput.disabled && nextDeviceName !== currentDeviceName) {
      const updated = await api.renameDevice(state.currentUser.device_id, nextDeviceName);
      currentDeviceName = updated.name;
    }
    settingsPreview = nextSettings;
    state.settings = settingsStore.set(settingsPreview);
    connectionNoticeState = advanceConnectionNotice(
      INITIAL_CONNECTION_NOTICE_STATE,
      state.sync,
      state.settings.notifications.connectionLost,
    ).state;
    if (!state.settings.notifications.connectionLost) hideAttentionNotice();
    applyVisualSettings(state.settings);
    renderProjectAgentButtons();
    renderAgentProfileControls();
    if (state.session) {
      renderSessionDeliveryControls();
      void ensureCodexLocalSyncStatus();
    }
    settingsDeviceLoadGeneration += 1;
    settingsDialog.close();
    announce(localizer.t("Settings saved."));
  } catch (error) {
    deviceStatus.textContent = error.message ?? localizer.t("Unable to rename this device.");
    if (!deviceInput.disabled) deviceInput.focus();
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function ensureNotificationPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    // The in-page live status remains available when browser notifications are unavailable.
  }
}

function maybeNotifyAgentCompletion(event) {
  if (!state.settings.notifications.agentCompleted || event?.type !== "agent_response" || !document.hidden) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const content = eventContent(event);
  try {
    new Notification("GatherThread · Agent completed", {
      body: content ? content.slice(0, 180) : `${event.actor.username}'s Agent completed.`,
      tag: `gatherthread-agent-${event.id}`,
    });
  } catch {
    // Completion remains visible in the timeline if a system notification fails.
  }
}

function addCustomModelFromSettings() {
  const errorNode = element("settings-custom-model-error");
  const input = element("settings-custom-model");
  errorNode.textContent = "";
  try {
    settingsPreview = addCustomCodexModel(readSettingsForm(settingsPreview), input.value);
    const added = input.value.trim();
    input.value = "";
    renderModelOptions(element("settings-default-model"), added, settingsPreview);
    updateEffortControl(element("settings-default-model"), element("settings-default-effort"), "medium", settingsPreview);
    applyVisualSettings(settingsPreview);
  } catch (error) {
    errorNode.textContent = error.message ?? "Unable to add this model.";
    input.focus();
  }
}

function renderContextDiagnostic(settings) {
  const input = element("settings-context-budget");
  const rawValue = digitsOnly(input.value);
  const rawBytes = contextBudgetInputBytes(rawValue, element("settings-context-unit").value);
  const diagnostic = element("settings-context-diagnostic");
  if (!rawValue) {
    input.setAttribute("aria-invalid", "true");
    diagnostic.dataset.state = "warning";
    diagnostic.textContent = "Enter a whole number from 8 KiB to 5 MiB.";
    return;
  }
  if (rawBytes == null || rawBytes < CONTEXT_BUDGET_MIN_BYTES || rawBytes > CONTEXT_BUDGET_MAX_BYTES) {
    input.setAttribute("aria-invalid", "true");
    diagnostic.dataset.state = "warning";
    diagnostic.textContent = "The current value is outside the supported range of 8 KiB to 5 MiB.";
    return;
  }
  const result = effectiveContextBudget(settings, {
    maxContextBytes: settings.sync.contextBudgetBytes,
    label: "configured connector ceiling",
  });
  const approximateTokens = Math.max(4096, Math.floor(result.configuredBytes / 4));
  const enabledHarnesses = currentProjectEnabledHarnesses(settings);
  input.setAttribute("aria-invalid", "false");
  diagnostic.dataset.state = "valid";
  const connectorGuidance = enabledHarnesses.map((harness) => harness === DSH_HARNESS
    ? "DeepSeek Harness uses the context limit configured by its GatherThread plugin instead of this browser value. Reconnect the DSH plugin after changing its local limit."
    : "Reconnect Codex after changing this value. Codex Desktop Hooks use a separate 7 KiB capsule and continue across turns.").join(" ");
  diagnostic.textContent = `Configured projection ceiling: ${formatBytes(result.configuredBytes)} (about ${new Intl.NumberFormat().format(approximateTokens)} tokens at four UTF-8 bytes per token). The connected model's reported window remains the hard upper bound. ${connectorGuidance}`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(2))} MiB`;
  return `${Number((bytes / 1024).toFixed(1))} KiB`;
}

function syncPreset(selectId, inputId, values) {
  const value = Number(element(inputId).value);
  element(selectId).value = values.includes(value) ? String(value) : "custom";
}

function syncAllNumericPresets() {
  syncPreset("settings-text-scale-preset", "settings-text-scale", [90, 100, 110, 125]);
  syncPreset("settings-left-width-preset", "settings-left-width", [220, 260, 340]);
  syncPreset("settings-right-width-preset", "settings-right-width", [260, 290, 320, 380]);
  syncPreset("settings-composer-height-preset", "settings-composer-height", [220, 280, 380]);
  const factor = element("settings-context-unit").value === "MiB" ? 1024 * 1024 : 1024;
  const bytes = Number(element("settings-context-budget").value) * factor;
  const preset = element("settings-context-preset");
  preset.value = [...preset.options].some((option) => Number(option.value) === bytes) ? String(bytes) : "custom";
}

function installLayoutResizer(resizer, side) {
  const minimum = side === "left" ? 210 : 260;
  const maximum = side === "left" ? 420 : 480;
  const settingKey = side === "left" ? "leftRailPixels" : "rightPanelPixels";
  const inputId = side === "left" ? "settings-left-width" : "settings-right-width";
  const applyWidth = (pixels) => {
    const width = Math.round(Math.min(maximum, Math.max(minimum, pixels)));
    state.settings = settingsStore.set({
      ...state.settings,
      layout: { ...state.settings.layout, [settingKey]: width },
    });
    applyVisualSettings(state.settings);
    if (settingsDialog.open) {
      element(inputId).value = String(width);
      settingsPreview = state.settings;
      syncAllNumericPresets();
    }
    resizer.setAttribute("aria-valuenow", String(width));
  };
  resizer.setAttribute("aria-valuenow", String(state.settings.layout[settingKey]));
  resizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 1040px)").matches) return;
    resizer.focus();
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.dataset.dragging = "true";
    const move = (moveEvent) => applyWidth(side === "left" ? moveEvent.clientX : window.innerWidth - moveEvent.clientX);
    const finish = () => {
      delete resizer.dataset.dragging;
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", finish);
      resizer.removeEventListener("pointercancel", finish);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
  });
  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const signedDirection = side === "right" ? -direction : direction;
    applyWidth(state.settings.layout[settingKey] + signedDirection * (event.shiftKey ? 20 : 4));
  });
}

function installComposerLayoutResizer(resizer) {
  const minimum = 210;
  const maximum = 560;
  const applyHeight = (pixels) => {
    const viewportMaximum = Math.max(minimum, Math.min(maximum, Math.floor(window.innerHeight * 0.44)));
    const height = Math.round(Math.min(viewportMaximum, Math.max(minimum, pixels)));
    state.settings = settingsStore.set({
      ...state.settings,
      layout: { ...state.settings.layout, composerPixels: height },
    });
    applyVisualSettings(state.settings);
    if (settingsDialog.open) {
      element("settings-composer-height").value = String(height);
      settingsPreview = state.settings;
      syncAllNumericPresets();
    }
    resizer.setAttribute("aria-valuemax", String(viewportMaximum));
    resizer.setAttribute("aria-valuenow", String(height));
  };
  resizer.setAttribute("aria-valuenow", String(state.settings.layout.composerPixels));
  resizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 760px)").matches || resizer.hidden) return;
    resizer.focus();
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.dataset.dragging = "true";
    const move = (moveEvent) => {
      const bottom = sessionView.getBoundingClientRect().bottom;
      applyHeight(bottom - moveEvent.clientY);
    };
    const finish = () => {
      delete resizer.dataset.dragging;
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", finish);
      resizer.removeEventListener("pointercancel", finish);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
  });
  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    applyHeight(state.settings.layout.composerPixels + direction * (event.shiftKey ? 20 : 4));
  });
}
