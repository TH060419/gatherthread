import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Git checkouts may use CRLF on Windows; source extraction below uses LF sentinels.
const source = (await readFile(new URL("../src/main.js", import.meta.url), "utf8")).replace(/\r\n?/gu, "\n");
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const noop = () => {};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// Execute the actual event handlers/functions without starting the app's polling
// or accessing a real account. Dependencies below are bounded UI/API doubles.
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, name);
  const tail = source.slice(start);
  const end = tail.indexOf("\n}\n") + 2;
  assert.ok(end > 1, name);
  return tail.slice(0, end);
}

function element() {
  return {
    value: "", textContent: "", hidden: false, disabled: false, childNodes: [], children: [],
    focus: noop, reset: noop, setAttribute: noop, removeAttribute: noop,
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; this.childNodes = children; },
  };
}

function harness(names, overrides = {}) {
  const nodes = new Map();
  const context = vm.createContext({
    exampleMode: false,
    authenticationGeneration: 1, selectedSessionGeneration: 1, workspaceLoadGeneration: 0,
    state: { currentUser: { id: "u1", username: "User", device_id: "d1" }, project: { id: "p1" },
      projects: [], session: { id: "s1" }, settings: { composer: {} }, invitations: [], snapshotRequests: [] },
    element: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    authView: element(), workspace: element(), emptyState: element(), sessionView: element(),
    hostedAgentStatus: { enabled: false },
    cloudGithubUi: { updateContext: noop, completeAuthorization: async () => {} },
    deviceCredentialDialog: { open: false }, codeSyncUi: { showFirstLoginNotice: noop },
    onboarding: { cancel: noop, offer: noop, refreshLanguage: noop },
    sessionContextDetails: { open: false }, updateSessionContextDisclosure: noop,
    location: { hash: "" }, URLSearchParams, initials: () => "U", localizer: { t: (value) => value },
    renderProjectSelect: noop, renderSessionList: noop, maybeOpenPendingDshPairing: noop,
    renderCurrentAvatar: noop, applyAvatarProfiles: noop,
    renderMembers: noop, renderTimeline: noop, renderComposerPermissions: noop,
    renderSessionDeliveryControls: noop, announce: noop,
    memberRefreshInFlight: false, avatarProfilesRefreshInFlight: null, stopMemberRefresh: noop, stopSnapshotPolling: noop,
    sync: { disconnect: noop }, resetWorkspaceToAuth: noop,
    ...overrides,
    api: { getAccountAvatar: async () => ({ user_id: "u1", avatar_id: null }), listAvatarProfiles: async () => [], ...overrides.api },
  });
  vm.runInContext([...new Set(["captureWorkspaceScope", "refreshAccountAvatar", "refreshAvatarProfiles", ...names])]
    .map(functionSource).join("\n"), context);
  return context;
}

