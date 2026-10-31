import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { cloudRequestInput, retryAgentRequestPermission } from "../src/agent-request-control.js";
import { agentContextUpdateReason } from "../src/domain.js";
import { createSoloDrafts } from "../src/solo-drafts.js";
import { HttpCollaborationApi } from "../src/api.js";
import { configurationPrompt } from "../src/configuration-assistant.js";

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
    agentContextUpdateReason,
    authenticationGeneration: 1, selectedSessionGeneration: 1, workspaceLoadGeneration: 0, projectNavigationGeneration: 0,
    soloNavigationGeneration: 0, pendingMessageSend: null,
    soloDrafts: { has: () => false, isPending: () => false, submitted: noop, leave: async () => {} },
    configurationSkillContent: content => content, configurationDrafts: new Map(), CONFIGURATION_SKILL: "/gatherthread-config",
    configurationSkillChip: { hidden: true },
    state: { currentUser: { id: "u1", username: "User", device_id: "d1" }, avatarProfiles: new Map(), avatarProfileRevision: 0, project: { id: "p1" },
      projects: [], session: { id: "s1" }, sync: { contentRevision: 0 }, settings: { composer: {} }, invitations: [], snapshotRequests: [] },
    element: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    authView: element(), workspace: element(), emptyState: element(), sessionView: element(),
    hostedAgentStatus: { enabled: false },
    cloudGithubUi: { updateContext: noop, completeAuthorization: async () => {} },
    teamsUi: { updateContext: noop, selected: () => null, pendingStart: () => false, activeRun: () => null, t: value => value },
    filesUi: { confirmLeave: async () => true, clear: noop, updateContext: noop },
    cloudCodeConsent: { updateContext: noop, refresh: noop, refreshLanguage: noop, includeCode: () => true,
      submission: () => ({ allowed: true, includeCode: true, reason: "" }) },
    deviceCredentialDialog: { open: false }, codeSyncUi: { showFirstLoginNotice: noop },
    onboarding: { cancel: noop, offer: noop, refreshLanguage: noop },
    invitationLink: { hasPending: () => false, reset: noop },
    sessionContextDetails: { open: false }, updateSessionContextDisclosure: noop,
    sessionToolbar: { reset: noop, refresh: noop },
    codexLauncher: { clear: noop }, claudeLauncher: { clear: noop }, connectClaudeDialog: { open: false }, codexDeviceAuthorization: { clear: noop },
    renderNativeSettingsRuntimeOptions: noop,
    location: { hash: "" }, URLSearchParams, initials: () => "U", localizer: { t: (value) => value },
    renderProjectSelect: noop, renderSessionList: noop, maybeOpenPendingDshPairing: noop,
    renderCurrentAvatar: noop, applyAvatarProfiles: noop,
    renderMembers: noop, renderTimeline: noop, renderComposerPermissions: noop, sendError: element(),
    renderSessionDeliveryControls: noop, announce: noop,
    memberRefreshInFlight: false, avatarProfilesRefreshInFlight: null, stopMemberRefresh: noop, stopSnapshotPolling: noop,
    sync: { disconnect: noop }, resetWorkspaceToAuth: noop,
    ...overrides,
    api: { getAccountAvatar: async () => ({ user_id: "u1", avatar_id: null }), listAvatarProfiles: async () => [], ...overrides.api },
  });
  vm.runInContext([...new Set(["captureWorkspaceScope", "leaveEmptySolo", "applyAccountAvatar", "refreshAccountAvatar", "refreshAvatarProfiles", "clearStaleTeamComposerProblem", "isAlternativeNative", ...names])]
    .map(functionSource).join("\n"), context);
  return context;
}

function installSoloDrafts(app) {
  app.createSoloDrafts = createSoloDrafts;
  const start = source.indexOf("const soloDrafts = createSoloDrafts("), end = source.indexOf("\n});", start) + 4;
  assert.ok(start >= 0 && end > start, "production Solo cleanup callbacks exist");
  vm.runInContext(source.slice(start, end).replace("const soloDrafts =", "globalThis.soloDrafts ="), app);
}

test("participant create dialog leaves Multi selectable and viewers cannot open it", () => {
  const multi = { disabled: false, checked: true }, solo = { checked: false };
  let opened = 0;
  const app = harness(["openCreateDialog"], {
    state: { project: { role: "participant" } }, requestAnimationFrame: callback => callback(),
    createForm: { querySelector: selector => selector.includes("multi") ? multi : solo },
    createDialog: { showModal: () => opened++ },
  });
  app.openCreateDialog();
  assert.equal(opened, 1);
  assert.equal(multi.disabled, false);
  assert.equal(solo.checked, false);
  app.state.project.role = "viewer";
  app.openCreateDialog();
  assert.equal(opened, 1);
});

function soloNavigationFixture(overrides = {}) {
  const app = harness(["selectSession"], {
    mobileWorkspace: { close: noop }, codeSyncUi: { close: noop }, historySummaryUi: { reset: noop },
    messageInput: { ...element(), value: "/gatherthread-config\nPrivate unsent team requirements" },
    messageActions: { reset: noop, refresh: noop }, messageDeletion: { reset: noop },
    expandedWorklogs: new Set(), collapsedWorklogs: new Set(), progressSectionState: new Map(), revealedProgressEvents: new Set(),
    stopDshRuntimePolling: noop, renderProjectPermissions: noop, clearCreatedInvitationSecret: noop,
    closeMembersPanelWithoutFocus: noop, renderSnapshotRequests: noop, downloadCodexButton: element(), importVisibleHistoryButton: element(),
    startMemberRefresh: noop, renderSessionHeader: noop, refreshDshRuntimes: async () => {}, startDshRuntimePolling: noop,
    restoreSnapshotRequests: noop, sync: { disconnect: noop, connect: async () => {} },
    ...overrides,
    api: { getSession: async id => ({ id, mode: "multi" }), listMembers: async () => [], ...overrides.api },
  });
  app.state.session.mode = "solo";
  app.state.sessions = [app.state.session, { id: "s2", mode: "multi" }];
  app.configurationSkillChip.hidden = false;
  app.configurationDrafts.set("s1", { private: "Original configuration draft" });
  installSoloDrafts(app); app.soloDrafts.remember(app.state.session);
  return app;
}

