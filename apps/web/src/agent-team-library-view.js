import { TEAM_ZH_CN } from "./agent-team-i18n.js";
import { mountTeamCanvas } from "./agent-team-canvas.js";
import { teamConnectionChoices, teamConnectionKey, teamModelKey, teamTargetForModel, moduleSnapshot,
  sameTeamSnapshot, removeTeamNode, teamEdgeAllowed } from "./agent-team-graph.js";
const terminal = run => !["running", "paused"].includes(run.status);
const clarificationHelp = "Send a chat message in this session explaining how to proceed, then select Continue after clarification. To change identities, prompts or data flows, stop this task, edit and retest the Team, then start a new task.";

export function mountAgentTeams({ document: doc, api, hostButton, getContext, onChange = () => {},
  refreshSources = async () => {},
  makeKey = prefix => `${prefix}-${crypto.randomUUID()}`, confirm = message => globalThis.confirm(message) }) {
  const t = text => doc.documentElement.lang.startsWith("zh") ? TEAM_ZH_CN[text] ?? text : text;
  const translations = [];
  const el = (tag, className = "", text = "") => { const node = doc.createElement(tag); node.className = className;
    node.setAttribute("data-i18n-skip", ""); node.textContent = text; return node; };
  const button = (text, action, className = "team-glass") => { const node = el("button", className, t(text));
    if (text) translations.push(() => { node.textContent = t(text); });
    node.type = "button"; if (action) node.addEventListener("click", action); return node; };
  const field = (text, input) => { const wrapper = el("label", "team-field"), label = el("span", "", t(text));
    translations.push(() => { label.textContent = t(text); }); wrapper.append(label, input); return wrapper; };
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

  let scope = "", generation = 0, epoch = 0, readBusy = false, refreshTimer, teams = [], favorites = [], runs = [],
    editId = null, draft = null, budgets = null, baseRevision = null, dirty = false, draftVersion = 0, selectedKey = "", returnFocus, catalogSignature = "";
  const intents = new Map();
  const canvas = mountTeamCanvas({ document: doc, host: graphHost, t, makeId: makeKey, getDraft: () => draft,
    onChange: changed, onSelection: () => renderInspector() });
  const context = () => getContext() ?? {};
  const current = gen => gen === generation && context().scope === scope;
  const saved = () => teams.find(team => team.id === editId);
  const pendingFor = id => [...intents.values()].filter(intent => intent.id === id);
  const pendingEnable = id => pendingFor(id).some(intent => intent.kind === "control" && intent.input.enabled);
  const canEnable = team => team?.test_status === "passed" && team.tested_revision === team.revision;
  function showError(problem) {
    const messages = { conflict: "The configuration changed elsewhere. Your unsaved edits are kept. Reopen the Team to load the latest version.",
      agent_team_incomplete: "Choose an Agent, model and reasoning effort for every module.", agent_team_disconnected: "Connect every module to the start module.",
      agent_team_limit: "Team limit reached (5). Delete one to add another.", agent_team_favorite_limit: "Favorite limit reached (5). Remove one to add another.",
      agent_team_target_unavailable: "This saved connection is unavailable. Choose an exact Agent and model again.",
      agent_team_clarification_required: clarificationHelp,
      validation_error: "Review the Team configuration and try again." };
    error.textContent = t(messages[problem?.code] ?? "Unable to complete this Team action.");
  }
  function mergeTeam(team, own = false) {
    const index = teams.findIndex(item => item.id === team.id);
    if (index >= 0 && teams[index].revision > team.revision) return;
    if (index < 0) teams.push(team); else teams[index] = team;
    if (editId === team.id && (!dirty || own)) baseRevision = team.revision;
  }
  function updateContext() {
    const next = context(); hostButton.disabled = !next.userId || !next.projectId || !next.sessionId || !next.writable || !api.saveAgentTeam;
    hostButton.textContent = t("Agent teams");
    const signature = JSON.stringify(teamConnectionChoices(next, t));
    if (scope === next.scope) {
      if (signature !== catalogSignature && draft) {
        catalogSignature = signature;
        const focused = doc.activeElement, id = focused?.id, start = focused?.selectionStart, end = focused?.selectionEnd;
        renderInspector(); const replacement = id ? doc.getElementById(id) : null;
        if (replacement) { replacement.focus({ preventScroll: true });
          if (typeof start === "number") replacement.setSelectionRange?.(start, end); }
      }
      return;
    }
    catalogSignature = signature;
    scope = next.scope; generation++; epoch++; teams = []; favorites = []; runs = []; intents.clear(); selectedKey = "";
    editId = null; dirty = false; draft = null; clearTimeout(refreshTimer); readBusy = false;
    if (secondary.open) secondary.close(); if (dialog.open) dialog.close();
    if (next.userId && next.sessionId) queueMicrotask(() => void refresh());
  }
  async function refresh() {
    updateContext(); const ctx = context(), gen = generation, before = epoch;
    if (!ctx.userId || !ctx.sessionId || readBusy) return; readBusy = true;
    try {
      const results = await Promise.allSettled([api.listAgentTeams(), api.listTeamRuns(ctx.sessionId)]);
      if (!current(gen) || before !== epoch) return;
      if (results[0].status === "fulfilled") {
        teams = results[0].value.teams; favorites = results[0].value.modules;
        const fresh = saved();
        if (!dirty && fresh && fresh.revision !== baseRevision) {
          baseRevision = fresh.revision; draft = structuredClone(fresh.draft);
          budgets = { max_calls: fresh.max_calls, max_duration_minutes: fresh.max_duration_minutes };
          nameInput.value = draft.name; calls.value = String(budgets.max_calls); minutes.value = String(budgets.max_duration_minutes);
          rulesInput.value = draft.team_prompt; canvas.render(); renderInspector();
        }
      } else if (dialog.open) error.textContent = t("Unable to refresh Teams.");
      if (results[1].status === "fulfilled") runs = results[1].value.runs.filter(run => run.purpose !== "test");
      render(); onChange();
    } finally {
      if (current(gen)) { readBusy = false; clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refresh(), dialog.open || runs.some(run => !terminal(run)) || intents.size ? 2000 : 12000); refreshTimer.unref?.(); }
    }
  }
  async function attempt(intent) {
    if (intent.generation !== generation || intent.scope !== scope || context().scope !== scope) return;
    if (intent.busy) return intent.promise;
    const gen = generation; intent.busy = true; epoch++; render(); error.textContent = "";
    intent.promise = (async () => {
      try {
        const result = await intent.call();
        if (!current(gen)) return;
        if (result.team) mergeTeam(result.team, true);
        if (result.favorite && !favorites.some(item => item.id === result.favorite.id)) favorites.push(result.favorite);
        if (result.run) { if (result.run.purpose !== "test") {
          const index = runs.findIndex(item => item.id === result.run.id);
          if (index < 0) runs.unshift(result.run); else if (!terminal(runs[index]) || terminal(result.run)) runs[index] = result.run;
        } }
        intent.accept?.(result); intents.delete(intent.slot); status.textContent = t("Connection recovered.");
        return result;
      } catch (problem) {
        if (!current(gen)) throw problem;
        if (problem.status >= 400 && problem.status < 500) intents.delete(intent.slot);
        else intent.uncertain = true;
        showError(problem); throw problem;
      } finally { if (current(gen)) { intent.busy = false; epoch++; render(); onChange(); void refresh(); } }
    })(); return intent.promise;
  }
  function mutate(slot, kind, id, value, call, accept) {
    const previous = intents.get(slot); if (previous) return attempt(previous);
    const intent = { slot, kind, id, generation, scope, input: structuredClone(value), call: () => call(intent.input), accept, busy: false };
    intents.set(slot, intent); return attempt(intent);
  }
  async function recoverActions() {
    const gen = generation;
    for (const intent of [...intents.values()]) { if (!current(gen)) break;
      if (!intent.busy) { try { await attempt(intent); } catch { /* The original action remains reviewable. */ } } }
  }
  function changed() {
    if (!draft) return; dirty = true; draftVersion++; error.textContent = "";
    if (saved()?.enabled || pendingEnable(editId)) void control(saved(), false).catch(() => {});
    renderButtons();
  }
  async function saveCurrent() {
    if (!draft || !editId) throw new Error(t("Connect and sign in before configuring Teams."));
    const id = editId, gen = generation;
    const assertEditor = () => { if (!current(gen) || editId !== id || !draft) throw new Error(t("Unable to complete this Team action.")); };
    const stop = intents.get(`disable:${id}`); if (stop) { await attempt(stop); assertEditor(); }
    const previous = intents.get(`save:${id}`); if (previous) { await attempt(previous); assertEditor(); if (!dirty) return saved(); }
    if (!dirty && saved()) return saved();
    if (!nameInput.reportValidity() || !calls.reportValidity() || !minutes.reportValidity() || !draft.name.trim()) throw new Error(t("Review the Team configuration and try again."));
    const version = draftVersion;
    const payload = { draft: structuredClone(draft), ...budgets, expected_revision: baseRevision, idempotency_key: makeKey("team-save") };
    const response = await mutate(`save:${id}`, "save", id, payload, value => api.saveAgentTeam(id, value), result => {
      if (editId === id && draftVersion === version) { dirty = false; draft = structuredClone(result.team.draft); }
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
      solo_transfer_ack: ctx.sessionMode === "solo", idempotency_key: makeKey("team-test") }, value => api.executeAgentTeam(ctx.sessionId, id, value, true), result => {
        const stored = teams.find(item => item.id === id);
        if (stored) Object.assign(stored, { enabled: false, tested_revision: null, test_run_id: result.run.id, test_session_id: ctx.sessionId,
          test_status: ["completed", "running"].includes(result.run.status) ? "running" : "failed" });
      });
  }
  function openEditor(team) {
    if (team === null && teams.length >= 5) { error.textContent = t("Team limit reached (5). Delete one to add another."); return; }
    if (dirty && !confirm(t("Discard unsaved changes?"))) return;
    editId = team?.id ?? makeKey("team"); baseRevision = team?.revision ?? null;
    draft = team ? structuredClone(team.draft) : { name: t("New Agent Team"), team_prompt: "", nodes: [], edges: [] };
    budgets = { max_calls: team?.max_calls ?? 12, max_duration_minutes: team?.max_duration_minutes ?? 30 };
    dirty = !team; draftVersion++; nameInput.value = draft.name; calls.value = String(budgets.max_calls); minutes.value = String(budgets.max_duration_minutes); rulesInput.value = draft.team_prompt;
    overview.hidden = true; editor.hidden = false; title.textContent = t("Edit my Agent team"); canvas.select(null); canvas.render(); renderInspector(); renderButtons(); nameInput.focus();
  }
  function insertModule(snapshot) {
    if (!draft || draft.nodes.length >= 16) { error.textContent = t("Maximum 16 modules and 32 data flows."); return; }
    const index = draft.nodes.length, id = makeKey("module"); let slot = 0;
    while (slot < 64 && draft.nodes.some(node => Math.abs(node.x - (60 + slot % 4 * 290)) < 245
      && Math.abs(node.y - (70 + Math.floor(slot / 4) * 180)) < 130)) slot++;
    draft.nodes.push({ ...(snapshot ? structuredClone(snapshot) : { label: `${t("Module")} ${index + 1}`, role: "", target: null }),
      id, x: 60 + slot % 4 * 290, y: 70 + Math.floor(slot / 4) * 180 });
    if (!draft.entry_node_id) draft.entry_node_id = id; changed(); canvas.select({ kind: "node", id }); canvas.reveal(id); renderInspector();
  }
  function closeDialog() {
    if (dirty && !confirm(t("Discard unsaved changes?"))) return;
    dirty = false; editId = null; draft = null;
    if (secondary.open) secondary.close(); dialog.close(); returnFocus?.focus();
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  hostButton.addEventListener("click", () => { updateContext(); if (hostButton.disabled) return; returnFocus = doc.activeElement;
    overview.hidden = false; editor.hidden = true; title.textContent = t("My Agent teams"); dialog.showModal(); render(); void refresh();
    const gen = generation; void refreshSources().then(() => { if (current(gen)) updateContext(); }).catch(() => {}); });
  function selectField(text, choices, value, change, disabled = false) {
    const select = el("select"); select.setAttribute("aria-label", t(text));
    for (const item of choices) { const option = el("option", "", item.label); option.value = item.key; option.disabled = item.available === false; select.append(option); }
    select.value = value ?? ""; if (!choices.some(item => item.key === value)) select.selectedIndex = -1;
    select.disabled = disabled || !choices.length;
    select.addEventListener("change", () => change(select.value)); return field(text, select);
  }
  function renderInspector() {
    inspector.replaceChildren(); if (!draft) return;
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
      const profileFields = el("div", "team-model-grid");
      profileFields.append(selectField("Agent", choices, teamConnectionKey(node.target), key => {
        const next = choices.find(item => item.key === key); node.target = teamTargetForModel(next?.models.find(item => item.available !== false)); changed(); canvas.render(); renderInspector();
      }));
      profileFields.append(selectField("Model", connection?.models ?? [], model?.key, key => {
        node.target = teamTargetForModel(connection.models.find(item => item.key === key)); changed(); canvas.render(); renderInspector();
      }));
      const efforts = model?.efforts ?? [];
      profileFields.append(selectField("Reasoning effort", efforts.map(value => ({ key: value, label: t(value) })), node.target?.reasoning_effort, value => {
        const next = teamTargetForModel(model, value); if (!next) return; node.target = next; changed();
      }, !efforts.length)); inspector.append(profileFields);
      if (!efforts.length) inspector.append(el("p", "field-help", t("No reasoning choices advertised.")));
      if (node.target && (!connection || !connection.available || !model || (node.target.reasoning_effort && !efforts.includes(node.target.reasoning_effort)))) {
        inspector.append(el("p", "team-notice", t("This saved connection is unavailable. Choose an exact Agent and model again.")));
      }
      const role = input(`identity-${node.id}`, 1000); role.value = node.role;
      role.placeholder = t("Responsibilities and boundaries of this role.");
      role.addEventListener("input", () => { node.role = role.value; changed(); canvas.render(); refreshFavoriteState(); });
      const prompt = el("textarea"); prompt.maxLength = 2000; prompt.rows = 3; prompt.value = node.prompt ?? "";
      prompt.placeholder = t("How to work within this role and format the response.");
      prompt.addEventListener("input", () => { node.prompt = prompt.value; changed(); refreshFavoriteState(); }); inspector.append(field("Identity", role), field("Prompt", prompt));
      const nodeActions = el("div", "team-inspector-actions"); let matched = favorites.find(item => sameTeamSnapshot(item.module, moduleSnapshot(node)));
      const favoriteButton = button(matched ? "Unfavorite" : "Favorite", () => {
        favoriteButton.disabled = true;
        if (matched) {
          void mutate(`favorite:${matched.id}`, "favorite", matched.id, { idempotency_key: makeKey("team-unfavorite") },
            value => api.deleteTeamItem("module", matched.id, value), () => { favorites = favorites.filter(item => item.id !== matched.id); renderInspector(); }).catch(showError);
        } else {
          if (favorites.length >= 5) { error.textContent = t("Favorite limit reached (5). Remove one to add another."); return; }
          const id = makeKey("favorite");
          void mutate(`favorite-node:${node.id}`, "favorite", id, { module: moduleSnapshot(node), idempotency_key: makeKey("team-favorite") },
            value => api.saveTeamModule(id, value), () => renderInspector()).catch(showError).finally(refreshFavoriteState);
        }
      });
      function refreshFavoriteState() {
        matched = favorites.find(item => sameTeamSnapshot(item.module, moduleSnapshot(node)));
        favoriteButton.textContent = t(matched ? "Unfavorite" : "Favorite");
        favoriteButton.disabled = !node.label.trim() || (!matched && favorites.length >= 5) || intents.has(`favorite-node:${node.id}`);
      }
      refreshFavoriteState();
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
        if (!teamEdgeAllowed(draft.edges, candidate.source, candidate.target, candidate.direction, edge.id)) { error.textContent = t("This route already exists, or its endpoints are invalid."); renderInspector(); return; }
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
    secondaryTitle.textContent = t("Configuration relationships"); secondaryBody.replaceChildren();
    const relationships = el("ol", "team-relationships");
    for (const edge of draft?.edges ?? []) {
      const from = draft.nodes.find(node => node.id === edge.source), to = draft.nodes.find(node => node.id === edge.target);
      relationships.append(el("li", "", `${from?.label ?? edge.source} ${edge.direction === "bidirectional" ? "↔" : "→"} ${to?.label ?? edge.target}`));
    }
    if (relationships.children.length) secondaryBody.append(relationships); else secondaryBody.append(el("p", "field-help", t("No data flows yet.")));
    secondary.showModal();
  }
  function showFavorites() {
    secondaryTitle.textContent = `${t("Favorite modules")} (${favorites.length}/5)`; secondaryBody.replaceChildren();
    if (!favorites.length) secondaryBody.append(el("p", "field-help", t("No favorite modules yet.")));
    const favoriteList = el("ul", "team-library-list");
    for (const favorite of favorites) {
      const row = el("li", "team-library-row"), choose = button("", () => { insertModule(favorite.module); secondary.close(); }, "team-row-edit");
      choose.textContent = favorite.module.label;
      const remove = button("Delete", () => { void mutate(`favorite:${favorite.id}`, "favorite", favorite.id,
        { idempotency_key: makeKey("team-unfavorite") }, value => api.deleteTeamItem("module", favorite.id, value), () => {
          favorites = favorites.filter(item => item.id !== favorite.id); showFavoritesContent(); renderInspector();
        }).catch(showError); }, "text-button team-danger");
      remove.setAttribute("aria-label", `${t("Delete")}: ${favorite.module.label}`); row.append(choose, remove); favoriteList.append(row);
    }
    secondaryBody.append(favoriteList); if (!secondary.open) secondary.showModal();
  }
  const showFavoritesContent = () => { if (secondary.open) secondary.close(); showFavorites(); };
  function renderButtons() {
    const team = saved(), pending = pendingFor(editId), stopping = intents.get(`disable:${editId}`), enabling = pendingEnable(editId);
    const saving = pending.some(intent => intent.kind === "save");
    saveButton.textContent = t(saving ? "Saving…" : dirty ? "Save" : "Saved"); saveButton.disabled = !dirty || saving;
    addBlank.disabled = !draft || draft.nodes.length >= 16; clearButton.disabled = !draft?.nodes.length;
    addFavorite.disabled = !favorites.length || draft?.nodes.length >= 16;
    const testing = team?.test_status === "running" || pending.some(intent => intent.kind === "test");
    testButton.textContent = t(testing ? "Test running…" : !dirty && canEnable(team) ? "Successfully connected" : "Test");
    testButton.disabled = saving || testing || !draft?.nodes.length || (!dirty && canEnable(team));
    const active = team?.enabled || enabling;
    enableButton.textContent = t(stopping?.busy ? "Stopping…" : active ? "Disable" : "Enable");
    enableButton.className = `team-glass ${active ? "team-danger" : "team-enable"}`;
    // A pending enable does not block independent disable, even before its acknowledgement.
    enableButton.disabled = active ? Boolean(stopping?.busy) : dirty || !canEnable(team) || saving || testing;
    testState.textContent = t(dirty ? "Changes require a new test." : testing ? "Test running…" : team?.test_status === "failed"
      ? "Test failed. Review the modules and try again." : canEnable(team) ? "Successfully connected" : "Not tested");
    recover.hidden = ![...intents.values()].some(intent => intent.uncertain && !intent.busy);
    status.textContent = [...intents.values()].some(intent => intent.uncertain) ? t("The last action is unconfirmed. Check it before repeating it.") : "";
  }
  function renderRuns() {
    runList.replaceChildren();
    if (!runs.length) runList.append(el("p", "field-help", t("No Team tasks in this session yet.")));
    for (const run of runs.slice(0, 12)) {
      const row = el("article", "team-run-row"), summary = el("p");
      const needsClarification = run.status === "paused" && run.error_code === "agent_team_instruction_conflict";
      summary.textContent = `${teams.find(team => team.id === run.definition_id)?.draft.name ?? "Team"} · ${t(needsClarification ? "Awaiting clarification" : run.status)} · ${run.calls_used}/${run.max_calls}`;
      const actions = el("div", "team-run-actions");
      const available = run.status === "running" ? [["pause", "Pause"], ["stop", "Stop"]] : run.status === "paused"
        ? [[run.error_code === "agent_timeout" ? "continue" : "resume", needsClarification ? "Continue after clarification" : run.error_code === "agent_timeout" ? "Continue" : "Resume"], ["stop", "Stop"]] : [];
      for (const [action, label] of available) {
        const controlButton = button(label, () => void controlRun(run, action).catch(showError), action === "stop" ? "team-glass team-danger" : "team-glass");
        controlButton.disabled = !context().writable || Boolean(intents.get(`run-${action}:${run.id}`)?.busy); actions.append(controlButton);
      }
      row.append(summary);
      if (needsClarification) row.append(el("p", "field-help", t(clarificationHelp)));
      row.append(actions); runList.append(row);
    }
  }
  function render() {
    list.replaceChildren(); count.textContent = `${teams.length}/5`;
    if (!teams.length) list.append(el("li", "field-help", t("No Teams saved yet. Start by adding one.")));
    for (const team of teams) {
      const row = el("li", "team-library-row"), edit = button("", () => openEditor(team), "team-row-edit"), label = el("strong", "", team.draft.name),
        detail = el("small", "", `${team.draft.nodes.length} ${t("Module")} · ${t(team.enabled ? "Enabled" : team.test_status === "passed" ? "Disabled" : team.test_status === "running" ? "Test running…" : "Not tested")}`);
      edit.append(label, detail);
      const active = team.enabled || pendingEnable(team.id), stop = intents.get(`disable:${team.id}`), toggle = button(active ? "Disable" : "Enable", () => {
        void control(team, !active).catch(showError);
      }, `team-glass team-toggle ${active ? "team-danger" : "team-enable"}`);
      toggle.disabled = active ? Boolean(stop?.busy) : !canEnable(team); toggle.setAttribute("aria-label", `${t(active ? "Disable" : "Enable")}: ${team.draft.name}`);
      const remove = button("Delete", () => { if (!confirm(t("Delete this saved Team? Accepted tasks keep their original configuration."))) return;
        void mutate(`delete:${team.id}`, "delete", team.id, { idempotency_key: makeKey("team-delete") }, value => api.deleteTeamItem("team", team.id, value), () => {
          teams = teams.filter(item => item.id !== team.id); if (editId === team.id) { editId = null; dirty = false; overview.hidden = false; editor.hidden = true; }
        }).catch(showError);
      }, "text-button team-delete"); remove.setAttribute("aria-label", `${t("Delete")}: ${team.draft.name}`);
      row.append(edit, toggle, remove); list.append(row);
    }
    add.disabled = teams.length >= 5; add.title = add.disabled ? t("Team limit reached (5). Delete one to add another.") : "";
    renderButtons(); renderRuns();
  }
  async function controlRun(run, action) {
    const ctx = context();
    return mutate(`run-${action}:${run.id}`, "run", run.id, { action, idempotency_key: makeKey(`team-${action}`) },
      value => api.controlTeamRun(ctx.sessionId, run.id, value));
  }
  const activeRun = () => {
    const pending = intents.get("start-task"), ctx = context();
    if (!pending) return runs.find(run => ["running", "paused"].includes(run.status));
    const event = ctx.events?.find(item => item.type === "agent_request" && item.actor?.id === ctx.userId
      && (item.sessionId ?? item.session_id) === ctx.sessionId && !item.deleted && !item.contentUnavailable
      && !pending.previousEvents?.has(item.id) && item.payload?.agent_team?.purpose !== "test"
      && item.payload?.agent_team?.start_idempotency_key === pending.input.idempotency_key
      && item.payload?.agent_team?.task_content === pending.input.content);
    const marker = event?.payload?.agent_team;
    if (!marker?.run_id) return undefined;
    const known = runs.find(run => run.id === marker.run_id);
    if (known) return terminal(known) ? undefined : known;
    return { id: marker.run_id, session_id: ctx.sessionId, status: "running", purpose: "task" };
  };
  async function startTask(content, options = {}) {
    const team = teams.find(item => `team:${item.id}` === selectedKey), ctx = context();
    if (!team?.enabled || !canEnable(team)) throw new Error(t("Choose an enabled Team."));
    const previous = intents.get("start-task"); if (previous) return attempt(previous);
    if (activeRun()) throw new Error(t("A Team task is already active. Stop or finish it before starting another."));
    if (!acknowledgeShared(team.draft)) return null;
    const previousEvents = new Set((ctx.events ?? []).map(event => event.id));
    const pending = mutate("start-task", "start", team.id, { content, expected_revision: team.revision, content_revision: ctx.contentRevision ?? 0,
      solo_transfer_ack: ctx.sessionMode === "solo", idempotency_key: makeKey("team-task") }, value => api.executeAgentTeam(ctx.sessionId, team.id, value), receipt => {
      options.onAccepted?.(receipt);
    });
    const intent = intents.get("start-task"); if (intent) intent.previousEvents = previousEvents;
    return pending;
  }
  return { updateContext, refresh, open: () => hostButton.click(),
    refreshLanguage() { translations.forEach(update => update()); hostButton.textContent = t("Agent teams");
      title.textContent = t(editor.hidden ? "My Agent teams" : "Edit my Agent team");
      if (draft) { canvas.render(); renderInspector(); } render(); },
    t, choices: () => teams.filter(team => team.enabled && canEnable(team)).map(team => ({ key: `team:${team.id}`, label: team.draft.name, team })),
    selected: () => teams.find(team => `team:${team.id}` === selectedKey), select(key) { selectedKey = key; }, selectionKey: () => selectedKey,
    startTask, pendingStart: () => intents.has("start-task"), activeRun, recover: recoverActions,
    controlRun, stopActive: () => { const run = activeRun(); return run ? controlRun(run, "stop") : Promise.resolve(); },
    stopping: () => { const run = activeRun(); return Boolean(run && intents.get(`run-stop:${run.id}`)?.busy); },
  };
}