test("closed Cloud Agent never counts as the last available Agent or becomes the Settings default", () => {
 const nodes = Object.fromEntries(["settings-enabled-codex", "settings-enabled-dsh", "settings-enabled-cloud",
  "settings-agent-harness", "settings-codex-agent-fields", "settings-dsh-agent-fields", "settings-cloud-agent-fields",
  "settings-agent-summary"].map((id) => [id, element()]));
 for (const [id, value] of [["settings-enabled-codex", "codex"], ["settings-enabled-dsh", "deepseek-harness"], ["settings-enabled-cloud", "cloud"]]) nodes[id].value = value;
 nodes["settings-enabled-codex"].checked = true; nodes["settings-enabled-cloud"].checked = true;
 nodes["settings-agent-harness"].value = "codex";
 nodes["settings-agent-harness"].options = ["codex", "deepseek-harness", "cloud"].map((value) => ({ value }));
 const app = harness(["settingsEnabledHarnesses", "syncSettingsAgentControls"], { element: (id) => nodes[id],
  CLOUD_AGENT_ENTRY_ENABLED: false, DSH_HARNESS: "deepseek-harness", renderCloudStatus: noop, settingsAgentSummary: (value) => value });
 app.syncSettingsAgentControls(); assert.equal(nodes["settings-enabled-codex"].disabled, true);
 nodes["settings-enabled-codex"].checked = false;
 app.syncSettingsAgentControls({ changedCheckbox: nodes["settings-enabled-codex"] });
 assert.equal(nodes["settings-agent-harness"].value, "codex");
 assert.deepEqual([...app.settingsEnabledHarnesses()], ["codex"]);
 assert.equal(nodes["settings-cloud-agent-fields"].hidden, true);
 // A migrated cloud-only selection gets a usable local Settings default.
 nodes["settings-enabled-codex"].checked = false; nodes["settings-agent-harness"].value = "cloud";
 app.syncSettingsAgentControls({ changedCheckbox: nodes["settings-enabled-cloud"] });
 assert.equal(nodes["settings-agent-harness"].value, "codex");
 assert.equal(nodes["settings-agent-harness"].options.find((option) => option.value === "cloud").disabled, true);
 nodes["settings-enabled-dsh"].checked = true; nodes["settings-enabled-codex"].checked = false;
 nodes["settings-agent-harness"].value = "deepseek-harness"; app.syncSettingsAgentControls();
 assert.equal(nodes["settings-enabled-dsh"].disabled, true);
 assert.equal(nodes["settings-agent-harness"].value, "deepseek-harness");
});

test("the global badge reports live delivery regardless of viewer-to-participant transitions", () => {
  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { ...element(), dataset: {} });
    return nodes.get(id);
  };
  const app = harness(["renderSyncState"], { element: el, timelineRegion: element(),
    sessionDeliveryMode: ({ role }) => role === "viewer" ? "read_only" : "live" });
  app.state.sync = { phase: "live", cursor: 161, detail: "Connected", bufferedCount: 0 };
  for (const role of ["viewer", "participant", "viewer", "participant"]) {
    app.state.session = { id: "s1", role, members: [{ userId: "u1", role }] };
    app.renderSyncState();
    assert.equal(el("global-connection-label").textContent, "Live · #161");
    assert.equal(el("sync-title").textContent, "Live");
  }
  app.state.sync.phase = "offline";
  app.renderSyncState();
  assert.equal(el("global-connection-label").textContent, "Offline");
});

test("a project list response after logout cannot reopen a workspace", async () => {
  const pending = deferred();
  let selections = 0;
  const app = harness(["enterWorkspace"], {
    api: { listProjects: () => pending.promise, getHostedAgentStatus: async () => ({ enabled: false }) },
    selectProject: () => { selections += 1; },
  });
  const work = app.enterWorkspace();
  app.authenticationGeneration += 1;
  app.state.currentUser = null;
  pending.resolve([{ id: "p-old", name: "Private project" }]);
  await work;
  assert.equal(selections, 0);
  assert.equal(app.state.projects.length, 0);
});

test("context policy load cannot populate settings after switching authenticated project scope", async () => {
  const pending = deferred();
  const app = harness(["captureWorkspaceScope", "loadHistoryContextPolicy"], {
    settingsHistoryPolicyGeneration: 0, settingsHistoryPolicy: null, settingsDialog: { open: true },
    api: { getProjectContextPolicy: () => pending.promise },
  });
  const work = app.loadHistoryContextPolicy();
  assert.equal(app.element("settings-history-context-mode").disabled, true);
  app.selectedSessionGeneration += 1;
  app.state.project = { id: "p-other" };
  pending.resolve({ mode: "original" });
  await work;
  assert.equal(app.settingsHistoryPolicy, null);
  assert.equal(app.element("settings-history-context-mode").disabled, true);
});