for (const outcome of ["deleted", "message-accepted-elsewhere", "transport-error"]) {
  test(`leaving an empty Solo opens the next conversation without waiting for cleanup and fences its draft (${outcome})`, async () => {
    const cleanup = deferred(), calls = [];
    const app = soloNavigationFixture({ api: { discardEmptySolo: id => { calls.push(id); return cleanup.promise; } } });
    let navigated = false;
    const navigation = app.selectSession("s2").then(() => { navigated = true; });
    try {
      await nextTurn();
      assert.equal(navigated, true, "the cleanup acknowledgement must not hold session navigation");
      assert.equal(app.state.session?.id, "s2"); assert.equal(app.messageInput.value, "");
      assert.equal(app.configurationSkillChip.hidden, true); assert.equal(app.configurationDrafts.has("s1"), false);
      assert.deepEqual(calls, ["s1"]);
      app.messageInput.value = "A new Multi conversation draft";
    } finally {
      if (outcome === "transport-error") cleanup.reject(new Error("Synthetic offline transport"));
      else cleanup.resolve({ session_id: "s1", discarded: outcome === "deleted" });
      await navigation; await nextTurn();
    }
    assert.equal(app.messageInput.value, "A new Multi conversation draft", "a late cleanup cannot erase the new conversation's draft");
    assert.equal(app.state.session.id, "s2");
    assert.equal(app.state.sessions.some(session => session.id === "s1"), outcome !== "deleted");
  });
}

test("an in-flight send from a new Solo blocks cleanup and preserves its input until accepted", async () => {
  let cleaned = 0;
  const app = soloNavigationFixture({ pendingMessageSend: () => true,
    api: { discardEmptySolo: async () => { cleaned++; return { discarded: true }; } } });
  const draft = app.messageInput.value;
  await app.selectSession("s2");
  assert.equal(app.state.session.id, "s1"); assert.equal(app.messageInput.value, draft);
  assert.equal(app.configurationSkillChip.hidden, false); assert.equal(cleaned, 0);
});

for (const discarded of [true, false]) {
  test(`a Solo scheduled for cleanup cannot be reopened while its delete outcome is unknown (${discarded})`, async () => {
    const cleanup = deferred(), reads = [], sessionList = element();
    const app = soloNavigationFixture({ sessionList,
      document: { createElement: () => ({ ...element(), classList: { add: noop }, addEventListener: noop }) },
      api: {
      discardEmptySolo: () => cleanup.promise,
      getSession: async id => { reads.push(id); return { id, mode: id === "s1" ? "solo" : "multi" }; },
    } });
    vm.runInContext(functionSource("renderSessionList"), app);
    await app.selectSession("s2");
    app.messageInput.value = "Keep this new conversation draft";
    try {
      assert.equal(app.soloDrafts.isPending("s1"), true);
      assert.equal(sessionList.children[0].children[0].disabled, true, "pending cleanup disables the actual list button");
      assert.equal(sessionList.children[1].children[0].disabled, false, "other conversations stay selectable");
      await app.selectSession("s1");
      assert.equal(app.state.session.id, "s2", "a pending delete must not reopen a conversation the server is removing");
      assert.deepEqual(reads, ["s2"]); assert.equal(app.messageInput.value, "Keep this new conversation draft");
    } finally {
      cleanup.resolve({ session_id: "s1", discarded }); await nextTurn();
    }
    assert.equal(app.soloDrafts.isPending("s1"), false); assert.equal(app.state.session.id, "s2");
    assert.equal(app.messageInput.value, "Keep this new conversation draft");
    if (!discarded) {
      assert.equal(sessionList.children[0].children[0].disabled, false, "retained Solo is re-enabled when cleanup settles");
      await app.selectSession("s1");
      assert.equal(app.state.session.id, "s1", "a conversation protected by an accepted message becomes selectable again");
    } else assert.equal(app.state.sessions.some(session => session.id === "s1"), false);
  });
}

function soloCreationFixture({ entry, mode = "solo", create, list, confirmLeave = async () => false } = {}) {
  const cleanup = [], submit = element(); let handler;
  const created = { id: "new-session", mode };
  const app = harness(["startTeamConfiguration", "selectSession"], {
    configuringTeam: false, createIdempotencyKey: kind => `${kind}-fixture-key`,
    messageInput: element(), window: { confirm: () => true },
    filesUi: { confirmLeave }, agentManagementUi: { close: noop },
    createDialog: { close: noop },
    createForm: { addEventListener(type, callback) { assert.equal(type, "submit"); handler = callback; },
      querySelector: () => submit, reset: noop },
    FormData: class { get(name) { return name === "mode" ? mode : "Fixture conversation"; } },
    api: { createSession: create ?? (async () => created), listProjectSessions: list ?? (async () => [created]),
      discardEmptySolo: async id => { cleanup.push(id); return { session_id: id, discarded: true }; } },
  });
  app.state.project.role = "owner"; app.state.sessions = [app.state.session];
  installSoloDrafts(app);
  if (entry === "ordinary") {
    const start = source.indexOf('createForm.addEventListener("submit",'), end = source.indexOf("\n});", start) + 4;
    assert.ok(start >= 0 && end > start); vm.runInContext(source.slice(start, end), app);
  }
  return { app, cleanup, submit, created, run: configuration => entry === "ordinary" ? handler({ preventDefault: noop }) : app.startTeamConfiguration(configuration) };
}

