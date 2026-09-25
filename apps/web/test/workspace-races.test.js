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
    authenticationGeneration: 1, selectedSessionGeneration: 1, workspaceLoadGeneration: 0,
    state: { currentUser: { id: "u1", username: "User", device_id: "d1" }, project: { id: "p1" },
      projects: [], session: { id: "s1" }, settings: { composer: {} }, invitations: [], snapshotRequests: [] },
    element: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    authView: element(), workspace: element(), emptyState: element(), sessionView: element(),
    deviceCredentialDialog: { open: false }, codeSyncUi: { showFirstLoginNotice: noop },
    location: { hash: "" }, URLSearchParams, initials: () => "U", localizer: { t: (value) => value },
    renderProjectSelect: noop, renderSessionList: noop, maybeOpenPendingDshPairing: noop,
    renderMembers: noop, renderTimeline: noop, renderComposerPermissions: noop,
    renderSessionDeliveryControls: noop, announce: noop,
    memberRefreshInFlight: false, stopMemberRefresh: noop, stopSnapshotPolling: noop,
    sync: { disconnect: noop }, resetWorkspaceToAuth: noop,
    ...overrides,
  });
  vm.runInContext(names.map(functionSource).join("\n"), context);
  return context;
}

test("a project list response after logout cannot reopen a workspace", async () => {
  const pending = deferred();
  let selections = 0;
  const app = harness(["enterWorkspace"], {
    api: { listProjects: () => pending.promise }, selectProject: () => { selections += 1; },
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
    api: { listProjects: () => pending.promise }, selectProject: () => { selections += 1; },
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
