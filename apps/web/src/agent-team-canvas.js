import { TEAM_NODE_WIDTH, TEAM_NODE_HEIGHT, teamEdgePath, teamEdgeAllowed } from "./agent-team-graph.js";

/** Pointer and keyboard graph editing; callers own the independent module configuration. */
export function mountTeamCanvas({ document: doc, host, getDraft, onChange, onSelection, t, makeId }) {
  const el = (tag, className = "") => { const node = doc.createElement(tag); node.className = className; return node; };
  const button = (text, title = text) => { const node = el("button", "team-glass"); node.type = "button";
    node.textContent = text; node.setAttribute("aria-label", t(title)); return node; };
  const viewport = el("div", "team-canvas-viewport"); viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", t("Team workflow canvas"));
  const spacer = el("div", "team-canvas-spacer"), stage = el("div", "team-canvas-stage");
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("team-canvas-lines");
  const nodes = el("div", "team-canvas-nodes"), empty = el("p", "team-canvas-empty");
  stage.append(svg, nodes, empty); spacer.append(stage); viewport.append(spacer);
  const hud = el("div", "team-canvas-tools"), minus = button("−", "Zoom out"), plus = button("+", "Zoom in"), reset = button("100%", "Reset zoom");
  hud.append(minus, reset, plus); host.append(viewport, hud);
  let pinned = null, hovered = null, zoom = 1, drag = null, wire = null, handledPointerClick = null;
  const current = () => pinned ?? hovered;
  const pointerOwner = () => drag?.pointerId ?? wire?.pointerId;
  function gestureCurrent() {
    const draft = getDraft();
    return (!drag || drag.draft === draft && draft?.nodes.includes(drag.node) && drag.node.x === drag.lastX && drag.node.y === drag.lastY)
      && (!wire || wire.draft === draft && draft?.nodes.includes(wire.node));
  }
  function clearGesture(notify = false) {
    const changed = notify && drag?.moved && gestureCurrent();
    const pointers = new Set([drag?.pointerId, wire?.pointerId]);
    // Clear before callbacks/capture release: both can synchronously re-enter.
    drag = null; wire = null; handledPointerClick = null; viewport.dataset.linking = "false";
    for (const id of pointers) if (id !== undefined && viewport.hasPointerCapture?.(id)) viewport.releasePointerCapture?.(id);
    if (changed) onChange();
  }
  function focusedControl() {
    const active = doc.activeElement;
    const card = active?.closest?.("[data-node-id]");
    if (card && [...nodes.children].includes(card)) return { kind: "node", id: card.dataset.nodeId, port: active.dataset.port };
    const edge = active?.closest?.("[data-edge-id]");
    if (edge && [...svg.querySelectorAll("[data-edge-id]")].includes(edge)) return { kind: "edge", id: edge.dataset.edgeId };
    return null;
  }
  function restoreFocus(anchor) {
    if (!anchor) return;
    const target = anchor.kind === "edge"
      ? [...svg.querySelectorAll("[data-edge-id]")].find(edge => edge.dataset.edgeId === anchor.id)
      : [...nodes.children].find(node => node.dataset.nodeId === anchor.id)
        ?.querySelector(anchor.port ? `[data-port='${anchor.port}']` : ".team-node-drag");
    (target ?? viewport).focus({ preventScroll: true });
  }
  function highlight() {
    const selected = current();
    for (const node of nodes.children) node.dataset.highlighted = String(selected?.kind === "node" && selected.id === node.dataset.nodeId);
    for (const path of svg.querySelectorAll("[data-edge-id]")) path.dataset.highlighted = String(selected?.kind === "edge" && selected.id === path.dataset.edgeId);
  }
  function select(value, fixed = true) {
    if (fixed) {
      const previous = current();
      pinned = value; hovered = null;
      if (!value || (drag || wire) && (previous?.kind !== value.kind || previous?.id !== value.id)) clearGesture(true);
    } else if (!pinned) hovered = value; else return;
    highlight(); onSelection(current(), Boolean(pinned));
  }
  function hover(value) { if (!pinned) select(value, false); }
  function addWire(from, to) {
    const draft = getDraft();
    if (!gestureCurrent()) { clearGesture(); return false; }
    if (!draft || draft.edges.length >= 32 || !draft.nodes.some(node => node.id === from) || !draft.nodes.some(node => node.id === to)
      || !teamEdgeAllowed(draft.edges, from, to, "one_way")) return false;
    const edge = { id: makeId("edge"), source: from, target: to, direction: "one_way" };
    draft.edges.push(edge); wire = null; onChange(); select({ kind: "edge", id: edge.id }); render(); return true;
  }
  function lines() {
    const focus = focusedControl();
    const draft = getDraft(); svg.replaceChildren(); if (!draft) return;
    const defs = doc.createElementNS(svg.namespaceURI, "defs");
    for (const [id, orient] of [["team-arrow-end", "auto"], ["team-arrow-start", "auto-start-reverse"]]) {
      const marker = doc.createElementNS(svg.namespaceURI, "marker");
      for (const [key, value] of Object.entries({ id, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient })) marker.setAttribute(key, value);
      const shape = doc.createElementNS(svg.namespaceURI, "path"); shape.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); shape.setAttribute("fill", "currentColor"); marker.append(shape); defs.append(marker);
    }
    svg.append(defs);
    for (const edge of draft.edges) {
      const from = draft.nodes.find(node => node.id === edge.source), to = draft.nodes.find(node => node.id === edge.target); if (!from || !to) continue;
      const path = doc.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", teamEdgePath(from, to));
      path.dataset.edgeId = edge.id; path.setAttribute("tabindex", "0"); path.setAttribute("role", "button");
      path.setAttribute("aria-label", `${from.label} ${edge.direction === "bidirectional" ? "↔" : "→"} ${to.label}`);
      path.setAttribute("marker-end", "url(#team-arrow-end)"); if (edge.direction === "bidirectional") path.setAttribute("marker-start", "url(#team-arrow-start)");
      path.addEventListener("click", event => { event.stopPropagation(); select({ kind: "edge", id: edge.id }); });
      path.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); select({ kind: "edge", id: edge.id }); } });
      path.addEventListener("pointerenter", () => hover({ kind: "edge", id: edge.id })); path.addEventListener("pointerleave", () => hover(null)); svg.append(path);
    }
    highlight();
    if (focus?.kind === "edge") restoreFocus(focus);
  }
  function render() {
    const focus = focusedControl();
    viewport.setAttribute("aria-label", t("Team workflow canvas"));
    for (const [control, label] of [[minus, "Zoom out"], [reset, "Reset zoom"], [plus, "Zoom in"]]) control.setAttribute("aria-label", t(label));
    const draft = getDraft();
    if (!gestureCurrent()) clearGesture();
    const selection = current();
    if (selection && !(selection.kind === "node" ? draft?.nodes : draft?.edges)?.some(item => item.id === selection.id)) select(null);
    nodes.replaceChildren();
    empty.hidden = Boolean(draft?.nodes.length); empty.textContent = t("Add a blank or favorite module to start.");
    const width = Math.max(1500, ...(draft?.nodes ?? []).map(node => node.x + TEAM_NODE_WIDTH + 120));
    const height = Math.max(800, ...(draft?.nodes ?? []).map(node => node.y + TEAM_NODE_HEIGHT + 120));
    stage.style.width = `${width}px`; stage.style.height = `${height}px`; stage.style.transform = `scale(${zoom})`;
    spacer.style.width = `${width * zoom}px`; spacer.style.height = `${height * zoom}px`; reset.textContent = `${Math.round(zoom * 100)}%`;
    svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
    for (const node of draft?.nodes ?? []) {
      const card = el("article", "team-graph-node"); card.dataset.nodeId = node.id;
      card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
      const title = button(node.label); title.className = "team-node-drag"; title.setAttribute("aria-label", `${t("Select module")}: ${node.label}`);
      const agent = el("span", "team-node-agent"); agent.textContent = node.target ? `${node.target.kind === "cloud" ? t("Cloud Agent") : node.target.harness === "codex" ? "Codex" : "DSH"} · ${node.target.model}` : t("Choose an Agent");
      const role = el("span", "team-node-role"); role.textContent = node.role || t("No identity yet");
      const entry = el("span", "team-node-entry"); entry.textContent = t("Start"); entry.hidden = (draft.entry_node_id ?? draft.nodes[0]?.id) !== node.id;
      card.append(title, agent, role, entry);
      for (const direction of ["in", "out"]) {
        const port = button(direction === "in" ? "●" : "+", direction === "in" ? "Connect to this module" : "Drag or select to create a data flow");
        port.className = `team-node-port team-node-port-${direction}`; port.dataset.port = direction; port.dataset.portNode = node.id;
        port.addEventListener("pointerdown", event => {
          if (direction !== "out" || event.button !== 0) return;
          if (!getDraft()?.nodes.includes(node)) return;
          event.preventDefault(); event.stopPropagation(); wire = { source: node.id, node, draft: getDraft(), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
          viewport.setPointerCapture?.(event.pointerId); viewport.dataset.linking = "true";
        });
        port.addEventListener("click", event => { event.stopPropagation();
          if (!getDraft()?.nodes.includes(node)) return;
          if (direction === "out") { wire = { source: node.id, node, draft: getDraft() }; viewport.dataset.linking = "true"; }
          else if (wire) { addWire(wire.source, node.id); viewport.dataset.linking = "false"; }
        }); card.append(port);
      }
      title.addEventListener("pointerdown", event => {
        if (event.button !== 0) return; event.stopPropagation(); select({ kind: "node", id: node.id });
        if (!getDraft()?.nodes.includes(node)) return;
        drag = { id: node.id, node, draft: getDraft(), x: node.x, y: node.y, lastX: node.x, lastY: node.y,
          clientX: event.clientX, clientY: event.clientY, moved: false, pointerId: event.pointerId };
        viewport.setPointerCapture?.(event.pointerId);
      });
      card.addEventListener("click", event => { if (!event.target.closest("[data-port]")) { event.stopPropagation(); select({ kind: "node", id: node.id }); } });
      card.addEventListener("pointerenter", () => hover({ kind: "node", id: node.id })); card.addEventListener("pointerleave", () => hover(null));
      title.addEventListener("keydown", event => {
        const offset = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!offset) return; event.preventDefault(); clearGesture(true); select({ kind: "node", id: node.id }); const amount = event.shiftKey ? 40 : 10;
        if (!getDraft()?.nodes.includes(node)) return;
        node.x = Math.min(10000, Math.max(0, node.x + offset[0] * amount)); node.y = Math.min(10000, Math.max(0, node.y + offset[1] * amount));
        onChange(); render(); nodes.querySelector(`[data-node-id="${node.id}"] .team-node-drag`)?.focus();
      }); nodes.append(card);
    }
    lines(); highlight(); restoreFocus(focus);
  }
  // A touch drag need not emit a compatibility click. Only the click ending
  // that gesture may be suppressed; a new pointerdown always starts afresh.
  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const owner = pointerOwner();
    if (owner !== undefined && owner !== event.pointerId) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (owner !== undefined) clearGesture(true);
    handledPointerClick = null;
  }, true);
  viewport.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!gestureCurrent()) { clearGesture(); render(); return; }
    const node = getDraft()?.nodes.find(node => node.id === drag.id); if (!node) return;
    const dx = (event.clientX - drag.clientX) / zoom, dy = (event.clientY - drag.clientY) / zoom;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    node.x = Math.round(Math.min(10000, Math.max(0, drag.x + dx))); node.y = Math.round(Math.min(10000, Math.max(0, drag.y + dy)));
    drag.lastX = node.x; drag.lastY = node.y;
    const card = nodes.querySelector(`[data-node-id="${node.id}"]`); if (card) { card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; } lines();
  });
  viewport.addEventListener("pointerup", event => {
    if (drag?.pointerId === event.pointerId) { handledPointerClick = { pointerId: event.pointerId }; const changed = drag.moved; drag = null; if (changed) { onChange(); render(); } }
    if (wire?.pointerId === event.pointerId) {
      handledPointerClick = { pointerId: event.pointerId };
      const to = doc.elementFromPoint(event.clientX, event.clientY)?.closest("[data-port='in']")?.dataset.portNode;
      if (to) addWire(wire.source, to);
      else if (Math.abs(event.clientX - wire.startX) + Math.abs(event.clientY - wire.startY) > 4) wire = null;
      // A tap keeps click-to-connect mode, but the captured pointer has ended.
      if (wire) wire = { source: wire.source, node: wire.node, draft: wire.draft };
      viewport.dataset.linking = String(Boolean(wire));
    }
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  });
  const cancelPointer = event => {
    const owner = pointerOwner(); if (owner === undefined || event.pointerId !== undefined && event.pointerId !== owner) return;
    clearGesture(true); render();
  };
  viewport.addEventListener("pointercancel", cancelPointer);
  viewport.addEventListener("lostpointercapture", cancelPointer);
  // Capturing the pointer can retarget its compatibility click to the viewport.
  // Selection and wiring were already handled by pointerup; do not clear them.
  viewport.addEventListener("click", event => {
    if (event.detail === 0 && pointerOwner() !== undefined) clearGesture(true);
    const gesture = handledPointerClick;
    if (gesture && event.detail !== 0 && (event.pointerId === undefined || event.pointerId === gesture.pointerId)) {
      handledPointerClick = null;
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  viewport.addEventListener("click", event => { if (!event.target.closest(".team-graph-node, [data-edge-id]")) { wire = null; viewport.dataset.linking = "false"; select(null); } });
  function setZoom(next) { if (pointerOwner() !== undefined) clearGesture(true); const previous = zoom; zoom = Math.min(1.8, Math.max(.4, next));
    const x = (viewport.scrollLeft + viewport.clientWidth / 2) / previous, y = (viewport.scrollTop + viewport.clientHeight / 2) / previous;
    render(); viewport.scrollLeft = x * zoom - viewport.clientWidth / 2; viewport.scrollTop = y * zoom - viewport.clientHeight / 2;
  }
  minus.addEventListener("click", () => setZoom(zoom - .1)); plus.addEventListener("click", () => setZoom(zoom + .1)); reset.addEventListener("click", () => setZoom(1));
  viewport.addEventListener("wheel", event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom(zoom + (event.deltaY < 0 ? .08 : -.08)); } }, { passive: false });
  return { render, select, selection: () => current(), pinned: () => pinned, resetView(id) {
    zoom = 1; viewport.scrollLeft = 0; viewport.scrollTop = 0; render();
    const draft = getDraft(), node = draft?.nodes.find(item => item.id === id) ?? draft?.nodes[0];
    if (node) { viewport.scrollLeft = Math.max(0, node.x - 80); viewport.scrollTop = Math.max(0, node.y - 80); }
  }, reveal(id) {
    render(); const node = getDraft()?.nodes.find(item => item.id === id); if (node) { viewport.scrollLeft = Math.max(0, node.x * zoom - 80); viewport.scrollTop = Math.max(0, node.y * zoom - 80); }
  } };
}
