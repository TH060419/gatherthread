export function mountDeviceAuthorization({ document, api, localizer, scope }) {
  const get = (id) => document.getElementById(id);
  const button = get("authorize-codex-device");
  const copy = get("copy-codex-authorization");
  const value = get("codex-device-authorization");
  const status = get("codex-authorization-status");
  let generation = 0, pendingId = null, timer;
  const revoke = (id) => { if (id) void api.revokeDeviceAuthorization(id).catch(() => {}); };
  const clear = () => {
    generation += 1; clearTimeout(timer); revoke(pendingId); pendingId = null;
    value.value = ""; get("codex-authorization-result").hidden = true;
    status.textContent = ""; button.disabled = false; copy.disabled = true;
  };
  button.addEventListener("click", async () => {
    clear(); const run = generation; const currentScope = scope();
    button.disabled = true;
    try {
      const result = await api.createDeviceAuthorization();
      if (run !== generation || currentScope !== scope()) { revoke(result.authorization.id); return; }
      pendingId = result.authorization.id; value.value = result.authorization_token;
      get("codex-authorization-result").hidden = false; copy.disabled = false;
      status.textContent = localizer.t("One use within 10 minutes. Paste into the connector's hidden prompt or Launcher. Do not save or share it.");
      timer = setTimeout(clear, Math.max(0, Date.parse(result.authorization.expires_at) - Date.now()));
    } catch { if (run === generation && currentScope === scope()) status.textContent = localizer.t("Device authorization unavailable. Try again."); }
    finally { if (run === generation && currentScope === scope()) button.disabled = false; }
  });
  copy.addEventListener("click", async () => {
    const run = generation;
    try { await globalThis.navigator.clipboard.writeText(value.value);
      if (run === generation) status.textContent = localizer.t("Authorization copied. Use it once in the connector within 10 minutes.");
    } catch { if (run === generation) { value.focus(); value.select(); status.textContent = localizer.t("Copy unavailable. Select and copy the authorization manually."); } }
  });
  return { clear };
}
