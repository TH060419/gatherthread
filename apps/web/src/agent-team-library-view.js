import { TEAM_ZH_CN } from "./agent-team-i18n.js";
import { describeTeamActionError, formatTeamRunIssue, isTeamActionUncertain, teamTimeoutContinuationAvailable } from "./agent-team-diagnostics.js";
import { mountTeamCanvas } from "./agent-team-canvas.js";
import { teamConnectionChoices, teamConnectionKey, teamModelKey, teamTargetForModel, moduleSnapshot,
  sameTeamSnapshot, removeTeamNode, teamEdgeAllowed } from "./agent-team-graph.js";
const terminal = run => !["running", "paused"].includes(run.status);
const testMetadataKey = team => JSON.stringify([team?.revision, team?.test_status, team?.test_run_id, team?.tested_revision]);
// Compare configuration content, independent of object key order or optional
// empty prompts. Metadata/control revisions are not edits to the configuration.
const configurationKey = (draft, limits) => JSON.stringify({ draft: { ...draft,
  team_prompt: draft.team_prompt ?? "", entry_node_id: draft.entry_node_id ?? draft.nodes[0]?.id,
  nodes: draft.nodes.map(node => ({ ...node, prompt: node.prompt ?? "" })) }, ...limits },
(_key, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
// Match the server's normalization of editable fields. Team rules preserve their
// whitespace; module names, identities and prompts are trimmed by their schemas.
const acceptedConfigurationKey = (draft, limits) => configurationKey({ ...draft, name: draft.name.trim(),
  nodes: draft.nodes.map(node => ({ ...node, label: node.label.trim(), role: (node.role ?? "").trim(), prompt: node.prompt?.trim() })) },
{ max_calls: limits.max_calls, max_duration_minutes: limits.max_duration_minutes });

export function mountAgentTeams({ document: doc, api, hostButton, getContext, onChange = () => {},
  refreshSources = async () => {},
  makeKey = prefix => `${prefix}-${crypto.randomUUID()}`, confirm = message => globalThis.confirm(message) }) {
  const t = text => doc.documentElement.lang.startsWith("zh") ? TEAM_ZH_CN[text] ?? text : text;
  const translations = [];
  const el = (tag, className = "", text = "") => { const node = doc.createElement(tag); node.className = className;
    node.setAttribute("data-i18n-skip", ""); node.textContent = text; return node; };
  const button = (text, action, className = "team-glass") => { const node = el("button", className, t(text));
    if (text) node.dataset.teamI18n = text;
    node.type = "button"; if (action) node.addEventListener("click", action); return node; };
  const field = (text, input) => { const wrapper = el("label", "team-field"), label = el("span", "", t(text));
    label.dataset.teamI18n = text; wrapper.append(label, input); return wrapper; };
  const input = (name, maxLength) => { const node = el("input"); node.id = `team-${name}`; if (maxLength) node.maxLength = maxLength; return node; };
  const dialog = el("dialog", "create-dialog agent-team-dialog"); dialog.id = "agent-team-dialog";
  dialog.setAttribute("aria-labelledby", "agent-team-title");
  const header = el("header", "team-heading"), titleArea = el("div"), title = el("h2", "", t("My Agent teams")); title.id = "agent-team-title";
  const lockup = el("div", "team-brand");
  for (const theme of ["light", "dark"]) { const logo = el("img", `brand-lockup-image-${theme}`);
    logo.src = `./brand/lockup-color-transparent-${theme}.svg`; logo.alt = "GatherThread"; lockup.append(logo); }
  titleArea.append(lockup, title); const close = button("Close", () => closeDialog(), "text-button"); header.append(titleArea, close);
  const body = el("div", "team-dialog-body"), overview = el("section", "team-overview"), list = el("ul", "team-library-list");
  const intro = el("p", "field-help", t("Save up to 5 Teams and 5 favorite modules. Test a Team before enabling it."));
  translations.push(() => { intro.textContent = t("Save up to 5 Teams and 5 favorite modules. Test a Team before enabling it."); });
  const libraryActions = el("div", "team-library-heading"), count = el("span", "field-help"), refreshButton = button("Refresh", () => void refresh(), "text-button");
  libraryActions.append(count, refreshButton);
  const add = button("Add Agent Team", () => openEditor(null), "team-glass team-add-team"); add.id = "team-add";
  overview.append(intro, libraryActions, list, add);
  const editor = el("section", "team-editor"); editor.hidden = true;
  const back = button("Back to Teams", () => { if (!dirty || confirm(t("Discard unsaved changes?"))) { editId = null; dirty = false; editor.hidden = true; overview.hidden = false; title.textContent = t("My Agent teams"); render(); } }, "text-button team-back");
  const nameInput = input("name", 120); nameInput.placeholder = t("Team name");
  nameInput.addEventListener("input", () => { draft.name = nameInput.value; changed(); });
  const toolbar = el("div", "team-toolbar"), addBlank = button("Add blank module", () => insertModule()), addFavorite = button("Add favorite module", () => showFavorites()),
    saveButton = button("Save", () => void saveCurrent().catch(showError)), clearButton = button("Clear", () => {
      if (!draft.nodes.length || !confirm(t("Clear all modules and data flows?"))) return;
      draft.nodes = []; draft.edges = []; delete draft.entry_node_id; canvas.select(null); changed(); canvas.render(); renderInspector();
    }, "team-glass team-danger");
  for (const [node, id] of [[addBlank, "team-add-blank"], [addFavorite, "team-add-favorite"], [saveButton, "team-save"], [clearButton, "team-clear"]]) node.id = id;
  toolbar.append(addBlank, addFavorite, saveButton, clearButton);
  const graphHost = el("div", "team-canvas");
  const configLink = button("View configuration", () => showRelationships(), "text-button team-config-link");
  const lower = el("div", "team-editor-bottom"), configuration = el("div", "team-configuration"), inspector = el("section", "team-inspector");
  const limits = el("fieldset", "team-limits"), calls = input("max-calls"), minutes = input("max-minutes");
  for (const [node, max, property] of [[calls, 48, "max_calls"], [minutes, 120, "max_duration_minutes"]]) {
    node.type = "number"; node.min = "1"; node.max = String(max); node.step = "1"; node.required = true;
    node.addEventListener("input", () => { budgets[property] = Number(node.value); changed(); });
  }
  limits.append(field("Total call limit", calls), field("Duration limit (minutes)", minutes));
  const rules = el("details", "team-rules"), summary = el("summary", "", t("Team rules")), rulesInput = el("textarea"); rulesInput.maxLength = 2000;
  rulesInput.setAttribute("aria-label", t("Team rules")); rulesInput.addEventListener("input", () => { draft.team_prompt = rulesInput.value; changed(); }); rules.append(summary, rulesInput);
  configuration.append(inspector, limits, rules);
  const execution = el("aside", "team-execution-actions"), testButton = button("Test", () => void testCurrent().catch(showError)),
    enableButton = button("Enable", () => void toggleCurrent().catch(showError)); testButton.id = "team-test"; enableButton.id = "team-enable";
  const testState = el("p", "field-help"); execution.append(testButton, enableButton, testState);
  lower.append(configuration, execution);
  const testNote = el("p", "team-test-note field-help");
  translations.push(() => { testNote.textContent = t("Tests check every module and data flow. Provider and shared-Agent allowances still apply.");
    summary.textContent = t("Team rules"); nameInput.placeholder = t("Team name"); });
  editor.append(back, field("Team name", nameInput), toolbar, graphHost, configLink, lower, testNote);
  const records = el("details", "team-run-records"), recordTitle = el("summary", "", t("Run records")), runList = el("div", "team-runs"); records.append(recordTitle, runList);
  translations.push(() => { recordTitle.textContent = t("Run records"); });
  body.append(overview, editor, records);
  const footer = el("footer", "team-footer"), status = el("p", "field-help"), error = el("p", "form-error");
  status.setAttribute("role", "status"); error.setAttribute("role", "alert");
  const recover = button("Check the previous action", () => void recoverActions()); recover.hidden = true; footer.append(status, error, recover);
  dialog.append(header, body, footer); doc.body.append(dialog);
  const secondary = el("dialog", "create-dialog agent-team-dialog team-secondary-dialog"), secondaryTitle = el("h2"), secondaryBody = el("div", "team-dialog-body");
  secondaryTitle.id = "team-secondary-title"; secondary.setAttribute("aria-labelledby", secondaryTitle.id);
  const secondaryHeader = el("header", "team-heading"); secondaryHeader.append(secondaryTitle, button("Close", () => secondary.close(), "text-button")); secondary.append(secondaryHeader, secondaryBody); doc.body.append(secondary);

  let scope = "", generation = 0, epoch = 0, readBusy = false, refreshTimer, teams = [], favorites = [], runs = [], testRuns = [], runRefreshFailed = false, hadTaskActivity = false,
    editId = null, draft = null, budgets = null, baseRevision = null, baseline = null, dirty = false, draftVersion = 0, selectedKey = "", returnFocus, catalogSignature = "", writableState, secondaryMode = "", refreshFavoriteControl = null;
  const intents = new Map();
  const actionKinds = new WeakMap(), problemIntents = new WeakMap(), problemFences = new WeakMap(), obsoleteProblems = new WeakSet(), testReads = new Map();
  let runAuthority = 0, runAccessBlocked = false, observedContentRevision;
  let displayedProblem = null, displayedProblemText = null;
  const canvas = mountTeamCanvas({ document: doc, host: graphHost, t, makeId: makeKey, getDraft: () => draft,
    onChange: changed, onSelection: () => renderInspector() });
  const context = () => getContext() ?? {};
  const current = gen => gen === generation && context().scope === scope;
  const saved = () => teams.find(team => team.id === editId);
  const pendingFor = id => [...intents.values()].filter(intent => intent.id === id);
  const pendingEnable = id => pendingFor(id).some(intent => intent.kind === "control" && intent.input.enabled);
  const canEnable = team => team?.test_status === "passed" && team.tested_revision === team.revision;
  const canControl = () => context().controlWritable ?? context().writable;
  function clearPrivateRuns(blocked = false) {
    // This also fences receipts for runs not yet observed in this tab. A late
    // acceptance remains a receipt, but cannot restore erased/unauthorized data.
    runAuthority++; runs = []; testRuns = []; testReads.clear(); runAccessBlocked = blocked;
    // A rendered server diagnostic is another private cache. Do not retain its
    // old module label across an authorization/history fence or a locale refresh.
    // Fixed local validation copy belongs to the current editor and stays intact.
    if (displayedProblem) { displayedProblem = null; error.textContent = ""; }
  }
  function observeTeams(values, acceptedIntent) {
    for (const intent of intents.values()) if (intent !== acceptedIntent && ["save", "control", "test"].includes(intent.kind)) {
      for (const team of values) if (intent.id === team.id) (intent.observedTeams ??= new Map()).set(team.id,
        { revision: team.revision, testKey: testMetadataKey(team) });
    }
  }
  function supersedeDefinitionActions(id) {
    for (const [slot, intent] of intents) if (intent.id === id && ["save", "control", "test"].includes(intent.kind)) {
      intent.superseded = true;
      if (!intent.busy) intents.delete(slot);
    }
  }
  function supersedeFavoriteCreation(id) {
    for (const [slot, intent] of intents) if (intent.kind === "favorite" && intent.id === id && intent.input.module) {
      intent.superseded = true;
      if (!intent.busy) intents.delete(slot);
    }
  }
  function fenceClearedRun(id) {
    // Remember the fence only on currently pending replies, not in an
    // ever-growing tab-wide tombstone list. Accepted tasks still acknowledge
    // their original composer intent without restoring the cleared run cache.
    for (const intent of intents.values()) if (intent.kind === "start" || intent.kind === "run" && intent.id === id) {
      (intent.clearedRunIds ??= new Set()).add(id);
    }
  }
  function observeRuns(ids, acceptedIntent) {
    // Run summaries have no ordering revision. A delayed acceptance ACK must
    // not roll a subsequently observed status back, including Pause/Resume on
    // another device. Keep this fence only on outstanding replies; accepting
    // their receipts/composer callbacks remains independent of cache updates.
    for (const intent of intents.values()) if (intent !== acceptedIntent && ["start", "run"].includes(intent.kind)) {
      for (const id of ids) if (intent.kind === "start" || intent.id === id) (intent.observedRunIds ??= new Set()).add(id);
    }
  }
  function pendingCanonicalRunId(pending, ctx) {
    if (!pending) return undefined;
    return ctx.events?.find(item => item.type === "agent_request" && item.actor?.id === ctx.userId
      && (item.sessionId ?? item.session_id) === ctx.sessionId && !item.deleted && !item.contentUnavailable
      && !pending.previousEvents?.has(item.id) && item.payload?.agent_team?.purpose !== "test"
      && item.payload?.agent_team?.start_idempotency_key === pending.input.idempotency_key
      && item.payload?.agent_team?.task_content === pending.input.content)?.payload.agent_team.run_id;
  }
  function isObsoleteError(problem) {
    const fence = problemFences.get(problem);
    return obsoleteProblems.has(problem) || Boolean(fence && (!current(fence.generation)
      || fence.authority !== runAuthority || fence.contentRevision !== (context().contentRevision ?? 0)));
  }
  function describeError(problem, action) {
    if (isObsoleteError(problem)) return "";
    // The composer can retain the same public problem after this dialog closes.
    // Keep its original authority fence so a later refresh cannot revive a
    // private module label through localization or another caller's catch.
    if (problem && typeof problem === "object" && !problemFences.has(problem)) problemFences.set(problem,
      { generation, authority: runAuthority, contentRevision: context().contentRevision ?? 0 });
    return describeTeamActionError(problem, actionKinds.get(problem) ?? action, t);
  }
  function showError(problem) {
    if (isObsoleteError(problem)) return;
    displayedProblem = problem; displayedProblemText = null;
    error.textContent = describeError(problem);
  }
  function showLocalError(message) {
    displayedProblem = null; displayedProblemText = message; error.textContent = t(message);
  }
  function clearIntentProblem(intent) {
    if (displayedProblem && problemIntents.get(displayedProblem) === intent) { displayedProblem = null; error.textContent = ""; }
  }
  function mergeTeam(team) {
    const index = teams.findIndex(item => item.id === team.id);
    // Save/control advance the definition revision. Once that revision has
    // already been observed, their receipt cannot reset later test metadata,
    // including on an exact retry. A new authenticated GET remains authoritative.
    if (index >= 0 && teams[index].revision >= team.revision) return teams[index];
    if (index < 0) teams.push(team); else teams[index] = team;
    if (editId === team.id && baseline === configurationKey(team.draft,
      { max_calls: team.max_calls, max_duration_minutes: team.max_duration_minutes })) baseRevision = team.revision;
    return team;
  }
  function updateContext() {
    const next = context(); hostButton.disabled = !next.userId || !next.projectId || !next.sessionId
      || !(next.writable || canControl()) || !api.saveAgentTeam;
    const permission = `${next.writable}:${next.controlWritable ?? next.writable}`;
    const permissionChanged = writableState !== permission; writableState = permission;
    hostButton.textContent = t("Agent teams");
    const signature = JSON.stringify(teamConnectionChoices(next, t));
    if (scope === next.scope) {
      if (observedContentRevision !== (next.contentRevision ?? 0)) {
        observedContentRevision = next.contentRevision ?? 0; epoch++; clearPrivateRuns(runAccessBlocked); render();
      }
      if (signature !== catalogSignature && draft) {
        catalogSignature = signature;
        const focused = doc.activeElement, id = focused?.id, start = focused?.selectionStart, end = focused?.selectionEnd;
        renderInspector(); const replacement = id ? doc.getElementById(id) : null;
        if (replacement) { replacement.focus({ preventScroll: true });
          if (typeof start === "number") replacement.setSelectionRange?.(start, end); }
      }
      if (permissionChanged) render();
      return;
    }
    catalogSignature = signature;
    scope = next.scope; generation++; epoch++; teams = []; favorites = []; runs = []; testRuns = []; testReads.clear(); intents.clear(); selectedKey = "";
    runRefreshFailed = false; hadTaskActivity = false; displayedProblem = null; displayedProblemText = null;
    runAccessBlocked = false; observedContentRevision = next.contentRevision ?? 0; runAuthority++;
    editId = null; dirty = false; draft = null; baseline = null; clearTimeout(refreshTimer); readBusy = false;
    if (secondary.open) secondary.close(); if (dialog.open) dialog.close();
    refreshFavoriteControl = null; secondaryMode = ""; secondaryTitle.textContent = ""; secondaryBody.replaceChildren();
    nameInput.value = ""; calls.value = ""; minutes.value = ""; rulesInput.value = ""; inspector.replaceChildren();
    overview.hidden = false; editor.hidden = true; title.textContent = t("My Agent teams"); error.textContent = ""; status.textContent = "";
    canvas.select(null); canvas.render(); render();
    if (next.userId && next.sessionId) queueMicrotask(() => void refresh());
  }
  async function refresh() {
    updateContext(); const ctx = context(), gen = generation, before = epoch;
    if (!ctx.userId || !ctx.sessionId || readBusy) return; readBusy = true;
    // Only a marker already visible before this GET proves that its missing
    // private run has ended/been cleared. A marker arriving while an older GET
    // is in flight must wait for the next read, or a new start could be fenced.
    const pendingRunId = pendingCanonicalRunId(intents.get("start-task"), ctx);
    try {
      const results = await Promise.allSettled([api.listAgentTeams(), api.listTeamRuns(ctx.sessionId)]);
      if (!current(gen) || before !== epoch) return;
      let favoritesChanged = false;
      if (results[0].status === "fulfilled") {
        favoritesChanged = JSON.stringify(favorites) !== JSON.stringify(results[0].value.modules);
        for (const old of teams) if (!results[0].value.teams.some(team => team.id === old.id)) supersedeDefinitionActions(old.id);
        for (const old of favorites) if (!results[0].value.modules.some(item => item.id === old.id)) supersedeFavoriteCreation(old.id);
        teams = results[0].value.teams; favorites = results[0].value.modules; observeTeams(teams);
        // Favorite snapshots have no revision, and even created_at can match
        // after a same-tick delete/recreate. Once a read has observed this ID
        // during deletion, only another read may decide its current absence.
        // Keep the fence across exact-key retries of that deletion receipt.
        for (const intent of intents.values()) if (intent.kind === "favorite" && !intent.input.module
          && favorites.some(item => item.id === intent.id)) intent.favoriteObserved = true;
        for (const id of testReads.keys()) if (!teams.some(team => team.test_run_id === id)) testReads.delete(id);
        const fresh = saved();
        if (!dirty && fresh && fresh.revision !== baseRevision) {
          baseRevision = fresh.revision; draft = structuredClone(fresh.draft);
          budgets = { max_calls: fresh.max_calls, max_duration_minutes: fresh.max_duration_minutes };
          baseline = configurationKey(draft, budgets);
          nameInput.value = draft.name; calls.value = String(budgets.max_calls); minutes.value = String(budgets.max_duration_minutes);
          rulesInput.value = draft.team_prompt; canvas.render(); renderInspector();
        }
      } else if (dialog.open) showLocalError("Unable to refresh Teams.");
      if (results[1].status === "fulfilled") {
        runRefreshFailed = false; runAccessBlocked = false;
        const fresh = results[1].value.runs.filter(run => run.purpose !== "test");
        if (fresh.length) hadTaskActivity = true;
        const currentTests = results[1].value.runs.filter(run => run.purpose === "test");
        testRuns = [...currentTests, ...testRuns.filter(run => !currentTests.some(item => item.id === run.id)
          && teams.some(team => team.test_run_id === run.id))];
        for (const old of runs) if (!fresh.some(run => run.id === old.id)) fenceClearedRun(old.id);
        if (pendingRunId && !fresh.some(run => run.id === pendingRunId)) fenceClearedRun(pendingRunId);
        observeRuns(fresh.map(run => run.id));
        runs = fresh;
      } else {
        runRefreshFailed = true;
        if ([401, 403, 404].includes(results[1].reason?.status)) clearPrivateRuns(true);
      }
      if (saved()?.test_status === "failed") void loadTestFailure(saved());
      render(); if (favoritesChanged) showFavoritesContent(); onChange();
    } finally {
      if (current(gen)) { readBusy = false; clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refresh(), dialog.open || runs.some(run => !terminal(run)) || intents.size ? 2000 : 12000); refreshTimer.unref?.(); }
    }
  }
  async function attempt(intent) {
    if (intent.generation !== generation || intent.scope !== scope || context().scope !== scope) return;
    if (intent.superseded || intents.get(intent.slot) !== intent) return;
    if (intent.busy) return intent.promise;
    // An exact-key retry returns the server's current state. Only observations
    // arriving during this transport attempt can supersede that new receipt.
    const gen = generation, authority = runAuthority, contentRevision = context().contentRevision ?? 0;
    intent.busy = true; delete intent.observedRunIds; delete intent.observedTeams; epoch++; render(); clearIntentProblem(intent);
    intent.promise = (async () => {
      try {
        const emergency = intent.kind === "disable" || intent.kind === "run" && ["pause", "stop"].includes(intent.input.action);
        if (!context().writable && !(emergency && canControl())) {
          throw Object.assign(new Error("Team changes require current writable history."), { status: 409, code: "conflict" });
        }
        const result = await intent.call();
        if (!current(gen)) return;
        // A Delete receipt has no state revision. A newer observed definition
        // may be a recreated Team, so leave that snapshot and its pending
        // actions intact until the post-receipt authenticated refresh settles it.
        const newerDefinition = intent.kind === "delete" && teams.some(team => team.id === intent.id
          && team.revision > intent.definitionRevision);
        const observedFavoriteDeletion = intent.kind === "favorite" && !intent.input.module && intent.favoriteObserved;
        if (intent.kind === "delete" && !newerDefinition) supersedeDefinitionActions(intent.id);
        const observedTeamRevision = intent.observedTeams?.get(intent.id)?.revision;
        const teamReceiptCurrent = result.team && (observedTeamRevision === undefined || result.team.revision > observedTeamRevision);
        let acceptedTeam;
        if (teamReceiptCurrent && !intent.superseded) { acceptedTeam = mergeTeam(result.team); observeTeams([acceptedTeam], intent); }
        if (result.favorite && !intent.superseded && !favorites.some(item => item.id === result.favorite.id)) favorites.push(result.favorite);
        const runReceiptCurrent = authority === runAuthority && !runAccessBlocked
          && contentRevision === (context().contentRevision ?? 0) && intent.contentRevision === contentRevision;
        if (runReceiptCurrent && result.run?.purpose === "test" && (!intent.observedTeams?.has(intent.id)
          || intent.observedTeams.get(intent.id).testKey === intent.initialTestKey)) testRuns = [result.run, ...testRuns.filter(run => run.id !== result.run.id)];
        if (runReceiptCurrent && result.run && !intent.clearedRunIds?.has(result.run.id) && !intent.observedRunIds?.has(result.run.id)) { if (result.run.purpose !== "test") {
          const index = runs.findIndex(item => item.id === result.run.id);
          if (index < 0) runs.unshift(result.run); else if (!terminal(runs[index]) || terminal(result.run)) runs[index] = result.run;
          observeRuns([result.run.id], intent);
        } }
        const receipt = result.team ? { ...result, team: acceptedTeam ?? teams.find(team => team.id === result.team.id) ?? result.team } : result;
        if (!intent.superseded && !newerDefinition && !observedFavoriteDeletion
          && (intent.kind !== "test" || runReceiptCurrent)) intent.accept?.(receipt, intent);
        if (intent.kind === "favorite" && !intent.superseded) showFavoritesContent();
        clearIntentProblem(intent);
        intents.delete(intent.slot); status.textContent = t("Connection recovered.");
        return intent.superseded ? undefined : receipt;
      } catch (problem) {
        if (!current(gen)) return;
        if (intent.superseded) { intents.delete(intent.slot); return; }
        if (!isTeamActionUncertain(problem)) intents.delete(intent.slot);
        else intent.uncertain = true;
        const historyChanged = contentRevision !== (context().contentRevision ?? 0)
          || intent.contentRevision !== (context().contentRevision ?? 0);
        if (authority !== runAuthority || runAccessBlocked || historyChanged) {
          // Settle the original exact-key intent using its real outcome, but
          // never let its obsolete private error cross this boundary. Outer
          // click handlers and the composer can recognize the neutral failure
          // without replacing a newer validation or reviving a label on locale change.
          const neutral = Object.assign(new Error(historyChanged ? "Shared history changed; review the current conversation."
            : "Team access changed; review your current permissions."),
          { status: historyChanged ? 409 : 403, code: historyChanged ? "context_changed" : "forbidden" });
          obsoleteProblems.add(neutral); actionKinds.set(neutral, intent.kind); problemIntents.set(neutral, intent);
          throw neutral;
        }
        if (problem && typeof problem === "object") { actionKinds.set(problem, intent.kind); problemIntents.set(problem, intent); }
        if (["start", "run", "test"].includes(intent.kind) && [401, 403, 404].includes(problem?.status)) clearPrivateRuns(true);
        showError(problem); throw problem;
      } finally { if (current(gen)) { intent.busy = false; epoch++; render(); onChange(); void refresh(); } }
    })(); return intent.promise;
  }
  function mutate(slot, kind, id, value, call, accept) {
    const previous = intents.get(slot); if (previous) return attempt(previous);
    const intent = { slot, kind, id, generation, scope, contentRevision: context().contentRevision ?? 0,
      definitionRevision: teams.find(team => team.id === id)?.revision ?? 0,
      initialTestKey: testMetadataKey(teams.find(team => team.id === id)),
      input: structuredClone(value), call: () => call(intent.input), accept, busy: false };
    intents.set(slot, intent); if (kind === "start") hadTaskActivity = true; return attempt(intent);
  }
  async function recoverActions() {
    const gen = generation;
    for (const intent of [...intents.values()]) { if (!current(gen)) break;
      if (!intent.busy) { try { await attempt(intent); } catch { /* The original action remains reviewable. */ } } }
  }
  function changed() {
    if (!draft) return; updateDirty(); draftVersion++; error.textContent = ""; displayedProblem = null; displayedProblemText = null;
    if (dirty && (saved()?.enabled || pendingEnable(editId))) void control(saved(), false).catch(() => {});
    renderButtons();
  }
  function updateDirty() {
    const stored = saved(), key = configurationKey(draft, budgets);
    // A remote edit must not lend its successful test to an older visible draft.
    // Keep the editor's original CAS revision until that configuration is loaded.
    dirty = key !== baseline || Boolean(stored && key !== configurationKey(stored.draft,
      { max_calls: stored.max_calls, max_duration_minutes: stored.max_duration_minutes }));
  }
  async function saveCurrent() {
    if (!draft || !editId) throw Object.assign(new Error("Team editor unavailable"), { code: "unauthorized", status: 401 });
    const id = editId, gen = generation;
    const sameEditor = () => current(gen) && editId === id && draft;
    const stop = intents.get(`disable:${id}`); if (stop) { await attempt(stop); if (!sameEditor()) return; }
    const previous = intents.get(`save:${id}`); if (previous) { await attempt(previous); if (!sameEditor()) return; if (!dirty) return saved(); }
    if (!dirty && saved()) return saved();
    if (!nameInput.reportValidity() || !calls.reportValidity() || !minutes.reportValidity() || !draft.name.trim()) throw Object.assign(new Error("Invalid Team configuration"), { code: "validation_error", status: 422 });
    const version = draftVersion;
    const payload = { draft: structuredClone(draft), ...budgets, expected_revision: baseRevision, idempotency_key: makeKey("team-save") };
    const response = await mutate(`save:${id}`, "save", id, payload, value => api.saveAgentTeam(id, value), result => {
      if (editId === id) {
        // Library receipts identify the accepted mutation but can return a
        // newer current definition. Do not lend its revision to a newer local
        // draft that was never based on those unseen remote changes.
        if (draftVersion !== version && acceptedConfigurationKey(payload.draft, payload)
          !== acceptedConfigurationKey(result.team.draft, result.team)) {
          updateDirty();
          throw Object.assign(new Error("Team configuration changed during Save recovery"), { status: 409, code: "conflict" });
        }
        baseline = configurationKey(result.team.draft, { max_calls: result.team.max_calls, max_duration_minutes: result.team.max_duration_minutes });
        baseRevision = result.team.revision;
        if (draftVersion === version) {
          draft = structuredClone(result.team.draft);
          budgets = { max_calls: result.team.max_calls, max_duration_minutes: result.team.max_duration_minutes };
          nameInput.value = draft.name; calls.value = String(budgets.max_calls); minutes.value = String(budgets.max_duration_minutes);
          rulesInput.value = draft.team_prompt; canvas.render(); renderInspector();
        }
        updateDirty();
      }
    });
    return response?.team;
  }
  async function control(team, enabled) {
    if (!team) return;
    const ctx = context(), id = team.id;
    const payload = { enabled, ...(enabled ? { expected_revision: team.revision } : {}), idempotency_key: makeKey(enabled ? "team-enable" : "team-disable") };
    return mutate(`${enabled ? "enable" : "disable"}:${id}`, "control", id, payload,
      value => api.controlAgentTeam(ctx.sessionId, id, value));
  }
  async function toggleCurrent() {
    const team = saved(); if (team?.enabled || pendingEnable(editId)) return control(team, false);
    const id = editId, gen = generation, stored = await saveCurrent();
    if (!current(gen) || editId !== id || !canEnable(stored)) return; return control(stored, true);
  }
  function acknowledgeShared(plan) {
    return context().sessionMode !== "solo" || !plan.nodes.some(node => node.target?.kind === "shared")
      || confirm(t("Solo disclosure: shared modules send this task and conversation context to the owners' devices. Continue?"));
  }
  async function testCurrent() {
    const selectedId = editId, gen = generation, team = await saveCurrent();
    if (!current(gen) || editId !== selectedId || !team || !acknowledgeShared(team.draft)) return;
    const ctx = context(), id = team.id;
    return mutate(`test:${id}`, "test", id, { expected_revision: team.revision, content_revision: ctx.contentRevision ?? 0,
      solo_transfer_ack: ctx.sessionMode === "solo", idempotency_key: makeKey("team-test") }, value => api.executeAgentTeam(ctx.sessionId, id, value, true), (result, intent) => {
        const stored = teams.find(item => item.id === id);
        const observed = intent.observedTeams?.get(id);
        // A pre-acceptance GET may still say not_tested. The accepted probe
        // must then latch even if the following GET fails. A later observed
        // running/terminal test stamp, however, outranks this original ACK.
        if ((!observed || observed.testKey === intent.initialTestKey)
          && stored?.revision === team.revision && testMetadataKey(stored) === intent.initialTestKey) Object.assign(stored, { enabled: false, tested_revision: null, test_run_id: result.run.id, test_session_id: ctx.sessionId,
          test_status: ["completed", "running"].includes(result.run.status) ? "running" : "failed" });
      });
  }
  function openEditor(team) {
    if (team === null && teams.length >= 5) { showLocalError("Team limit reached (5). Delete one to add another."); return; }
    if (dirty && !confirm(t("Discard unsaved changes?"))) return;
    editId = team?.id ?? makeKey("team"); baseRevision = team?.revision ?? null;
    draft = team ? structuredClone(team.draft) : { name: t("New Agent Team"), team_prompt: "", nodes: [], edges: [] };
    budgets = { max_calls: team?.max_calls ?? 12, max_duration_minutes: team?.max_duration_minutes ?? 30 };
    baseline = team ? configurationKey(draft, budgets) : null;
    dirty = !team; draftVersion++; nameInput.value = draft.name; calls.value = String(budgets.max_calls); minutes.value = String(budgets.max_duration_minutes); rulesInput.value = draft.team_prompt;
    overview.hidden = true; editor.hidden = false; title.textContent = t("Edit my Agent team"); canvas.select(null); canvas.resetView(draft.entry_node_id); renderInspector(); renderButtons(); nameInput.focus();
    if (team?.test_status === "failed") void loadTestFailure(team);
  }
  async function loadTestFailure(team) {
    if (runAccessBlocked || !team?.test_run_id || !team.test_session_id || !api.getTeamRun || testRuns.some(run => run.id === team.test_run_id)
      || testReads.has(team.test_run_id) && Date.now() - testReads.get(team.test_run_id) < 12000) return;
    const gen = generation, authority = runAuthority, contentRevision = context().contentRevision ?? 0, id = team.test_run_id; testReads.set(id, Date.now());
    try {
      const result = await api.getTeamRun(team.test_session_id, id);
      if (!current(gen) || authority !== runAuthority || runAccessBlocked || contentRevision !== (context().contentRevision ?? 0)
        || result.run?.purpose !== "test" || result.run.id !== id || !teams.some(item => item.test_run_id === id)) return;
      testRuns = [result.run, ...testRuns.filter(run => run.id !== id)]; renderButtons(); onChange();
    } catch { /* A removed record or changed access cannot expose an old private failure. */ }
  }
  function insertModule(snapshot) {
    if (!draft || draft.nodes.length >= 16) { showLocalError("Maximum 16 modules and 32 data flows."); return; }
    const index = draft.nodes.length, id = makeKey("module"); let slot = 0;
    while (slot < 64 && draft.nodes.some(node => Math.abs(node.x - (60 + slot % 4 * 290)) < 245
      && Math.abs(node.y - (70 + Math.floor(slot / 4) * 180)) < 130)) slot++;
    draft.nodes.push({ ...(snapshot ? structuredClone(snapshot) : { label: `${t("Module")} ${index + 1}`, role: "", target: null }),
      id, x: 60 + slot % 4 * 290, y: 70 + Math.floor(slot / 4) * 180 });
    if (!draft.entry_node_id) draft.entry_node_id = draft.nodes[0].id; changed(); canvas.select({ kind: "node", id }); canvas.reveal(id); renderInspector();
  }
  function closeDialog() {
    if (dirty && !confirm(t("Discard unsaved changes?"))) return;
    dirty = false; editId = null; draft = null;
    if (secondary.open) secondary.close(); dialog.close(); restoreFocus();
  }
  function restoreFocus() {
    if (dialog.open || doc.querySelector?.("dialog[open]")) return;
    for (const candidate of [returnFocus, hostButton, doc.getElementById("mobile-tools-button"), doc.getElementById("mobile-compose-tools-button")]) {
      if (!candidate || candidate === doc.body || candidate === doc.documentElement || candidate.isConnected === false
        || candidate.disabled || candidate.closest?.("[hidden], [inert], dialog:not([open])") || !candidate.getClientRects?.().length) continue;
      const visibility = doc.defaultView?.getComputedStyle(candidate).visibility;
      if (visibility === "hidden" || visibility === "collapse") continue;
      candidate.focus({ preventScroll: true });
      if (doc.activeElement === candidate) return;
    }
  }
  // WebKit can restore BODY when the opener lives in a now-closed mobile
  // tools dialog. Run again after the native close focus steps have completed.
  dialog.addEventListener("close", restoreFocus);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  hostButton.addEventListener("click", () => { updateContext(); if (hostButton.disabled) return; returnFocus = doc.activeElement;
    overview.hidden = false; editor.hidden = true; title.textContent = t("My Agent teams"); dialog.showModal(); render(); void refresh();
    const gen = generation; void refreshSources().then(() => { if (current(gen)) updateContext(); }).catch(() => {}); });
  function selectField(text, choices, value, change, disabled = false) {
    const select = el("select"); select.id = `team-selection-${text.toLowerCase().replaceAll(" ", "-")}`; select.setAttribute("aria-label", t(text));
    for (const item of choices) { const option = el("option", "", item.available === false ? `${item.label} · ${t("Unavailable")}` : item.label);
      option.value = item.key; option.disabled = item.available === false; select.append(option); }
    select.value = value ?? ""; if (!choices.some(item => item.key === value)) select.selectedIndex = -1;
    select.disabled = disabled || !choices.length;
    select.addEventListener("change", () => change(select.value)); return field(text, select);
  }
  function restoreReplacedFocus(previous, replacement) {
    if (!previous || previous.isConnected !== false || !dialog.open || secondary.open
      || ![previous, doc.body].includes(doc.activeElement) || !replacement || replacement.disabled || !replacement.getClientRects?.().length) return;
    replacement.focus({ preventScroll: true });
    if (typeof previous.selectionStart === "number") replacement.setSelectionRange?.(previous.selectionStart, previous.selectionEnd);
  }
  function renderInspector() {
    const previous = doc.activeElement?.closest(".team-inspector") === inspector ? doc.activeElement : null;
    renderInspectorFields();
    if (previous?.id) restoreReplacedFocus(previous, doc.getElementById(previous.id));
  }
  function renderInspectorFields() {
    refreshFavoriteControl = null; inspector.replaceChildren(); if (!draft) return;
    const selected = canvas.selection();
    if (!selected) { inspector.append(el("p", "field-help", t("Select a module or data flow to edit it."))); return; }
    if (selected.kind === "node") {
      const node = draft.nodes.find(item => item.id === selected.id); if (!node) return;
      inspector.append(el("h3", "", t("Module")));
      const nodeName = input(`node-name-${node.id}`, 120); nodeName.value = node.label;
      nodeName.addEventListener("input", () => { node.label = nodeName.value; changed(); canvas.render(); refreshFavoriteState(); }); inspector.append(field("Name", nodeName));
      const choices = teamConnectionChoices(context(), t), connection = choices.find(item => item.key === teamConnectionKey(node.target));
      const targetBase = value => { if (!value) return null; const { reasoning_effort: _effort, ...base } = value; return base; };
      const model = connection?.models.find(item => teamModelKey(item.target) === teamModelKey(node.target)
        && JSON.stringify(item.target) === JSON.stringify(targetBase(node.target)));
      // Catalogs are advisory and may remove an exact route. Keep the saved
      // selection visible and disabled, never silently show/select a substitute.
      const unavailable = (key, label) => ({ key, label, available: false });
      const connectionChoices = [...choices];
      if (node.target && !connection) connectionChoices.unshift(unavailable(teamConnectionKey(node.target), node.target.kind === "cloud"
        ? t("Cloud Agent") : `${node.target.harness === "codex" ? "Codex" : "DSH"} · ${node.target.runtime_id ?? node.target.share_id}`));
      const modelChoices = [...(connection?.models ?? [])];
      const selectedModelKey = node.target && !model && modelChoices.some(item => item.key === teamModelKey(node.target))
        ? `saved:${teamModelKey(node.target)}` : node.target ? teamModelKey(node.target) : undefined;
      if (node.target && !model) modelChoices.unshift(unavailable(selectedModelKey, `${node.target.provider} · ${node.target.model}`));
      const profileFields = el("div", "team-model-grid");
      profileFields.append(selectField("Agent", connectionChoices, teamConnectionKey(node.target), key => {
        const next = choices.find(item => item.key === key); node.target = teamTargetForModel(next?.models.find(item => item.available !== false)); changed(); canvas.render(); renderInspector();
      }));
      profileFields.append(selectField("Model", modelChoices, selectedModelKey, key => {
        node.target = teamTargetForModel(connection.models.find(item => item.key === key)); changed(); canvas.render(); renderInspector();
      }));
      const efforts = model?.efforts ?? [];
      const effortChoices = efforts.map(value => ({ key: value, label: t(value) }));
      if (node.target?.reasoning_effort && !efforts.includes(node.target.reasoning_effort)) effortChoices.unshift(unavailable(node.target.reasoning_effort, t(node.target.reasoning_effort)));
      profileFields.append(selectField("Reasoning effort", effortChoices, node.target?.reasoning_effort, value => {
        const next = teamTargetForModel(model, value); if (!next) return; node.target = next; changed();
      }, !efforts.length)); inspector.append(profileFields);
      if (!efforts.length) inspector.append(el("p", "field-help", t("No reasoning choices advertised.")));
      if (node.target && (!connection || !connection.available || !model || model.available === false || (node.target.reasoning_effort && !efforts.includes(node.target.reasoning_effort)))) {
        inspector.append(el("p", "team-notice", t("This saved connection is unavailable. Choose an exact Agent and model again.")));
      }
      const role = input(`identity-${node.id}`, 1000); role.value = node.role;
      role.placeholder = t("Responsibilities and boundaries of this role.");
      role.addEventListener("input", () => { node.role = role.value; changed(); canvas.render(); refreshFavoriteState(); });
      const prompt = el("textarea"); prompt.id = `team-prompt-${node.id}`; prompt.maxLength = 2000; prompt.rows = 3; prompt.value = node.prompt ?? "";
      prompt.placeholder = t("How to work within this role and format the response.");
      prompt.addEventListener("input", () => { node.prompt = prompt.value; changed(); refreshFavoriteState(); }); inspector.append(field("Identity", role), field("Prompt", prompt));
      const nodeActions = el("div", "team-inspector-actions"); let matched = favorites.find(item => sameTeamSnapshot(item.module, moduleSnapshot(node)));
      const favoriteButton = button(matched ? "Unfavorite" : "Favorite", () => {
        favoriteButton.disabled = true;
        if (matched) {
          const id = matched.id;
          void mutate(`favorite:${id}`, "favorite", id, { idempotency_key: makeKey("team-unfavorite") },
            value => api.deleteTeamItem("module", id, value), () => { supersedeFavoriteCreation(id); favorites = favorites.filter(item => item.id !== id); renderInspector(); }).catch(showError);
        } else {
          if (favorites.length >= 5) { showLocalError("Favorite limit reached (5). Remove one to add another."); return; }
          const id = makeKey("favorite");
          void mutate(`favorite-node:${node.id}`, "favorite", id, { module: moduleSnapshot(node), idempotency_key: makeKey("team-favorite") },
            value => api.saveTeamModule(id, value), () => renderInspector()).catch(showError).finally(refreshFavoriteState);
        }
      });
      function refreshFavoriteState() {
        matched = favorites.find(item => sameTeamSnapshot(item.module, moduleSnapshot(node)));
        favoriteButton.textContent = t(matched ? "Unfavorite" : "Favorite");
        favoriteButton.disabled = !node.label.trim() || (!matched && favorites.length >= 5) || intents.has(`favorite-node:${node.id}`)
          || Boolean(matched && intents.has(`favorite:${matched.id}`));
      }
      favoriteButton.id = "team-module-favorite"; refreshFavoriteControl = refreshFavoriteState; refreshFavoriteState();
      const entry = button("Start from this module", () => { draft.entry_node_id = node.id; changed(); canvas.render(); renderInspector(); }, "text-button");
      entry.disabled = (draft.entry_node_id ?? draft.nodes[0]?.id) === node.id;
      const remove = button("Delete module", () => { draft = removeTeamNode(draft, node.id); canvas.select(null); changed(); canvas.render(); renderInspector(); }, "text-button team-danger");
      nodeActions.append(favoriteButton, entry, remove); inspector.append(nodeActions);
    } else {
      const edge = draft.edges.find(item => item.id === selected.id); if (!edge) return;
      inspector.append(el("h3", "", t("Data flow")));
      const endpoints = draft.nodes.map(node => ({ key: node.id, label: node.label })), endpointsGrid = el("div", "team-edge-endpoints");
      function updateEdge(property, value) {
        const candidate = { ...edge, [property]: value };
        if (!teamEdgeAllowed(draft.edges, candidate.source, candidate.target, candidate.direction, edge.id)) { showLocalError("This route already exists, or its endpoints are invalid."); renderInspector(); return; }
        Object.assign(edge, candidate); changed(); canvas.render(); renderInspector();
      }
      endpointsGrid.append(selectField("Source", endpoints, edge.source, value => updateEdge("source", value)),
        selectField("Destination", endpoints, edge.target, value => updateEdge("target", value)));
      const directions = el("div", "team-direction");
      for (const [value, label] of [["one_way", "One-way"], ["bidirectional", "Bidirectional"]]) {
        const node = button(label, () => updateEdge("direction", value)); node.setAttribute("aria-pressed", String(edge.direction === value)); directions.append(node);
      }
      const remove = button("Delete data flow", () => { draft.edges = draft.edges.filter(item => item.id !== edge.id); canvas.select(null); changed(); canvas.render(); renderInspector(); }, "text-button team-danger");
      inspector.append(endpointsGrid, directions, remove);
    }
  }
  function showRelationships() {
    secondaryMode = "relationships"; secondaryTitle.textContent = t("Configuration relationships"); secondaryBody.replaceChildren();
    const relationships = el("ol", "team-relationships");
    for (const edge of draft?.edges ?? []) {
      const from = draft.nodes.find(node => node.id === edge.source), to = draft.nodes.find(node => node.id === edge.target);
      relationships.append(el("li", "", `${from?.label ?? edge.source} ${edge.direction === "bidirectional" ? "↔" : "→"} ${to?.label ?? edge.target}`));
    }
    if (relationships.children.length) secondaryBody.append(relationships); else secondaryBody.append(el("p", "field-help", t("No data flows yet.")));
    if (!secondary.open) secondary.showModal();
  }
  function showFavorites() {
    const previous = doc.activeElement, focusKey = previous?.dataset?.teamFavoriteControl;
    secondaryMode = "favorites"; secondaryTitle.textContent = `${t("Favorite modules")} (${favorites.length}/5)`; secondaryBody.replaceChildren();
    if (!favorites.length) secondaryBody.append(el("p", "field-help", t("No favorite modules yet.")));
    const favoriteList = el("ul", "team-library-list");
    for (const favorite of favorites) {
      const row = el("li", "team-library-row"), choose = button("", () => { insertModule(favorite.module); secondary.close(); }, "team-row-edit");
      choose.dataset.teamFavoriteControl = `pick:${favorite.id}`;
      choose.textContent = favorite.module.label;
      const remove = button("Delete", () => { void mutate(`favorite:${favorite.id}`, "favorite", favorite.id,
        { idempotency_key: makeKey("team-unfavorite") }, value => api.deleteTeamItem("module", favorite.id, value), () => {
          supersedeFavoriteCreation(favorite.id); favorites = favorites.filter(item => item.id !== favorite.id); showFavoritesContent(); renderInspector();
        }).catch(showError); }, "text-button team-danger");
      remove.dataset.teamFavoriteControl = `delete:${favorite.id}`;
      remove.setAttribute("aria-label", `${t("Delete")}: ${favorite.module.label}`); row.append(choose, remove); favoriteList.append(row);
    }
    secondaryBody.append(favoriteList); if (!secondary.open) secondary.showModal();
    if (focusKey && previous.isConnected === false && [previous, doc.body].includes(doc.activeElement)) {
      const replacement = [...secondaryBody.querySelectorAll("[data-team-favorite-control]")].find(node => node.dataset.teamFavoriteControl === focusKey)
        ?? secondaryHeader.querySelector("button");
      replacement?.focus({ preventScroll: true });
    }
  }
  const showFavoritesContent = () => { if (dialog.open && secondary.open && secondaryMode === "favorites") showFavorites(); };
  function renderButtons() {
    const team = saved(), pending = pendingFor(editId), stopping = intents.get(`disable:${editId}`), enabling = pendingEnable(editId);
    const saving = pending.some(intent => intent.kind === "save");
    const writable = context().writable;
    for (const input of [nameInput, rulesInput, calls, minutes]) input.disabled = !writable;
    saveButton.textContent = t(saving ? "Saving…" : dirty ? "Save" : "Saved"); saveButton.disabled = !writable || !dirty || saving;
    addBlank.disabled = !writable || !draft || draft.nodes.length >= 16; clearButton.disabled = !writable || !draft?.nodes.length;
    addFavorite.disabled = !writable || !favorites.length || draft?.nodes.length >= 16;
    const testing = team?.test_status === "running" || pending.some(intent => intent.kind === "test");
    testButton.textContent = t(testing ? "Test running…" : !dirty && canEnable(team) ? "Successfully connected" : "Test");
    testButton.disabled = !context().writable || saving || testing || !draft?.nodes.length || (!dirty && canEnable(team));
    const active = team?.enabled || enabling;
    enableButton.textContent = t(stopping?.busy ? "Stopping…" : active ? "Disable" : "Enable");
    enableButton.className = `team-glass ${active ? "team-danger" : "team-enable"}`;
    // A pending enable does not block independent disable, even before its acknowledgement.
    enableButton.disabled = active ? !canControl() || Boolean(stopping?.busy) : !writable || dirty || !canEnable(team) || saving || testing;
    testState.textContent = t(dirty ? "Changes require a new test." : testing ? "Test running…" : team?.test_status === "failed"
      ? "Test failed. Review the modules and try again." : canEnable(team) ? "Successfully connected" : "Not tested");
    if (!dirty && ["running", "failed"].includes(team?.test_status) && !pending.some(intent => intent.kind === "test")) {
      const diagnostic = formatTeamRunIssue(testRuns.find(run => run.id === team.test_run_id), t);
      if (diagnostic) testState.textContent = `${diagnostic.text} ${diagnostic.advice}`;
      else if (team.test_status === "failed") testState.textContent = t("Test failed. The detailed record is unavailable; check the connections and retest. Test calls use provider and sharing allowances.");
    }
    recover.hidden = ![...intents.values()].some(intent => intent.uncertain && !intent.busy);
    status.textContent = [...intents.values()].some(intent => intent.uncertain) ? t("The last action is unconfirmed. Check it before repeating it.") : "";
  }
  function renderRuns() {
    runList.replaceChildren();
    if (runRefreshFailed) { const notice = runNotice(); if (notice) runList.append(el("p", "field-help team-run-refresh-error", `${notice.text} ${notice.advice}`)); }
    if (!runs.length) runList.append(el("p", "field-help", t("No private run records in this session.")));
    for (const run of runs.slice(0, 12)) {
      const row = el("article", "team-run-row"), summary = el("p");
      const needsClarification = run.status === "paused" && run.error_code === "agent_team_instruction_conflict";
      summary.textContent = `${teams.find(team => team.id === run.definition_id)?.draft.name ?? "Team"} · ${t(needsClarification ? "Awaiting clarification" : run.status)} · ${run.calls_used}/${run.max_calls}`;
      const actions = el("div", "team-run-actions");
      const available = run.status === "running" ? [["pause", "Pause"], ["stop", "Stop"]] : run.status === "paused"
        ? [...(run.error_code === "agent_timeout" && !teamTimeoutContinuationAvailable(run) ? []
          : [[run.error_code === "agent_timeout" ? "continue" : "resume", needsClarification ? "Continue after clarification" : run.error_code === "agent_timeout" ? "Continue" : "Resume"]]), ["stop", "Stop"]] : [];
      for (const [action, label] of available) {
        const controlButton = button(label, () => void controlRun(run, action).catch(showError), action === "stop" ? "team-glass team-danger" : "team-glass");
        controlButton.dataset.teamControl = `run:${run.id}:${action}`;
        controlButton.disabled = !(["pause", "stop"].includes(action) ? canControl() : context().writable) || Boolean(intents.get(`run-${action}:${run.id}`)?.busy); actions.append(controlButton);
      }
      if (terminal(run) && api.forgetTeamRun) {
        const slot = `forget:${run.id}`, clear = button("Clear private record", () => {
          if (!confirm(t("Clear this private run record? Conversation messages will stay."))) return;
          const ctx = context();
          void mutate(slot, "forget", run.id, {}, () => api.forgetTeamRun(ctx.sessionId, run.id), () => {
            fenceClearedRun(run.id); runs = runs.filter(item => item.id !== run.id);
          }).catch(showError);
        }, "text-button team-danger");
        clear.dataset.teamControl = `run:${run.id}:forget`; clear.disabled = !context().writable || Boolean(intents.get(slot)?.busy); actions.append(clear);
      }
      row.append(summary);
      const diagnostic = formatTeamRunIssue(run, t);
      if (diagnostic) {
        row.append(el("p", "field-help team-run-reason", diagnostic.text));
        row.append(el("p", "field-help team-run-advice", diagnostic.advice));
      }
      row.append(actions); runList.append(row);
    }
  }
  function render() {
    const previous = doc.activeElement, focusKey = previous?.dataset?.teamControl;
    list.replaceChildren(); count.textContent = `${teams.length}/5`;
    if (!teams.length) list.append(el("li", "field-help", t("No Teams saved yet. Start by adding one.")));
    for (const team of teams) {
      const row = el("li", "team-library-row"), edit = button("", () => openEditor(team), "team-row-edit"), label = el("strong", "", team.draft.name),
        detail = el("small", "", `${team.draft.nodes.length} ${t("Module")} · ${t(team.enabled ? "Enabled" : team.test_status === "passed" ? "Disabled" : team.test_status === "running" ? "Test running…" : "Not tested")}`);
      edit.dataset.teamControl = `team:${team.id}:edit`; edit.append(label, detail);
      const active = team.enabled || pendingEnable(team.id), stop = intents.get(`disable:${team.id}`), toggle = button(active ? "Disable" : "Enable", () => {
        void control(team, !active).catch(showError);
      }, `team-glass team-toggle ${active ? "team-danger" : "team-enable"}`);
      toggle.dataset.teamControl = `team:${team.id}:toggle`;
      toggle.disabled = active ? !canControl() || Boolean(stop?.busy) : !context().writable || !canEnable(team); toggle.setAttribute("aria-label", `${t(active ? "Disable" : "Enable")}: ${team.draft.name}`);
      const remove = button("Delete", () => { if (!confirm(t("Delete this saved Team? Accepted tasks keep their original configuration."))) return;
        void mutate(`delete:${team.id}`, "delete", team.id, { idempotency_key: makeKey("team-delete") }, value => api.deleteTeamItem("team", team.id, value), () => {
          teams = teams.filter(item => item.id !== team.id); if (editId === team.id) { editId = null; dirty = false; overview.hidden = false; editor.hidden = true; }
        }).catch(showError);
      }, "text-button team-delete"); remove.disabled = !context().writable; remove.dataset.teamControl = `team:${team.id}:delete`; remove.setAttribute("aria-label", `${t("Delete")}: ${team.draft.name}`);
      row.append(edit, toggle, remove); list.append(row);
    }
    add.disabled = !context().writable || teams.length >= 5; add.title = teams.length >= 5 ? t("Team limit reached (5). Delete one to add another.") : "";
    renderButtons(); renderRuns(); refreshFavoriteControl?.();
    if (focusKey) {
      const replacement = [...dialog.querySelectorAll("[data-team-control]")].find(node => node.dataset.teamControl === focusKey);
      const fallback = focusKey.startsWith("run:") ? recordTitle : add.disabled ? close : add;
      restoreReplacedFocus(previous, replacement && !replacement.disabled ? replacement : fallback);
    }
  }
  async function controlRun(run, action) {
    const ctx = context();
    return mutate(`run-${action}:${run.id}`, "run", run.id, { action, idempotency_key: makeKey(`team-${action}`) },
      value => api.controlTeamRun(ctx.sessionId, run.id, value));
  }
  const activeRun = () => {
    const pending = intents.get("start-task"), ctx = context();
    if (runAccessBlocked) return undefined;
    if (!pending) return runs.find(run => ["running", "paused"].includes(run.status));
    if (pending.contentRevision !== (ctx.contentRevision ?? 0)) return undefined;
    const runId = pendingCanonicalRunId(pending, ctx);
    if (!runId || pending.clearedRunIds?.has(runId)) return undefined;
    const known = runs.find(run => run.id === runId);
    if (known) return terminal(known) ? undefined : known;
    return { id: runId, session_id: ctx.sessionId, status: "running", purpose: "task" };
  };
  function runNotice() {
    if (runRefreshFailed && (hadTaskActivity || intents.has("start-task"))) return { runId: null, code: "unconfirmed", moduleLabel: null,
      text: t("Unable to confirm the latest Team status."),
      advice: t("The connection or your access may have changed. Status will refresh automatically after reconnection; do not submit the same task again. Open run records to check.") };
    // Two devices can have two accepted tasks. A healthy newer task must not
    // hide another still-active task that needs clarification or recovery.
    const run = runs.find(item => item.status === "paused")
      ?? runs.find(item => item.status === "running" && formatTeamRunIssue(item, t)) ?? runs[0];
    const diagnostic = formatTeamRunIssue(run, t);
    return diagnostic ? { runId: run.id, ...diagnostic } : null;
  }
  async function startTask(content, options = {}) {
    updateContext();
    // Recover a frozen accepted intent before consulting the current picker or
    // library. Disabling/deleting its definition does not cancel that task.
    const previous = intents.get("start-task"); if (previous) return attempt(previous);
    const team = teams.find(item => `team:${item.id}` === selectedKey), ctx = context();
    if (!team?.enabled || !canEnable(team)) throw Object.assign(new Error("Team is not enabled"), { code: "agent_team_not_enabled", status: 409 });
    if (activeRun()) throw Object.assign(new Error("Team task already active"), { code: "agent_team_busy", status: 429 });
    if (!acknowledgeShared(team.draft)) return null;
    const previousEvents = new Set((ctx.events ?? []).map(event => event.id));
    const pending = mutate("start-task", "start", team.id, { content,
      ...(options.replyTo ? { reply_to_event_id: options.replyTo } : {}),
      ...(options.mentions?.length ? { mentions: options.mentions } : {}),
      expected_revision: team.revision, content_revision: ctx.contentRevision ?? 0,
      solo_transfer_ack: ctx.sessionMode === "solo", idempotency_key: makeKey("team-task") }, value => api.executeAgentTeam(ctx.sessionId, team.id, value), receipt => {
      options.onAccepted?.(receipt);
    });
    const intent = intents.get("start-task"); if (intent) intent.previousEvents = previousEvents;
    return pending;
  }
  return { updateContext, refresh, open: () => hostButton.click(),
    refreshLanguage() { translations.forEach(update => update());
      for (const surface of [dialog, secondary]) for (const node of surface.querySelectorAll("[data-team-i18n]")) node.textContent = t(node.dataset.teamI18n);
      hostButton.textContent = t("Agent teams");
      title.textContent = t(editor.hidden ? "My Agent teams" : "Edit my Agent team");
      rulesInput.setAttribute("aria-label", t("Team rules"));
      if (draft) { canvas.render(); renderInspector(); }
      if (secondary.open) { if (secondaryMode === "favorites") showFavorites(); else if (secondaryMode === "relationships") showRelationships(); }
      render(); if (displayedProblem) showError(displayedProblem); else if (displayedProblemText) error.textContent = t(displayedProblemText); },
    t, choices: () => teams.filter(team => team.enabled && canEnable(team)).map(team => ({ key: `team:${team.id}`, label: team.draft.name, team })),
    selected: () => teams.find(team => `team:${team.id}` === selectedKey), select(key) { selectedKey = key; }, selectionKey: () => selectedKey,
    startTask, pendingStart: () => intents.has("start-task"), activeRun, recover: recoverActions, runNotice,
    describeError, isObsoleteError,
    openRunRecords() { if (!dialog.open) { returnFocus = doc.activeElement; dialog.showModal(); }
      records.open = true; renderRuns(); recordTitle.focus({ preventScroll: true }); void refresh(); },
    controlRun, stopActive: () => { const run = activeRun(); return run ? controlRun(run, "stop") : Promise.resolve(); },
    stopping: () => { const run = activeRun(); return Boolean(run && intents.get(`run-stop:${run.id}`)?.busy); },
  };
}
