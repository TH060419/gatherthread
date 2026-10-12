import { normalizeLauncherEmail, projectCodexLauncherUrl } from "./domain.js?v=20261012-content-1";

const EMAIL_HINT_KEY = "gt-account-email-hint";
const optionalStorage = (name) => { try { return globalThis[name]; } catch { return null; } };

/** One exact, bounded same-origin source index; never an arbitrary download URL. */
export async function currentAgentDownloadIndex(fetchResponse = globalThis.fetch) {
  if (typeof fetchResponse !== "function") return null;
  let reader;
  try {
    const response = await fetchResponse("/downloads/launcher.json", { cache: "no-store", redirect: "error",
      credentials: "same-origin", signal: AbortSignal.timeout(2000) });
    if (response.status !== 200 || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")
      || Number(response.headers.get("content-length")) > 2048 || !response.body) return null;
    reader = response.body.getReader();
    let bytes = 0, text = ""; const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 2048) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const manifest = JSON.parse(text);
    if (!manifest || Array.isArray(manifest) || Object.keys(manifest).sort().join(",") !== "index_path,source_commit"
      || typeof manifest.source_commit !== "string" || manifest.source_commit.length !== 40 || !/^[a-f0-9]{40}$/u.test(manifest.source_commit)
      || manifest.index_path !== `/downloads/${manifest.source_commit}/index.html`) return null;
    return manifest.index_path;
  } catch { return null; }
  finally { try { await reader?.cancel(); } catch {} }
}

/** Advanced terminal setup shares the Launcher's index, not the old registry build. */
export function mountAgentPackageDownloads({ document, localizer, fetchResponse = globalThis.fetch }) {
  const versions = new Map();
  const nodes = new Map(["codex", "dsh"].map(kind => {
    const node = document.getElementById(`connect-${kind}-package-download`);
    return [kind, { node, fallback: node?.getAttribute("href") }];
  }));
  const close = kind => versions.set(kind, (versions.get(kind) ?? 0) + 1);
  return { close, clear() { for (const kind of nodes.keys()) close(kind); }, async open(kind) {
    close(kind); const run = versions.get(kind), entry = nodes.get(kind);
    if (!entry?.node) return;
    entry.node.href = entry.fallback;
    localizer.setText(entry.node, "Source-checkout instructions");
    const index = await currentAgentDownloadIndex(fetchResponse);
    if (run !== versions.get(kind) || !index) return;
    entry.node.href = index;
    localizer.setText(entry.node, "Download packages for this server");
  } };
}

// A non-secret login hint, never a password or a credential. Bound to the
// authenticated actor so a shared browser cannot prefill another account.
export function createAccountEmailHint({ sessionStorage = optionalStorage("sessionStorage"),
  localStorage = optionalStorage("localStorage"), now = Date.now } = {}) {
  let memory = null;
  const readStorage = store => {
    try {
      const raw = store?.getItem(EMAIL_HINT_KEY);
      const record = raw && raw.length <= 2048 ? JSON.parse(raw) : null;
      if (raw && (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now())) {
        store?.removeItem(EMAIL_HINT_KEY); return null;
      }
      return record;
    }
    catch { return null; }
  };
  const valid = (record, userId) => record?.userId === userId && Number.isFinite(record.expiresAt) && record.expiresAt > now();
  return {
    read(userId) {
      for (const record of [memory, readStorage(sessionStorage), readStorage(localStorage)]) {
        if (!valid(record, userId)) continue;
        try { return normalizeLauncherEmail(record.email); } catch { /* Discard untrusted hints. */ }
      }
      return "";
    },
    remember(userId, email, rememberDevice) {
      if (!userId) return;
      const normalized = normalizeLauncherEmail(email), started = now();
      memory = { userId, email: normalized, expiresAt: started + 86400_000 };
      try { sessionStorage?.setItem(EMAIL_HINT_KEY, JSON.stringify(memory)); } catch { /* Private mode is supported. */ }
      try {
        if (rememberDevice) localStorage?.setItem(EMAIL_HINT_KEY, JSON.stringify({ ...memory, expiresAt: started + 30 * 86400_000 }));
        else localStorage?.removeItem(EMAIL_HINT_KEY);
      } catch { /* No credential storage is required. */ }
    },
    clear(userId) {
      if (!userId || memory?.userId === userId) memory = null;
      for (const store of [sessionStorage, localStorage]) {
        const record = readStorage(store);
        if (!userId || record?.userId === userId) { try { store?.removeItem(EMAIL_HINT_KEY); } catch {} }
      }
    },
  };
}

