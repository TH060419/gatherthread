/** Private cloud repository tasks. No provider or GitHub credentials enter this module. */
export function mountCloudGithub({ api: getApi, context, t, setText = (node, source) => { node.textContent = t(source); }, agentEnabled = false, openSurface = () => {}, document: doc = document }) {
  const el = (id) => doc.getElementById(id);
  const dialog = el("project-code-dialog");
  let generation = 0, selected = null, taskRows = [], key = "", pending = false, bindingKey;
  const message = (value) => setText(el("cloud-github-error"), value);
  function appendLabel(parent, source, raw = false) {
    const span = doc.createElement("span");
    if (raw) { span.setAttribute("data-i18n-skip", ""); span.textContent = source; }
    else setText(span, source);
    parent.append(span);
  }
  async function action(fn) {
    if (pending) return;
    pending = true; message("");
    const gen = generation;
    try { await fn(); } catch (error) { if (gen === generation) message(error.message); }
    finally { pending = false; }
  }
  function clear() {
    generation++; selected = null; taskRows = []; bindingKey = undefined;
    el("cloud-github-parent").value = ""; el("cloud-github-selected").textContent = "";
    el("cloud-github-changes").replaceChildren(); el("cloud-github-task-list").replaceChildren();
    el("cloud-github-pr-form").hidden = true; el("cloud-github-delete").disabled = true;
    el("cloud-github-continue").disabled = true;
    for (const id of ["cloud-github-status", "cloud-github-error", "cloud-github-task-status", "cloud-github-answer"]) el(id).textContent = "";
    el("cloud-github-repository").value = ""; el("cloud-github-base").value = "main";
    el("cloud-github-pr-title").value = ""; el("cloud-github-pr-body").value = "";
    el("cloud-github-pr-link").hidden = true; el("cloud-github-pr-link").removeAttribute("href");
    el("cloud-github-controls").hidden = true;
  }
  function updateContext() {
    const c = context(), next = `${c.userId ?? ""}:${c.projectId ?? ""}:${c.sessionId ?? ""}`;
    if (next !== key) { key = next; clear(); if (dialog.open) dialog.close(); }
    const available = Boolean(c.userId && c.projectId && c.sessionId);
    el("cloud-github-new").disabled = !agentEnabled || !available;
  }
  function appendSource(parent, base64) {
    const pre = doc.createElement("pre");
    parent.append(pre);
    if (base64 === null) { setText(pre, "File absent"); return; }
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      pre.setAttribute("data-i18n-skip", ""); pre.textContent = value.slice(0, 20000);
      if (value.length > 20000) {
        const note = doc.createElement("p"); setText(note, "Preview truncated"); parent.append(note);
      }
    } catch { setText(pre, "Binary file changed"); }
  }
  function renderTask(task) {
    const sameRevision = selected?.id === task.id && selected?.revision === task.revision;
    selected = task;
    const status = el("cloud-github-task-status"); status.replaceChildren();
    appendLabel(status, task.repository, true); status.append(doc.createTextNode(" · "));
    appendLabel(status, task.state);
    if (task.error_code) {
      status.append(doc.createTextNode(" · "));
      appendLabel(status, "Review the project setup and reconnect GitHub if needed.");
    }
    el("cloud-github-answer").setAttribute("data-i18n-skip", "");
    el("cloud-github-answer").textContent = task.answer ?? "";
    el("cloud-github-changes").replaceChildren();
    for (const change of task.changes) {
      const details = doc.createElement("details"), summary = doc.createElement("summary");
      const path = doc.createElement("span");
      path.setAttribute("data-i18n-skip", ""); path.textContent = change.path;
      summary.append(path);
      if (change.before_executable !== change.after_executable) {
        const note = doc.createElement("span"); setText(note, "File mode changed");
        summary.append(doc.createTextNode(" · "), note);
      }
      details.append(summary);
      for (const [label, source] of [["Before", change.before_base64], ["After", change.after_base64]]) {
        const heading = doc.createElement("h4"); setText(heading, label); details.append(heading);
        appendSource(details, source);
      }
      el("cloud-github-changes").append(details);
    }
    const link = el("cloud-github-pr-link");
    link.hidden = !task.pull_request_url;
    if (task.pull_request_url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/u.test(task.pull_request_url)) link.href = task.pull_request_url;
    else link.removeAttribute("href");
    el("cloud-github-pr-form").hidden = task.state !== "completed" || !task.changes.length || Boolean(task.pull_request_url);
    if (!sameRevision) {
      el("cloud-github-pr-title").value = "GatherThread: cloud coding changes";
      el("cloud-github-pr-body").value = (task.answer ?? "").slice(0, 6000);
    }
    el("cloud-github-continue").disabled = !agentEnabled || !task.resumable;
    el("cloud-github-delete").disabled = task.state === "running";
  }
  async function refresh() {
    updateContext(); const c = context(), gen = generation;
    if (!c.projectId) return;
    const status = await getApi().getHostedGithubStatus(c.projectId);
    if (gen !== generation) return;
    const statusNode = el("cloud-github-status"); statusNode.replaceChildren();
    if (!status.enabled) setText(statusNode, "Cloud GitHub is not enabled on this server.");
    else if (!status.connected) setText(statusNode, "Connect your GitHub account");
    else {
      appendLabel(statusNode, status.login, true); statusNode.append(doc.createTextNode(" · "));
      appendLabel(statusNode, status.binding?.repository ?? "Choose a repository", Boolean(status.binding));
    }
    el("cloud-github-controls").hidden = !status.enabled;
    if (!status.enabled) return;
    const install = el("cloud-github-install");
    if (/^https:\/\/github\.com\/apps\/[A-Za-z0-9_.-]+\/installations\/new$/u.test(status.installation_url)) install.href = status.installation_url;
    el("cloud-github-repository-form").hidden = !status.connected;
    el("cloud-github-disconnect").hidden = !status.connected;
    const nextBinding = JSON.stringify(status.binding ?? null);
    if (bindingKey !== nextBinding) {
      bindingKey = nextBinding;
      el("cloud-github-repository").value = status.binding?.repository ?? "";
      el("cloud-github-base").value = status.binding?.base_branch ?? "main";
    }
    const { tasks } = await getApi().listHostedGithubTasks(c.projectId);
    if (gen !== generation) return;
    taskRows = tasks;
    el("cloud-github-task-list").replaceChildren();
    for (const task of tasks.filter((item) => item.session_id === undefined || item.session_id === c.sessionId)) {
      const button = doc.createElement("button"); button.type = "button"; button.className = "text-button";
      appendLabel(button, task.repository, true); button.append(doc.createTextNode(" · "));
      appendLabel(button, task.state); button.append(doc.createTextNode(" · "));
      appendLabel(button, task.id.slice(-8), true);
      button.addEventListener("click", () => void action(async () => { const detail = await getApi().getHostedGithubTask(task.id); if (gen === generation) renderTask(detail); })); el("cloud-github-task-list").append(button);
    }
    if (selected) { const detail = await getApi().getHostedGithubTask(selected.id); if (gen === generation) renderTask(detail); }
  }
  el("cloud-github-refresh").addEventListener("click", () => void action(refresh));
  el("cloud-github-authorize").addEventListener("click", () => void action(async () => {
    const gen = generation;
    const { authorization_url } = await getApi().authorizeHostedGithub();
    if (gen !== generation) return;
    const url = new URL(authorization_url);
    if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") throw new Error("Invalid GitHub authorization URL");
    window.location.assign(url.href);
  }));
  el("cloud-github-repository-form").addEventListener("submit", (event) => {
    event.preventDefault(); void action(async () => {
      const gen = generation;
      await getApi().bindHostedGithub(context().projectId, { repository: el("cloud-github-repository").value.trim(), base_branch: el("cloud-github-base").value.trim() });
      if (gen !== generation) return;
      clear(); await refresh();
    });
  });
  el("cloud-github-disconnect").addEventListener("click", () => void action(async () => {
    const gen = generation;
    await getApi().disconnectHostedGithub(); if (gen !== generation) return;
    clear(); await refresh();
  }));
  el("cloud-github-pr-form").addEventListener("submit", (event) => {
    event.preventDefault(); const task = selected; if (!task) return;
    void action(async () => {
      const gen = generation;
      const result = await getApi().publishHostedGithub(task.id, { title: el("cloud-github-pr-title").value,
        body: el("cloud-github-pr-body").value, expected_revision: task.revision });
      if (gen !== generation) return;
      renderTask(result); await refresh();
    });
  });
  function chooseRepository() {
    if (!agentEnabled) { message("Cloud Agent · coming later"); return false; }
    el("agent-harness-select").value = "cloud";
    el("agent-harness-select").dispatchEvent(new Event("change", { bubbles: true }));
    el("cloud-agent-source").value = "github";
    el("cloud-agent-source").dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  el("cloud-github-continue").addEventListener("click", () => {
    if (!agentEnabled) { message("Cloud Agent · coming later"); return; }
    if (!selected) return;
    const models = el("agent-cloud-model-select");
    if (![...models.options].some((option) => option.value === selected.profile_id)) {
      message("The original cloud model is no longer available."); return;
    }
    if (!chooseRepository()) return;
    models.value = selected.profile_id;
    models.dispatchEvent(new Event("change", { bubbles: true }));
    el("cloud-github-parent").value = selected.id;
    const selectedLabel = el("cloud-github-selected"); selectedLabel.replaceChildren();
    appendLabel(selectedLabel, "Continue task"); selectedLabel.append(doc.createTextNode(": "));
    appendLabel(selectedLabel, selected.id.slice(-8), true);
    dialog.close(); el("message-input").focus();
  });
  el("cloud-github-new").addEventListener("click", () => {
    if (!chooseRepository()) return;
    el("cloud-github-parent").value = ""; setText(el("cloud-github-selected"), "New repository task");
    dialog.close(); el("message-input").focus();
  });
  el("cloud-github-delete").addEventListener("click", () => void action(async () => {
    if (!selected) return; const gen = generation;
    await getApi().deleteHostedGithubTask(selected.id); if (gen !== generation) return;
    clear(); await refresh();
  }));
  const poll = setInterval(() => { if (dialog.open && !el("code-github-panel").hidden && !doc.hidden && taskRows.some((task) => task.state === "running")) void action(refresh); }, 5000);
  window.addEventListener("pagehide", () => clearInterval(poll), { once: true });
  return {
    updateContext,
    refresh: () => action(refresh),
    async openTask(id) {
      updateContext(); const gen = generation;
      if (!context().sessionId) return;
      openSurface();
      await action(async () => { await refresh(); const task = await getApi().getHostedGithubTask(id);
        if (gen === generation) renderTask(task); });
    },
    async start(sessionId, input) {
      if (!agentEnabled) throw new Error("Cloud Agent · coming later");
      updateContext(); const gen = generation;
      const task = await getApi().startHostedGithubTask(sessionId, { content: input.content, profile_id: input.profileId,
        idempotency_key: input.idempotencyKey, reply_to_event_id: input.replyTo ?? null,
        ...(el("cloud-github-parent").value ? { continue_task_id: el("cloud-github-parent").value } : {}) });
      if (gen === generation && context().sessionId === sessionId) {
        el("cloud-github-parent").value = ""; setText(el("cloud-github-selected"), "New repository task");
        selected = task;
      }
      return task;
    },
    async completeAuthorization() {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      if (!hash.has("github_code")) return;
      const input = { code: hash.get("github_code"), state: hash.get("github_state") };
      history.replaceState(null, "", window.location.pathname + window.location.search);
      await action(async () => { await getApi().completeHostedGithub(input); });
    },
  };
}
