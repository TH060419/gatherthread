import { HttpCollaborationApi, MockCollaborationApi } from "./api.js?v=20260922-1";
import {
  canAppend,
  canRetryFailedAgentRequest,
  createIdempotencyKey,
  createSelectionGuard,
  emptyProjectState,
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
} from "./domain.js?v=20260923-1";
import { SessionSync } from "./realtime.js";
import { mountCodeSync } from "./code-sync-view.js?v=20260924-1";
import { mountCodeStorageSettings } from "./code-storage-settings.js?v=20260924-2";
import { mountHistorySummaries } from "./history-summary-view.js";
import { DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS } from "./history-summary-policy.js";
import { createAmbientCanvas } from "./ambient-canvas.js?v=20260829-14";
import { createLocalizer, memberRemovalAriaLabel, memberRoleAriaLabel } from "./i18n.js?v=20260924-2";
import { automaticDeviceName } from "./device-name.js?v=20260830-1";
import {
  codexExecutionProfile,
  DSH_HARNESS,
  DSH_INSTALL_COMMAND,
  DSH_PINNED_START_COMMAND,
  DSH_START_COMMAND,
  DSH_VERSION_COMMAND,
  dshExecutionProfile,
  dshExecutionSelection,
  dshPairingCodeFromHash,
  dshRuntimeChoices,
  resolveCodexRuntime,
  resolveDshRuntime,
  withoutDshPairingHash,
} from "./dsh.js?v=20260922-1";
import { renderMarkdown } from "./markdown.js?v=20260829-1";
import {
  captureTimelineScroll,
  isTimelineAtBottom,
  scrollTimelineToBottom,
  settleTimelineScroll,
} from "./timeline-scroll.js?v=20260925-1";
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
  SHARED_LANGUAGE_STORAGE_KEY,
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
} from "./settings.js?v=20260922-1";

const query = new URLSearchParams(location.search);
const configuredApiUrl = query.get("api") ?? "";
const mockEnabled = query.get("mock") === "1";
const api = mockEnabled
  ? new MockCollaborationApi()
  : new HttpCollaborationApi({ baseUrl: configuredApiUrl });
const sync = new SessionSync(api);
const projectSelectionGuard = createSelectionGuard();
const settingsStore = createSettingsStore();

if (mockEnabled) {
  elementAfterReady("token-help", "Mock mode is enabled for this tab. Use demo-token.");
  elementAfterReady("test-access-help", "Mock mode is enabled for this tab. Use demo-test-access to try first-time activation.");
} else if (configuredApiUrl) {
  elementAfterReady("token-help", `Use your device token to sign in on ${configuredApiUrl}. The token is exchanged for a secure browser session and is never stored by the page.`);
  elementAfterReady("test-access-help", `Use a one-time test qualification code to activate an account on ${configuredApiUrl} and receive a device token.`);
}

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
let workspaceLoadGeneration = 0;
let pendingMessageSend = null;
let selectionRetry = null;
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
const localSyncActionsInFlight = new Set();
const retryingAgentRequestIds = new Set();
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
const claimTestAccessForm = element("claim-test-access-form");
const claimInvitationForm = element("claim-invitation-form");
const loginError = element("login-error");
const rememberedAccountSelect = element("remembered-account-select");
const forgetRememberedAccountButton = element("forget-remembered-account");
const authEntryChooser = element("auth-entry-chooser");
const authIdentity = element("auth-identity");
const authEntryChoices = [
  { entry: "login", button: element("auth-select-login"), panel: element("auth-login-panel") },
  { entry: "activate", button: element("auth-select-activate"), panel: element("auth-activate-panel") },
  { entry: "invitation", button: element("auth-select-invitation"), panel: element("auth-invitation-panel") },
];
const sessionList = element("session-list");
const projectSelect = element("project-select");
const sessionView = element("session-view");
const emptyState = element("empty-state");
const timeline = element("event-timeline");
const timelineRegion = element("timeline-region");
const timelineBottomButton = element("timeline-bottom-button");
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
const leaveProjectDialog = element("leave-project-dialog");
const leaveProjectForm = element("leave-project-form");
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
const agentDshModelSelect = element("agent-dsh-model-select");
const agentDshEffortSelect = element("agent-dsh-effort-select");
const attentionNotice = element("attention-notice");
const attentionNoticeMessage = element("attention-notice-message");
const ambientCanvas = createAmbientCanvas(element("ambient-canvas"));
const localizer = createLocalizer(document);
const codeSyncUi = mountCodeSync({
  document, api, localizer, mockEnabled,
  getContext: () => ({
    project: state.project,
    userId: state.currentUser?.id,
    canCreateProjects: state.currentUser?.can_create_projects === true,
    sessionId: state.session?.id,
    sessionWritable: canAppend({ session: state.session, currentUser: state.currentUser, connectionPhase: state.sync.phase, kind: "human_chat" }).allowed,
    runtimes: state.executionRuntimes,
    devices: state.devices,
    members: state.projectMembers,
    enabledHarnesses: state.project ? projectEnabledHarnesses(state.settings, state.project.id) : [],
  }),
});
const codeStorageSettings = mountCodeStorageSettings({
  document, api, localizer, getUserId: () => state.currentUser?.id ?? null,
});
const historySummaryUi = mountHistorySummaries({
  document, api, localizer, renderMarkdown,
  getContext: () => ({
    scope: `${authenticationGeneration}:${selectedSessionGeneration}:${state.currentUser?.id ?? ""}:${state.session?.id ?? ""}`,
    sessionId: state.session?.id,
    userId: state.currentUser?.id,
    events: state.sync.events,
    writable: canAppend({ session: state.session, currentUser: state.currentUser, connectionPhase: state.sync.phase, kind: "human_chat" }).allowed,
    executionProfile: historySummaryExecutionProfile(),
    instructions: state.settings.historySummaries.instructions,
  }),
  onChange: () => renderTimeline(),
});
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
let settingsHistoryPolicyGeneration = 0;
let settingsHistoryPolicy = null;
let attentionNoticeTimer;
let connectionNoticeState = INITIAL_CONNECTION_NOTICE_STATE;

applyVisualSettings(state.settings);
element("auth-language-button").addEventListener("click", () => {
  const locale = state.settings.general.locale === "zh-CN" ? "en" : "zh-CN";
  state.settings = settingsStore.set({ ...state.settings, general: { locale } });
  applyVisualSettings(state.settings);
});
window.addEventListener("storage", (event) => {
  if (event.key !== SHARED_LANGUAGE_STORAGE_KEY) return;
  state.settings = settingsStore.get();
  applyVisualSettings(state.settings);
  if (settingsDialog.open) populateSettingsForm(state.settings);
});
setAutomaticClaimDeviceName({ force: true });
element("claim-device-name").addEventListener("input", () => {
  element("claim-device-name").dataset.automatic = "false";
});