test("cancelling AI configuration preserves an existing unsent message without creating a Solo", async () => {
  let creates = 0, confirmations = 0, closed = 0;
  const f = soloCreationFixture({ entry: "ai", create: async () => { creates++; return { id: "unexpected", mode: "solo" }; } });
  const original = "Keep my unfinished discussion draft";
  f.app.messageInput.value = original;
  f.app.window.confirm = () => { confirmations++; return false; };
  f.app.agentManagementUi.close = () => { closed++; };
  assert.equal(await f.run(), false);
  assert.equal(confirmations, 1); assert.equal(creates, 0); assert.equal(closed, 0);
  assert.equal(f.app.messageInput.value, original); assert.equal(f.app.state.session.id, "s1");
  assert.equal(f.app.configuringTeam, false); assert.deepEqual(f.cleanup, []);
});

test("AI configuration refuses an oversized configuration draft before replacing input or creating a Solo", async () => {
  let creates = 0;
  const f = soloCreationFixture({ entry: "ai", create: async () => { creates++; return { id: "unexpected", mode: "solo" }; } });
  f.app.messageInput.value = "Preserve this existing message";
  f.app.window.confirm = () => assert.fail("an oversized configuration must be refused before confirmation");
  assert.equal(await f.run({ requirements: "x".repeat(6001) }), false);
  assert.equal(creates, 0); assert.equal(f.app.messageInput.value, "Preserve this existing message");
  assert.equal(f.app.state.session.id, "s1"); assert.equal(f.app.configuringTeam, false);
  assert.equal(f.app.configurationDrafts.size, 0); assert.deepEqual(f.cleanup, []);
});

function aiConfigurationNavigationFixture({ refreshRuntimes = async () => {}, connect = async () => {},
  confirmLeave = async () => true, discarded = true } = {}) {
  const created = { id: "ai-configuration-session", mode: "solo" };
  const cleanup = [], inputEvents = [], focus = [];
  const app = soloNavigationFixture({
    configuringTeam: false, createIdempotencyKey: () => "ai-navigation-fixture",
    configurationPrompt, Event, structuredClone, window: { confirm: () => true },
    filesUi: { confirmLeave }, agentManagementUi: { close: noop },
    refreshDshRuntimes: refreshRuntimes, sync: { disconnect: noop, connect },
    api: { createSession: async () => created, listProjectSessions: async () => [created, { id: "s2", mode: "multi" }],
      getSession: async id => ({ id, mode: id === created.id ? "solo" : "multi" }),
      discardEmptySolo: async id => { cleanup.push(id); return { session_id: id, discarded }; } },
  });
  app.state.project.role = "owner"; app.state.settings.general = { locale: "zh-CN" };
  app.state.session.mode = "multi"; app.soloDrafts.submitted(app.state.session.id);
  app.configurationDrafts.clear(); app.messageInput.value = "";
  app.messageInput.dispatchEvent = event => inputEvents.push({ type: event.type, value: app.messageInput.value });
  app.messageInput.setSelectionRange = noop;
  app.messageInput.focus = () => focus.push("input");
  app.element("session-title").focus = () => focus.push("title");
  vm.runInContext(functionSource("startTeamConfiguration"), app);
  return { app, created, cleanup, inputEvents, focus };
}

for (const stage of ["runtime discovery", "replay connection"]) {
  test(`AI setup seeds its prompt before ${stage} and never overwrites editing or refocuses on late completion`, async () => {
    const waiting = deferred(); let blocked = false;
    const delay = () => { blocked = true; return waiting.promise; };
    const f = aiConfigurationNavigationFixture(stage === "runtime discovery" ? { refreshRuntimes: delay } : { connect: delay });
    const work = f.app.startTeamConfiguration();
    const draft = `${configurationPrompt("zh-CN")}科研团队，需要计算与独立复核。`;
    try {
      await nextTurn();
      assert.equal(blocked, true); assert.equal(f.app.state.session.id, f.created.id);
      assert.equal(f.app.messageInput.value, configurationPrompt("zh-CN"), "the prompt is present as soon as the new conversation is displayed");
      assert.deepEqual(f.focus, ["title", "input"]);
      f.app.messageInput.value = draft;
    } finally { waiting.resolve(); await work; }
    assert.equal(f.app.messageInput.value, draft);
    assert.equal(f.inputEvents.length, 1, "the setup prompt is only seeded once");
    assert.deepEqual(f.focus, ["title", "input"], "a late discovery/replay cannot steal the user's input focus");
  });

  test(`returning to the AI Solo before its old ${stage} finishes cannot restore an obsolete prompt`, async () => {
    const waiting = deferred(); let calls = 0;
    const delayFirst = () => ++calls === 1 ? waiting.promise : Promise.resolve();
    // The server protects this Solo when another device has accepted a message.
    // It can therefore be selected again after conditional cleanup settles.
    const f = aiConfigurationNavigationFixture({ discarded: false,
      ...(stage === "runtime discovery" ? { refreshRuntimes: delayFirst } : { connect: delayFirst }) });
    const work = f.app.startTeamConfiguration();
    let focusBeforeCompletion;
    const draft = "New requirements entered after returning to the retained Solo";
    try {
      await nextTurn();
      assert.equal(calls, 1); assert.equal(f.app.state.session.id, f.created.id);
      assert.equal(f.inputEvents.length, 1);
      await f.app.selectSession("s2"); await nextTurn();
      assert.deepEqual(f.cleanup, [f.created.id]);
      assert.equal(f.app.soloDrafts.isPending(f.created.id), false);
      await f.app.selectSession(f.created.id);
      f.app.messageInput.value = draft;
      focusBeforeCompletion = [...f.focus];
    } finally { waiting.resolve(); await work; }
    assert.equal(f.app.state.session.id, f.created.id);
    assert.equal(f.app.messageInput.value, draft);
    assert.equal(f.inputEvents.length, 1, "returning to the same ID must not revive the earlier setup callback");
    assert.deepEqual(f.focus, focusBeforeCompletion);
  });
}

test("cancelled AI session navigation never seeds a prompt or changes the existing input", async () => {
  const f = aiConfigurationNavigationFixture({ confirmLeave: async () => false });
  const draft = "Keep this discussion draft when cancelling the file-editor leave prompt";
  f.app.messageInput.value = draft;
  assert.equal(await f.app.startTeamConfiguration(), false);
  await nextTurn();
  assert.equal(f.app.state.session.id, "s1"); assert.equal(f.app.messageInput.value, draft);
  assert.deepEqual(f.inputEvents, []); assert.deepEqual(f.focus, []);
  assert.deepEqual(f.cleanup, [f.created.id]);
});

