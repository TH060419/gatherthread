import { driver } from "driver.js";
import { GUIDE_COPY, guideSteps, guideText, onboardingKey, createOnboardingProgress } from "./onboarding-content.js";

function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }

// Only visible targets are handed to Driver.js: it scrolls offscreen targets
// into view otherwise. Never move the reader's conversation-history scroll.
export function visibleGuideTarget(doc, selectors) {
  const viewport = doc.defaultView;
  const currentModal = [...doc.querySelectorAll("dialog[open]")].at(-1);
  for (const selector of selectors.split(",")) {
    for (const node of doc.querySelectorAll(selector.trim())) {
      if (node.closest("[hidden]") || !node.getClientRects().length) continue;
      if (currentModal && !currentModal.contains(node)) continue;
      const rect = node.getBoundingClientRect();
      const style = viewport.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") continue;
      let clipped = false;
      for (let parent = node.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
        const css = viewport.getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if ((/(auto|scroll|hidden|clip)/u.test(css.overflowY) && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1))
          || (/(auto|scroll|hidden|clip)/u.test(css.overflowX) && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))) { clipped = true; break; }
      }
      if (clipped) continue;
      if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0
        && rect.bottom <= viewport.innerHeight && rect.right <= viewport.innerWidth) return node;
    }
  }
  return undefined;
}