clearSensitiveInputs();
window.addEventListener("pagehide", () => {
  codeSyncUi.close();
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

function authenticationIdentity({ required = false } = {}) {
  const displayName = element("claim-display-name").value.trim();
  const deviceInput = element("claim-device-name");
  const deviceName = deviceInput.value.trim();
  if (required && (!displayName || !deviceName)) {
    throw new Error("Set a display name and device name above before continuing.");
  }
  return { displayName, deviceName, deviceNameEdited: deviceInput.dataset.automatic === "false" };
}

let activeAuthEntry = "choose";
let authRequestInProgress = false;
let rememberedAccounts = [];
let rememberedAccountsGeneration = 0;
let selectedRememberedAccountId = "";
let tokenEntryIdentity = null;

function selectRememberedAccount() {
  const account = rememberedAccounts.find((entry) => entry.id === rememberedAccountSelect.value);
  const nextId = account?.id ?? "";
  if (nextId && !selectedRememberedAccountId) {
    tokenEntryIdentity = {
      displayName: element("claim-display-name").value,
      deviceName: element("claim-device-name").value,
      automatic: element("claim-device-name").dataset.automatic,
    };
  }
  if (!nextId && selectedRememberedAccountId && tokenEntryIdentity) {
    element("claim-display-name").value = tokenEntryIdentity.displayName;
    element("claim-device-name").value = tokenEntryIdentity.deviceName;
    if (tokenEntryIdentity.automatic === undefined) delete element("claim-device-name").dataset.automatic;
    else element("claim-device-name").dataset.automatic = tokenEntryIdentity.automatic;
    tokenEntryIdentity = null;
  }
  element("token-entry").hidden = Boolean(account);
  element("token").disabled = Boolean(account);
  element("login-remember-control").hidden = Boolean(account);
  forgetRememberedAccountButton.hidden = !account;
  loginError.textContent = "";
  if (account && nextId !== selectedRememberedAccountId) {
    element("token").value = "";
    element("claim-display-name").value = account.display_name;
    element("claim-device-name").value = account.device_name;
    element("claim-device-name").dataset.automatic = "false";
  }
  selectedRememberedAccountId = nextId;
}

function renderRememberedAccounts() {
  const selected = rememberedAccountSelect.value;
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = localizer.t("Use a device access token");
  const options = rememberedAccounts.map((account) => {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = `${account.display_name} · ${account.device_name}`;
    option.setAttribute("data-i18n-skip", "");
    return option;
  });
  rememberedAccountSelect.replaceChildren(defaultOption, ...options);
  rememberedAccountSelect.value = rememberedAccounts.some((account) => account.id === selected) ? selected : "";
  element("remembered-account-control").hidden = rememberedAccounts.length === 0;
  selectRememberedAccount();
}

async function refreshRememberedAccounts() {
  const generation = ++rememberedAccountsGeneration;
  try {
    const accounts = await api.listRememberedAccounts();
    if (generation !== rememberedAccountsGeneration || authView.hidden) return;
    rememberedAccounts = Array.isArray(accounts) ? accounts : [];
    renderRememberedAccounts();
  } catch {
    if (generation !== rememberedAccountsGeneration) return;
    rememberedAccounts = [];
    renderRememberedAccounts();
    loginError.textContent = localizer.t("Remembered accounts are temporarily unavailable. You can still use a device token.");
  }
}

rememberedAccountSelect.addEventListener("change", selectRememberedAccount);
forgetRememberedAccountButton.addEventListener("click", async () => {
  const id = rememberedAccountSelect.value;
  if (!id || authRequestInProgress) return;
  forgetRememberedAccountButton.disabled = true;
  try {
    await api.forgetRememberedAccount(id);
    rememberedAccountSelect.value = "";
    await refreshRememberedAccounts();
    setAutomaticClaimDeviceName({ force: true });
    element("claim-display-name").value = "";
  } catch (error) {
    loginError.textContent = localizer.t(error.message ?? "Unable to forget this account.");
  } finally {
    forgetRememberedAccountButton.disabled = false;
  }
});

function setActiveAuthEntry(entry, { focus = false } = {}) {
  if (authRequestInProgress) return;
  activeAuthEntry = entry;
  authEntryChooser.hidden = entry !== "choose";
  authIdentity.hidden = entry === "choose";
  for (const choice of authEntryChoices) choice.panel.hidden = choice.entry !== entry;
  element("token").value = "";
  element("test-access-token").value = "";
  element("claim-invite-secret").value = "";
  loginError.textContent = "";
  element("test-access-error").textContent = "";
  element("claim-invite-error").textContent = "";
  if (focus) {
    const targetId = entry === "choose" ? "auth-select-login"
      : entry === "login" ? rememberedAccountSelect.value ? "remembered-account-select" : "token"
        : entry === "activate" || entry === "invitation" ? "claim-display-name"
          : "claim-invite-secret";
    element(targetId).focus();
  }
}

for (const choice of authEntryChoices) choice.button.addEventListener("click", () => setActiveAuthEntry(choice.entry, { focus: true }));
for (const button of document.querySelectorAll(".auth-entry-back")) {
  button.addEventListener("click", () => setActiveAuthEntry("choose", { focus: true }));
}

for (const id of ["claim-display-name", "claim-device-name"]) {
  element(id).addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (activeAuthEntry === "invitation") {
      if (element("claim-invite-secret").value.trim()) claimInvitationForm.requestSubmit();
      else element("claim-invite-secret").focus();
    } else if (activeAuthEntry === "activate") {
      if (element("test-access-token").value.trim()) claimTestAccessForm.requestSubmit();
      else element("test-access-token").focus();
    } else if (activeAuthEntry === "login") {
      if (rememberedAccountSelect.value || element("token").value.trim()) loginForm.requestSubmit();
      else element("token").focus();
    } else element("auth-select-login").focus();
  });
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (authRequestInProgress) return;
  const generation = ++authenticationGeneration;
  loginError.textContent = "";
  const data = new FormData(loginForm);
  const rememberedId = rememberedAccountSelect.value;
  const token = data.get("token")?.toString().trim() ?? "";
  if (!rememberedId && (!token || token.startsWith("gtq_"))) {
    loginError.textContent = localizer.t(token.startsWith("gtq_")
      ? "Use First-time activation for a test qualification code."
      : "Enter your device access token.");
    (rememberedAccountSelect.value ? rememberedAccountSelect : element("token")).focus();
    return;
  }
  const submit = loginForm.querySelector("button[type='submit']");
  authRequestInProgress = true;
  submit.disabled = true;
  submit.textContent = "Checking…";
  try {
    const rememberDevice = data.get("remember-device") === "on";
    const identity = authenticationIdentity({ required: Boolean(rememberedId) });
    const actor = rememberedId
      ? await api.activateRememberedAccount(rememberedId, { displayName: identity.displayName, deviceName: identity.deviceName })
      : await api.authenticate(token, {
        rememberDevice,
        ...(identity.displayName ? { displayName: identity.displayName } : {}),
        ...(identity.deviceNameEdited && identity.deviceName ? { deviceName: identity.deviceName } : {}),
      });
    if (generation !== authenticationGeneration) return;
    state.currentUser = actor;
    loginForm.reset();
    renderRememberedAccounts();
    element("claim-display-name").value = "";
    setAutomaticClaimDeviceName({ force: true });
    await enterWorkspace();
  } catch (error) {
    if (generation !== authenticationGeneration) return;
    loginError.textContent = localizer.t(error.message ?? "Unable to sign in.");
    (rememberedId ? rememberedAccountSelect : element("token")).focus();
  } finally {
    authRequestInProgress = false;
    submit.disabled = false;
    submit.textContent = `${localizer.t("Sign in")} →`;
  }
});

claimTestAccessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (authRequestInProgress) return;
  const generation = ++authenticationGeneration;
  const data = new FormData(claimTestAccessForm);
  const errorNode = element("test-access-error");
  const accessToken = data.get("test-access-token")?.toString().trim() ?? "";
  errorNode.textContent = "";
  if (!accessToken) {
    errorNode.textContent = localizer.t("Enter your test qualification code.");
    element("test-access-token").focus();
    return;
  }
  const submit = claimTestAccessForm.querySelector("button[type='submit']");
  authRequestInProgress = true;
  submit.disabled = true;
  submit.textContent = "Activating…";
  try {
    const identity = authenticationIdentity({ required: true });
    const result = await api.claimTestAccess({
      accessToken,
      displayName: identity.displayName,
      deviceName: identity.deviceName,
      rememberDevice: data.get("remember-device") === "on",
    });
    if (generation !== authenticationGeneration) return;
    state.currentUser = result.actor;
    showNewDeviceAccessToken(result.accessToken);
    claimTestAccessForm.reset();
    element("claim-display-name").value = "";
    setAutomaticClaimDeviceName({ force: true });
    await enterWorkspace();
  } catch (error) {
    if (generation !== authenticationGeneration) return;
    errorNode.textContent = localizer.t(error.message ?? "Unable to activate this account.");
    element("test-access-token").focus();
  } finally {
    authRequestInProgress = false;
    submit.disabled = false;
    submit.textContent = `${localizer.t("Activate account")} →`;
  }
});

claimInvitationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (authRequestInProgress) return;
  const generation = ++authenticationGeneration;
  const data = new FormData(claimInvitationForm);
  const errorNode = element("claim-invite-error");
  const submit = claimInvitationForm.querySelector("button[type='submit']");
  errorNode.textContent = "";
  authRequestInProgress = true;
  submit.disabled = true;
  submit.textContent = "Joining…";
  try {
    const identity = authenticationIdentity({ required: true });
    const result = await api.claimInvitation({
      inviteToken: data.get("invite-secret")?.toString().trim() ?? "",
      displayName: identity.displayName,
      deviceName: identity.deviceName,
      rememberDevice: data.get("remember-device") === "on",
    });
    if (generation !== authenticationGeneration) return;
    state.currentUser = result.actor;
    showNewDeviceAccessToken(result.accessToken);
    claimInvitationForm.reset();
    element("claim-display-name").value = "";
    setAutomaticClaimDeviceName({ force: true });
    await enterWorkspace(result.invitation.projectId);
  } catch (error) {
    if (generation !== authenticationGeneration) return;
    errorNode.textContent = localizer.t(error.message ?? "Unable to claim this invitation.");
    element("claim-invite-secret").focus();
  } finally {
    authRequestInProgress = false;
    submit.disabled = false;
    submit.textContent = localizer.t("Join project");
  }
});