for (const entry of ["ordinary", "ai"]) {
  test(`${entry} Solo creation is conditionally discarded if the actual session navigation is cancelled`, async () => {
    const f = soloCreationFixture({ entry });
    await f.run(); await nextTurn();
    assert.equal(f.app.state.session.id, "s1"); assert.deepEqual(f.cleanup, [f.created.id]);
    assert.equal(f.app.state.sessions.some(session => session.id === f.created.id), false);
    assert.equal(f.submit.disabled, false); assert.equal(f.app.configuringTeam, false);
  });

  for (const phase of ["create", "list"]) {
    test(`${entry} Solo creation recovers an unused session after switching selection during ${phase}`, async () => {
      const pending = deferred(), f = soloCreationFixture({ entry,
        ...(phase === "create" ? { create: () => pending.promise } : { list: () => pending.promise }) });
      const work = f.run(); await nextTurn();
      f.app.selectedSessionGeneration++; f.app.state.session = { id: "chosen-session", mode: "multi" };
      f.app.state.sessions = [f.app.state.session];
      pending.resolve(phase === "create" ? f.created : [f.created]);
      await work; await nextTurn();
      assert.deepEqual(f.cleanup, [f.created.id]); assert.equal(f.app.state.session.id, "chosen-session");
      assert.deepEqual(f.app.state.sessions.map(session => session.id), ["chosen-session"]);
    });
  }

  test(`${entry} late Solo creation never sends cleanup using a newly authenticated account`, async () => {
    const pending = deferred(), f = soloCreationFixture({ entry, create: () => pending.promise });
    const work = f.run();
    f.app.authenticationGeneration++; f.app.state.currentUser = { id: "another-user" }; f.app.soloDrafts.clear();
    pending.resolve(f.created); await work; await nextTurn();
    assert.deepEqual(f.cleanup, []); assert.equal(f.app.soloDrafts.has(f.created.id), false);
    assert.equal(f.app.state.currentUser.id, "another-user");
  });
}

test("cancelled ordinary Multi creation is preserved and never sent to Solo cleanup", async () => {
  const f = soloCreationFixture({ entry: "ordinary", mode: "multi" });
  await f.run(); await nextTurn();
  assert.deepEqual(f.cleanup, []); assert.equal(f.app.state.sessions.some(session => session.id === f.created.id), true);
});

test("a missing Solo's reconciliation read has a short deadline even when the transport ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, signal: options.signal });
    if (String(url).endsWith("/discard-empty")) return { ok: false, status: 404,
      json: async () => ({ error: { code: "not_found", message: "Session not found" } }) };
    return new Promise(() => {});
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const errors = [], drafts = createSoloDrafts({ api: new HttpCollaborationApi(), onError: error => errors.push(error) });
  drafts.remember({ id: "already-removed", mode: "solo" });
  let settled = false;
  const cleanup = drafts.leave("already-removed").then(() => { settled = true; });
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(2999); for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1); for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(settled, true, "404 reconciliation must not fall back to the generic 45-second deadline");
  await cleanup; assert.equal(calls[1].signal.aborted, true); assert.equal(errors.length, 1);
});

test("switching projects clears unconsumed Launcher and manual authorizations before loading", async () => {
  let launcherCleared = 0, manualCleared = 0;
  const app = harness(["selectProject"], {
    mobileWorkspace: { close: noop }, codeSyncUi: { close: noop }, historySummaryUi: { reset: noop },
    codexLauncher: { clear: () => { launcherCleared++; } },
    codexDeviceAuthorization: { clear: () => { manualCleared++; } },
    projectSelectionGuard: { begin: () => { throw new Error("fixture-stop-before-API"); } },
  });
  await assert.rejects(app.selectProject("p2"), /fixture-stop-before-API/);
  assert.equal(launcherCleared, 1);
  assert.equal(manualCleared, 1);
});

test("cancelling dirty-file project navigation preserves the current project, conversation, draft and live scope", async () => {
  const confirmation = deferred();
  let cleared = 0, disconnected = 0, requested = 0, pickerRestored = 0, invalidated = 0;
  const draft = { value: "Unsent conversation draft" };
  const app = harness(["selectProject"], {
    messageInput: draft,
    filesUi: { confirmLeave: () => confirmation.promise, clear: () => { cleared++; } },
    sync: { disconnect: () => { disconnected++; } },
    projectSelectionGuard: { begin: () => { invalidated++; } },
    renderProjectSelect: () => { pickerRestored++; },
    api: { getProject: async () => { requested++; return { id: "p2" }; } },
  });
  const project = app.state.project, session = app.state.session, actor = app.state.currentUser;
  const scope = app.captureWorkspaceScope();
  const pending = app.selectProject("p2");
  await nextTurn();
  assert.equal(app.state.project, project); assert.equal(app.state.session, session);
  assert.equal(disconnected, 0); assert.equal(requested, 0); assert.equal(cleared, 0);
  confirmation.resolve(false); await pending;
  assert.equal(app.state.project, project); assert.equal(app.state.session, session); assert.equal(app.state.currentUser, actor);
  assert.equal(draft.value, "Unsent conversation draft"); assert.equal(scope(), true);
  assert.equal(pickerRestored, 1); assert.equal(invalidated, 0); assert.equal(disconnected, 0); assert.equal(requested, 0); assert.equal(cleared, 0);
});