test("context policy lookup failure stays disabled with an explicit retry instead of inventing a default", async () => {
  const app = harness(["captureWorkspaceScope", "loadHistoryContextPolicy"], {
    settingsHistoryPolicyGeneration: 0, settingsHistoryPolicy: null, settingsDialog: { open: true },
    api: { getProjectContextPolicy: async () => { throw new Error("Fixture policy unavailable"); } },
  });
  await app.loadHistoryContextPolicy();
  assert.equal(app.settingsHistoryPolicy, null);
  assert.equal(app.element("settings-history-context-mode").disabled, true);
  assert.equal(app.element("settings-history-context-retry").hidden, false);
  assert.equal(app.element("settings-history-context-status").textContent, "Unable to load Agent context policy.");
});

function contextPolicySaveHarness(write) {
  const saved = [];
  const app = harness(["captureWorkspaceScope", "saveSettings"], {
    settingsDeviceLoadGeneration: 1, settingsHistoryPolicy: { projectId: "p1", mode: "summary" },
    settingsDialog: { open: true, close() { this.open = false; } }, settingsPreview: {},
    contextBudgetInputBytes: () => 262144, CONTEXT_BUDGET_MIN_BYTES: 8192, CONTEXT_BUDGET_MAX_BYTES: 5242880,
    DSH_HARNESS: "deepseek-harness", currentDeviceName: "Fixture device", readSettingsForm: () => ({ notifications: {} }),
    notificationPermissionNeeded: () => false, settingsStore: { set: (value) => { saved.push(value); return value; } },
    connectionNoticeState: {}, INITIAL_CONNECTION_NOTICE_STATE: {}, advanceConnectionNotice: () => ({ state: {} }),
    hideAttentionNotice: noop, applyVisualSettings: noop, renderProjectAgentButtons: noop,
    renderAgentProfileControls: noop, ensureCodexLocalSyncStatus: noop,
    api: { setProjectContextPolicy: write },
  });
  app.element("settings-history-summary-instructions").value = "Preserve fixture details.";
  app.element("settings-history-context-mode").value = "original";
  app.element("settings-device-name").disabled = true;
  return { app, saved, event: { preventDefault: noop, submitter: element() } };
}

test("a profile poll started before a successful avatar save cannot restore the previous image", async () => {
  const pending = deferred();
  const applied = [];
  const app = harness(["captureWorkspaceScope", "refreshMembers"], {
    api: { listMembers: async () => [], listAvatarProfiles: () => pending.promise },
    applyAvatarProfiles: profiles => applied.push(profiles), messageActions: { refresh: noop },
  });
  app.state.avatarProfileRevision = 0;
  const work = app.refreshMembers("s1");
  app.state.avatarProfileRevision += 1;
  pending.resolve([{ user_id: "u1", avatar_id: "cat" }]);
  await work;
  assert.equal(applied.length, 0);
  assert.equal(app.memberRefreshInFlight, false);
});

test("a transient avatar metadata failure does not block membership and permission refresh", async () => {
  const app = harness(["captureWorkspaceScope", "refreshMembers"], {
    api: { listMembers: async () => [{ userId: "u1", role: "viewer" }],
      listAvatarProfiles: async () => { throw new Error("profile unavailable"); } },
    messageActions: { refresh: noop },
  });
  await app.refreshMembers("s1");
  assert.equal(app.state.session.members[0].role, "viewer");
  assert.equal(app.memberRefreshInFlight, false);
});

test("pending avatar metadata cannot delay a role change or occupy member refresh", async () => {
  const pending = deferred();
  let permissions = 0;
  const app = harness(["captureWorkspaceScope", "refreshMembers"], {
    api: { listMembers: async () => [{ userId: "u1", role: "viewer" }], listAvatarProfiles: () => pending.promise },
    renderComposerPermissions: () => { permissions += 1; }, messageActions: { refresh: noop },
  });
  const work = app.refreshMembers("s1");
  try {
    await nextTurn();
    assert.equal(app.state.session.members?.[0]?.role, "viewer");
    assert.equal(permissions, 1);
    assert.equal(app.memberRefreshInFlight, false);
  } finally { pending.resolve([]); await work; }
});