element("logout-button").addEventListener("click", async () => {
  authenticationGeneration += 1;
  projectSelectionGuard.invalidate();
  selectedSessionGeneration += 1;
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  stopDshRuntimePolling();
  clearCreatedInvitationSecret();
  clearNewDeviceAccessToken();
  const button = element("logout-button");
  button.disabled = true;
  try {
    await api.logout?.();
  } catch {
    loginError.textContent = "The server could not confirm logout. If it is offline, close this browser tab to end the local session.";
  } finally {
    resetWorkspaceToAuth();
    void refreshRememberedAccounts();
    button.disabled = false;
    (rememberedAccountSelect.value ? rememberedAccountSelect : element("token")).focus();
  }
});

acceptInvitationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isCurrent = captureWorkspaceScope();
  const errorNode = element("accept-invite-error");
  const submit = acceptInvitationForm.querySelector("button[type='submit']");
  const inviteSecret = new FormData(acceptInvitationForm).get("invite-secret")?.toString().trim() ?? "";
  errorNode.textContent = "";
  submit.disabled = true;
  submit.textContent = "Accepting…";
  try {
    const result = await api.acceptInvitation(inviteSecret);
    if (!isCurrent()) return;
    acceptInvitationForm.reset();
    const projects = await api.listProjects();
    if (!isCurrent()) return;
    state.projects = projects;
    await selectProject(result.invitation.projectId);
    announce("Invitation accepted. You joined the project.");
  } catch (error) {
    if (!isCurrent()) return;
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
  const isCurrent = captureWorkspaceScope();
  const projectId = state.project.id;
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
    const result = await api.createInvitation(projectId, {
      role: rolePolicy.allowedRoles.includes(requestedRole) ? requestedRole : rolePolicy.defaultRole,
      ttl: data.get("ttl")?.toString() ?? "24h",
    });
    if (!isCurrent()) return;
    createdInvitationSecret = result.inviteToken;
    element("created-invite-secret").textContent = createdInvitationSecret;
    element("created-invitation").hidden = false;
    state.invitations = [result.invitation, ...state.invitations.filter((item) => item.id !== result.invitation.id)];
    renderInvitations();
    announce("Invitation created. Copy the secret now.");
  } catch (error) {
    if (!isCurrent()) return;
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
  if (selectionRetry?.type === "project") void selectProject(selectionRetry.id);
  else if (selectionRetry?.type === "session") void selectSession(selectionRetry.id);
  else if (state.project) openCreateDialog();
  else openCreateProjectDialog();
});
element("cancel-create-button").addEventListener("click", () => createDialog.close());
element("dialog-cancel-button").addEventListener("click", () => createDialog.close());
element("new-project-button").addEventListener("click", openCreateProjectDialog);
element("topbar-create-project-button").addEventListener("click", openCreateProjectDialog);
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
let pendingMemberRemoval = null;
let memberRemovalGeneration = 0;
async function openMemberRemovalDialog(userId, username, isSelf) {
  if (!state.project || !userId) return;
  const projectId = state.project.id;
  const generation = ++memberRemovalGeneration;
  pendingMemberRemoval = { projectId, userId, isSelf, branch: null };
  element("leave-project-title").textContent = isSelf ? localizer.t("Leave this project?")
    : `${localizer.t("Remove member")}: ${username}?`;
  element("leave-project-description").textContent = isSelf
    ? localizer.t("You will lose access to cloud sessions and code. Local files and Agent conversations stay on your device.")
    : `${username}: ${localizer.t("This member will lose access to cloud sessions and code. Their local files and Agent conversations stay on their device.")}`;
  element("confirm-leave-project-button").textContent = localizer.t(isSelf ? "Leave project" : "Remove member");
  element("leave-project-error").textContent = "";
  element("leave-project-branch-choice").hidden = true;
  element("confirm-leave-project-button").disabled = true;
  leaveProjectDialog.showModal();
  try {
    const status = await api.getProjectCode(projectId);
    if (generation !== memberRemovalGeneration || !leaveProjectDialog.open || state.project?.id !== projectId) return;
    const branch = status.branches.find((item) => item.user_id === userId) ?? null;
    pendingMemberRemoval.branch = branch;
    const choice = element("leave-project-branch-resolution");
    choice.replaceChildren();
    element("leave-project-branch-choice").hidden = !branch;
    if (branch) {
      choice.add(new Option(localizer.t("Choose what happens to the cloud branch…"), ""));
      if (branch.review_status === "merged") choice.add(new Option(localizer.t("Owner merged this branch to main; remove the branch"), "merged_to_main"));
      choice.add(new Option(localizer.t("Delete this member's cloud branch without merging"), "delete"));
      choice.value = "";
      element("leave-project-branch-note").textContent = branch.review_status === "merged"
        ? localizer.t("Choose explicitly. Main keeps the reviewed work and counts against the owner's quota; removing the branch releases this member's quota.")
        : localizer.t("To preserve this work, ask the owner to review and merge it to main before leaving. Otherwise choose deletion. Local Git is unchanged; backups follow their retention period.");
    }
    element("confirm-leave-project-button").disabled = Boolean(branch);
    requestAnimationFrame(() => element(branch ? "leave-project-branch-resolution" : "cancel-leave-project-button").focus());
  } catch (error) {
    if (generation === memberRemovalGeneration && leaveProjectDialog.open) {
      element("leave-project-error").textContent = error.message ?? localizer.t("Unable to check cloud branches.");
    }
  }
}
element("leave-project-button").addEventListener("click", () => {
  if (state.project && state.currentUser && ["participant", "viewer"].includes(state.project.role)) {
    void openMemberRemovalDialog(state.currentUser.id, state.currentUser.username, true);
  }
});
element("leave-project-branch-resolution").addEventListener("change", () => {
  element("confirm-leave-project-button").disabled = Boolean(pendingMemberRemoval?.branch)
    && !element("leave-project-branch-resolution").value;
});
element("close-leave-project-button").addEventListener("click", () => leaveProjectDialog.close());
element("cancel-leave-project-button").addEventListener("click", () => leaveProjectDialog.close());
leaveProjectDialog.addEventListener("close", () => { memberRemovalGeneration += 1; pendingMemberRemoval = null; });
leaveProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const context = pendingMemberRemoval;
  if (!context || state.project?.id !== context.projectId) return;
  const { projectId, userId, isSelf, branch } = context;
  const resolution = element("leave-project-branch-resolution").value;
  if (branch && !resolution) return;
  const submit = element("confirm-leave-project-button");
  submit.disabled = true;
  element("leave-project-error").textContent = "";
  try {
    await api.removeProjectMember(projectId, userId, branch ? {
      branch_resolution: resolution, expected_branch_head_commit: branch.head_commit,
    } : {});
    if (state.project?.id !== projectId) return;
    leaveProjectDialog.close();
    if (!isSelf) {
      const [members, sessions, sessionMembers] = await Promise.all([
        api.listProjectMembers(projectId), api.listProjectSessions(projectId),
        state.session ? api.listMembers(state.session.id) : Promise.resolve([]),
      ]);
      if (state.project?.id !== projectId) return;
      state.projectMembers = members;
      state.sessions = sessions;
      if (state.session) state.session = { ...state.session, members: sessionMembers };
      renderMembers();
      renderSessionList();
      announce(localizer.t("Member removed. Their local Git was not changed."));
      return;
    }
    codeSyncUi.close();
    sync.disconnect();
    stopMemberRefresh();
    stopSnapshotPolling();
    stopDshRuntimePolling();
    selectedSessionGeneration += 1;
    projectSelectionGuard.invalidate();
    state.project = null;
    state.session = null;
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    await enterWorkspace();
    announce("You left the project. Local files and Agent conversations were not changed.");
  } catch (error) {
    element("leave-project-error").textContent = error.message ?? "Unable to remove this member.";
  } finally {
    submit.disabled = !leaveProjectDialog.open || Boolean(pendingMemberRemoval?.branch)
      && !element("leave-project-branch-resolution").value;
  }
});
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
  const isCurrent = captureWorkspaceScope();
  const projectId = state.project?.id;
  const errorNode = element("create-error");
  const submit = createForm.querySelector("button[type='submit']");
  const data = new FormData(createForm);
  errorNode.textContent = "";
  submit.disabled = true;
  try {
    if (!projectId) throw new Error("Create a project first.");
    const created = await api.createSession(projectId, {
      name: data.get("name")?.toString() ?? "",
      mode: data.get("mode")?.toString() ?? "multi",
      idempotencyKey: createIdempotencyKey("create-session"),
    });
    if (!isCurrent()) return;
    const sessions = await api.listProjectSessions(projectId);
    if (!isCurrent()) return;
    state.sessions = sessions;
    renderSessionList();
    createDialog.close();
    createForm.reset();
    await selectSession(created.id);
  } catch (error) {
    if (!isCurrent()) return;
    errorNode.textContent = error.message ?? "Unable to create the session.";
  } finally {
    submit.disabled = false;
  }
});

createProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isCurrent = captureWorkspaceScope();
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
    if (!isCurrent()) return;
    const projects = await api.listProjects();
    if (!isCurrent()) return;
    state.projects = projects;
    createProjectDialog.close();
    createProjectForm.reset();
    await selectProject(created.id);
  } catch (error) {
    if (!isCurrent()) return;
    errorNode.textContent = error.message ?? "Unable to create the project.";
  } finally {
    submit.disabled = false;
  }
});

renameProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isCurrent = captureWorkspaceScope();
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
    if (!isCurrent() || state.project?.id !== projectId) return;
    state.project = { ...state.project, ...renamed };
    state.projects = state.projects.map((project) => project.id === projectId ? { ...project, ...renamed } : project);
    renderProjectSelect();
    renameProjectDialog.close();
    announce("Project renamed.");
  } catch (error) {
    if (!isCurrent()) return;
    errorNode.textContent = error.message ?? "Unable to rename the project.";
    element("rename-project-name").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Save name";
  }
});

renameSessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isCurrent = captureWorkspaceScope();
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
    if (!isCurrent() || state.session?.id !== sessionId) return;
    updateSessionMetadata(sessionId, renamed);
    renameSessionDialog.close();
    announce("Session updated.");
  } catch (error) {
    if (!isCurrent()) return;
    errorNode.textContent = error.message ?? "Unable to rename the session.";
    element("rename-session-name").focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Save changes";
  }
});

deleteCloudForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isCurrent = captureWorkspaceScope();
  const target = pendingCloudDeletion;
  if (!target) return;
  const submit = element("confirm-delete-cloud-button");
  const errorNode = element("delete-cloud-error");
  errorNode.textContent = "";
  submit.disabled = true;
  try {
    if (target.type === "session") {
      await api.deleteSession(target.id);
      if (!isCurrent()) return;
      if (state.session?.id === target.id) {
        sync.disconnect();
        stopMemberRefresh();
        stopSnapshotPolling();
        selectedSessionGeneration += 1;
        state.session = null;
      }
      deleteCloudReturnFocus = null;
      deleteCloudDialog.close();
      const refreshIsCurrent = captureWorkspaceScope();
      const projects = await api.listProjects();
      if (!refreshIsCurrent()) return;
      state.projects = projects;
      location.hash = new URLSearchParams({ project: target.projectId }).toString();
      await selectProject(target.projectId);
      announce("Session deleted from cloud. Local copies were not changed.");
    } else {
      await api.deleteProject(target.id);
      if (!isCurrent()) return;
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
    if (!isCurrent()) return;
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
agentDshModelSelect.addEventListener("change", () => updateComposerDshExecutionProfile("model"));
agentDshEffortSelect.addEventListener("change", () => updateComposerDshExecutionProfile("effort"));
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
  if (button && !button.disabled) void retryAgentRequest(button.dataset.requestId, button);
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
    if (generation !== authenticationGeneration) return;
    if (!actor) {
      await refreshRememberedAccounts();
      return;
    }
    state.currentUser = actor;
    await enterWorkspace();
  } catch (error) {
    if (generation !== authenticationGeneration) return;
    resetWorkspaceToAuth();
    void refreshRememberedAccounts();
    loginError.textContent = error.message ?? "Unable to restore this browser session.";
  }
}

function resetWorkspaceToAuth() {
  authenticationGeneration += 1;
  workspaceLoadGeneration += 1;
  pendingMessageSend?.restore?.();
  pendingMessageSend = null;
  selectionRetry = null;
  codeSyncUi.close();
  codeSyncUi.closeNotice();
  if (connectCodexDialog.open) connectCodexDialog.close();
  if (connectDshDialog.open) connectDshDialog.close();
  if (approveDshPairingDialog.open) approveDshPairingDialog.close();
  if (renameSessionDialog.open) renameSessionDialog.close();
  if (renameProjectDialog.open) renameProjectDialog.close();
  if (createDialog.open) createDialog.close();
  if (createProjectDialog.open) createProjectDialog.close();
  cancelSettingsDialog();
  if (deleteCloudDialog.open) deleteCloudDialog.close();
  if (leaveProjectDialog.open) leaveProjectDialog.close();
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  stopDshRuntimePolling();
  selectedSessionGeneration += 1;
  historySummaryUi.reset();
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
  messageInput.value = "";
  codeSyncUi.updateContext();
  selectedCodexLocalRuntimeId = "";
  localSyncStatusRequestsInFlight.clear();
  localSyncActionsInFlight.clear();
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
  claimTestAccessForm.reset();
  claimInvitationForm.reset();
  authRequestInProgress = false;
  setActiveAuthEntry("choose");
  setAutomaticClaimDeviceName({ force: true });
}

// Async UI responses belong to one authenticated selection, even when a user
// leaves and returns to the same project/session before a request finishes.
function captureWorkspaceScope() {
  const authentication = authenticationGeneration;
  const selection = selectedSessionGeneration;
  const actor = state.currentUser;
  return () => authentication === authenticationGeneration
    && selection === selectedSessionGeneration && actor === state.currentUser;
}

async function enterWorkspace(preferredProjectId) {
  const authentication = authenticationGeneration;
  const load = ++workspaceLoadGeneration;
  const selection = selectedSessionGeneration;
  if (!state.currentUser) return;
  const isCurrent = () => authentication === authenticationGeneration
    && load === workspaceLoadGeneration && Boolean(state.currentUser);
  authView.hidden = true;
  workspace.hidden = false;
  const noticeDeviceId = state.currentUser.device_id;
  if (deviceCredentialDialog.open) {
    deviceCredentialDialog.addEventListener("close", () => {
      if (authentication === authenticationGeneration && state.currentUser?.device_id === noticeDeviceId && !workspace.hidden) {
        codeSyncUi.showFirstLoginNotice(noticeDeviceId);
      }
    }, { once: true });
  } else {
    codeSyncUi.showFirstLoginNotice(noticeDeviceId);
  }
  element("current-username").textContent = state.currentUser.username;
  element("current-user-avatar").textContent = initials(state.currentUser.username);
  const projects = await api.listProjects();
  if (!isCurrent() || selection !== selectedSessionGeneration) return;
  state.projects = projects;
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
    renderProjectSelect();
    codeSyncUi.updateContext();
    renderSessionList();
    sessionView.hidden = true;
    emptyState.hidden = false;
    const empty = emptyProjectState(state.currentUser.can_create_projects === true);
    element("empty-state-eyebrow").textContent = "No project yet";
    element("empty-state-title").textContent = empty.title;
    element("empty-state-description").textContent = empty.description;
    element("empty-create-button").hidden = !empty.canCreateProjects;
    element("empty-create-button").textContent = "Create project";
    localizer.apply(state.settings.general.locale);
    element("new-session-button").hidden = true;
    element("owner-invitations").hidden = true;
  }
  if (!isCurrent()) return;
  maybeOpenPendingDshPairing();
}