export function mountCodexLauncher({ document, api, localizer, emailHint, context,
  platform = globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? "",
  fetchResponse = globalThis.fetch,
  navigate = uri => { globalThis.location.href = uri; } }) {
  const get = id => document.getElementById(id);
  const button = get("open-codex-launcher-button"), prepareButton = get("prepare-codex-launcher-button");
  const email = get("codex-launcher-email"), status = get("codex-launcher-status");
  const macInstall = get("codex-launcher-macos-install");
  if (macInstall) macInstall.hidden = !/^mac/i.test(platform);
  const grants = new Map();
  let generation = 0, downloadGeneration = 0, prepared = null;
  const download = get("download-codex-launcher-button"), releaseFallback = download?.href;
  const readDownloads = async () => {
    const run = downloadGeneration;
    if (!download || typeof fetchResponse !== "function") return;
    download.href = releaseFallback;
    const index = await currentAgentDownloadIndex(fetchResponse);
    if (index && run === downloadGeneration) download.href = index;
  };
  const tell = value => { status.textContent = localizer.t(value); };
  const revoke = id => { void api.revokeDeviceAuthorization(id).catch(() => {}); };
  const invalidate = ({ keepOpened = false } = {}) => {
    generation++; prepared = null; button.disabled = true; prepareButton.disabled = false;
    for (const [id, grant] of grants) {
      if (keepOpened && grant.opened && grant.scope === context()?.scope) continue;
      clearTimeout(grant.timer); grants.delete(id); revoke(id);
    }
  };
  const clear = () => { downloadGeneration++; invalidate(); email.value = ""; status.textContent = ""; };
  const close = () => { downloadGeneration++; invalidate({ keepOpened: true }); status.textContent = ""; };
  const prepare = async () => {
    invalidate({ keepOpened: true });
    const run = generation, current = context();
    if (!current?.userId || !current.projectId) return;
    let enteredEmail;
    try { enteredEmail = normalizeLauncherEmail(email.value); }
    catch { tell("Enter the email you use to sign in, then confirm it."); return; }
    prepareButton.disabled = true; tell("Preparing your Launcher connection…");
    let issuedId = null;
    try {
      const result = await api.createCodexLauncherAuthorization({ project_id: current.projectId, email: enteredEmail });
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result?.authorization?.id ?? "")) {
        issuedId = result.authorization.id;
      }
      if (run !== generation || current.scope !== context()?.scope) {
        if (issuedId) revoke(issuedId);
        issuedId = null; return;
      }
      const expires = Date.parse(result.authorization.expires_at);
      if (normalizeLauncherEmail(result.email) !== enteredEmail || !Number.isFinite(expires) || expires <= Date.now()) {
        throw new Error("Invalid handoff");
      }
      const uri = projectCodexLauncherUrl({ ...current, email: result.email, authorizationId: result.authorization.id });
      prepared = { uri, scope: current.scope, id: result.authorization.id };
      const grant = { opened: false, scope: current.scope, timer: null };
      grant.timer = setTimeout(() => {
        grants.delete(result.authorization.id); revoke(result.authorization.id);
        if (prepared?.id === result.authorization.id) {
          prepared = null; button.disabled = true; tell("Connection expired. Close this dialog and open it again.");
        }
      }, Math.min(600_000, expires - Date.now()));
      grant.timer.unref?.(); grants.set(result.authorization.id, grant);
      if (emailHint.read(current.userId) !== enteredEmail) emailHint.remember(current.userId, enteredEmail, false);
      get("codex-launcher-email-row").hidden = true;
      get("codex-launcher-account").textContent = enteredEmail;
      button.disabled = false;
      tell("Email is ready. Open the Launcher and enter your password there.");
    } catch {
      if (issuedId && !grants.has(issuedId)) revoke(issuedId);
      if (run === generation && current.scope === context()?.scope) {
        get("codex-launcher-email-row").hidden = false;
        tell("Unable to prepare the connection. Check your account email and try again.");
      }
    } finally { if (run === generation) prepareButton.disabled = false; }
  };
  button.disabled = true;
  button.addEventListener("click", () => {
    if (!prepared || prepared.scope !== context()?.scope || !grants.has(prepared.id)) return;
    try {
      navigate(prepared.uri); grants.get(prepared.id).opened = true;
      tell("Enter your password in the Launcher. If it did not open, install the current Launcher first.");
    } catch { tell("Unable to open the Launcher. Install the current Launcher and try again."); }
  });
  prepareButton.addEventListener("click", () => void prepare());
  email.addEventListener("input", () => invalidate({ keepOpened: true }));
  return { clear, close, async open() {
    close(); const current = context(); if (!current) return;
    const downloads = readDownloads();
    email.value = emailHint.read(current.userId);
    get("codex-launcher-email-row").hidden = Boolean(email.value);
    get("codex-launcher-account").textContent = email.value;
    if (email.value) await prepare();
    else tell("Enter the email you use to sign in, then confirm it.");
    await downloads;
  } };
}
