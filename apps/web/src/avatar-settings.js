import { AVATAR_CATALOG, renderAvatar } from "./avatars.js";

export function mountAvatarSettings({ document, api, localizer, getUser, getRevision = () => 0, onSaved }) {
  const el = (id) => document.getElementById(id);
  const t = (text) => localizer.t(text);
  let generation = 0;
  let selected = null;
  let saved = null;
  let busy = false;
  const status = el("settings-avatar-status");
  const save = el("settings-avatar-save");
  const cancel = el("settings-avatar-cancel");

  function controls() {
    const user = getUser();
    renderAvatar(document, el("settings-avatar-preview"), { userId: user?.id, username: user?.username, avatarId: selected });
    save.disabled = busy || !user || selected === saved;
    cancel.disabled = busy || selected === saved;
    save.textContent = t(busy ? "Saving avatar…" : "Save avatar");
  }

  function render() {
    const user = getUser();
    const grid = el("settings-avatar-grid");
    grid.replaceChildren();
    for (const entry of [{ id: null, label: "Use initials" }, ...AVATAR_CATALOG]) {
      const label = document.createElement("label");
      label.className = "avatar-choice";
      label.classList.toggle("is-selected", selected === entry.id);
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "account-avatar";
      input.value = entry.id ?? "";
      input.checked = selected === entry.id;
      input.disabled = busy;
      input.addEventListener("change", () => {
        selected = entry.id;
        status.textContent = "";
        for (const choice of grid.children) choice.classList.toggle("is-selected", choice.children[0].checked);
        controls(); // Keep the focused radio in place for native arrow-key navigation.
      });
      const avatar = document.createElement("span");
      renderAvatar(document, avatar, { userId: user?.id, username: user?.username, avatarId: entry.id });
      const caption = document.createElement("span");
      caption.textContent = t(entry.label);
      label.append(input, avatar, caption);
      grid.append(label);
    }
    controls();
  }

  async function load() {
    const user = getUser();
    const revision = getRevision();
    const request = ++generation;
    busy = true;
    selected = saved = user?.avatar_id ?? null;
    status.textContent = t("Loading avatar…");
    render();
    try {
      const profile = await api.getAccountAvatar();
      if (request !== generation || user !== getUser() || !el("settings-dialog").open) return;
      if (profile.user_id !== user?.id) throw new Error(t("Unable to load avatar. Reopen Settings to retry."));
      if (revision !== getRevision()) {
        selected = saved = user?.avatar_id ?? null;
        status.textContent = "";
        return;
      }
      selected = saved = profile.avatar_id;
      onSaved(profile);
      status.textContent = "";
    } catch {
      if (request !== generation || user !== getUser() || !el("settings-dialog").open) return;
      status.textContent = t("Unable to load avatar. Reopen Settings to retry.");
    } finally {
      if (request === generation && user === getUser()) { busy = false; render(); }
    }
  }

  save.addEventListener("click", async () => {
    if (save.disabled) return;
    const user = getUser();
    const request = ++generation;
    const desired = selected;
    busy = true;
    status.textContent = "";
    render();
    try {
      const profile = await api.setAccountAvatar(desired);
      if (request !== generation || user !== getUser() || !el("settings-dialog").open) return;
      if (profile.user_id !== user.id) throw new Error("Account changed");
      saved = selected = profile.avatar_id;
      onSaved(profile);
      status.textContent = t("Avatar saved for your account.");
    } catch {
      if (request === generation && user === getUser() && el("settings-dialog").open) status.textContent = t("Could not save avatar. Try again.");
    } finally {
      if (request === generation && user === getUser()) { busy = false; render(); }
    }
  });
  cancel.addEventListener("click", () => { selected = saved; status.textContent = ""; render(); });
  el("settings-dialog").addEventListener("close", reset);
  function reset() { generation += 1; busy = false; selected = saved = null; }
  return { load, reset, render };
}
