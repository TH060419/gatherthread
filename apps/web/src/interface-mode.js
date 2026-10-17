// Browser presentation only. This preference never grants native-device capability.
export const INTERFACE_MODE_STORAGE_KEY = "gatherthread.interface-mode.v1";
const PREFERENCES = ["auto", "mobile", "desktop"];
const TABLET_MAX_WIDTH = 1366;

export function normalizeInterfacePreference(value) {
  return PREFERENCES.includes(value) ? value : "auto";
}

export function isMobileCandidate(navigator = {}, width = 0, coarsePointer = false) {
  const mobilePlatform = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent ?? "")
    || navigator.userAgentData?.mobile === true
    || (/Mac/i.test(navigator.platform ?? "") && navigator.maxTouchPoints > 1);
  const touchViewport = Number.isFinite(width) && width > 0 && width <= TABLET_MAX_WIDTH
    && coarsePointer === true && navigator.maxTouchPoints > 0;
  return mobilePlatform || touchViewport;
}

export function resolveInterfaceMode(preference) {
  // Detection suggests a choice; it cannot switch the interface without consent.
  return preference === "mobile" ? "mobile" : "desktop";
}

export function createInterfacePreferenceStore(storage) {
  let preference = "auto";
  try {
    preference = normalizeInterfacePreference(storage?.getItem?.(INTERFACE_MODE_STORAGE_KEY));
  } catch {
    // A blocked storage getter/read must not prevent sign-in or layout changes.
  }
  return {
    get: () => preference,
    set(value, { persist = true } = {}) {
      if (!PREFERENCES.includes(value)) throw new RangeError("Unsupported interface preference.");
      preference = value;
      try { if (persist) storage?.setItem?.(INTERFACE_MODE_STORAGE_KEY, value); } catch {
        // Keep the explicit choice for this page if browser storage is unavailable.
      }
      return preference;
    },
  };
}

const CHINESE = {
  "Choose your interface": "选择界面",
  "This may be a phone or tablet. Use the mobile interface?": "你可能正在使用手机或平板，是否切换到移动端界面？",
  "You can change this anytime in Settings → General.": "随时可在「设置 → 通用」中切换。",
  "Use desktop interface": "使用电脑端",
  "Use mobile interface": "使用移动端",
};

/** Mount once, before showing login or the workspace. No reload or account state is used. */
export function mountInterfaceMode({ document: doc, window: win, t = text => text,
  onChange = () => {}, promptEnabled = true }) {
  let storage;
  try { storage = win.localStorage; } catch { /* Some private/embedded browsers deny access. */ }
  const store = createInterfacePreferenceStore(storage);
  const root = doc.documentElement;
  const pointerQuery = win.matchMedia?.("(pointer: coarse)");
  let mode = resolveInterfaceMode(store.get());
  let lastNotifiedPreference = store.get();
  let postponed = false;
  let promptRequested = false;
  let scheduled = false;
  let returnFocus = null;
  root.dataset.interfaceMode = mode;
  root.dataset.interfacePreference = store.get();

  const dialog = doc.createElement("dialog");
  dialog.id = "interface-mode-dialog";
  dialog.className = "interface-mode-dialog";
  dialog.setAttribute("aria-labelledby", "interface-mode-title");
  dialog.setAttribute("aria-describedby", "interface-mode-description interface-mode-help");
  const title = doc.createElement("h2");
  title.id = "interface-mode-title";
  title.tabIndex = -1;
  const description = doc.createElement("p");
  description.id = "interface-mode-description";
  const help = doc.createElement("p");
  help.id = "interface-mode-help";
  help.className = "interface-mode-help";
  const actions = doc.createElement("div");
  actions.className = "interface-mode-actions";
  const desktopButton = doc.createElement("button");
  desktopButton.id = "interface-mode-use-desktop";
  desktopButton.type = "button";
  desktopButton.className = "button button-secondary";
  const mobileButton = doc.createElement("button");
  mobileButton.id = "interface-mode-use-mobile";
  mobileButton.type = "button";
  mobileButton.className = "button button-primary";
  actions.append(desktopButton, mobileButton);
  dialog.append(title, description, help, actions);
  doc.body.append(dialog);

  function translate(text) {
    const translated = t(text);
    return translated !== text ? translated : /^zh/i.test(root.lang) ? CHINESE[text] ?? text : text;
  }

  function refreshLanguage() {
    title.textContent = translate("Choose your interface");
    description.textContent = translate("This may be a phone or tablet. Use the mobile interface?");
    help.textContent = translate("You can change this anytime in Settings → General.");
    desktopButton.textContent = translate("Use desktop interface");
    mobileButton.textContent = translate("Use mobile interface");
  }

  function candidate() {
    return isMobileCandidate(win.navigator, win.innerWidth, pointerQuery?.matches === true);
  }

  function anotherDialogIsOpen() {
    return [...doc.querySelectorAll("dialog[open]")].some(other => other !== dialog);
  }

  function maybePrompt() {
    promptRequested = true;
    if (!promptEnabled || store.get() !== "auto" || postponed || dialog.open || !candidate()
      || root.dataset.bootState || doc.visibilityState === "hidden" || anotherDialogIsOpen()) return false;
    refreshLanguage();
    returnFocus = doc.activeElement;
    try {
      dialog.showModal();
      title.focus({ preventScroll: true });
      return true;
    } catch {
      // Missing/blocked native dialogs must not block the login or workspace.
      return false;
    }
  }

  function schedulePrompt() {
    if (scheduled || !promptRequested) return;
    scheduled = true;
    win.queueMicrotask(() => { scheduled = false; maybePrompt(); });
  }

  function refresh() {
    const preference = store.get();
    const next = resolveInterfaceMode(preference);
    const changed = next !== mode || preference !== lastNotifiedPreference;
    mode = next;
    lastNotifiedPreference = preference;
    root.dataset.interfaceMode = mode;
    root.dataset.interfacePreference = preference;
    refreshLanguage();
    if (changed) onChange(mode, preference);
    return mode;
  }

  function setPreference(preference) {
    store.set(preference);
    postponed = false;
    if (dialog.open) dialog.close();
    const next = refresh();
    if (preference === "auto") {
      promptRequested = true;
      schedulePrompt();
    }
    return next;
  }

  desktopButton.addEventListener("click", () => setPreference("desktop"));
  mobileButton.addEventListener("click", () => setPreference("mobile"));
  dialog.addEventListener("cancel", () => { postponed = true; });
  dialog.addEventListener("close", () => {
    if (dialog.open || anotherDialogIsOpen()) return;
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
  });
  doc.addEventListener("close", event => { if (event.target !== dialog) schedulePrompt(); }, true);
  doc.addEventListener("visibilitychange", schedulePrompt);
  win.addEventListener("resize", schedulePrompt);
  if (pointerQuery?.addEventListener) pointerQuery.addEventListener("change", schedulePrompt);
  else pointerQuery?.addListener?.(schedulePrompt);
  win.addEventListener("storage", event => {
    if (event.key !== INTERFACE_MODE_STORAGE_KEY) return;
    const next = normalizeInterfacePreference(event.newValue);
    store.set(next, { persist: false });
    postponed = false;
    if (dialog.open) dialog.close();
    refresh();
    schedulePrompt();
  });
  const observer = new win.MutationObserver(() => { refreshLanguage(); schedulePrompt(); });
  observer.observe(root, { attributes: true, attributeFilter: ["lang", "data-boot-state"] });
  refreshLanguage();

  return { getPreference: store.get, getMode: () => mode, setPreference, maybePrompt, refresh,
    isMobileCandidate: candidate };
}