test("pending account avatar cannot delay loading projects", async () => {
  const pending = deferred();
  let selections = 0;
  const app = harness(["enterWorkspace"], {
    api: { listProjects: async () => [{ id: "p1" }], getAccountAvatar: () => pending.promise,
      getHostedAgentStatus: async () => ({ enabled: false }) },
    selectProject: async () => { selections += 1; },
  });
  const work = app.enterWorkspace();
  try {
    await nextTurn();
    assert.equal(selections, 1);
    assert.equal(app.state.projects.length, 1);
  } finally { pending.resolve({ user_id: "u1", avatar_id: null }); await work; }
});

test("pending avatar metadata cannot delay opening a session or connecting realtime", async () => {
  const pending = deferred();
  let connections = 0;
  const app = harness(["selectSession"], {
    mobileWorkspace: { close: noop }, codeSyncUi: { close: noop }, historySummaryUi: { reset: noop },
    messageActions: { reset: noop, refresh: noop }, expandedWorklogs: new Map(),
    stopDshRuntimePolling: noop, renderProjectPermissions: noop, sendError: element(),
    clearCreatedInvitationSecret: noop, closeMembersPanelWithoutFocus: noop, renderSnapshotRequests: noop,
    downloadCodexButton: element(), importVisibleHistoryButton: element(), startMemberRefresh: noop,
    renderSessionHeader: noop, refreshDshRuntimes: async () => {}, startDshRuntimePolling: noop,
    restoreSnapshotRequests: noop, sync: { disconnect: noop, connect: async () => { connections += 1; } },
    api: { getSession: async () => ({ id: "s2" }), listMembers: async () => [], listAvatarProfiles: () => pending.promise },
  });
  const work = app.selectSession("s2");
  try {
    await nextTurn();
    assert.equal(app.state.session?.id, "s2");
    assert.equal(connections, 1);
    assert.equal(app.sessionView.hidden, false);
  } finally { pending.resolve([]); await work; }
});

test("avatar reads are single-flight per selection and late profiles cannot cross a session or save fence", async () => {
  const first = deferred(), second = deferred();
  const applied = [];
  let calls = 0;
  const app = harness(["refreshAvatarProfiles"], {
    api: { listAvatarProfiles: () => (++calls === 1 ? first.promise : second.promise) },
    applyAvatarProfiles: profiles => applied.push(profiles),
  });
  app.state.avatarProfileRevision = 0;
  const stale = app.refreshAvatarProfiles("s1");
  await app.refreshAvatarProfiles("s1");
  assert.equal(calls, 1);
  app.selectedSessionGeneration += 1;
  app.state.session = { id: "s2" };
  const current = app.refreshAvatarProfiles("s2");
  first.resolve([{ user_id: "u1", avatar_id: "cat" }]);
  await stale;
  assert.equal(applied.length, 0);
  assert.ok(app.avatarProfilesRefreshInFlight);
  app.state.avatarProfileRevision += 1;
  second.resolve([{ user_id: "u1", avatar_id: "fox" }]);
  await current;
  assert.equal(applied.length, 0);
  assert.equal(app.avatarProfilesRefreshInFlight, null);
});

test("late account avatar reads cannot overwrite a save or a new authenticated account", async () => {
  for (const change of ["save", "account"]) {
    const pending = deferred();
    let renders = 0;
    const app = harness(["refreshAccountAvatar"], {
      api: { getAccountAvatar: () => pending.promise }, renderCurrentAvatar: () => { renders += 1; },
    });
    app.state.avatarProfileRevision = 0;
    const work = app.refreshAccountAvatar();
    if (change === "save") app.state.avatarProfileRevision += 1;
    else { app.authenticationGeneration += 1; app.state.currentUser = { id: "u2", avatar_id: "owl" }; }
    pending.resolve({ user_id: "u1", avatar_id: "cat" });
    await work;
    assert.equal(renders, 0);
    assert.notEqual(app.state.currentUser.avatar_id, "cat");
  }
});

