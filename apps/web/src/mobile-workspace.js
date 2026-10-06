// Presentation only: move the existing controls, never duplicate request paths.
export const MOBILE_WORKSPACE_MAX_WIDTH = 1366;

export function isMobileDevice(navigator = {}) {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent ?? "")
    || (/Mac/i.test(navigator.platform ?? "") && navigator.maxTouchPoints > 1);
}

export function usesMobileWorkspace(navigator, width) {
  return isMobileDevice(navigator) && width <= MOBILE_WORKSPACE_MAX_WIDTH;
}

export function mobileAgentLabel(harness, effort, t = text => text) {
  const agent = harness === "cloud" ? t("Cloud") : harness === "deepseek-harness" ? "DSH" : "Codex";
  return effort ? `${agent} · ${t(effort)}` : agent;
}

export function mobileControlLabel(text) {
  return ({ "Request my agent": "Ask AI", "Waiting for Agent…": "Waiting…", "Pause Agent": "Pause",
    "Resume Agent": "Resume" })[text] ?? text;
}

export function mountMobileWorkspace({ document: doc, window: win, t, enabled = true, onLayoutChange = () => {} }) {
  const el = id => doc.getElementById(id);
  const workspace = el("workspace");
  const query = win.matchMedia(`(max-width: ${MOBILE_WORKSPACE_MAX_WIDTH}px)`);
  const mobileDevice = isMobileDevice(win.navigator);
  doc.documentElement.dataset.mobileDevice = String(mobileDevice && enabled);
  const rail = el("session-rail");
  const profile = el("agent-request-profile");
  const dialogs = [el("mobile-sessions-dialog"), el("mobile-agent-dialog"), el("mobile-tools-dialog"), el("mobile-members-dialog")];
  const placements = [];
  let active = false;
  let scheduled = false;
  let returnFocus = el("mobile-tools-button");
  const remember = (node, target) => {
    const marker = doc.createComment("mobile control home");
    node.before(marker);
    placements.push({ node, marker, target });
  };
  remember(rail, el("mobile-sessions-content"));
  remember(profile, el("mobile-agent-content"));
  remember(el("member-panel"), el("mobile-members-content"));
  for (const id of ["project-code-button", "settings-button", "mobile-members-button", "logout-button",
    "rename-session-button", "delete-session-button", "session-context-details",
    "history-summary-select-button", "mentions-button", "history-summary-view-button",
    "history-summary-versions-button", "download-codex-button"]) {
    remember(el(id), el("mobile-tools-content"));
  }

  function closeAll() {
    el("session-context-details").open = false;
    for (const dialog of dialogs) if (dialog.open) dialog.close();
  }
  function open(dialog, trigger) {
    if (!active || workspace.hidden) return;
    closeAll();
    returnFocus = trigger?.getClientRects().length ? trigger : el("mobile-tools-button");
    dialog.showModal();
    trigger?.setAttribute("aria-expanded", "true");
  }
  const triggers = [el("toggle-session-rail-button"), el("mobile-agent-button"), el("mobile-tools-button"), el("mobile-members-button")];
  dialogs.forEach((dialog, index) => {
    dialog.querySelector("[data-mobile-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => {
      if (index === 2) el("session-context-details").open = false;
      // A resize can restore desktop disclosure state before this async event fires.
      if (active) {
        triggers[index].setAttribute("aria-expanded", "false");
        if (index === 2) el("mobile-compose-tools-button").setAttribute("aria-expanded", "false");
      }
      // A newly opened settings/create dialog owns focus. Do not steal it.
      if (!workspace.hidden && !doc.querySelector("dialog[open]") && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    });
  });
  for (const dialog of doc.querySelectorAll("dialog")) {
    if (dialogs.includes(dialog)) continue;
    dialog.addEventListener("close", () => {
      if (active && !workspace.hidden && !doc.querySelector("dialog[open]")
        && (doc.activeElement === doc.body || doc.activeElement?.closest("dialog:not([open])"))) {
        returnFocus.focus({ preventScroll: true });
      }
    });
  }
  el("mobile-agent-button").addEventListener("click", () => open(dialogs[1], triggers[1]));
  el("mobile-tools-button").addEventListener("click", () => open(dialogs[2], triggers[2]));
  el("mobile-compose-tools-button").addEventListener("click", () => open(dialogs[2], el("mobile-compose-tools-button")));
  // Close the navigation surface before existing handlers open another dialog.
  dialogs[0].addEventListener("click", event => {
    if (event.target.closest("button")) dialogs[0].close();
  }, true);
  el("project-select").addEventListener("change", () => dialogs[0].close());
  dialogs[2].addEventListener("click", event => {
    if (event.target.closest("button") && !event.target.closest("#session-context-panel")) dialogs[2].close();
  }, true);

  function update() {
    const next = enabled && mobileDevice && query.matches;
    const changed = next !== active;
    if (changed) {
      closeAll();
      active = next;
      for (const { node, marker, target } of placements) {
        if (active) target.append(node);
        else marker.after(node);
      }
    }
    workspace.dataset.mobileUi = String(active);
    doc.documentElement.dataset.mobileWorkspace = String(active);
    if (workspace.hidden) closeAll();
    for (const note of doc.querySelectorAll(".mobile-device-note")) note.hidden = !mobileDevice || !active;
    const harness = el("agent-harness-select").value;
    const effortSelect = el(harness === "deepseek-harness" ? "agent-dsh-effort-select" : "agent-effort-select");
    const effort = harness === "cloud" || effortSelect.hidden ? "" : effortSelect.value;
    el("mobile-agent-label").textContent = mobileAgentLabel(harness, effort, t);
    const full = profile.querySelectorAll("select:not([hidden])");
    const description = [...full].filter(select => !select.closest("[hidden]"))
      .map(select => select.selectedOptions[0]?.textContent).filter(Boolean).join(" · ");
    const label = `${t("Agent, model and reasoning")} · ${description}`;
    el("mobile-agent-button").setAttribute("aria-label", label);
    el("mobile-agent-button").title = label;
    if (active) {
      el("mobile-members-button").setAttribute("aria-label", t("Members"));
      el("mobile-members-button").title = t("Members");
      el("mobile-members-button").setAttribute("aria-controls", "mobile-members-dialog");
      el("mobile-members-button").setAttribute("aria-expanded", String(dialogs[3].open));
      triggers[0].setAttribute("aria-controls", "mobile-sessions-dialog");
      triggers[0].setAttribute("aria-expanded", String(dialogs[0].open));
      triggers[0].setAttribute("aria-label", t("Projects and sessions"));
      triggers[0].title = t("Projects and sessions");
      for (const button of el("mobile-tools-content").children) {
        if (button.tagName !== "BUTTON" || !button.classList.contains("icon-button")) continue;
        let caption = button.querySelector(".mobile-action-caption");
        if (!caption) {
          caption = doc.createElement("span"); caption.className = "mobile-action-caption";
          caption.setAttribute("aria-hidden", "true"); caption.dataset.i18nSkip = ""; button.append(caption);
        }
        caption.textContent = button.getAttribute("aria-label");
      }
    } else {
      el("mobile-members-button").setAttribute("aria-controls", "member-panel");
      triggers[0].setAttribute("aria-controls", "session-rail");
    }
    if (changed) onLayoutChange();
  }
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    win.queueMicrotask(() => { scheduled = false; update(); });
  };
  const observer = new win.MutationObserver(schedule);
  observer.observe(profile, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["lang"] });
  observer.observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
  query.addEventListener?.("change", update);
  if (!query.addEventListener) query.addListener(update);
  const resizeViewport = () => {
    if (win.visualViewport) workspace.style.setProperty("--mobile-viewport-height", `${win.visualViewport.height}px`);
  };
  win.visualViewport?.addEventListener("resize", resizeViewport);
  resizeViewport();
  update();
  return {
    update, close: closeAll,
    isActive: () => active,
    canConnectLocally: () => !mobileDevice || !enabled,
    toggleRail: () => {
      if (!active) return false;
      if (dialogs[0].open) dialogs[0].close(); else open(dialogs[0], triggers[0]);
      return true;
    },
    toggleMembers: () => {
      if (!active) return false;
      open(dialogs[3], triggers[3]); return true;
    },
    closeMembers: () => {
      if (!active) return false;
      dialogs[3].close(); return true;
    },
  };
}
