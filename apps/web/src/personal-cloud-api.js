// Account-private metadata only. Keys are write-only, never saved in browser storage.
export function mountPersonalCloudApi({ document, api, localizer, getContext, makeId = () => crypto.randomUUID(),
  confirm = () => false, onChanged = () => {} }) {
  const el = id => document.getElementById(`cloud-api-${id}`);
  const controls = ["refresh", "new", "save", "cancel", "delete", "provider", "label", "model", "key", "enabled"];
  let generation = 0, busy = false, snapshot = null, selected = null, draftId = null, scope = null, statusSource = "";
  const translations = [];
  const current = (run, context) => run === generation && getContext()?.scope === context.scope;
  const setStatus = value => { statusSource = value; el("status").textContent = localizer.t(value); };
  const setBusy = value => {
    busy = value;
    for (const id of controls) el(id).disabled = value || snapshot?.enabled === false && !["refresh", "cancel"].includes(id);
  };
  const node = (tag, value, translated = false) => {
    const result = document.createElement(tag); result.setAttribute("data-i18n-skip", "");
    const update = () => { result.textContent = translated ? localizer.t(value) : value; };
    if (translated) translations.push(update);
    update(); return result;
  };
  function cancelEdit() {
    selected = null; draftId = null; el("key").value = ""; el("editor").hidden = true;
    for (const id of ["label", "model"]) el(id).value = "";
  }
  function clear() {
    generation++; scope = null; snapshot = null; translations.length = 0;
    el("list").replaceChildren(); el("provider").replaceChildren(); el("endpoint").textContent = "";
    el("docs").removeAttribute("href"); cancelEdit(); setStatus(""); setBusy(false);
  }
  function refreshProvider() {
    const provider = snapshot?.providers.find(item => item.id === el("provider").value);
    el("endpoint").textContent = provider?.base_url ?? "";
    el("docs").removeAttribute("href");
    if (provider) {
      try {
        const url = new URL(provider.docs_url);
        if (url.protocol === "https:" && !url.username && !url.password) el("docs").href = url.href;
      } catch { /* Invalid provider metadata never becomes a navigation link. */ }
    }
  }
  function edit(configuration = null) {
    if (busy || !snapshot?.enabled || !getContext() || getContext().scope !== scope) return;
    selected = configuration; draftId = configuration?.id ?? makeId();
    el("provider").value = configuration?.provider_id ?? snapshot.providers[0]?.id ?? "";
    el("label").value = configuration?.label ?? ""; el("model").value = configuration?.model ?? "";
    el("enabled").checked = configuration?.enabled ?? true;
    el("key").value = ""; el("key").placeholder = localizer.t(configuration
      ? "Leave blank to keep the saved key" : "Paste your provider API key");
    el("delete").hidden = !configuration; el("editor").hidden = false;
    refreshProvider(); setStatus(""); el("provider").focus();
  }
  function render() {
    translations.length = 0; el("list").replaceChildren(); el("provider").replaceChildren();
    for (const provider of snapshot.providers) {
      const option = node("option", provider.label); option.value = provider.id; el("provider").append(option);
    }
    for (const configuration of snapshot.configurations) {
      const row = node("li", ""); row.className = "account-device-row";
      const details = node("div", ""); details.className = "account-device-details";
      details.append(node("strong", configuration.label), node("small", configuration.model),
        node("small", configuration.enabled ? "Enabled" : "Paused", true));
      const button = node("button", "Edit API connection", true); button.type = "button"; button.className = "text-button";
      button.addEventListener("click", () => edit(configuration)); row.append(details, button); el("list").append(row);
    }
  }
  async function load() {
    const context = getContext(); if (!context) { clear(); return; }
    if (scope && scope !== context.scope) clear();
    if (busy) return;
    scope = context.scope; const run = ++generation;
    cancelEdit(); el("list").replaceChildren(); setBusy(true); setStatus("Loading personal API connections…");
    try {
      const result = await api.getCloudApi(); if (!current(run, context)) return;
      snapshot = result; render(); setStatus(result.enabled ? result.configurations.length ? "" : "Add your first API connection."
        : "Personal API connections are not enabled on this server.");
    } catch {
      if (current(run, context)) setStatus("Could not load API connections. Refresh and try again.");
    } finally { if (current(run, context)) setBusy(false); }
  }
  async function save() {
    const context = getContext(); if (busy || !snapshot?.enabled || !context || context.scope !== scope) return;
    const key = el("key").value.trim(); el("key").value = "";
    const model = el("model").value.trim(), label = el("label").value.trim(), providerId = el("provider").value;
    if (!snapshot.providers.some(item => item.id === providerId) || !label || label.length > 80 || !model || model.length > 160
      || /[\u0000-\u0020\u007f-\u009f]/u.test(model) || /[\u0000-\u001f\u007f-\u009f]/u.test(label)
      || !selected && !key || key && (key.length < 8 || key.length > 4096 || /[^\x21-\x7e]/u.test(key))) {
      setStatus("Choose a provider, model and label; a new connection also needs an API key."); return;
    }
    const run = generation, id = draftId;
    const input = { expected_revision: selected?.revision ?? null, provider_id: providerId, label, model,
      enabled: el("enabled").checked, ...(key ? { api_key: key } : {}) };
    if (selected && selected.provider_id !== providerId && !key) {
      setStatus("Changing provider requires a new API key."); return;
    }
    setBusy(true); setStatus("Saving API connection…");
    try {
      await api.putCloudApi(id, input); if (!current(run, context)) return;
      onChanged(); setBusy(false); await load();
    } catch (error) {
      if (current(run, context)) setStatus(error?.code === "cloud_api_changed"
        ? "This API connection changed. Refresh before editing."
        : "Could not save this API connection. Refresh and try again.");
    } finally { if (current(run, context)) setBusy(false); }
  }
  async function remove() {
    const context = getContext(); if (busy || !selected || !context || context.scope !== scope) return;
    const run = generation, configuration = selected;
    if (!confirm(localizer.t("Delete this API connection? New requests using it will stop, and the saved key will be removed."))
      || !current(run, context)) return;
    el("key").value = ""; setBusy(true); setStatus("Deleting API connection…");
    try {
      await api.deleteCloudApi(configuration.id, { expected_revision: configuration.revision });
      if (!current(run, context)) return;
      onChanged(); setBusy(false); await load();
    } catch { if (current(run, context)) setStatus("Could not delete this API connection. Refresh and try again."); }
    finally { if (current(run, context)) setBusy(false); }
  }
  el("refresh").addEventListener("click", () => void load()); el("new").addEventListener("click", () => edit());
  el("save").addEventListener("click", () => void save()); el("delete").addEventListener("click", () => void remove());
  el("cancel").addEventListener("click", () => { if (!busy) { cancelEdit(); setStatus(""); el("new").focus(); } });
  el("provider").addEventListener("change", () => { el("key").value = ""; refreshProvider(); });
  return { load, clear, refreshLanguage() {
    for (const update of translations) update(); setStatus(statusSource);
    if (!el("editor").hidden) el("key").placeholder = localizer.t(selected ? "Leave blank to keep the saved key" : "Paste your provider API key");
  } };
}