test("avatar refresh failures release their own slot and a successful retry updates presentation", async () => {
  let calls = 0;
  const applied = [];
  const app = harness(["refreshAvatarProfiles", "refreshAccountAvatar"], {
    api: { listAvatarProfiles: async () => {
      if (++calls === 1) throw new Error("profile timeout");
      return [{ user_id: "u1", avatar_id: "owl" }];
    }, getAccountAvatar: async () => ({ user_id: "u1", avatar_id: "owl" }) },
    applyAvatarProfiles: profiles => applied.push(profiles),
  });
  await app.refreshAvatarProfiles("s1");
  assert.equal(app.avatarProfilesRefreshInFlight, null);
  await app.refreshAvatarProfiles("s1");
  assert.equal(applied[0][0].avatar_id, "owl");
  await app.refreshAccountAvatar();
  assert.equal(app.state.currentUser.avatar_id, "owl");
});

test("context policy save failure stays in settings with a relevant bilingual error and no false local save", async () => {
  const { app, saved, event } = contextPolicySaveHarness(async () => { throw new Error("Fixture server internal"); });
  await app.saveSettings(event);
  assert.equal(app.settingsDialog.open, true);
  assert.equal(saved.length, 0);
  assert.equal(app.element("settings-history-context-status").textContent, "Unable to save Agent context policy. Retry saving settings.");
  assert.equal(app.element("settings-device-status").textContent, "");
  assert.equal(event.submitter.disabled, false);
});

test("a completed context policy save cannot close or alter a newer authenticated workspace", async () => {
  const pending = deferred(), calls = [];
  const { app, saved, event } = contextPolicySaveHarness((...args) => { calls.push(args); return pending.promise; });
  const work = app.saveSettings(event);
  await Promise.resolve();
  assert.deepEqual(calls, [["p1", "original"]]);
  app.authenticationGeneration += 1;
  app.state.currentUser = { id: "u2" };
  pending.resolve({ mode: "original" });
  await work;
  assert.equal(app.settingsDialog.open, true);
  assert.equal(saved.length, 0);
});

test("a stale membership rejection cannot clear a newer session or its pending refresh", async () => {
  const pending = deferred();
  let disconnected = 0;
  const app = harness(["captureWorkspaceScope", "refreshMembers"], {
    api: { listMembers: () => pending.promise }, sync: { disconnect: () => { disconnected += 1; } },
  });
  const work = app.refreshMembers("s1");
  app.selectedSessionGeneration += 1;
  app.state.session = { id: "s2" };
  const newerRefresh = () => true;
  app.memberRefreshInFlight = newerRefresh;
  pending.reject({ status: 403 });
  await work;
  assert.equal(app.state.session.id, "s2");
  assert.equal(disconnected, 0);
  assert.equal(app.memberRefreshInFlight, newerRefresh);
});

test("a background workspace reload cannot undo a newer project selection", async () => {
  const pending = deferred();
  let selections = 0;
  const app = harness(["enterWorkspace"], {
    api: { listProjects: () => pending.promise, getHostedAgentStatus: async () => ({ enabled: false }) },
    selectProject: () => { selections += 1; },
  });
  const work = app.enterWorkspace();
  app.selectedSessionGeneration += 1;
  app.state.project = { id: "p-new" };
  pending.resolve([{ id: "p-old" }]);
  await work;
  assert.equal(selections, 0);
  assert.equal(app.state.project.id, "p-new");
});