test("cancelling dirty-file conversation navigation does not reset selection or clear active work", async () => {
  const confirmation = deferred();
  let disconnected = 0, requested = 0, reset = 0;
  const app = harness(["selectSession"], {
    filesUi: { confirmLeave: () => confirmation.promise, clear: () => { reset++; } },
    sync: { disconnect: () => { disconnected++; } },
    messageActions: { reset: () => { reset++; } }, messageDeletion: { reset: () => { reset++; } },
    api: { getSession: async () => { requested++; return { id: "s2" }; } },
  });
  const project = app.state.project, session = app.state.session, generation = app.selectedSessionGeneration;
  const pending = app.selectSession("s2"); await nextTurn();
  assert.equal(app.state.session, session); assert.equal(disconnected, 0); assert.equal(reset, 0);
  confirmation.resolve(false); await pending;
  assert.equal(app.state.project, project); assert.equal(app.state.session, session);
  assert.equal(app.selectedSessionGeneration, generation); assert.equal(disconnected, 0); assert.equal(reset, 0); assert.equal(requested, 0);
});

test("cancelling the actual logout handler's dirty-file confirmation retains authentication and workspace", async () => {
  const confirmation = deferred();
  let handler, loggedOut = 0, reset = 0, invalidated = 0, disconnected = 0;
  const button = { ...element(), addEventListener(type, callback) { assert.equal(type, "click"); handler = callback; } };
  const app = harness([], {
    element: (id) => { assert.equal(id, "logout-button"); return button; },
    filesUi: { confirmLeave: () => confirmation.promise },
    projectSelectionGuard: { invalidate: () => { invalidated++; } },
    sync: { disconnect: () => { disconnected++; } },
    resetWorkspaceToAuth: () => { reset++; }, api: { logout: async () => { loggedOut++; } },
  });
  const marker = 'element("logout-button").addEventListener("click", async () => {';
  const start = source.indexOf(marker), end = source.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end + 4), app);
  const actor = app.state.currentUser, project = app.state.project, session = app.state.session;
  const authentication = app.authenticationGeneration, selection = app.selectedSessionGeneration;
  const pending = handler(); await nextTurn();
  assert.equal(loggedOut, 0); assert.equal(disconnected, 0); assert.equal(button.disabled, false);
  confirmation.resolve(false); await pending;
  assert.equal(app.state.currentUser, actor); assert.equal(app.state.project, project); assert.equal(app.state.session, session);
  assert.equal(app.authenticationGeneration, authentication); assert.equal(app.selectedSessionGeneration, selection);
  assert.equal(loggedOut, 0); assert.equal(reset, 0); assert.equal(invalidated, 0); assert.equal(disconnected, 0);
});

test("authenticated invitation entry waits for explicit confirmation before loading projects or offering onboarding", async () => {
  let previews = 0;
  let onboardingOffers = 0;
  let projects = 0;
  const app = harness(["enterWorkspace"], {
    document: { documentElement: { dataset: { bootState: "loading" } } },
    invitationLink: { hasPending: () => true, async open() { previews += 1; } },
    onboarding: { cancel: noop, offer() { onboardingOffers += 1; } },
    api: { async listProjects() { projects += 1; return []; } },
  });
  await app.enterWorkspace();
  assert.equal(previews, 1);
  assert.equal(projects, 0);
  assert.equal(onboardingOffers, 0);
  assert.equal(app.document.documentElement.dataset.bootState, undefined);
});