export function mountOnboarding({ document: doc, getContext, openSettings, storage = browserStorage(), createDriver = driver }) {
  const win = doc.defaultView;
  const el = (id) => doc.getElementById(id);
  const progress = createOnboardingProgress(storage);
  let tour = null;
  let activeTopic;
  let activeItems = [];
  let activeKey;
  let returnFocus;
  let restorePresentation;
  let ownedCodeDialog = false;
  let pendingKey = null;
  let autoFrame;
  let layoutFrame;
  let ending = false;
  let language;
  let line;
  let lastTarget;
  const originalAttributes = new Map();
  const text = (pair) => guideText(pair, getContext().locale);
  const key = () => onboardingKey(getContext());
  const modal = () => [...doc.querySelectorAll("dialog[open]")].at(-1);

  function prepare(view) {
    const workspace = el("workspace");
    if (workspace.dataset.onboardingView !== (view ?? "")) workspace.dataset.onboardingView = view ?? "";
    if (!view?.startsWith("code-") && ownedCodeDialog) {
      ownedCodeDialog = false;
      el("project-code-dialog").close();
    }
    if (view === "rail") {
      el("workspace").dataset.leftRailCollapsed = "false";
      el("toggle-session-rail-button").setAttribute("aria-expanded", "true");
    }
    if (view === "conversation" && win.innerWidth <= 760) {
      el("workspace").dataset.leftRailCollapsed = "true";
      el("toggle-session-rail-button").setAttribute("aria-expanded", "false");
      if (el("member-panel").classList.contains("member-panel-open")) el("member-panel").classList.remove("member-panel-open");
      el("mobile-members-button").setAttribute("aria-expanded", "false");
    }
    if (view === "details" && getContext().session && !el("session-context-details").open) el("session-context-details").open = true;
    if (view === "members") {
      el("workspace").dataset.rightPanelCollapsed = "false";
      if (!el("member-panel").classList.contains("member-panel-open")) el("member-panel").classList.add("member-panel-open");
      el("mobile-members-button").setAttribute("aria-expanded", "true");
    }
    if (view?.startsWith("code-")) {
      const dialog = el("project-code-dialog");
      if (!dialog.open) {
        // This existing entry only reads status. All transfer/enable/merge
        // controls remain blocked by the tour; no synthetic mutation clicks.
        ownedCodeDialog = true;
        el("project-code-button").click();
      }
      const viewButton = { "code-overview": "code-back-device-view", "code-device": "code-open-device-view", "code-branches": "code-open-branches-view" }[view];
      const viewPanel = { "code-overview": "code-enabled-home", "code-device": "code-device-view", "code-branches": "code-branches-view" }[view];
      if (!el("code-enabled-content").hidden && viewButton && el(viewPanel).hidden) el(viewButton).click();
    }
  }

  function cleanup() {
    tour = null;
    line?.remove(); line = null;
    doc.removeEventListener("keydown", handleKey, true);
    doc.removeEventListener("focusin", containFocus, true);
    if (ownedCodeDialog) { ownedCodeDialog = false; el("project-code-dialog").close(); }
    restorePresentation?.(); restorePresentation = null;
    for (const [node, attributes] of originalAttributes) {
      if (!node.isConnected) continue;
      for (const [name, value] of attributes) value === null ? node.removeAttribute(name) : node.setAttribute(name, value);
    }
    originalAttributes.clear();
    const focus = returnFocus;
    returnFocus = null;
    win.requestAnimationFrame(() => {
      if (focus?.isConnected && !focus.closest("[hidden]") && !focus.closest("dialog:not([open])")) focus.focus({ preventScroll: true });
      else if (!el("workspace").hidden) el("settings-button").focus({ preventScroll: true });
    });
  }

  function end(status) {
    if (!tour || ending) return;
    ending = true;
    if (activeTopic === "basics" && status) progress.mark(activeKey, status);
    const instance = tour;
    instance.destroy();
    if (tour === instance) cleanup();
    ending = false;
  }

  function containFocus(event) {
    const popup = tour?.getState("popover")?.wrapper;
    if (popup && !popup.contains(event.target)) popup.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
  }

  function handleKey(event) {
    if (!tour) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); end("skipped"); return; }
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "ArrowLeft" && tour.hasPreviousStep()) tour.movePrevious();
      if (event.key === "ArrowRight") tour.hasNextStep() ? tour.moveNext() : end("completed");
      return;
    }
    if (event.key !== "Tab") return;
    const popup = tour.getState("popover")?.wrapper;
    const buttons = [...(popup?.querySelectorAll("button:not([disabled])") ?? [])].filter((node) => node.getClientRects().length);
    if (!buttons.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const position = buttons.indexOf(doc.activeElement);
    const next = (position + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  }

  function attachLayers() {
    if (!tour) return;
    const parent = modal() ?? doc.body;
    const popup = tour.getState("popover")?.wrapper;
    const overlay = tour.getState("__overlaySvg");
    if (popup && popup.parentElement !== parent) parent.append(popup);
    if (overlay && overlay.parentElement !== parent) parent.append(overlay);
    if (line && line.parentElement !== parent) parent.append(line);
  }

  function drawLine() {
    if (!tour) return;
    attachLayers();
    const popup = tour.getState("popover")?.wrapper;
    const target = tour.getActiveElement();
    if (!popup || !target || target.id === "driver-dummy-element" || !target.isConnected) { line?.remove(); line = null; return; }
    const box = target.getBoundingClientRect();
    const card = popup.getBoundingClientRect();
    if (!line) {
      line = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      line.classList.add("onboarding-connector");
      line.setAttribute("aria-hidden", "true");
      line.innerHTML = '<defs><marker id="onboarding-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><path class="onboarding-line" marker-end="url(#onboarding-arrow)"/>';
      (modal() ?? doc.body).append(line);
    }
    line.setAttribute("viewBox", `0 0 ${win.innerWidth} ${win.innerHeight}`);
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    const x = Math.max(card.left + 12, Math.min(card.right - 12, cx));
    const y = cy < card.top ? card.top : cy > card.bottom ? card.bottom : Math.max(card.top + 12, Math.min(card.bottom - 12, cy));
    const startX = cy >= card.top && cy <= card.bottom ? (cx < card.left ? card.left : card.right) : x;
    const endX = Math.max(box.left, Math.min(box.right, startX));
    const endY = Math.max(box.top, Math.min(box.bottom, y));
    // A short crisp connector reaches the actual control, never an invented spot.
    line.querySelector(".onboarding-line").setAttribute("d", `M ${startX} ${y} L ${endX} ${endY}`);
  }

  function start(topic = "basics") {
    if (el("workspace").hidden || !getContext().userId) return;
    if (modal()) return; // Let credential, privacy and business dialogs finish first.
    pendingKey = null;
    end(null);
    activeTopic = topic;
    activeKey = key();
    language = getContext().locale;
    returnFocus = doc.activeElement;
    const workspace = el("workspace");
    const previousView = workspace.dataset.onboardingView;
    const left = workspace.dataset.leftRailCollapsed;
    const right = workspace.dataset.rightPanelCollapsed;
    const memberOpen = el("member-panel").classList.contains("member-panel-open");
    const detailsOpen = el("session-context-details").open;
    const leftAria = el("toggle-session-rail-button").getAttribute("aria-expanded");
    const rightAria = el("mobile-members-button").getAttribute("aria-expanded");
    restorePresentation = () => {
      if (previousView === undefined) delete workspace.dataset.onboardingView; else workspace.dataset.onboardingView = previousView;
      if (left === undefined) delete workspace.dataset.leftRailCollapsed; else workspace.dataset.leftRailCollapsed = left;
      if (right === undefined) delete workspace.dataset.rightPanelCollapsed; else workspace.dataset.rightPanelCollapsed = right;
      el("member-panel").classList.toggle("member-panel-open", memberOpen);
      el("session-context-details").open = detailsOpen;
      el("toggle-session-rail-button").setAttribute("aria-expanded", leftAria ?? "true");
      el("mobile-members-button").setAttribute("aria-expanded", rightAria ?? "true");
    };
    const items = activeItems = guideSteps(topic, getContext());
    const makeSteps = () => items.map((item) => ({
      element: () => {
        prepare(item.view);
        lastTarget = visibleGuideTarget(doc, item.target);
        if (lastTarget && !originalAttributes.has(lastTarget)) originalAttributes.set(lastTarget,
          ["aria-haspopup", "aria-expanded", "aria-controls"].map((name) => [name, lastTarget.getAttribute(name)]));
        return lastTarget;
      },
      popover: { title: text(item.title), description: text(item.text), side: "bottom", align: "center" },
    }));
    tour = createDriver({
      steps: makeSteps(), animate: false, smoothScroll: false, allowScroll: true,
      allowClose: true, allowKeyboardControl: false, disableActiveInteraction: true,
      overlayOpacity: 0.38, stagePadding: 7, stageRadius: 12, popoverOffset: 20,
      popoverClass: "onboarding-popover", showProgress: true, progressText: "{{current}} / {{total}}",
      nextBtnText: text(GUIDE_COPY.next), prevBtnText: text(GUIDE_COPY.back), doneBtnText: text(GUIDE_COPY.done),
      onCloseClick: () => end("skipped"), onDoneClick: () => end("completed"),
      onDestroyStarted: () => end("skipped"),
      onDestroyed: cleanup,
      onPopoverRender: (popover) => {
        popover.wrapper.setAttribute("data-i18n-skip", "");
        popover.wrapper.setAttribute("aria-modal", "true");
        popover.progress.setAttribute("aria-live", "polite");
        popover.closeButton.setAttribute("aria-label", text(GUIDE_COPY.skip));
        if (!lastTarget) {
          const hint = doc.createElement("p"); hint.className = "onboarding-hint";
          hint.textContent = text(getContext().session ? GUIDE_COPY.missing : GUIDE_COPY.empty);
          popover.description.append(hint);
        }
        if (topic === "basics" && ["chat", "request"].includes(items[tour.getActiveIndex()]?.id) && !getContext().writable) {
          const hint = doc.createElement("p"); hint.className = "onboarding-hint"; hint.textContent = text(GUIDE_COPY.readonly);
          popover.description.append(hint);
        }
        const skip = doc.createElement("button"); skip.type = "button"; skip.className = "onboarding-skip";
        skip.textContent = text(GUIDE_COPY.skip); skip.addEventListener("click", () => end("skipped"));
        popover.wrapper.append(skip);
        if (topic === "basics" && tour.isLastStep()) {
          const more = doc.createElement("button"); more.type = "button"; more.className = "onboarding-more";
          more.textContent = text(GUIDE_COPY.more); more.addEventListener("click", () => { end("completed"); openSettings(); });
          popover.description.append(more);
        }
        const parent = modal(); if (parent) parent.append(popover.wrapper);
        win.requestAnimationFrame(drawLine);
      },
      onHighlighted: () => { attachLayers(); win.requestAnimationFrame(drawLine); },
    });
    doc.addEventListener("keydown", handleKey, true);
    doc.addEventListener("focusin", containFocus, true);
    tour.drive();
  }

  function autoStart() {
    win.cancelAnimationFrame(autoFrame);
    if (!pendingKey || pendingKey !== key() || progress.has(pendingKey) || el("workspace").hidden || modal() || tour) return;
    autoFrame = win.requestAnimationFrame(() => {
      if (pendingKey === key() && !modal() && !el("workspace").hidden) start("basics");
    });
  }
  function reconcileLayout() {
    if (!tour) return;
    win.cancelAnimationFrame(layoutFrame);
    layoutFrame = win.requestAnimationFrame(() => {
      if (!tour) return;
      const item = activeItems[tour.getActiveIndex()];
      prepare(item.view);
      const active = tour.getActiveElement();
      const resolved = visibleGuideTarget(doc, item.target);
      // Loading, live updates, and scrolling may reveal, replace or hide a target.
      if (resolved !== (active?.id === "driver-dummy-element" ? undefined : active)) tour.drive(tour.getActiveIndex());
      else tour.refresh();
      drawLine();
    });
  }
  const observer = new win.MutationObserver((records) => {
    if (pendingKey) autoStart();
    if (!records.some((record) => !record.target.closest?.(".onboarding-popover, .onboarding-connector, .driver-overlay")
      && (el("workspace").contains(record.target) || el("project-code-dialog").contains(record.target)))) return;
    reconcileLayout();
  });
  observer.observe(doc.body, { attributes: true, attributeFilter: ["open", "hidden", "class", "style"], childList: true, subtree: true });
  win.addEventListener("resize", reconcileLayout);
  doc.addEventListener("scroll", reconcileLayout, true);
  el("project-code-dialog").addEventListener("close", () => { if (tour && ownedCodeDialog && !el("project-code-dialog").open) end("skipped"); });
  return {
    start,
    offer() { pendingKey = key(); autoStart(); },
    cancel() { pendingKey = null; win.cancelAnimationFrame(autoFrame); end(null); },
    refreshLanguage() {
      if (tour && language !== getContext().locale) {
        const index = tour.getActiveIndex(); const topic = activeTopic;
        end(null); start(topic); tour?.drive(index);
      }
    },
  };
}