test("an invitation created for a previous selection cannot reveal its secret", async () => {
  const pending = deferred();
  let handler;
  const submit = element();
  const form = { addEventListener: (_event, callback) => { handler = callback; }, querySelector: () => submit };
  const app = harness(["captureWorkspaceScope"], {
    createInvitationForm: form, FormData: class { get(key) { return key === "role" ? "participant" : "24h"; } },
    invitationRolePolicy: () => ({ allowedRoles: ["participant"], defaultRole: "participant" }),
    clearCreatedInvitationSecret: noop, renderInvitations: noop, createdInvitationSecret: "",
    api: { createInvitation: () => pending.promise },
  });
  const start = source.indexOf('createInvitationForm.addEventListener("submit",');
  vm.runInContext(source.slice(start, source.indexOf("\n});", start) + 4), app);
  const work = handler({ preventDefault: noop });
  app.selectedSessionGeneration += 1;
  app.state.project = { id: "p2" };
  pending.resolve({ inviteToken: "fixture-old-invitation", invitation: { id: "i1" } });
  await work;
  assert.equal(app.createdInvitationSecret, "");
  assert.equal(app.state.invitations.length, 0);
  assert.notEqual(app.element("created-invite-secret").textContent, "fixture-old-invitation");
});

function messageHarness(pending) {
  let writes = 0;
  const input = { ...element(), value: "First draft" };
  const app = harness(["captureWorkspaceScope", "sendMessage"], {
    api: { appendHumanChat: () => { writes += 1; return pending.promise; } },
    messageInput: input, sendError: element(), sendChatButton: element(), sendAgentButton: element(),
    pendingMessageSend: null, createIdempotencyKey: () => "fixture-message", window: {},
    messageActions: { metadata: () => ({ replyTo: null, mentions: [] }), sent: noop },
  });
  return { app, input, writes: () => writes };
}

test("repeat submit while a message is pending writes once and keeps a newer draft", async () => {
  const pending = deferred();
  const { app, input, writes } = messageHarness(pending);
  const first = app.sendMessage("human_chat");
  await app.sendMessage("human_chat");
  assert.equal(writes(), 1);
  input.value = "Next draft typed during the request";
  pending.resolve({});
  await first;
  assert.equal(input.value, "Next draft typed during the request");
});

test("a successful send for an old session cannot clear an identical new-session draft", async () => {
  const pending = deferred();
  const { app, input } = messageHarness(pending);
  const work = app.sendMessage("human_chat");
  app.selectedSessionGeneration += 1;
  app.state.session = { id: "s2" };
  pending.resolve({});
  await work;
  assert.equal(input.value, "First draft");
});

test("a newer quote attached during send is not cleared by the previous acknowledgement", async () => {
  const pending = deferred();
  const { app, input } = messageHarness(pending);
  let replyTo = "old-quote";
  app.messageActions.metadata = () => ({ replyTo, mentions: [] });
  const work = app.sendMessage("human_chat");
  replyTo = "new-quote";
  pending.resolve({});
  await work;
  assert.equal(input.value, "First draft");
});

test("local conversation uploads keep an offline selected device and fail closed for ambiguity", () => {
  const controls = Object.fromEntries([
    "codexLocalSyncControls", "composer", "codexLocalRuntimeSelect", "codexLocalRuntimeField",
    "codexAutoUploadToggle", "uploadLocalTurnsButton", "codexLocalSyncStatus",
  ].map((name) => [name, element()]));
  let runtimes = [{ id: "r-other", model: "model" }];
  const app = harness(["renderCodexLocalSyncControls"], {
    ...controls, currentProjectEnabledHarnesses: () => ["codex"],
    onlineCodexLocalRuntimes: () => runtimes, selectedCodexLocalRuntimeId: "r-selected",
    codexLocalRuntimeLabel: (runtime) => runtime.id, document: { createElement: element },
  });
  app.renderCodexLocalSyncControls();
  assert.equal(app.selectedCodexLocalRuntimeId, "r-selected");
  assert.equal(app.codexAutoUploadToggle.disabled, true);
  assert.equal(app.uploadLocalTurnsButton.disabled, true);
  assert.equal(app.codexLocalSyncStatus.textContent, "Selected device is offline");
  app.selectedCodexLocalRuntimeId = "";
  runtimes = [{ id: "r1" }, { id: "r2" }];
  app.renderCodexLocalSyncControls();
  assert.equal(app.selectedCodexLocalRuntimeId, "");
  assert.equal(app.uploadLocalTurnsButton.disabled, true);
});

