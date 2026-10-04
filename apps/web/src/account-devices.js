// Browser sessions and native Agent credentials share an account, not a login token.
export function mountAccountDevices({ document, api, localizer, getContext, confirm, onRevoked = () => {} }) {
  const list = document.getElementById("settings-devices-list");
  const status = document.getElementById("settings-devices-status");
  const refresh = document.getElementById("settings-devices-refresh");
  let generation = 0, busy = false, statusSource = "";
  const translations = [];
  status.setAttribute("data-i18n-skip", "");
  const setStatus = source => { statusSource = source; status.textContent = localizer.t(source); };
  const refreshLanguage = () => { for (const update of translations) update(); setStatus(statusSource); };
  const current = (run, context) => run === generation && getContext()?.scope === context.scope;
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const uiText = (tag, source, className) => {
    const node = text(tag, "", className);
    node.setAttribute("data-i18n-skip", "");
    const update = () => { node.textContent = localizer.t(source); };
    translations.push(update); update();
    return node;
  };
  const buttons = [];
  const setBusy = value => { busy = value; refresh.disabled = value; for (const button of buttons) button.disabled = value; };
  const restoreFocus = (button, wasFocused) => {
    if (wasFocused && (document.activeElement === document.body || document.activeElement === button)) {
      button.focus({ preventScroll: true });
    }
  };
  const clear = () => {
    generation++;
    list.replaceChildren(); buttons.length = 0; translations.length = 0; setStatus(""); setBusy(false);
  };
  const load = async () => {
    if (busy) return;
    const context = getContext();
    if (!context) return;
    const run = ++generation;
    const wasFocused = document.activeElement === refresh;
    list.replaceChildren(); buttons.length = 0; translations.length = 0;
    setStatus("Loading account devices…");
    setBusy(true);
    try {
      const devices = await api.listDevices();
      if (!current(run, context)) return;
      for (const device of devices.filter(item => item.user_id === context.userId)) {
        const row = text("li", "", "account-device-row");
        const details = text("div", "", "account-device-details");
        const name = text("strong", device.name);
        name.setAttribute("translate", "no"); name.setAttribute("data-i18n-skip", "");
        const expired = device.expires_at && Date.parse(device.expires_at) <= Date.now();
        const label = device.id === context.deviceId ? "This browser" : device.revoked_at ? "Access revoked" : expired ? "Access expired" : "Authorized device";
        details.append(name, uiText("small", label));
        if (device.last_used_at) {
          const date = new Date(device.last_used_at);
          if (Number.isFinite(date.getTime())) {
            const lastUsed = text("small", ""); lastUsed.setAttribute("data-i18n-skip", "");
            const update = () => { lastUsed.textContent = `${localizer.t("Last used")}: ${date.toLocaleString(document.documentElement?.lang || undefined)}`; };
            translations.push(update); update(); details.append(lastUsed);
          }
        }
        row.append(details);
        if (device.id !== context.deviceId && !device.revoked_at && !expired) {
          const button = uiText("button", "Revoke access", "text-button danger-text-button");
          button.type = "button"; button.dataset.deviceId = device.id;
          const updateAria = () => button.setAttribute("aria-label", localizer.t("Revoke access for {device}").replace("{device}", () => device.name));
          translations.push(updateAria); updateAria();
          button.addEventListener("click", async () => {
            if (busy || !current(run, context)) return;
            const wasFocused = document.activeElement === button;
            const warning = localizer.t("Revoke access for {device}? This signs out that browser and stops any Agent authorized on that device. Your other devices stay connected.").replace("{device}", () => device.name);
            if (!confirm(warning) || !current(run, context)) return;
            setBusy(true); setStatus("");
            try {
              await api.revokeDevice(device.id);
              if (!current(run, context)) return;
              onRevoked();
              setBusy(false);
              await load();
              if (current(run + 1, context)) refresh.focus();
            } catch {
              if (current(run, context)) setStatus("Could not revoke device access. Refresh and try again.");
            } finally {
              if (current(run, context)) { setBusy(false); restoreFocus(button, wasFocused); }
            }
          });
          buttons.push(button); row.append(button);
        }
        list.append(row);
      }
      setStatus("");
    } catch {
      if (current(run, context)) setStatus("Unable to load account devices. Refresh and try again.");
    } finally {
      if (current(run, context)) { setBusy(false); restoreFocus(refresh, wasFocused); }
    }
  };
  refresh.addEventListener("click", () => void load());
  return { load, clear, refreshLanguage };
}
