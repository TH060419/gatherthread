import { createIdempotencyKey } from "./domain.js?v=20261012-content-1";
import { canLinkTeamNodes, clampTeamPosition, removeTeamNode, teamEdgePath, teamRunControls, teamRunLabel,
  teamTargetChoices, teamTargetKey, teamFailureMessage } from "./agent-team-graph.js";

const SVG = "http://www.w3.org/2000/svg";
const terminal = run => run && !["running", "paused"].includes(run.status);
const clone = value => JSON.parse(JSON.stringify(value));

/** Graph editing never dispatches work. Only the explicit start/control forms do. */
export function mountAgentTeams({ document: doc = document, api, localizer, getContext,
  onBeforeOpen = () => {}, onStart = () => {}, onNavigateEvent = () => {}, makeKey = createIdempotencyKey }) {
  const el = id => doc.getElementById(`agent-team-${id}`);
  const dialog = el("dialog"), openButton = el("button");
  const t = value => localizer.t(value);
  const text = (node, value) => { if (node.textContent !== t(value)) localizer.setText(node, value); };
  let scope = "", generation = 0, plan = emptyPlan(), revision = null, selected = null, entry = "";
  let choices = [], runs = [], run = null, pending = false, loaded = false, dirty = false;
  // pending belongs only to mutations; a background read must not gate Stop.
  let poll, readBusy = false, readController = null, drag = null, connecting = null, returnFocus;
  let startAttempt = null;
  let controlAttempt = null;
  let runEpoch = 0;
  let viewingRun = false, taskDraft = null;
  const visiblePlan = () => viewingRun && run ? run.plan : plan;
  const visibleEntry = () => viewingRun && run ? run.steps?.[0]?.node_id ?? run.current_node_id : entry;
  function showRun(value) {
    if (value && !viewingRun) taskDraft = [el("task").value, el("max-calls").value, el("max-minutes").value];
    if (!value && viewingRun && taskDraft) {
      [el("task").value, el("max-calls").value, el("max-minutes").value] = taskDraft; taskDraft = null;
    }
    viewingRun = Boolean(value && run); connecting = null; drag = null;
    const shown = visiblePlan(); selected = shown.nodes.some(node => node.id === selected) ? selected : shown.nodes[0]?.id ?? null;
    el("name").value = shown.name; el("prompt").value = shown.team_prompt;
    if (viewingRun) { el("task").value = run.content; el("max-calls").value = String(run.max_calls); el("max-minutes").value = String(run.max_duration_minutes); }
    renderGraph(); renderInspector(); renderControls();
  }

  function emptyPlan() { return { name: t("My team"), team_prompt: "", nodes: [], edges: [] }; }
  function raw(node, value) { node.setAttribute("data-i18n-skip", ""); node.textContent = value; }
  function status(value) { text(el("status"), value); }
  function error(value) { text(el("error"), value); }
  function stoppedPolling() { clearTimeout(poll); poll = null; }
  function cancelRead() { const controller = readController; readController = null; readBusy = false; controller?.abort(); }
  function current(gen) { return generation === gen && scope === getContext()?.scope; }
  function locked() { return pending || readBusy || viewingRun || Boolean(startAttempt) || Boolean(controlAttempt) || run && !terminal(run); }
  function updateContext() {
    const c = getContext();
    const next = c?.scope ?? "";
    if (next !== scope) {
      scope = next; generation++; runEpoch++; stoppedPolling(); cancelRead(); pending = false;
      plan = emptyPlan(); revision = null; selected = null; entry = ""; choices = []; runs = []; run = null;
      el("max-calls").value = "12"; el("max-minutes").value = "30";
      viewingRun = false; taskDraft = null; dirty = false; loaded = false; startAttempt = null; controlAttempt = null; connecting = null; drag = null;
      if (dialog.open) dialog.close();
      for (const id of ["name", "prompt", "task", "node-name", "node-role", "error", "status"]) {
        const node = el(id); if ("value" in node) node.value = ""; else node.textContent = "";
      }
      fillSelect(el("add-target"), []); renderGraph(); renderRun(); renderInspector();
    }
    openButton.disabled = !c?.sessionId || !c?.userId;
    if (!c?.writable) { drag = null; connecting = null; }
    if (dialog.open) renderControls();
  }
  function markDirty() { dirty = true; status("Unsaved team changes"); renderControls(); }
  function fillSelect(node, items, value, placeholder = "Choose an Agent") {
    const previous = node.value;
    const fragment = doc.createDocumentFragment();
    const first = doc.createElement("option"); first.value = ""; first.textContent = t(placeholder); fragment.append(first);
    for (const item of items) {
      const option = doc.createElement("option"); option.value = item.value; option.textContent = item.label;
      option.setAttribute("data-i18n-skip", ""); fragment.append(option);
    }
    node.replaceChildren(fragment); node.value = value ?? previous;
  }
  function refreshChoices() {
    const c = getContext();
    choices = loaded ? teamTargetChoices({ runtimes: c?.runtimes, devices: c?.devices, userId: c?.userId, cloudStatus: c?.cloudStatus }) : [];
    const items = choices.map(choice => ({ value: choice.key, label: `${choice.label}${choice.available ? "" : ` · ${t("Unavailable")}`}` }));
    fillSelect(el("add-target"), items);
    renderInspector(); renderGraph(); renderControls();
  }
  function renderNodeSelects() {
    const items = visiblePlan().nodes.map(node => ({ value: node.id, label: node.label }));
    fillSelect(el("entry-node"), items, visibleEntry(), "Choose the first Agent");
    fillSelect(el("edge-source"), items, connecting ?? undefined);
    fillSelect(el("edge-target"), items);
  }
  function selectNode(id, { focus = false } = {}) {
    selected = visiblePlan().nodes.some(node => node.id === id) ? id : null;
    for (const node of el("nodes").children) node.dataset.selected = String(node.dataset.nodeId === selected);
    renderInspector();
    if (focus) el("nodes").querySelector(`[data-node-id="${selected}"] .team-node-header`)?.focus();
  }
  function renderInspector() {
    const node = visiblePlan().nodes.find(candidate => candidate.id === selected);
    el("node-inspector").hidden = !node;
    if (!node) {
      for (const id of ["node-name", "node-role"]) el(id).value = "";
      el("node-target").replaceChildren(); el("node-code").checked = false; el("code-field").hidden = true;
      return;
    }
    if (doc.activeElement !== el("node-name")) el("node-name").value = node.label;
    if (doc.activeElement !== el("node-role")) el("node-role").value = node.role;
    const selectedKey = teamTargetKey(node.target);
    const items = choices.map(choice => ({ value: choice.key, label: `${choice.label}${choice.available ? "" : ` · ${t("Unavailable")}`}` }));
    if (!choices.some(choice => choice.key === selectedKey)) items.push({ value: selectedKey, label: `${node.target.model} · ${t("Unavailable")}` });
    fillSelect(el("node-target"), items, selectedKey);
    el("code-field").hidden = node.target.kind !== "cloud";
    el("node-code").checked = node.target.kind === "cloud" && node.target.include_code;
    text(el("make-entry"), visibleEntry() === node.id ? "First Agent" : "Start with this Agent");
  }
  function renderPaths() {
    const plan = visiblePlan();
    const fragment = doc.createDocumentFragment();
    for (const edge of plan.edges) {
      const source = plan.nodes.find(node => node.id === edge.source), target = plan.nodes.find(node => node.id === edge.target);
      if (!source || !target) continue;
      const path = doc.createElementNS(SVG, "path"); path.setAttribute("d", teamEdgePath(source, target));
      path.setAttribute("marker-end", "url(#team-edge-arrow)");
      if (edge.direction === "bidirectional") path.setAttribute("marker-start", "url(#team-edge-arrow)");
      fragment.append(path);
    }
    el("edge-paths").replaceChildren(fragment);
  }
  function renderEdges() {
    const shown = visiblePlan();
    el("edge-list").replaceChildren();
    for (const edge of shown.edges) {
      const source = shown.nodes.find(node => node.id === edge.source), target = shown.nodes.find(node => node.id === edge.target);
      const li = doc.createElement("li"), label = doc.createElement("span"), button = doc.createElement("button");
      raw(label, `${source?.label ?? "?"} ${edge.direction === "bidirectional" ? "↔" : "→"} ${target?.label ?? "?"}`);
      button.type = "button"; button.className = "icon-button"; button.textContent = "×";
      button.setAttribute("aria-label", `${t("Remove connection")}: ${source?.label} ${edge.direction === "bidirectional" ? "↔" : "→"} ${target?.label}`);
      button.disabled = locked() || !getContext()?.writable;
      button.addEventListener("click", () => { if (locked() || !getContext()?.writable) return; plan.edges = plan.edges.filter(candidate => candidate.id !== edge.id); markDirty(); renderGraph(); });
      li.append(label, button); el("edge-list").append(li);
    }
  }
  function renderGraph() {
    const shown = visiblePlan();
    const focusedId = doc.activeElement?.closest?.("[data-node-id]")?.dataset.nodeId;
    el("nodes").replaceChildren(); el("empty").hidden = shown.nodes.length > 0;
    for (const node of shown.nodes) {
      const card = doc.createElement("div"); card.className = "team-node"; card.dataset.nodeId = node.id;
      card.dataset.kind = node.target.kind; card.dataset.harness = node.target.harness ?? "cloud";
      card.dataset.selected = String(selected === node.id); card.dataset.running = String(run?.status === "running" && run.current_node_id === node.id);
      card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
      const header = doc.createElement("button"), label = doc.createElement("span"), tag = doc.createElement("span");
      header.type = "button"; header.className = "team-node-header";
      header.setAttribute("aria-label", `${t("Select and move Agent")}: ${node.label}`);
      label.className = "team-node-label"; raw(label, node.label); tag.className = "team-node-entry";
      if (visibleEntry() === node.id) text(tag, "First Agent"); header.append(label, tag);
      header.addEventListener("click", () => selectNode(node.id));
      header.addEventListener("pointerdown", event => {
        selectNode(node.id); if (locked() || !getContext()?.writable || event.button !== 0) return;
        event.preventDefault(); header.focus();
        drag = { kind: "move", id: node.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, originalX: node.x, originalY: node.y, card };
        header.setPointerCapture?.(event.pointerId);
      });
      header.addEventListener("keydown", event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta || locked() || !getContext()?.writable) return;
        event.preventDefault(); const distance = event.shiftKey ? 40 : 10;
        Object.assign(node, clampTeamPosition(node.x + delta[0] * distance, node.y + delta[1] * distance));
        card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; renderPaths(); markDirty();
      });
      const model = doc.createElement("span"), role = doc.createElement("span"), available = doc.createElement("span");
      model.className = "team-node-model"; raw(model, `${node.target.harness === "deepseek-harness" ? "DSH" : node.target.kind === "cloud" ? "Cloud" : "Codex"} · ${node.target.model}`);
      role.className = "team-node-role"; if (node.role) raw(role, node.role); else text(role, "Choose a role in the inspector");
      available.className = "team-node-availability";
      text(available, choices.find(choice => choice.key === teamTargetKey(node.target))?.available ? "Available" : "Unavailable");
      const input = doc.createElement("button"), output = doc.createElement("button");
      for (const [port, direction] of [[input, "in"], [output, "out"]]) {
        port.type = "button"; port.className = `team-port team-port-${direction}`; port.textContent = direction === "in" ? "•" : "＋";
        port.setAttribute("aria-label", `${t(direction === "in" ? "Connect to this Agent" : "Delegate from this Agent")}: ${node.label}`);
        port.disabled = locked() || !getContext()?.writable;
      }
      input.dataset.teamInput = node.id; output.setAttribute("aria-pressed", String(connecting === node.id));
      input.addEventListener("click", () => { if (connecting) connectNodes(connecting, node.id); else { selectNode(node.id); el("edge-target").value = node.id; status("Choose a source Agent to connect."); } });
      output.addEventListener("click", () => { connecting = node.id; el("edge-source").value = node.id; output.setAttribute("aria-pressed", "true"); status("Choose another Agent's input to connect."); });
      output.addEventListener("pointerdown", event => {
        if (locked() || !getContext()?.writable || event.button !== 0) return;
        connecting = node.id; el("edge-source").value = node.id;
        drag = { kind: "connect", id: node.id, pointerId: event.pointerId };
        status("Choose another Agent's input to connect.");
      });
      card.append(header, model, role, available, input, output); el("nodes").append(card);
    }
    renderPaths(); renderEdges(); renderNodeSelects();
    if (focusedId) el("nodes").querySelector(`[data-node-id="${focusedId}"] .team-node-header`)?.focus();
  }
  function connectNodes(source, target) {
    if (locked() || !getContext()?.writable) return;
    if (!canLinkTeamNodes(plan, source, target, el("edge-direction").value) || plan.edges.length >= 32) { error("Choose two different Agents with no existing connection in that direction."); return; }
    plan.edges.push({ id: makeKey("edge"), source, target, direction: el("edge-direction").value });
    connecting = null; error(""); markDirty(); renderGraph();
  }
  doc.addEventListener("pointermove", event => {
    if (!drag || drag.pointerId !== event.pointerId || drag.kind !== "move") return;
    if (locked() || !getContext()?.writable) { drag = null; return; }
    const node = plan.nodes.find(candidate => candidate.id === drag.id); if (!node) return;
    Object.assign(node, clampTeamPosition(drag.originalX + event.clientX - drag.x, drag.originalY + event.clientY - drag.y));
    drag.card.style.left = `${node.x}px`; drag.card.style.top = `${node.y}px`; renderPaths();
  });
  doc.addEventListener("pointerup", event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const previous = drag; drag = null;
    if (previous.kind === "move") markDirty();
    else { const target = doc.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-team-input]")?.dataset.teamInput; if (target) connectNodes(previous.id, target); }
  });
  doc.addEventListener("pointercancel", () => { drag = null; });

  function renderControls() {
    const c = getContext(), edit = !locked() && c?.writable;
    for (const id of ["name", "prompt", "add-target", "node-name", "node-role", "node-target", "node-code", "edge-source", "edge-target", "edge-direction", "entry-node", "task", "max-calls", "max-minutes"]) el(id).disabled = !edit;
    el("add-node").disabled = !edit || plan.nodes.length >= 16 || !el("add-target").value;
    el("connect").disabled = !edit || plan.nodes.length < 2;
    el("save").disabled = !edit || !plan.nodes.length || !dirty;
    el("reload").disabled = pending || readBusy || Boolean(startAttempt);
    el("refresh").disabled = pending || readBusy;
    el("refresh").setAttribute("aria-busy", String(readBusy));
    el("remove-node").disabled = !edit; el("make-entry").disabled = !edit;
    for (const button of el("nodes").querySelectorAll(".team-port")) button.disabled = !edit;
    for (const button of el("edge-list").querySelectorAll("button")) button.disabled = !edit;
    const live = runs.some(candidate => ["running", "paused"].includes(candidate.status));
    el("overview").hidden = !run || terminal(run) && !viewingRun;
    el("edit").hidden = !viewingRun;
    el("edit").disabled = pending || readBusy || Boolean(controlAttempt) || Boolean(startAttempt) || !c?.writable || run && !terminal(run);
    el("snapshot-note").hidden = !viewingRun;
    el("forget").hidden = !terminal(run); el("forget").disabled = pending || readBusy || Boolean(controlAttempt) || Boolean(startAttempt) || !c?.writable;
    el("start").disabled = viewingRun || pending || readBusy || Boolean(controlAttempt) || !c?.writable || live || !plan.nodes.length || !entry;
    if (startAttempt && !controlAttempt && !live && !pending && !readBusy) el("start").disabled = false;
    text(el("start"), startAttempt ? "Retry the same team start" : "Start team task");
    for (const id of ["pause", "resume", "stop", "continue"]) el(id).disabled = pending || !c?.writable || Boolean(controlAttempt);
    el("control-retry").hidden = !controlAttempt || pending;
    el("control-retry").disabled = pending || !c?.writable;
    el("control-note").hidden = !controlAttempt || pending;
    el("run-select").disabled = pending || readBusy || Boolean(controlAttempt);
    dialog.setAttribute("aria-busy", String(pending));
  }
  function renderRunSelect() {
    fillSelect(el("run-select"), runs.map(candidate => ({ value: candidate.id,
      label: `${t(teamRunLabel(candidate))} · ${candidate.calls_used}/${candidate.max_calls} · ${candidate.id.slice(-8)}` })), run?.id ?? "", "Choose a team task");
  }
  function renderRun() {
    text(el("run-status"), teamRunLabel(run)); text(el("overview-status"), teamRunLabel(run));
    const explanation = teamFailureMessage(run?.error_code); el("failure-note").hidden = !explanation;
    text(el("failure-note"), explanation ?? ""); el("run-budget").textContent = "";
    if (run) {
      const deadline = new Date(run.deadline_at);
      el("run-budget").textContent = `${t("Calls")}: ${run.calls_used} / ${run.max_calls} · ${t("Deadline")}: ${Number.isNaN(deadline.getTime()) ? "—" : deadline.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
    raw(el("overview-budget"), el("run-budget").textContent);
    const currentNode = run && !terminal(run) ? run.plan.nodes.find(node => node.id === run.current_node_id) : null;
    raw(el("overview-current"), currentNode ? `${t("Current Agent")}: ${currentNode.label}` : "");
    const controls = teamRunControls(run);
    for (const id of ["pause", "resume", "stop", "continue"]) el(id).hidden = !controls[id];
    el("run-note").hidden = !run || terminal(run);
    el("step-list").replaceChildren();
    for (const step of run?.steps ?? []) {
      const li = doc.createElement("li"), label = doc.createElement("span"); raw(label, step.node_label);
      const stepStatus = ["pending", "running"].includes(step.status) && run.status === "stopped" ? "Stopped"
        : ["pending", "running"].includes(step.status) && run.status === "paused" ? "Paused" : null;
      li.append(label, doc.createTextNode(` · ${t(stepStatus ?? { pending: "Queued", queued: "Queued", running: "Working", completed: "Completed", failed: "Failed", paused: "Paused", timed_out: "Timed out", stopped: "Stopped", waiting: "Waiting" }[step.status] ?? step.status)}`));
      const eventId = step.response_event_id ?? step.request_event_id;
      if (eventId) { const button = doc.createElement("button"); button.type = "button"; button.className = "text-button"; text(button, "View message"); button.addEventListener("click", () => { dialog.close(); onNavigateEvent(eventId); }); li.append(doc.createTextNode(" · "), button); }
      el("step-list").append(li);
    }
    renderControls();
  }
  async function action(operation) {
    if (pending) return;
    cancelRead(); stoppedPolling();
    const gen = generation; pending = true; error(""); renderControls();
    try { await operation(gen); }
    catch (failure) { if (current(gen)) error(teamFailureMessage(failure.code) ?? failure.message ?? "Agent team request failed. Refresh and try again."); }
    finally { if (current(gen)) { pending = false; renderControls(); schedulePoll(); } }
  }
  async function readAction(operation) {
    if (pending) return;
    cancelRead(); stoppedPolling();
    const gen = generation, controller = new AbortController();
    readController = controller; readBusy = true; error(""); renderControls();
    let timedOut = false;
    const cancelled = new Promise((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Team read cancelled")), { once: true }));
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
    timeout.unref?.();
    try { await Promise.race([operation(gen, controller.signal), cancelled]); }
    catch (failure) {
      if (current(gen) && readController === controller) {
        if (timedOut) error("Team refresh timed out. Loaded tasks can still be paused or stopped. Try refreshing again.");
        else if (!controller.signal.aborted) error(teamFailureMessage(failure.code) ?? failure.message ?? "Agent team request failed. Refresh and try again.");
      }
    } finally {
      clearTimeout(timeout);
      if (current(gen) && readController === controller) { readController = null; readBusy = false; renderControls(); schedulePoll(); }
    }
  }
  async function readRun(sessionId, id, gen, epoch, signal) {
    try { return (await api.getAgentTeamRun(sessionId, id, { signal })).run; }
    catch (failure) {
      if (failure.status !== 404) throw failure;
      if (signal?.aborted || !current(gen) || epoch !== runEpoch) return null;
      if (controlAttempt?.runId === id) controlAttempt = null;
      if (run?.id === id) { showRun(false); run = null; }
      runs = runs.filter(candidate => candidate.id !== id); renderRunSelect(); renderRun();
      error("This private team record is no longer available. Shared messages are kept.");
      return null;
    }
  }
  async function load({ replacePlan = false, requestedRunId = null, signal } = {}) {
    const c = getContext(), gen = generation; if (!c?.sessionId) return;
    const epoch = ++runEpoch;
    const [saved, listing] = await Promise.all([api.getAgentTeamPlan(c.sessionId, { signal }), api.listAgentTeamRuns(c.sessionId, { signal })]);
    if (signal?.aborted || !current(gen) || epoch !== runEpoch) return;
    if (!loaded || replacePlan) {
      plan = clone(saved.plan ?? emptyPlan()); revision = saved.revision; loaded = true; dirty = false;
      selected = plan.nodes[0]?.id ?? null; entry = plan.entry_node_id ?? (entry && plan.nodes.some(node => node.id === entry) ? entry : plan.nodes[0]?.id ?? "");
      el("name").value = plan.name; el("prompt").value = plan.team_prompt; status(saved.plan ? "Saved team loaded" : "Add an Agent to begin.");
    }
    runs = listing.runs;
    const active = runs.find(candidate => ["running", "paused"].includes(candidate.status));
    const selectedRun = controlAttempt ? { id: controlAttempt.runId } : (requestedRunId ? { id: requestedRunId } : null) ?? runs.find(candidate => candidate.id === run?.id) ?? active ?? runs[0];
    const nextRun = selectedRun ? await readRun(c.sessionId, selectedRun.id, gen, epoch, signal) : null;
    if (signal?.aborted || !current(gen) || epoch !== runEpoch) return;
    run = nextRun;
    showRun(Boolean(run && (requestedRunId || viewingRun || !terminal(run))));
    refreshChoices(); renderRunSelect(); renderRun(); schedulePoll();
  }
  function schedulePoll() {
    stoppedPolling(); if (pending || readBusy || !dialog.open || !run || terminal(run)) return;
    poll = setTimeout(() => void refreshRun(), 2000);
  }
  async function refreshRun() {
    if (pending || readBusy || !dialog.open || !run) return;
    return readAction(async (gen, signal) => {
      const c = getContext(), id = run.id, epoch = runEpoch;
      const nextRun = await readRun(c.sessionId, id, gen, epoch, signal);
      if (signal.aborted || !nextRun || pending || epoch !== runEpoch || !current(gen) || run?.id !== id) return;
      run = nextRun; runs = runs.map(candidate => candidate.id === id ? run : candidate); renderRunSelect(); renderRun();
      for (const node of el("nodes").children) node.dataset.running = String(run.status === "running" && run.current_node_id === node.dataset.nodeId);
    });
  }
  async function open(requestedRunId = null) {
    updateContext(); if (openButton.disabled) return;
    returnFocus = doc.activeElement; onBeforeOpen(); dialog.showModal();
    renderRun();
    await readAction(async (gen, signal) => {
      await getContext()?.refreshAgents?.();
      if (!signal.aborted && current(gen)) await load({ requestedRunId, signal });
    });
  }
  openButton.addEventListener("click", () => void open());
  for (const id of ["close", "done"]) el(id).addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { stoppedPolling(); cancelRead(); runEpoch++; drag = null; connecting = null; if (returnFocus?.isConnected) returnFocus.focus(); });
  for (const [id, field] of [["name", "name"], ["prompt", "team_prompt"]]) el(id).addEventListener("input", () => { plan[field] = el(id).value; markDirty(); });
  el("add-target").addEventListener("change", renderControls);
  el("add-node").addEventListener("click", () => {
    const choice = choices.find(candidate => candidate.key === el("add-target").value);
    if (!choice || locked() || !getContext()?.writable || plan.nodes.length >= 16) return;
    const index = plan.nodes.length, id = makeKey("node");
    plan.nodes.push({ id, label: `${choice.target.kind === "cloud" ? "Cloud Agent" : choice.target.harness === "codex" ? "Codex" : "DSH"} ${index + 1}`,
      role: "", x: 44 + index % 4 * 330, y: 42 + Math.floor(index / 4) * 220, target: clone(choice.target) });
    if (!entry) { entry = id; plan.entry_node_id = id; } selected = id; markDirty(); renderGraph(); renderInspector();
  });
  for (const [id, field] of [["node-name", "label"], ["node-role", "role"]]) el(id).addEventListener("input", () => {
    const node = plan.nodes.find(candidate => candidate.id === selected); if (!node || locked()) return;
    node[field] = el(id).value; markDirty(); renderGraph();
  });
  el("node-target").addEventListener("change", () => { const node = plan.nodes.find(candidate => candidate.id === selected), choice = choices.find(candidate => candidate.key === el("node-target").value); if (!node || !choice || locked()) return; node.target = clone(choice.target); markDirty(); renderGraph(); renderInspector(); });
  el("node-code").addEventListener("change", () => { const node = plan.nodes.find(candidate => candidate.id === selected); if (node?.target.kind === "cloud" && !locked()) { node.target.include_code = el("node-code").checked; markDirty(); } });
  el("remove-node").addEventListener("click", () => { if (locked()) return; plan = removeTeamNode(plan, selected); if (entry === selected) entry = plan.nodes[0]?.id ?? ""; selected = plan.nodes[0]?.id ?? null; markDirty(); renderGraph(); renderInspector(); });
  el("make-entry").addEventListener("click", () => { if (!selected || locked()) return; entry = selected; plan.entry_node_id = selected; markDirty(); renderGraph(); renderInspector(); });
  el("entry-node").addEventListener("change", () => { if (locked() || !getContext()?.writable) return; entry = el("entry-node").value; plan.entry_node_id = entry; markDirty(); renderGraph(); renderControls(); });
  el("connect").addEventListener("click", () => connectNodes(el("edge-source").value, el("edge-target").value));
  el("refresh").addEventListener("click", () => void readAction(async (gen, signal) => { await getContext()?.refreshAgents?.(); if (signal.aborted || !current(gen)) return; refreshChoices(); await load({ signal }); }));
  el("reload").addEventListener("click", () => { if (dirty && !globalThis.confirm(t("Discard unsaved team changes and reload the saved team?"))) return; void readAction((_gen, signal) => load({ replacePlan: true, signal })); });
  el("save").addEventListener("click", () => void action(async gen => {
    const snapshot = clone(plan), saved = await api.saveAgentTeamPlan(getContext().sessionId, { plan: snapshot, expected_revision: revision });
    if (!current(gen)) return; plan = clone(saved.plan); revision = saved.revision; dirty = false; status("Team saved");
  }));
  el("start-form").addEventListener("submit", event => {
    event.preventDefault(); if (el("start").disabled) return;
    void action(async gen => {
      const c = getContext();
      if (!startAttempt) startAttempt = { plan: clone(plan), entry_node_id: entry, content: el("task").value.trim(),
        max_calls: Number(el("max-calls").value), max_duration_minutes: Number(el("max-minutes").value), idempotency_key: makeKey("team-start"),
        content_revision: c.contentRevision ?? 0 };
      try {
        const result = await api.startAgentTeamRun(c.sessionId, startAttempt);
        if (!current(gen)) return; startAttempt = null; run = result.run; runs = [run, ...runs.filter(candidate => candidate.id !== run.id)];
        showRun(true); renderRunSelect(); renderRun(); schedulePoll(); status("Team task started"); onStart(run);
      } catch (failure) { if (current(gen) && failure.status > 0 && failure.status < 500) startAttempt = null; throw failure; }
    });
  });
  function control(command, retry = false) {
    if (!run || pending || !getContext()?.writable || !retry && controlAttempt) return;
    if (retry && (!controlAttempt || controlAttempt.runId !== run.id)) return;
    void action(async gen => {
      const attempt = controlAttempt ?? { runId: run.id, action: command, idempotencyKey: makeKey(`team-${command}`) };
      controlAttempt = attempt;
      runEpoch++;
      try {
        const result = await api.controlAgentTeamRun(getContext().sessionId, attempt.runId,
          { action: attempt.action, idempotency_key: attempt.idempotencyKey });
        if (!current(gen) || run?.id !== attempt.runId || controlAttempt !== attempt) return;
        controlAttempt = null; run = result.run; runs = runs.map(candidate => candidate.id === attempt.runId ? run : candidate);
        renderRunSelect(); renderRun();
      } catch (failure) {
        if (current(gen) && failure.status > 0 && failure.status < 500) controlAttempt = null;
        throw failure;
      }
    });
  }
  for (const command of ["pause", "resume", "stop", "continue"]) el(command).addEventListener("click", () => control(command));
  el("control-retry").addEventListener("click", () => control(controlAttempt?.action, true));
  el("forget").addEventListener("click", () => {
    if (!run || el("forget").disabled || !globalThis.confirm(t("Clear this ended task's private team record? Shared messages and local work are kept."))) return;
    const id = run.id;
    void action(async gen => { await api.forgetAgentTeamRun(getContext().sessionId, id); if (!current(gen) || run?.id !== id) return;
      showRun(false); run = null; runs = runs.filter(candidate => candidate.id !== id); renderRunSelect(); renderRun(); });
  });
  el("edit").addEventListener("click", () => { if (!el("edit").disabled) showRun(false); });
  el("run-select").addEventListener("change", () => void readAction(async (gen, signal) => { const id = el("run-select").value; if (!id) { run = null; showRun(false); renderRun(); return; } const epoch = ++runEpoch, nextRun = await readRun(getContext().sessionId, id, gen, epoch, signal); if (signal.aborted || !current(gen) || epoch !== runEpoch || !nextRun) return; run = nextRun; showRun(true); renderRun(); schedulePoll(); }));
  return { updateContext, open, refreshChoices, refreshLocale() { if (dialog.open) { refreshChoices(); renderRunSelect(); renderRun(); } } };
}