async function selectProject(projectId) {
  if (!state.currentUser) return;
  selectionRetry = null;
  codeSyncUi.close();
  historySummaryUi.reset();
  const selection = projectSelectionGuard.begin(projectId);
  sync.disconnect();
  stopMemberRefresh();
  stopSnapshotPolling();
  stopDshRuntimePolling();
  selectedSessionGeneration += 1;
  state.project = null;
  state.sessions = [];
  state.projectMembers = [];
  state.session = null;
  state.executionRuntimes = [];
  clearCreatedInvitationSecret();
  renderSessionList();
  renderMembers();
  renderWorkspaceContext();
  renderProjectPermissions();
  renderComposerPermissions();
  void renderInvitationControls();
  sessionView.hidden = true;
  emptyState.hidden = false;
  element("empty-state-eyebrow").textContent = "No sessions yet";
  element("empty-state-description").textContent = "Create a solo room for observers or a multi room for active collaboration.";
  element("empty-state-title").textContent = localizer.t("Loading project…");
  try {
    const project = await api.getProject(projectId);
    if (!projectSelectionGuard.isCurrent(selection)) return;
    state.project = project;
    codeSyncUi.updateContext();
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
    localizer.apply(state.settings.general.locale);
    renderMembers();
  } catch (error) {
    if (!projectSelectionGuard.isCurrent(selection)) return;
    selectionRetry = { type: "project", id: projectId };
    element("empty-create-button").hidden = false;
    element("empty-create-button").textContent = localizer.t("Retry");
    element("empty-state-title").textContent = localizer.t("Unable to open this project. Select it again to retry.");
    announce(error.message ?? localizer.t("Unable to open this project. Select it again to retry."));
  }
}

async function selectSession(sessionId) {
  if (!state.currentUser || !state.project) return;
  selectionRetry = null;
  codeSyncUi.close();
  historySummaryUi.reset();
  if (state.session?.id !== sessionId) expandedWorklogs.clear();
  const generation = ++selectedSessionGeneration;
  const projectId = state.project.id;
  sync.disconnect();
  stopMemberRefresh();
  stopDshRuntimePolling();
  state.session = null;
  state.executionRuntimes = [];
  renderComposerPermissions();
  renderProjectPermissions();
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
  downloadCodexButton.removeAttribute("aria-busy");
  importVisibleHistoryButton.removeAttribute("aria-busy");
  downloadCodexButton.disabled = true;
  try {
    const [session, members] = await Promise.all([
      api.getSession(sessionId),
      api.listMembers(sessionId),
    ]);
    if (generation !== selectedSessionGeneration) return;
    state.session = { ...session, members };
    state.executionRuntimes = [];
    startMemberRefresh(sessionId);
    location.hash = new URLSearchParams({ project: projectId, session: sessionId }).toString();
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
  } catch (error) {
    if (generation !== selectedSessionGeneration) return;
    selectionRetry = { type: "session", id: sessionId };
    element("empty-create-button").hidden = false;
    element("empty-create-button").textContent = localizer.t("Retry");
    sessionView.hidden = true;
    emptyState.hidden = false;
    element("empty-state-title").textContent = localizer.t("Unable to open this session. Select it again to retry.");
    announce(error.message ?? localizer.t("Unable to open this session. Select it again to retry."));
  }
}

function renderProjectSelect() {
  projectSelect.replaceChildren();
  if (!state.projects.length) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = localizer.t("No projects yet");
    projectSelect.append(placeholder);
  }
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    option.selected = project.id === state.project?.id;
    projectSelect.append(option);
  }
  projectSelect.disabled = state.projects.length < 2;
  element("new-project-button").hidden = state.currentUser?.can_create_projects !== true;
  renderProjectAgentButtons();
  renderDshConnectionStatus();
  element("delete-project-button").hidden = state.project?.role !== "owner";
  element("rename-project-button").hidden = state.project?.role !== "owner";
  element("leave-project-button").hidden = !["participant", "viewer"].includes(state.project?.role);
  element("topbar-create-project-button").hidden = !!state.project || state.currentUser?.can_create_projects !== true;
  renderWorkspaceContext();
}

function renderProjectAgentButtons(settings = state.settings) {
  const enabled = state.project ? new Set(projectEnabledHarnesses(settings, state.project.id)) : new Set();
  connectCodexButton.hidden = !enabled.has("codex");
  connectDshButton.hidden = !enabled.has(DSH_HARNESS);
}

