import { positionSessionContextPanel } from "./session-context-panel.js";
import { mountExampleGateway, exampleToolbar } from "./onboarding-example.js";
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

export function mountOnboarding({ document: doc, getContext, openSettings, storage = browserStorage(), createDriver = driver, prepareScenario }) {
  if (doc.documentElement.dataset.example !== "true") return mountExampleGateway({ document: doc, getContext, openSettings, storage });
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
  let ownedSettingsDialog = false;
  let initialOffer = true;
  let pendingKey = null;
  let autoFrame;
  let layoutFrame;
  let ending = false;
  let language;
  let toolbar;
  let line;
  let lastTarget;
  const originalAttributes = new Map();
  const text = (pair) => guideText(pair, getContext().locale);
  const key = () => onboardingKey(getContext());
  const modal = () => [...doc.querySelectorAll("dialog[open]")].at(-1);

  function prepare(item) {
    prepareScenario?.(item);
    const view = item.view;
    if (view !== "summary-settings" && ownedSettingsDialog) { ownedSettingsDialog = false; el("settings-dialog").close(); }
    if (view === "summary-settings" && !el("settings-dialog").open) {
      ownedSettingsDialog = true; openSettings();
      el("settings-sync").scrollIntoView({ block: "start", behavior: "instant" });
    }

    const workspace = el("workspace");
    workspace.dataset.onboardingStep = item.id;
    if (workspace.dataset.onboardingView !== (view ?? "")) workspace.dataset.onboardingView = view ?? "";
    if (!view?.startsWith("code-") && ownedCodeDialog) {
      ownedCodeDialog = false;
      el("project-code-dialog").close();
    }
    if (view === "rail") {
      el("workspace").dataset.leftRailCollapsed = "false";
      el("toggle-session-rail-button").setAttribute("aria-expanded", "true");
    }
    if (["conversation", "details", "snapshot", "summary-selection"].includes(view) && win.innerWidth <= 760) {
      el("workspace").dataset.leftRailCollapsed = "true";
      el("toggle-session-rail-button").setAttribute("aria-expanded", "false");
      if (el("member-panel").classList.contains("member-panel-open")) el("member-panel").classList.remove("member-panel-open");
      el("mobile-members-button").setAttribute("aria-expanded", "false");
    }
    if (view === "details" && getContext().session) {
      if (!el("session-context-details").open) el("session-context-details").open = true;
      positionDetailsPanel();
    } else if (el("session-context-details").open) el("session-context-details").open = false;
    if (view === "leave") {
      el("workspace").dataset.leftRailCollapsed = "false";
      el("toggle-session-rail-button").setAttribute("aria-expanded", "true");
    }
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
    const toolbar = doc.querySelector(".example-toolbar"); if (toolbar) doc.body.append(toolbar);
    line?.remove(); line = null;
    doc.removeEventListener("keydown", handleKey, true);
    doc.removeEventListener("focusin", containFocus, true);
    if (ownedCodeDialog) { ownedCodeDialog = false; el("project-code-dialog").close(); }
    if (ownedSettingsDialog) { ownedSettingsDialog = false; el("settings-dialog").close(); }
    positionSessionContextPanel(doc);
    delete el("workspace").dataset.onboardingStep;
    doc.documentElement.style.removeProperty("--example-guide-height");
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
    if (status) exitExample(status);
  }

  function exitExample(status, settings = false) {
    win.parent.postMessage({ type: "example-exit", channel: win.__examplePresentation?.channel, status, settings }, "*");
  }
  function positionDetailsPanel() { positionSessionContextPanel(doc); }

  function containFocus(event) {
    const popup = tour?.getState("popover")?.wrapper;
    if (popup && !popup.contains(event.target) && !event.target.closest?.(".example-toolbar")) popup.querySelector(".driver-popover-next-btn")?.focus({ preventScroll: true });
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
    const buttons = [...(popup?.querySelectorAll("button:not([disabled])") ?? []), ...doc.querySelectorAll(".example-toolbar button, .example-toolbar select")].filter((node) => node.getClientRects().length);
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
    const toolbar = doc.querySelector(".example-toolbar"); if (toolbar && toolbar.parentElement !== parent) parent.append(toolbar);
  }

  function drawLine() {
    if (!tour) return;
    attachLayers();
    const popup = tour.getState("popover")?.wrapper;
    const target = tour.getActiveElement();
    if (!popup || !target || target.id === "driver-dummy-element" || !target.isConnected) { line?.remove(); line = null; return; }
    positionCard(popup, target);
    const box = target.getBoundingClientRect();
    const card = popup.getBoundingClientRect();
    if (!line) {
      line = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      line.classList.add("onboarding-connector");
      line.setAttribute("aria-hidden", "true");
      line.innerHTML = '<defs><marker id="onboarding-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><rect class="onboarding-ring"/><path class="onboarding-line" marker-end="url(#onboarding-arrow)"/>';
      (modal() ?? doc.body).append(line);
    }
    line.setAttribute("viewBox", `0 0 ${win.innerWidth} ${win.innerHeight}`);
    const ring = line.querySelector(".onboarding-ring");
    const radius = tour.getConfig().stageRadius;
    for (const [name, value] of Object.entries({ x: box.left - 7, y: box.top - 7, width: box.width + 14, height: box.height + 14, rx: radius, ry: radius })) ring.setAttribute(name, String(value));
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    const x = Math.max(card.left + 12, Math.min(card.right - 12, cx));
    const y = cy < card.top ? card.top : cy > card.bottom ? card.bottom : Math.max(card.top + 12, Math.min(card.bottom - 12, cy));
    const startX = cy >= card.top && cy <= card.bottom ? (cx < card.left ? card.left : card.right) : x;
    const endX = Math.max(box.left, Math.min(box.right, startX));
    const endY = Math.max(box.top, Math.min(box.bottom, y));
    // A short crisp connector reaches the actual control, never an invented spot.
    line.querySelector(".onboarding-line").setAttribute("d", `M ${startX} ${y} L ${endX} ${endY}`);
  }

  function positionCard(popup, target) {
    popup.style.right = "auto"; popup.style.bottom = "auto";
    const width = popup.offsetWidth, height = popup.offsetHeight, margin = 14, gap = 24;
    if (target?.id === "timeline-region" && activeItems[tour.getActiveIndex()]?.id === "answer") {
      doc.documentElement.style.setProperty("--example-guide-height", `${height}px`);
    }
    const box = target?.getBoundingClientRect();
    const topLimit = 54;
    if (!box || target.id === "driver-dummy-element") {
      popup.style.setProperty("--guide-left", `${Math.max(margin, (win.innerWidth - width) / 2)}px`);
      popup.style.setProperty("--guide-top", `${Math.max(topLimit, (win.innerHeight - height) / 2)}px`);
      return;
    }
    const clampX = (x) => Math.max(margin, Math.min(win.innerWidth - width - margin, x));
    const clampY = (y) => Math.max(topLimit, Math.min(win.innerHeight - height - margin, y));
    // Prefer the outside of the whole disclosure, keeping its other controls
    // readable. On short/narrow screens fall back beside the highlighted control.
    const panel = target.closest('.session-context-panel');
    const anchors = panel ? [panel.getBoundingClientRect(), box] : [box];
    const candidates = anchors.flatMap((anchor) => [
      [anchor.right + gap, clampY(anchor.top)], [anchor.left - width - gap, clampY(anchor.top)],
      [clampX(anchor.left + (anchor.width - width) / 2), anchor.bottom + gap],
      [clampX(anchor.left + (anchor.width - width) / 2), anchor.top - height - gap],
    ]);
    const fit = candidates.find(([x, y]) => x >= margin && y >= topLimit && x + width <= win.innerWidth - margin && y + height <= win.innerHeight - margin);
    const [x, y] = fit ?? [clampX(box.left), clampY(box.bottom + gap)];
    popup.style.setProperty("--guide-left", `${x}px`); popup.style.setProperty("--guide-top", `${y}px`);
  }

  function start(topic = "basics") {
    if (el("workspace").hidden || !getContext().userId) return;
    if (modal()) return; // Finish a practice dialog before starting another guide.
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
        prepare(item);
        // All scrolling happens inside the disposable example, never real history.
        if (item.target) {
          const node = [...doc.querySelectorAll(item.target)].find((candidate) => !candidate.closest("[hidden]"));
          node?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        }
        lastTarget = item.target ? visibleGuideTarget(doc, item.target) : undefined;
        if (lastTarget) {
          const box = lastTarget.getBoundingClientRect();
          const circular = item.id === "quote" || item.id === "mention";
          const radius = circular ? Math.min(box.width, box.height) / 2 + 7 : Math.max(12, Math.min(24, parseFloat(win.getComputedStyle(lastTarget).borderRadius) + 7 || 12));
          tour.setConfig({ ...tour.getConfig(), stageRadius: radius });
        }
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
        popover.wrapper.removeAttribute("data-onboarding-focus-ready");
        popover.wrapper.setAttribute("aria-modal", "true");
        popover.progress.setAttribute("aria-live", "polite");
        popover.closeButton.setAttribute("aria-label", text(GUIDE_COPY.skip));
        if (!lastTarget && items[tour.getActiveIndex()]?.target) {
          const hint = doc.createElement("p"); hint.className = "onboarding-hint";
          hint.textContent = getContext().locale === "zh-CN" ? "正在准备示例中的功能…" : "Preparing this example control…";
          popover.description.append(hint);
        }
        const note = items[tour.getActiveIndex()]?.note;
        if (note) { const small = doc.createElement("p"); small.className = "onboarding-hint"; small.textContent = text(note); popover.description.append(small); }
        if (topic === "basics" && ["chat", "request"].includes(items[tour.getActiveIndex()]?.id) && !getContext().writable) {
          const hint = doc.createElement("p"); hint.className = "onboarding-hint"; hint.textContent = text(GUIDE_COPY.readonly);
          popover.description.append(hint);
        }
        const skip = doc.createElement("button"); skip.type = "button"; skip.className = "onboarding-skip";
        skip.textContent = text(GUIDE_COPY.skip); skip.addEventListener("click", () => end("skipped"));
        popover.wrapper.append(skip);
        if (topic === "basics" && tour.isLastStep()) {
          const more = doc.createElement("button"); more.type = "button"; more.className = "onboarding-more";
          more.textContent = text(GUIDE_COPY.more); more.addEventListener("click", () => { end(null); exitExample("completed", true); });
          popover.description.append(more);
        }
        const parent = modal(); if (parent) parent.append(popover.wrapper);
        win.requestAnimationFrame(() => {
          if (!tour || tour.getState("popover")?.wrapper !== popover.wrapper) return;
          positionCard(popover.wrapper, tour.getActiveElement()); drawLine();
          popover.nextButton.focus({ preventScroll: true });
          popover.wrapper.setAttribute("data-onboarding-focus-ready", items[tour.getActiveIndex()]?.id ?? "");
          win.requestAnimationFrame(drawLine);
        });
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
      prepare(item);
      const active = tour.getActiveElement();
      const resolved = item.target ? visibleGuideTarget(doc, item.target) : undefined;
      // Loading, live updates, and scrolling may reveal, replace or hide a target.
      if (resolved !== (active?.id === "driver-dummy-element" ? undefined : active)) tour.drive(tour.getActiveIndex());
      else { tour.refresh(); positionCard(tour.getState("popover").wrapper, active); }
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
  const controls = {
    start,
    offer() {
      if (!initialOffer) return;
      initialOffer = false;
      const topic = win.__examplePresentation?.topic;
      toolbar = exampleToolbar(doc, { start, cancel: () => end(null), onExit: (status) => exitExample(status) });
      if (topic && topic !== "browse") win.requestAnimationFrame(() => start(topic));
    },
    cancel() { pendingKey = null; win.cancelAnimationFrame(autoFrame); end(null); },
    refreshLanguage() {
      toolbar?.refreshLanguage();
      if (tour && language !== getContext().locale) {
        language = getContext().locale;
        const config = tour.getConfig();
        // Keep the current Settings dialog and scenario alive during preview.
        // Destroying/restarting would close owned dialogs and cancel the preview.
        tour.setConfig({ ...config,
          nextBtnText: text(GUIDE_COPY.next), prevBtnText: text(GUIDE_COPY.back), doneBtnText: text(GUIDE_COPY.done),
          steps: config.steps.map((item, index) => ({ ...item,
            popover: { ...item.popover, title: text(activeItems[index].title), description: text(activeItems[index].text) } })),
        });
        tour.drive(tour.getActiveIndex());
      }
    },
  };
  return controls;
}