test("retrying a cloud GitHub request opens its saved task and cannot execute the trial or a local harness", async () => {
  const opened = [], calls = [];
  const app = harness(["retryAgentRequest"], {
    retryingAgentRequestIds: new Set(), sendError: element(), captureWorkspaceScope: () => () => true,
    cloudGithubUi: { openTask: async (id) => opened.push(id) },
    api: { appendHostedAgentRequest: async () => calls.push("trial"), appendAgentRequest: async () => calls.push("local") },
  });
  app.state.sync = { events: [{ id: "request", type: "agent_request", payload: { github_task_id: "gh-task-fixture", execution_profile: { harness: "opencode" } } }] };
  await app.retryAgentRequest("request", { disabled: false, isConnected: true });
  assert.deepEqual(opened, ["gh-task-fixture"]); assert.deepEqual(calls, []);
});

for (const outcome of ["success", "failure"]) {
  test(`late browser restoration ${outcome} cannot replace an email-authenticated workspace`, async () => {
    const pending = deferred(); let entries = 0, resets = 0;
    const app = harness(["restoreBrowserSession", "beginEmailAuthentication", "completeEmailAuthentication"], {
      mockEnabled: false, authRequestInProgress: false, loginError: element(),
      api: { restoreSession: () => pending.promise }, setAutomaticClaimDeviceName: noop,
      enterWorkspace: async () => { entries += 1; }, resetWorkspaceToAuth: () => { resets += 1; },
    });
    const restoring = app.restoreBrowserSession();
    const current = app.beginEmailAuthentication();
    await app.completeEmailAuthentication({ actor: { id: "email-user" } }, current);
    if (outcome === "success") pending.resolve({ id: "old-user" }); else pending.reject(new Error("Old restoration failed"));
    await restoring;
    assert.equal(app.state.currentUser.id, "email-user");
    assert.equal(entries, 1); assert.equal(resets, 0); assert.equal(app.loginError.textContent, "");
  });
}

test("starting email authentication fences restoration before email completion", async () => {
  const pending = deferred(); let entries = 0;
  const app = harness(["restoreBrowserSession", "beginEmailAuthentication"], {
    mockEnabled: false, authRequestInProgress: false, loginError: element(),
    api: { restoreSession: () => pending.promise }, enterWorkspace: async () => { entries += 1; },
  });
  app.state.currentUser = null;
  const restoring = app.restoreBrowserSession();
  app.beginEmailAuthentication(); pending.resolve({ id: "old-user" }); await restoring;
  assert.equal(app.state.currentUser, null); assert.equal(entries, 0);
});

test("switching registration and login invalidates a former email completion", async () => {
  let entries = 0, cleared = 0;
  const app = harness(["setActiveAuthEntry", "beginEmailAuthentication", "completeEmailAuthentication"], {
    authRequestInProgress: false, authEntryChooser: element(), authIdentity: element(), authEntryChoices: [],
    registrationUi: { enter: async () => {}, clear: () => { cleared += 1; } },
    passwordResetUi: { enter() {}, clear() {} },
    setAutomaticClaimDeviceName: noop, enterWorkspace: async () => { entries += 1; },
  });
  app.state.currentUser = null;
  const former = app.beginEmailAuthentication();
  app.setActiveAuthEntry("email-login");
  await app.completeEmailAuthentication({ actor: { id: "old-registration" } }, former);
  assert.equal(app.state.currentUser, null); assert.equal(entries, 0); assert.equal(cleared, 1);
});


test("authentication state is initialized before startup restoration can access it", () => {
  const startup = source.indexOf("void restoreBrowserSession()");
  assert.ok(source.indexOf("let authRequestInProgress = false") < startup);
  assert.ok(source.indexOf("let authenticationGeneration = 0") < startup);
});