function renderProjectPermissions() {
  codeSyncUi.updateContext();
  const mayCreate = state.project?.role === "owner" || state.project?.role === "participant";
  element("new-session-button").hidden = !mayCreate;
  element("empty-create-button").hidden = !mayCreate;
  element("delete-project-button").hidden = state.project?.role !== "owner";
  element("rename-project-button").hidden = state.project?.role !== "owner";
  element("leave-project-button").hidden = !["participant", "viewer"].includes(state.project?.role);
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
  const load = {};
  dshRuntimeLoadInFlight = load;
  try {
    const [runtimesResult, devicesResult] = await Promise.allSettled([
      api.listSessionRuntimes(sessionId),
      api.listDevices(),
    ]);
    if (generation !== selectedSessionGeneration || state.session?.id !== sessionId) return;
    if (runtimesResult.status === "rejected") throw runtimesResult.reason;
    state.executionRuntimes = runtimesResult.value;
    state.devices = devicesResult.status === "fulfilled" ? devicesResult.value : [];
    if (state.project && projectAgentHarness(state.settings, state.project.id) === DSH_HARNESS) {
      const storedProfile = projectDshProfile(state.settings, state.project.id);
      const resolved = resolveDshRuntime(state.executionRuntimes, state.devices, storedProfile);
      if (resolved.runtime) {
        const selected = dshExecutionSelection(resolved.runtime, storedProfile);
        const normalizedProfile = dshStoredProjectProfile(resolved.runtime, selected);
        const profileChanged = storedProfile === null
          || storedProfile.runtimeId !== normalizedProfile.runtimeId
          || storedProfile.deviceId !== normalizedProfile.deviceId
          || storedProfile.provider !== normalizedProfile.provider
          || storedProfile.model !== normalizedProfile.model
          || (storedProfile.effort ?? "") !== (normalizedProfile.effort ?? "");
        if (profileChanged) {
          state.settings = settingsStore.set(withProjectDshProfile(
            state.settings,
            state.project.id,
            normalizedProfile,
          ));
        }
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
    if (dshRuntimeLoadInFlight === load) dshRuntimeLoadInFlight = false;
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
  const isCurrent = captureWorkspaceScope();
  memberRefreshInFlight = isCurrent;
  try {
    const members = await api.listMembers(sessionId);
    if (!isCurrent() || state.session?.id !== sessionId) return;
    state.session = { ...state.session, members };
    renderMembers();
    renderTimeline();
    renderComposerPermissions();
    renderSessionDeliveryControls();
  } catch (error) {
    if (!isCurrent() || state.session?.id !== sessionId) return;
    if (error?.status === 403 || error?.status === 404) {
      sync.disconnect();
      stopMemberRefresh();
      stopSnapshotPolling();
      selectedSessionGeneration += 1;
      state.session = null;
      location.hash = "";
      announce("Your access to the open collaboration was removed.");
      const refreshIsCurrent = captureWorkspaceScope();
      try {
        await enterWorkspace();
      } catch (refreshError) {
        if (!refreshIsCurrent()) return;
        resetWorkspaceToAuth();
        loginError.textContent = refreshError?.message ?? "Unable to refresh your remaining projects.";
      }
    }
    // Transient presence failures retry without discarding confirmed history.
  } finally {
    if (memberRefreshInFlight === isCurrent) memberRefreshInFlight = false;
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
      roleSelect.setAttribute("aria-label", memberRoleAriaLabel(member.username, localizer.t));
      for (const value of ["participant", "viewer"]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = value === member.role;
        roleSelect.append(option);
      }
      roleSelect.addEventListener("change", () => void changeProjectMemberRole(member, roleSelect));
      details.append(roleSelect);
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "member-remove-button";
      removeButton.textContent = localizer.t("Remove member");
      removeButton.setAttribute("aria-label", memberRemovalAriaLabel(member.username, localizer.t));
      removeButton.addEventListener("click", () => void openMemberRemovalDialog(member.userId, member.username, false));
      details.append(removeButton);
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
  const isCurrent = captureWorkspaceScope();
  const projectId = state.project.id;
  const sessionId = state.session?.id;
  const previousRole = member.role;
  select.disabled = true;
  try {
    await api.setProjectMemberRole(projectId, member.userId, select.value);
    if (!isCurrent()) return;
    const [projectMembers, sessions, members] = await Promise.all([
      api.listProjectMembers(projectId), api.listProjectSessions(projectId),
      sessionId ? api.listMembers(sessionId) : Promise.resolve([]),
    ]);
    if (!isCurrent()) return;
    state.projectMembers = projectMembers;
    if (state.session) {
      state.session = { ...state.session, members };
      renderMembers();
      renderComposerPermissions();
    }
    state.sessions = sessions;
    renderSessionList();
    announce(`${member.username} is now a ${select.value}.`);
  } catch (error) {
    if (!isCurrent()) return;
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
  const isCurrent = captureWorkspaceScope();
  const projectId = state.project.id;
  const status = element("invitation-list-status");
  const refresh = element("refresh-invitations-button");
  status.textContent = "Loading invitations…";
  refresh.disabled = true;
  try {
    const invitations = await api.listInvitations(projectId);
    if (!isCurrent() || state.project?.id !== projectId || (selection && !projectSelectionGuard.isCurrent(selection))) return;
    state.invitations = invitations.map(normalizeInvitation);
    renderInvitations();
  } catch (error) {
    if (isCurrent() && (!selection || projectSelectionGuard.isCurrent(selection))) {
      status.textContent = error.message ?? "Unable to load invitations.";
    }
  } finally {
    if (isCurrent() && (!selection || projectSelectionGuard.isCurrent(selection))) refresh.disabled = false;
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
  const isCurrent = captureWorkspaceScope();
  const projectId = state.project.id;
  button.disabled = true;
  element("create-invitation-error").textContent = "";
  try {
    const revoked = await api.revokeInvitation(projectId, invitation.id);
    if (!isCurrent() || state.project?.id !== projectId) return;
    state.invitations = state.invitations.map((item) => item.id === revoked.id ? revoked : item);
    renderInvitations();
    announce("Invitation revoked.");
  } catch (error) {
    if (!isCurrent()) return;
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
  for (const id of ["token", "test-access-token", "claim-invite-secret", "accept-invite-secret", "claim-display-name"]) {
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
  historySummaryUi.updateContext();
  const events = historySummaryUi.events().filter(isTimelineEventVisible);
  const summaryView = historySummaryUi.timeline();
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
    for (const version of summaryView.before.get(event.id) ?? []) {
      const summaryItem = document.createElement("li");
      summaryItem.append(historySummaryUi.card(version));
      timeline.append(summaryItem);
    }
    if (summaryView.hidden.has(event.id)) continue;
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
    const sourceControl = historySummaryUi.sourceControl(event);
    if (sourceControl) identity.prepend(sourceControl);
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
        }).allowed || retryingAgentRequestIds.has(request.id);
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
  renderTimelineBottomControl();
}

/**
 * Offer the jump back to the newest event exactly when the reader is not at it.
 * The rule is the same one auto-follow uses, so the control never offers to
 * scroll somewhere the reader already is.
 */
function renderTimelineBottomControl() {
  timelineBottomButton.hidden = isTimelineAtBottom(timelineRegion);
}

function returnToNewestEvent() {
  scrollTimelineToBottom(
    timelineRegion,
    state.settings.appearance.motion === "reduce" ? "auto" : "smooth",
  );
  renderTimelineBottomControl();
}

timelineRegion.addEventListener("scroll", renderTimelineBottomControl, { passive: true });
timelineBottomButton.addEventListener("click", returnToNewestEvent);

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
  const isCurrent = captureWorkspaceScope();
  const errorNode = element("snapshot-request-error");
  errorNode.textContent = "";
  downloadCodexButton.disabled = true;
  downloadCodexButton.setAttribute("aria-busy", "true");
  try {
    const request = await api.createSnapshotRequest(state.session.id, "immutable");
    if (!isCurrent() || state.session?.id !== sessionId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderSnapshotRequests();
    announce(`Snapshot queued through sequence ${request.throughSequence}.`);
    startSnapshotPolling();
  } catch (error) {
    if (!isCurrent()) return;
    errorNode.textContent = error.message ?? "Unable to queue this Codex snapshot.";
  } finally {
    if (isCurrent()) {
      downloadCodexButton.disabled = false;
      downloadCodexButton.removeAttribute("aria-busy");
    }
  }
}

async function createVisibleHistoryImport() {
  if (!state.session || importVisibleHistoryButton.disabled) return;
  const sessionId = state.session.id;
  const isCurrent = captureWorkspaceScope();
  const statusNode = element("visible-history-import-status");
  statusNode.textContent = "";
  importVisibleHistoryButton.disabled = true;
  importVisibleHistoryButton.setAttribute("aria-busy", "true");
  try {
    const request = await api.createSnapshotRequest(sessionId, "visible_history_replace");
    if (!isCurrent() || state.session?.id !== sessionId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderVisibleHistoryImportStatus();
    announce(`Visible Codex history import queued through sequence ${request.throughSequence}.`);
    startSnapshotPolling();
  } catch (error) {
    if (!isCurrent()) return;
    statusNode.textContent = error.message ?? localizer.t("Unable to queue visible Codex history import.");
  } finally {
    if (isCurrent()) {
      importVisibleHistoryButton.disabled = false;
      importVisibleHistoryButton.removeAttribute("aria-busy");
    }
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
  if (!selectedCodexLocalRuntimeId && runtimes.length === 1) selectedCodexLocalRuntimeId = runtimes[0].id;
  const selectedRuntime = runtimes.find((runtime) => runtime.id === selectedCodexLocalRuntimeId);
  codexLocalRuntimeSelect.replaceChildren();
  if (!selectedRuntime) {
    const option = document.createElement("option");
    option.value = selectedCodexLocalRuntimeId;
    option.textContent = localizer.t(selectedCodexLocalRuntimeId ? "Selected device is offline" : "Choose a local Agent device");
    option.selected = true;
    codexLocalRuntimeSelect.append(option);
  }
  for (const runtime of runtimes) {
    const option = document.createElement("option");
    option.value = runtime.id;
    option.textContent = codexLocalRuntimeLabel(runtime);
    option.selected = runtime.id === selectedCodexLocalRuntimeId;
    codexLocalRuntimeSelect.append(option);
  }
  codexLocalRuntimeField.hidden = runtimes.length < 2 && Boolean(selectedRuntime);
  codexLocalRuntimeSelect.disabled = runtimes.length === 0 || (runtimes.length === 1 && Boolean(selectedRuntime));

  if (!selectedRuntime) {
    codexAutoUploadToggle.checked = false;
    codexAutoUploadToggle.disabled = true;
    uploadLocalTurnsButton.disabled = true;
    codexLocalSyncStatus.textContent = localizer.t(selectedCodexLocalRuntimeId ? "Selected device is offline"
      : runtimes.length ? "Choose a local Agent device" : "No online Codex device is available.");
    return;
  }

  const requests = codexLocalSyncRequests(selectedCodexLocalRuntimeId);
  const latest = requests[0];
  const completed = requests.find((request) => request.status === "completed" && request.result);
  const active = localSyncActionsInFlight.has(`${authenticationGeneration}:${state.session.id}:${selectedCodexLocalRuntimeId}`)
    || (latest && new Set(["queued", "claimed", "importing", "compacting"]).has(latest.status));
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
  if (!sessionId || codexLocalSyncControls.hidden || !onlineCodexLocalRuntimes().some((runtime) => runtime.id === runtimeId)) return;
  const isCurrent = captureWorkspaceScope();
  if (codexLocalSyncRequests(runtimeId).length > 0) return;
  const key = `${authenticationGeneration}:${sessionId}:${runtimeId}`;
  if (localSyncStatusRequestsInFlight.has(key)) return;
  localSyncStatusRequestsInFlight.add(key);
  try {
    const request = await api.createSnapshotRequest(sessionId, "local_sync_status", runtimeId);
    if (!isCurrent() || state.session?.id !== sessionId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderCodexLocalSyncControls();
    startSnapshotPolling();
  } catch (error) {
    if (isCurrent() && state.session?.id === sessionId && selectedCodexLocalRuntimeId === runtimeId) {
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
  if (codexLocalSyncControls.hidden || !onlineCodexLocalRuntimes().some((runtime) => runtime.id === runtimeId)) return;
  const button = kind === "local_turn_upload" ? uploadLocalTurnsButton : codexAutoUploadToggle;
  if (button.disabled) return;
  const isCurrent = captureWorkspaceScope();
  const key = `${authenticationGeneration}:${sessionId}:${runtimeId}`;
  if (localSyncActionsInFlight.has(key)) return;
  localSyncActionsInFlight.add(key);
  let failure = "";
  codexAutoUploadToggle.disabled = true;
  uploadLocalTurnsButton.disabled = true;
  codexLocalSyncStatus.textContent = localizer.t("Reading local-to-cloud upload status…");
  try {
    const request = await api.createSnapshotRequest(sessionId, kind, runtimeId);
    if (!isCurrent() || state.session?.id !== sessionId) return;
    state.snapshotRequests = [request, ...state.snapshotRequests];
    renderCodexLocalSyncControls();
    startSnapshotPolling();
  } catch (error) {
    failure = error?.message ?? localizer.t("Unable to update local-to-cloud upload settings.");
  } finally {
    localSyncActionsInFlight.delete(key);
    if (isCurrent()) {
      renderCodexLocalSyncControls();
      if (failure && selectedCodexLocalRuntimeId === runtimeId) codexLocalSyncStatus.textContent = failure;
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
  if (pendingMessageSend && !pendingMessageSend()) {
    pendingMessageSend.restore();
    pendingMessageSend = null;
  }
  codeSyncUi.updateContext();
  const common = { session: state.session, currentUser: state.currentUser, connectionPhase: state.sync.phase };
  const chat = canAppend({ ...common, kind: "human_chat" });
  const harness = currentProjectHarness();
  const resolution = harness === DSH_HARNESS ? currentDshResolution() : currentCodexResolution();
  const agentAllowed = chat.allowed && resolution.runtime !== null;
  const agentReason = chat.allowed ? resolution.reason : chat.reason;
  const sending = Boolean(pendingMessageSend?.());
  sendChatButton.disabled = sending || !chat.allowed;
  sendAgentButton.disabled = sending || !agentAllowed;
  messageInput.disabled = !chat.allowed && !agentAllowed;
  element("composer-permission").textContent = chat.allowed ? "" : chat.reason;
  const dshSelection = harness === DSH_HARNESS && resolution.runtime
    ? dshExecutionSelection(
      resolution.runtime,
      state.project ? projectDshProfile(state.settings, state.project.id) : null,
    )
    : null;
  element("agent-target-label").textContent = agentAllowed
    ? harness === DSH_HARNESS
      ? `${resolution.runtime.deviceName} · ${dshSelection.provider} · ${dshSelection.model}${dshSelection.reasoningEffort ? ` · ${dshSelection.reasoningEffort}` : ""}`
      : `${resolution.runtime.harness} · ${resolution.runtime.provider} · ${agentModelSelect.value}`
    : agentReason;
  renderAgentProfileControls();
  historySummaryUi.updateContext();
}

function historySummaryExecutionProfile() {
  if (!state.session || !state.project) return null;
  const harness = currentProjectHarness();
  const resolution = harness === DSH_HARNESS ? currentDshResolution() : currentCodexResolution();
  const runtime = resolution.runtime;
  const advertised = state.executionRuntimes.find((candidate) => candidate.id === runtime?.id);
  if (!runtime || advertised?.purpose === "snapshot_connector"
    || (advertised?.userId && advertised.userId !== state.currentUser?.id)) return null;
  try {
    return harness === DSH_HARNESS
      ? dshExecutionProfile(runtime, dshExecutionSelection(runtime, projectDshProfile(state.settings, state.project.id)))
      : codexExecutionProfile(runtime, { model: agentModelSelect.value, reasoningEffort: agentEffortSelect.value });
  } catch { return null; }
}

async function sendMessage(kind) {
  const content = messageInput.value.trim();
  if (!content || !state.session) {
    sendError.textContent = content ? "Choose a session first." : "Write a message first.";
    messageInput.focus();
    return;
  }
  const button = kind === "human_chat" ? sendChatButton : sendAgentButton;
  if (button.disabled || pendingMessageSend?.()) return;
  sendError.textContent = "";
  if (kind === "agent_request" && state.settings.composer.confirmAgentRequest
    && !window.confirm("Start this Agent request with the selected harness and model?")) {
    messageInput.focus();
    return;
  }
  const isCurrent = captureWorkspaceScope();
  const sessionId = state.session.id;
  const draft = messageInput.value;
  const original = [...button.childNodes];
  isCurrent.restore = () => button.replaceChildren(...original);
  pendingMessageSend = isCurrent;
  renderComposerPermissions();
  button.textContent = "Sending…";
  try {
    const input = { content, idempotencyKey: createIdempotencyKey(kind) };
    if (kind === "human_chat") await api.appendHumanChat(sessionId, input);
    else {
      const harness = currentProjectHarness();
      const executionProfile = harness === DSH_HARNESS
        ? dshExecutionProfile(
          currentDshResolution().runtime,
          dshExecutionSelection(
            currentDshResolution().runtime,
            projectDshProfile(state.settings, state.project.id),
          ),
        )
        : codexExecutionProfile(currentCodexResolution().runtime, {
          model: agentModelSelect.value,
          reasoningEffort: agentEffortSelect.value,
        });
      await api.appendAgentRequest(sessionId, { ...input, executionProfile });
    }
    if (isCurrent() && messageInput.value === draft) {
      messageInput.value = "";
      messageInput.focus();
    }
  } catch (error) {
    if (isCurrent()) sendError.textContent = error.message ?? "The event was not accepted.";
  } finally {
    if (pendingMessageSend === isCurrent) {
      pendingMessageSend = null;
      isCurrent.restore();
      renderComposerPermissions();
    }
  }
}

/**
 * Re-run a failed request. The recorded execution profile is replayed verbatim,
 * so the retry targets the same harness, provider, model, and runtime the user
 * originally chose; it never falls back to a different target.
 */
async function retryAgentRequest(requestId, button) {
  if (retryingAgentRequestIds.has(requestId)) return;
  const request = state.session
    ? state.sync.events.find((event) => event.type === "agent_request" && event.id === requestId)
    : undefined;
  if (!request || !state.session) return;
  const isCurrent = captureWorkspaceScope();
  retryingAgentRequestIds.add(requestId);
  button.disabled = true;
  sendError.textContent = "";
  try {
    await api.appendAgentRequest(
      state.session.id,
      retryAgentRequestInput(request, createIdempotencyKey("agent_request")),
    );
  } catch (error) {
    if (isCurrent()) sendError.textContent = error.message ?? "The event was not accepted.";
  } finally {
    retryingAgentRequestIds.delete(requestId);
    if (button.isConnected) button.disabled = false;
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
  if (state.currentUser?.can_create_projects !== true) return;
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
  const isCurrent = captureWorkspaceScope();
  const next = window.prompt(localizer.t("Choose a new name for this DeepSeek Harness device."), runtime.deviceName)?.trim();
  if (!next || next === runtime.deviceName) return;
  if (next.length > 120) {
    element("connect-dsh-error").textContent = "Choose a device name between 1 and 120 characters.";
    return;
  }
  try {
    await api.renameDevice(runtime.deviceId, next);
    if (!isCurrent()) return;
    await refreshDshRuntimes({ announceFailure: true });
    announce("DeepSeek Harness device renamed.");
  } catch (error) {
    if (!isCurrent()) return;
    element("connect-dsh-error").textContent = error?.message ?? "Unable to rename the DeepSeek Harness device.";
  }
}

async function revokeDshDevice(runtime) {
  const isCurrent = captureWorkspaceScope();
  if (!window.confirm(localizer.t(`Revoke ${runtime.deviceName}? Its DSH plugin must pair again before accepting requests.`))) return;
  try {
    await api.revokeDevice(runtime.deviceId);
    if (!isCurrent()) return;
    await refreshDshRuntimes({ announceFailure: true });
    announce("DeepSeek Harness device access revoked.");
  } catch (error) {
    if (!isCurrent()) return;
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
  const isCurrent = captureWorkspaceScope();
  const pairingCode = pendingDshPairingCode;
  const submit = element("confirm-dsh-pairing-button");
  submit.disabled = true;
  element("approve-dsh-pairing-error").textContent = "";
  try {
    await api.approveDshPairing(pairingCode);
    if (!isCurrent() || pendingDshPairingCode !== pairingCode) return;
    clearPendingDshPairing();
    approveDshPairingDialog.close();
    announce("DeepSeek Harness pairing approved. Waiting for the local plugin to come online.");
    openConnectDshDialog();
  } catch (error) {
    if (!isCurrent() || pendingDshPairingCode !== pairingCode) return;
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
  const localeChanged = root.lang !== normalized.general.locale;
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
  element("auth-language-button").textContent = normalized.general.locale === "zh-CN" ? "EN" : "中";
  if (localeChanged && state.session) renderTimeline();
  if (localeChanged && state.project) renderMembers();
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

function dshStoredProjectProfile(runtime, selection) {
  return {
    runtimeId: runtime.id,
    deviceId: runtime.deviceId,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { effort: selection.reasoningEffort } : {}),
  };
}

function dshModelOptionValue(provider, model) {
  return JSON.stringify([provider, model]);
}

function renderDshExecutionControls(runtime, storedProfile) {
  const profiles = runtime?.executionProfiles ?? [];
  const dynamic = profiles.length > 0;
  const selection = runtime ? dshExecutionSelection(runtime, storedProfile) : null;
  const modelLabel = element("agent-dsh-model-label");
  const effortLabel = element("agent-dsh-effort-label");
  const hasReasoning = dynamic && selection.reasoningEfforts.length > 0;
  modelLabel.hidden = !dynamic;
  agentDshModelSelect.hidden = !dynamic;
  effortLabel.hidden = !hasReasoning;
  agentDshEffortSelect.hidden = !hasReasoning;
  element("agent-request-profile").dataset.layout = dynamic ? "dsh-dynamic" : "dsh-fixed";

  agentDshModelSelect.replaceChildren();
  if (dynamic) {
    const providers = new Set(profiles.map((profile) => profile.provider));
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = dshModelOptionValue(profile.provider, profile.model);
      option.dataset.provider = profile.provider;
      option.dataset.model = profile.model;
      option.textContent = providers.size > 1 ? `${profile.provider} · ${profile.model}` : profile.model;
      option.selected = profile.provider === selection.provider && profile.model === selection.model;
      agentDshModelSelect.append(option);
    }
  }

  agentDshEffortSelect.replaceChildren();
  if (hasReasoning) {
    for (const effort of selection.reasoningEfforts) {
      const option = document.createElement("option");
      option.value = effort;
      option.textContent = effort;
      option.selected = effort === selection.reasoningEffort;
      agentDshEffortSelect.append(option);
    }
  }
  agentDshModelSelect.disabled = !state.project || !dynamic;
  agentDshEffortSelect.disabled = !state.project || !hasReasoning;
  return selection;
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
  const dshResolution = currentDshResolution();
  renderDshExecutionControls(
    dshResolution.runtime,
    state.project ? projectDshProfile(state.settings, state.project.id) : null,
  );
  const disabled = !state.project;
  agentHarnessSelect.disabled = disabled;
  agentModelSelect.disabled = disabled;
  agentEffortSelect.disabled = disabled;
  element("codex-agent-profile-fields").hidden = harness !== "codex";
  element("dsh-agent-profile-fields").hidden = harness !== DSH_HARNESS;
  if (harness !== DSH_HARNESS) element("agent-request-profile").dataset.layout = "codex";
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
      const selected = dshExecutionSelection(resolution.runtime, projectDshProfile(state.settings, state.project.id));
      state.settings = settingsStore.set(withProjectDshProfile(
        state.settings,
        state.project.id,
        dshStoredProjectProfile(resolution.runtime, selected),
      ));
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
  const executionSelection = dshExecutionSelection(selected, projectDshProfile(state.settings, state.project.id));
  state.settings = settingsStore.set(withProjectDshProfile(
    state.settings,
    state.project.id,
    dshStoredProjectProfile(selected, executionSelection),
  ));
  renderProjectAgentButtons();
  renderComposerPermissions();
}

function updateComposerDshExecutionProfile(changed) {
  if (!state.project) return;
  const resolution = currentDshResolution();
  if (!resolution.runtime?.executionProfiles?.length) return;
  const option = agentDshModelSelect.selectedOptions[0];
  if (!option) return;
  const previous = projectDshProfile(state.settings, state.project.id);
  const selected = dshExecutionSelection(resolution.runtime, {
    provider: option.dataset.provider,
    model: option.dataset.model,
    effort: changed === "model" ? previous?.effort : agentDshEffortSelect.value,
  });
  state.settings = settingsStore.set(withProjectDshProfile(
    state.settings,
    state.project.id,
    dshStoredProjectProfile(resolution.runtime, selected),
  ));
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
  element("settings-history-summary-instructions").value = normalized.historySummaries.instructions;
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
    historySummaries: { instructions: element("settings-history-summary-instructions").value },
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
      if (selected) {
        const executionSelection = dshExecutionSelection(selected, projectDshProfile(next, state.project.id));
        next = withProjectDshProfile(next, state.project.id, dshStoredProjectProfile(selected, executionSelection));
      }
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
  void codeStorageSettings.load();
  void loadCurrentDeviceSettings();
  void loadHistoryContextPolicy();
  requestAnimationFrame(() => element("close-settings-button").focus());
}

async function loadHistoryContextPolicy() {
  const generation = ++settingsHistoryPolicyGeneration;
  const isCurrent = captureWorkspaceScope();
  const projectId = state.project?.id;
  const select = element("settings-history-context-mode");
  const status = element("settings-history-context-status");
  settingsHistoryPolicy = null;
  select.disabled = true;
  element("settings-history-context-retry").hidden = true;
  status.textContent = localizer.t(projectId ? "Loading Agent context policy…" : "Choose a project to set Agent context policy.");
  if (!projectId) return;
  try {
    const result = await api.getProjectContextPolicy(projectId);
    if (!isCurrent() || generation !== settingsHistoryPolicyGeneration || !settingsDialog.open) return;
    if (!["summary", "original"].includes(result.mode)) throw new Error("Unable to load Agent context policy.");
    settingsHistoryPolicy = { projectId, mode: result.mode };
    select.value = result.mode;
    select.disabled = false;
    status.textContent = "";
  } catch (error) {
    if (!isCurrent() || generation !== settingsHistoryPolicyGeneration || !settingsDialog.open) return;
    status.textContent = localizer.t("Unable to load Agent context policy.");
    element("settings-history-context-retry").hidden = false;
  }
}

element("settings-history-context-retry").addEventListener("click", () => void loadHistoryContextPolicy());
element("settings-history-summary-reset").addEventListener("click", () => {
  element("settings-history-summary-instructions").value = DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS;
  element("settings-history-summary-error").textContent = "";
  updateSettingsPreviewFromForm();
});

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
  codeStorageSettings.cancel();
  settingsDeviceLoadGeneration += 1;
  settingsHistoryPolicyGeneration += 1;
  settingsHistoryPolicy = null;
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
  const isCurrent = captureWorkspaceScope();
  const deviceId = state.currentUser?.device_id;
  const dialogGeneration = settingsDeviceLoadGeneration;
  const summaryInstructions = element("settings-history-summary-instructions").value;
  element("settings-history-summary-error").textContent = "";
  if (!summaryInstructions.trim() || summaryInstructions.length > 4000) {
    element("settings-history-summary-error").textContent = localizer.t("Summary instructions must contain 1 to 4000 characters.");
    element("settings-history-summary-instructions").focus();
    return;
  }
  const policy = settingsHistoryPolicy && settingsHistoryPolicy.projectId === state.project?.id
    ? { ...settingsHistoryPolicy, nextMode: element("settings-history-context-mode").value } : null;
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
  // Browser permission UI may remain pending (notably in embedded browsers).
  // It must not block saving unrelated workspace preferences.
  if (notificationPermissionNeeded(nextSettings.notifications)) void ensureNotificationPermission();
  let savingContextPolicy = false;
  try {
    if (!isCurrent() || !settingsDialog.open || dialogGeneration !== settingsDeviceLoadGeneration) return;
    if (!deviceInput.disabled && nextDeviceName !== currentDeviceName) {
      const updated = await api.renameDevice(deviceId, nextDeviceName);
      if (!isCurrent() || !settingsDialog.open || dialogGeneration !== settingsDeviceLoadGeneration) return;
      currentDeviceName = updated.name;
    }
    if (policy && policy.nextMode !== policy.mode) {
      savingContextPolicy = true;
      await api.setProjectContextPolicy(policy.projectId, policy.nextMode);
      if (!isCurrent() || !settingsDialog.open || dialogGeneration !== settingsDeviceLoadGeneration) return;
      savingContextPolicy = false;
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
    codeStorageSettings.cancel();
    settingsDialog.close();
    announce(localizer.t("Settings saved."));
  } catch (error) {
    if (!isCurrent() || !settingsDialog.open || dialogGeneration !== settingsDeviceLoadGeneration) return;
    if (savingContextPolicy) {
      element("settings-history-context-status").textContent = localizer.t("Unable to save Agent context policy. Retry saving settings.");
      element("settings-history-context-mode").focus();
      return;
    }
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
    ? "DeepSeek Harness: automatic compaction follows its native model and plugin settings, not this browser value. Oversized first imports may still exceed native limits."
    : `Codex: use the native model window first; fallback ${formatBytes(result.configuredBytes)} (about ${new Intl.NumberFormat().format(approximateTokens)} tokens). Reconnect Codex after changing the fallback. Codex Desktop Hooks retain a separate 7 KiB transfer capsule.`).join(" ");
  diagnostic.textContent = `Native context management. ${connectorGuidance}`;
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