test("closed Cloud Agent never counts as the last available Agent or becomes the Settings default", () => {
 const nodes = Object.fromEntries(["settings-enabled-codex", "settings-enabled-dsh", "settings-enabled-claude", "settings-enabled-cloud",
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

test("open Cloud Agent can be explicitly selected without changing existing local defaults", () => {
 const nodes = Object.fromEntries(["settings-enabled-codex", "settings-enabled-dsh", "settings-enabled-claude", "settings-enabled-cloud",
  "settings-agent-harness", "settings-codex-agent-fields", "settings-dsh-agent-fields", "settings-cloud-agent-fields",
  "settings-agent-summary"].map((id) => [id, element()]));
 for (const [id, value] of [["settings-enabled-codex", "codex"], ["settings-enabled-dsh", "deepseek-harness"], ["settings-enabled-cloud", "cloud"]]) nodes[id].value = value;
 nodes["settings-enabled-codex"].checked = true; nodes["settings-enabled-cloud"].checked = false;
 nodes["settings-agent-harness"].value = "codex";
 nodes["settings-agent-harness"].options = ["codex", "deepseek-harness", "cloud"].map((value) => ({ value }));
 const app = harness(["settingsEnabledHarnesses", "syncSettingsAgentControls"], { element: (id) => nodes[id],
  CLOUD_AGENT_ENTRY_ENABLED: true, DSH_HARNESS: "deepseek-harness", renderCloudStatus: noop, settingsAgentSummary: (value) => value });
 app.syncSettingsAgentControls();
 assert.equal(nodes["settings-enabled-cloud"].disabled, false);
 assert.equal(nodes["settings-agent-harness"].value, "codex");
 nodes["settings-enabled-cloud"].checked = true;
 app.syncSettingsAgentControls({ changedCheckbox: nodes["settings-enabled-cloud"] });
 assert.equal(nodes["settings-agent-harness"].value, "codex");
 nodes["settings-agent-harness"].value = "cloud";
 app.syncSettingsAgentControls();
 assert.equal(nodes["settings-cloud-agent-fields"].hidden, false);
 nodes["settings-enabled-codex"].checked = false;
 app.syncSettingsAgentControls({ changedCheckbox: nodes["settings-enabled-codex"] });
 assert.deepEqual([...app.settingsEnabledHarnesses()], ["cloud"]);
 assert.equal(nodes["settings-enabled-cloud"].disabled, true);
 assert.equal(nodes["settings-agent-harness"].value, "cloud");
});

test("cloud entry still fails closed for missing service, missing model and exhausted capacity", () => {
 const app = harness(["currentCloudProfile", "cloudStatusText"], {
  CLOUD_AGENT_ENTRY_ENABLED: true, projectCloudProfile: () => null,
 });
 assert.equal(app.currentCloudProfile(), undefined);
 assert.equal(app.cloudStatusText(), "Cloud Agent is not enabled on this server.");
 app.hostedAgentStatus = { enabled: true, profiles: [], user_limit_runs: null };
 assert.equal(app.cloudStatusText(), "Select an available cloud model.");
 for (const [status, message] of [["busy", "Cloud Agent is busy; try again later"],
  ["user_busy", "Your Cloud Agent task is still running; wait for it to finish"],
  ["rate_limit", "Please wait before starting another Cloud Agent task"]]) {
  app.hostedAgentStatus.profiles = [{ id: "selected", provider: "fixture", model: "model", available: false, status }];
  assert.equal(app.currentCloudProfile().available, false);
  assert.equal(app.cloudStatusText(), `fixture · model · ${message}`);
 }
 const selected = harness(["currentCloudProfile"], { projectCloudProfile: () => "deleted-profile",
  hostedAgentStatus: { enabled: true, profiles: [{ id: "other", available: true }] } });
 assert.equal(selected.currentCloudProfile(), undefined, "never replace a missing selected model");
});

test("mobile Cloud rejection reasons stay visible while ready and local labels stay compact", () => {
 const nodes = new Map();
 const el = (id) => {
  if (!nodes.has(id)) nodes.set(id, { ...element(), closest: () => element() });
  return nodes.get(id);
 };
 let writable = true, selectedHarness = "cloud";
 const app = harness(["currentCloudProfile", "cloudStatusText", "renderComposerPermissions"], {
  element: el, CLOUD_AGENT_ENTRY_ENABLED: true, DSH_HARNESS: "deepseek-harness",
  pendingMessageSend: null, pendingSharedAgentIntent: null,
  sharedAgentsUi: { updateContext: noop, selected: () => null },
  codeSyncUi: { updateContext: noop },
  canAppend: () => ({ allowed: writable, reason: "This conversation is read-only." }),
  currentProjectHarness: () => selectedHarness, projectCloudProfile: () => null,
  currentCodexResolution: () => ({ runtime: null, reason: "Connect your Agent on a computer." }),
  currentDshResolution: () => ({ runtime: null, reason: "Connect DSH on a computer." }),
  sendChatButton: element(), sendAgentButton: element(), messageInput: element(),
  renderAgentProfileControls: noop, historySummaryUi: { updateContext: noop }, agentRequestControl: { update: noop }, teamRunNotice: { update: noop },
 });
 app.state.sync = { phase: "live" };
 let reasonWrites = 0, reasonText = "";
 Object.defineProperty(el("mobile-cloud-status"), "textContent", {
  get: () => reasonText,
  set: (value) => { reasonText = value; reasonWrites += 1; },
 });
 app.renderComposerPermissions();
 assert.equal(el("mobile-cloud-status").hidden, false);
 assert.equal(el("mobile-cloud-status").textContent, "Cloud Agent is not enabled on this server.");
 assert.equal(reasonWrites, 1);
 app.renderComposerPermissions();
 assert.equal(reasonWrites, 1, "unchanged polling must not repeatedly replace the status live-region text");
 for (const status of ["busy", "user_busy", "rate_limit", "cooldown", "daily_limit", "unavailable"]) {
  app.hostedAgentStatus = { enabled: true, user_limit_runs: null,
   profiles: [{ id: "selected", provider: "fixture", model: "model", available: false, status }] };
  app.renderComposerPermissions();
  assert.equal(el("mobile-cloud-status").hidden, false, status);
  assert.equal(el("mobile-cloud-status").textContent, el("agent-target-label").textContent, status);
  assert.equal(app.sendAgentButton.disabled, true, status);
  const previousWrites = reasonWrites;
  app.renderComposerPermissions();
  assert.equal(reasonWrites, previousWrites, status);
 }
 app.hostedAgentStatus.profiles[0] = { ...app.hostedAgentStatus.profiles[0], available: true, status: "available" };
 app.renderComposerPermissions();
 assert.equal(el("mobile-cloud-status").hidden, true);
 assert.equal(el("mobile-cloud-status").textContent, "");
 assert.equal(app.sendAgentButton.disabled, false);
 writable = false;
 app.renderComposerPermissions();
 assert.equal(el("mobile-cloud-status").hidden, false);
 assert.equal(el("mobile-cloud-status").textContent, "This conversation is read-only.");
 for (const local of ["codex", "deepseek-harness"]) {
  selectedHarness = local;
  app.renderComposerPermissions();
  assert.equal(el("mobile-cloud-status").hidden, true, local);
  assert.equal(el("mobile-cloud-status").textContent, "", local);
 }
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
  const openedSections = [];
  const app = harness(["captureWorkspaceScope", "saveSettings"], {
    settingsDeviceLoadGeneration: 1, settingsHistoryPolicy: { projectId: "p1", mode: "summary" },
    settingsDialog: { open: true, close() { this.open = false; } }, settingsPreview: {},
    mobileSettings: { open: section => openedSections.push(section) },
    contextBudgetInputBytes: () => 262144, CONTEXT_BUDGET_MIN_BYTES: 8192, CONTEXT_BUDGET_MAX_BYTES: 5242880,
    DSH_HARNESS: "deepseek-harness", currentDeviceName: "Fixture device", importedInterfaceMode: undefined,
    readSettingsForm: () => ({ notifications: {} }),
    notificationPermissionNeeded: () => false, settingsStore: { set: (value) => { saved.push(value); return value; } },
    connectionNoticeState: {}, INITIAL_CONNECTION_NOTICE_STATE: {}, advanceConnectionNotice: () => ({ state: {} }),
    hideAttentionNotice: noop, applyVisualSettings: noop, renderProjectAgentButtons: noop,
    renderAgentProfileControls: noop, ensureCodexLocalSyncStatus: noop,
    api: { setProjectContextPolicy: write },
  });
  app.element("settings-history-summary-instructions").value = "Preserve fixture details.";
  app.element("settings-history-context-mode").value = "original";
  app.element("settings-device-name").disabled = true;
  return { app, saved, openedSections, event: { preventDefault: noop, submitter: element() } };
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
  let deletionResets = 0;
  const app = harness(["selectSession"], {
    mobileWorkspace: { close: noop }, codeSyncUi: { close: noop }, historySummaryUi: { reset: noop },
    messageActions: { reset: noop, refresh: noop }, messageDeletion: { reset: () => { deletionResets++; } },
    contentRefreshScroll: { anchorId: "old-session-anchor" }, expandedWorklogs: new Set(),
    collapsedWorklogs: new Set(), progressSectionState: new Map(), revealedProgressEvents: new Set(),
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
    assert.equal(deletionResets, 1);
    assert.equal(app.contentRefreshScroll, null);
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

test("a late account avatar read cannot undo a newer session profile response", async () => {
  const pending = deferred();
  const images = [];
  const app = harness(["refreshAccountAvatar", "refreshAvatarProfiles", "applyAvatarProfiles"], {
    api: { getAccountAvatar: () => pending.promise,
      listAvatarProfiles: async () => [{ user_id: "u1", avatar_id: "fox" }] },
    renderCurrentAvatar: () => { images.push(app.state.currentUser.avatar_id); },
  });
  app.state.avatarProfileRevision = 0;
  const stale = app.refreshAccountAvatar();
  await app.refreshAvatarProfiles("s1");
  assert.equal(app.state.currentUser.avatar_id, "fox");
  pending.resolve({ user_id: "u1", avatar_id: "cat" });
  await stale;
  assert.equal(app.state.currentUser.avatar_id, "fox");
  assert.equal(app.state.avatarProfiles.get("u1"), "fox");
  assert.deepEqual(images, ["fox"]);
});

test("a newer account read updates history avatars and fences an older profile read", async () => {
  const pending = deferred();
  const app = harness(["refreshAccountAvatar", "refreshAvatarProfiles", "applyAvatarProfiles"], {
    api: { getAccountAvatar: async () => ({ user_id: "u1", avatar_id: "fox" }),
      listAvatarProfiles: () => pending.promise },
  });
  app.state.avatarProfileRevision = 0;
  app.state.currentUser.avatar_id = "cat";
  app.state.avatarProfiles = new Map([["u1", "cat"]]);
  const stale = app.refreshAvatarProfiles("s1");
  try {
    await app.refreshAccountAvatar();
    assert.equal(app.state.currentUser.avatar_id, "fox");
    assert.equal(app.state.avatarProfiles.get("u1"), "fox");
  } finally { pending.resolve([{ user_id: "u1", avatar_id: "cat" }]); await stale; }
  assert.equal(app.state.currentUser.avatar_id, "fox");
});

test("a confirmed unchanged profile still invalidates an older account response", async () => {
  const pending = deferred();
  const app = harness(["refreshAccountAvatar", "refreshAvatarProfiles", "applyAvatarProfiles"], {
    api: { getAccountAvatar: () => pending.promise,
      listAvatarProfiles: async () => [{ user_id: "u1", avatar_id: "cat" }] },
  });
  app.state.avatarProfileRevision = 0;
  app.state.currentUser.avatar_id = "cat";
  const stale = app.refreshAccountAvatar();
  await app.refreshAvatarProfiles("s1");
  pending.resolve({ user_id: "u1", avatar_id: "fox" });
  await stale;
  assert.equal(app.state.currentUser.avatar_id, "cat");
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
  const { app, saved, openedSections, event } = contextPolicySaveHarness(async () => { throw new Error("Fixture server internal"); });
  await app.saveSettings(event);
  assert.equal(app.settingsDialog.open, true);
  assert.deepEqual(openedSections, ["settings-summaries"]);
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

for (const reason of ["Checking GT Cloud files…", "Could not check GT Cloud files. Reopen Project files to try again."]) {
  test(`cloud send rechecks code readiness and preserves the draft: ${reason}`, async () => {
    const f = messageHarness(deferred()); let calls = 0;
    f.app.CLOUD_AGENT_ENTRY_ENABLED = true;
    f.app.currentCloudProfile = () => ({ id: "fixture" });
    f.app.cloudCodeConsent.submission = () => ({ allowed: false, includeCode: false, reason });
    f.app.api.appendHostedAgentRequest = async () => { calls++; };
    f.app.element("cloud-agent-source").value = "trial";
    await f.app.sendMessage("hosted_agent");
    assert.equal(calls, 0);
    assert.equal(f.input.value, "First draft");
    assert.equal(f.app.sendError.textContent, reason);
    assert.equal(f.app.pendingMessageSend, null);
  });
}

for (const source of ["trial", "github"]) {
  test(`a normal cloud ${source} request sends the captured history revision and keeps its draft on rejection`, async () => {
    const pending = deferred(), f = messageHarness(pending), writes = [];
    f.app.CLOUD_AGENT_ENTRY_ENABLED = true;
    f.app.currentCloudProfile = () => ({ id: "fixture", provider: "fixture", model: "fixture" });
    f.app.api.appendHostedAgentRequest = (...args) => { writes.push(args); return pending.promise; };
    f.app.cloudGithubUi.start = (...args) => { writes.push(args); return pending.promise; };
    f.app.element("cloud-agent-source").value = source;
    f.app.state.sync.contentRevision = 4;
    const work = f.app.sendMessage("hosted_agent");
    assert.equal(writes[0][1].contentRevision, 4);
    if (source === "trial") assert.equal(writes[0][1].includeCode, true);
    f.app.state.sync.contentRevision = 5;
    pending.reject(new Error("Shared history changed. Refresh the page and try again."));
    await work;
    assert.equal(f.input.value, "First draft");
    assert.match(f.app.sendError.textContent, /Refresh/);
  });
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
    retryingAgentRequestIds: new Set(), retryAgentRequestKeys: new Map(), retryAgentRequestPermission,
    createIdempotencyKey: () => "retry-fixture", sendError: element(), captureWorkspaceScope: () => () => true,
    document: { createElement: () => ({ setAttribute: noop }) },
    cloudGithubUi: { openTask: async (id) => opened.push(id) },
    api: { appendHostedAgentRequest: async () => calls.push("trial"), appendAgentRequest: async () => calls.push("local") },
  });
  app.state.session.members = [{ userId: "u1", role: "owner" }]; app.state.session.mode = "multi";
  app.state.sync = { phase: "live", events: [{ id: "request", type: "agent_request", actor: { id: "u1" }, payload: { github_task_id: "gh-task-fixture", execution_profile: { harness: "opencode" } } }] };
  await app.retryAgentRequest("request", { disabled: false, isConnected: true, after: noop, parentElement: { querySelector: () => null } });
  assert.deepEqual(opened, ["gh-task-fixture"]); assert.deepEqual(calls, []);
});

function delayedCloudRetry() {
  const selection = deferred(), writes = [];
  const profile = { id: "api-fixture", provider: "fixture", model: "fixture-model", api_config_revision: "fixture-revision" };
  const request = { id: "request", type: "agent_request", actor: { id: "u1" }, payload: {
    content: "ERASED_RETRY_INSTRUCTIONS", profile_id: profile.id,
    execution_profile: { harness: "opencode", provider: profile.provider, model: profile.model },
  } };
  const app = harness(["retryAgentRequest"], {
    CLOUD_AGENT_ENTRY_ENABLED: true, retryingAgentRequestIds: new Set(), retryAgentRequestKeys: new Map(),
    retryAgentRequestPermission, cloudRequestInput, createIdempotencyKey: () => "retry-fixture", sendError: element(),
    document: { createElement: () => ({ setAttribute: noop }) }, window: { confirm: () => true },
    hostedAgentStatus: { enabled: true, profiles: [profile] }, refreshHostedAgentStatus: noop,
    api: { getHostedAgentSelection: () => selection.promise,
      appendHostedAgentRequest: async (...args) => { writes.push(args); } },
  });
  app.state.session = { id: "s1", mode: "multi", members: [{ userId: "u1", role: "owner" }] };
  app.state.sync = { phase: "live", contentRevision: 0, events: [request] };
  const button = { disabled: false, isConnected: true, after: noop, parentElement: { querySelector: () => null } };
  const resolveSelection = () => selection.resolve({ profile_id: profile.id, api_config_revision: profile.api_config_revision });
  const erase = () => {
    app.state.sync.contentRevision++;
    app.state.sync.events = [{ ...request, deleted: { deleted_at: "2026-10-12T00:00:00.000Z", reason: "author" },
      payload: { content: "[Message deleted]" } }];
  };
  return { app, request, button, writes, erase, resolveSelection };
}

test("a deletion during the actual cloud retry selection cannot resubmit the old request object", async () => {
  const f = delayedCloudRetry();
  const pending = f.app.retryAgentRequest(f.request.id, f.button);
  f.erase(); f.resolveSelection(); await pending;
  assert.equal(f.writes.length, 0, "erased instructions must never be POSTed after selection resolves");
  assert.equal(f.app.retryAgentRequestKeys.size, 0);
  assert.equal(f.app.sendError.textContent, "");
});

for (const source of ["missing", "deleted", "unavailable"]) {
  test(`cloud retry requires an authoritative ${source === "missing" ? "present" : "readable"} source after selection (${source})`, async () => {
    const f = delayedCloudRetry();
    const pending = f.app.retryAgentRequest(f.request.id, f.button);
    f.app.state.sync.events = source === "missing" ? [] : [{ ...f.request,
      ...(source === "deleted" ? { deleted: { deleted_at: "2026-10-12T00:00:00.000Z", reason: "author" } }
        : { contentUnavailable: true }), payload: {} }];
    f.resolveSelection(); await pending;
    assert.equal(f.writes.length, 0, "an old closure is not authoritative history even if the revision has not arrived yet");
  });
}

test("cloud retry rechecks deletion after code confirmation, immediately before POST", async () => {
  const f = delayedCloudRetry(); f.request.payload.include_code = true;
  f.app.window.confirm = () => { f.erase(); return true; };
  const pending = f.app.retryAgentRequest(f.request.id, f.button);
  f.resolveSelection(); await pending;
  assert.equal(f.writes.length, 0);
});

test("ordinary cloud retry survives new chat without a deletion and sends its exact history revision", async () => {
  const f = delayedCloudRetry();
  const pending = f.app.retryAgentRequest(f.request.id, f.button);
  f.app.state.sync.events.push({ id: "new-chat", type: "human_chat", actor: { id: "u1" }, payload: { content: "New discussion" } });
  f.resolveSelection(); await pending;
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0], "s1");
  assert.equal(f.writes[0][1].content, f.request.payload.content);
  assert.equal(f.writes[0][1].contentRevision, 0);
  assert.equal(f.writes[0][1].apiConfigRevision, "fixture-revision");
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
    document: { documentElement: { dataset: { bootState: "loading" } } },
    api: { restoreSession: () => pending.promise }, enterWorkspace: async () => { entries += 1; },
  });
  app.state.currentUser = null;
  const restoring = app.restoreBrowserSession();
  app.beginEmailAuthentication(); pending.resolve({ id: "old-user" }); await restoring;
  assert.equal(app.state.currentUser, null); assert.equal(entries, 0);
  assert.equal(app.document.documentElement.dataset.bootState, "loading", "a stale restore cannot reveal the login view");
});

test("anonymous session restoration reveals login only after the session lookup settles", async () => {
  const pending = deferred();
  const authView = { hidden: true };
  const document = { documentElement: { dataset: { bootState: "loading" } } };
  const app = harness(["restoreBrowserSession"], {
    mockEnabled: false, authRequestInProgress: false, loginError: element(), authView, document,
    api: { restoreSession: () => pending.promise },
  });
  app.state.currentUser = null;
  const restoring = app.restoreBrowserSession();
  assert.equal(authView.hidden, true);
  assert.equal(document.documentElement.dataset.bootState, "loading");
  pending.resolve(null); await restoring;
  assert.equal(authView.hidden, false);
  assert.equal(document.documentElement.dataset.bootState, undefined);
  assert.equal(app.state.currentUser, null);
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
