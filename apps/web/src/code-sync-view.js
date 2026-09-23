import { codeErrorText, codeRuntimeChoices, createCodeSyncController } from "./code-sync.js";

const ACTIVE_JOBS = new Set(["queued", "claimed", "importing", "compacting"]);
const shortCommit = (value) => typeof value === "string" ? value.slice(0, 9) : "—";

export function codeBranchAuthor(branch, members = []) {
  return members.find((member) => member.userId === branch.user_id)?.username || branch.name;
}

export function compareCodeSnapshots(base, head) {
  const before = new Map((base?.files ?? []).map((file) => [file.path, file]));
  const after = new Map((head?.files ?? []).map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile?.content_base64 === newFile?.content_base64 && oldFile?.executable === newFile?.executable) return [];
    return [{ path, type: !oldFile ? "Added" : !newFile ? "Deleted" : "Modified", before: oldFile, after: newFile }];
  });
}

export function codeFilePreview(file) {
  if (!file) return "";
  // Decode only a bounded prefix; source is displayed as text, never rendered as HTML.
  const raw = atob(String(file.content_base64 ?? "").slice(0, 32768));
  if (raw.includes("\0")) return null;
  return new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0))).slice(0, 12000);
}

export function mountCodeSync({ document: doc, api, localizer, getContext, mockEnabled = false }) {
  const el = (id) => doc.getElementById(id);
  const dialog = el("project-code-dialog");
  const trigger = el("project-code-button");
  const t = (text) => localizer.t(text);
  let returnFocus;
  let previewGeneration = 0;
  let reviewed;
  let viewProjectId;
  let pendingConfirmation;
  const controller = createCodeSyncController({ api, onChange: render, pollMs: mockEnabled ? 120 : 1800 });
  const routeKey = (state) => JSON.stringify([state.context?.project?.id, state.context?.sessionId, state.context?.userId, state.runtimeId]);

  function finishConfirmation(accepted) {
    const pending = pendingConfirmation;
    pendingConfirmation = null;
    el("code-confirmation").hidden = true;
    pending?.resolve(accepted);
    pending?.focus?.isConnected && pending.focus.focus({ preventScroll: true });
  }

  function confirm(message) {
    finishConfirmation(false);
    el("code-confirmation-message").textContent = message;
    el("code-confirmation").hidden = false;
    const focus = doc.activeElement;
    el("code-confirm-cancel").focus({ preventScroll: true });
    return new Promise((resolve) => { pendingConfirmation = { resolve, focus, route: routeKey(controller.getState()) }; });
  }

  function render(state) {
    const { context, repository, permissions, local, job } = state;
    if (pendingConfirmation && pendingConfirmation.route !== routeKey(state)) finishConfirmation(false);
    trigger.disabled = !context?.project;
    if (viewProjectId !== context?.project?.id) {
      finishConfirmation(false);
      viewProjectId = context?.project?.id;
      previewGeneration += 1;
      reviewed = null;
      el("code-review-preview").hidden = true;
      el("code-review-files").replaceChildren();
    }
    el("code-project-name").textContent = context?.project?.name ?? "";
    el("code-error").textContent = state.error ? t(state.error) : "";
    const enabled = repository?.repository?.enabled === true;
    el("code-repository-status").textContent = t(state.loading ? "Reading code status…" : !repository ? "Code status unavailable" : enabled ? "Git code storage enabled" : "Code storage is not enabled");
    el("code-refresh-button").disabled = state.loading || state.busy;
    el("code-enable-section").hidden = !repository || enabled;
    el("code-enable-button").hidden = context?.project?.role !== "owner";
    el("code-enable-button").disabled = !permissions.enable;
    el("code-owner-note").hidden = context?.project?.role === "owner";
    el("code-enabled-content").hidden = !enabled;
    if (!enabled) return;
    const runtimes = codeRuntimeChoices(context);
    const select = el("code-runtime-select");
    const options = [{ value: "", label: t("Choose a local Agent device") }, ...runtimes.map((runtime) => {
      const device = context.devices?.find((item) => item.id === runtime.deviceId)?.name ?? runtime.deviceId;
      return { value: runtime.id, label: `${runtime.harness === "codex" ? "Codex" : "DeepSeek Harness"} · ${device || t("Unnamed device")}` };
    })];
    if (state.runtimeId && !runtimes.some((runtime) => runtime.id === state.runtimeId)) {
      options.push({ value: state.runtimeId, label: t("Selected device is offline") });
    }
    const signature = JSON.stringify(options);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...options.map(({ value, label }) => {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = label;
        option.setAttribute("data-i18n-skip", "");
        return option;
      }));
      select.dataset.options = signature;
    }
    select.value = state.runtimeId;
    select.disabled = state.busy || state.loading || ACTIVE_JOBS.has(job?.status) || !context?.sessionWritable;
    let status;
    if (!context?.sessionId) status = "Select a writable session to use a local Agent device.";
    else if (!context.sessionWritable) status = "This session is read only. Code transfers require a writable session.";
    else if (!runtimes.length) status = "Connect Codex or DeepSeek Harness to transfer code.";
    else if (!state.runtimeId) status = "Choose a device to inspect its local code status.";
    else if (!runtimes.some((runtime) => runtime.id === state.runtimeId)) status = "Selected device is offline";
    else if (state.busy || ACTIVE_JOBS.has(job?.status)) status = "Code operation queued or running on the selected device…";
    else if (!local) status = "Local code status is not available. Refresh to retry.";
    else if (!local.enabled) status = "Enable code access in the local connector first, then reconnect and refresh.";
    else if (local.local_status_unknown) status = "Original workspace status is unknown. The cloud copy was restored to a new folder.";
    else if (job?.kind === "code_recover") status = "Recovery copy created. Open the new folder locally to continue.";
    else if (local.needs_download) status = "Your cloud branch has a different version. Download only after preserving local changes.";
    else status = local.local_changes > 0 ? "Local code changes are waiting to be uploaded." : "Local code matches the last synchronized version.";
    el("code-local-state").textContent = t(status);
    const own = repository.branches.find((branch) => branch.id === repository.own_branch_id);
    el("code-local-commits").textContent = local ? [
      own?.name ?? t("No personal branch yet"),
      `${t("Local")}: ${shortCommit(local.base_commit)}`,
      `${t("Cloud")}: ${shortCommit(local.cloud_commit)}`,
      ...(!local.local_status_unknown ? [`${t("Changed files")}: ${Number(local.local_changes) || 0}`] : []),
      ...(local.recovery_directory ? [`${t("Recovery folder")}: ${local.recovery_directory}`] : []),
    ].join(" · ") : "";
    el("code-auto-upload-toggle").checked = local?.automatic_upload === true;
    el("code-auto-upload-toggle").disabled = !permissions.transfer;
    for (const id of ["code-upload-button", "code-download-button", "code-recover-button"]) el(id).disabled = !permissions.transfer;
    el("code-review-button").disabled = !permissions.review;
    el("code-update-button").disabled = !permissions.update || own?.head_commit === repository.repository.main_commit;
    el("code-main-commit").textContent = `main · ${shortCommit(repository.repository.main_commit)}`;
    el("code-branches-empty").hidden = repository.branches.length > 0;
    const list = el("code-branch-list");
    const branchSignature = JSON.stringify([repository.branches, repository.own_branch_id, state.busy, context?.members]);
    if (list.dataset.branches !== branchSignature) {
      list.replaceChildren(...repository.branches.map((branch) => {
        const row = doc.createElement("li");
        const copy = doc.createElement("div");
        const title = doc.createElement("strong");
        title.textContent = `${codeBranchAuthor(branch, context?.members)}${branch.id === repository.own_branch_id ? ` · ${t("Yours")}` : ""}`;
        title.title = branch.name;
        title.setAttribute("data-i18n-skip", "");
        const meta = doc.createElement("span");
        meta.textContent = `${shortCommit(branch.head_commit)} · ${t({ draft: "Draft", requested: "Review requested", merged: "Merged" }[branch.review_status] ?? "Draft")}`;
        meta.setAttribute("data-i18n-skip", "");
        copy.append(title, meta);
        const review = doc.createElement("button");
        review.type = "button";
        review.className = "text-button";
        review.textContent = t("View changes");
        review.disabled = state.busy;
        review.addEventListener("click", () => void showPreview(branch.id));
        row.append(copy, review);
        return row;
      }));
      list.dataset.branches = branchSignature;
    }
    const selected = repository.branches.find((branch) => branch.id === reviewed?.branchId);
    const unchanged = reviewed && selected?.head_commit === reviewed.head && repository.repository.main_commit === reviewed.main;
    el("code-merge-button").hidden = context?.project?.role !== "owner";
    el("code-merge-button").disabled = !permissions.merge || !unchanged || selected?.review_status !== "requested";
    if (reviewed && !unchanged) el("code-review-summary").textContent = t("This preview is out of date. View the changes again before merging.");
  }

  async function showPreview(branchId) {
    finishConfirmation(false);
    const version = ++previewGeneration;
    const projectId = controller.getState().context?.project?.id;
    if (!projectId) return;
    reviewed = null;
    el("code-review-preview").hidden = false;
    el("code-merge-button").disabled = true;
    el("code-review-files").replaceChildren();
    el("code-review-summary").textContent = t("Loading changes…");
    try {
      const [base, branch] = await Promise.all([api.getProjectCodeSnapshot(projectId, "main"), api.getProjectCodeSnapshot(projectId, branchId)]);
      if (version !== previewGeneration || controller.getState().context?.project?.id !== projectId || !dialog.open) return;
      const changes = compareCodeSnapshots(base.snapshot, branch.snapshot);
      reviewed = { branchId, main: base.snapshot.commit, head: branch.snapshot.commit };
      el("code-review-summary").textContent = `${t("Changed files")}: ${changes.length}. ${t("Text previews are limited to 12,000 characters per file. Review and test code locally before approval.")}`;
      for (const change of changes) {
        const details = doc.createElement("details");
        const summary = doc.createElement("summary");
        summary.textContent = `${t(change.type)} · ${change.path}`;
        summary.setAttribute("data-i18n-skip", "");
        details.append(summary);
        for (const [label, file] of [["Before", change.before], ["After", change.after]]) {
          if (!file) continue;
          const heading = doc.createElement("strong");
          heading.textContent = t(label);
          const content = doc.createElement("pre");
          content.setAttribute("data-i18n-skip", "");
          content.textContent = codeFilePreview(file) ?? t("Binary file: review locally.");
          details.append(heading, content);
        }
        el("code-review-files").append(details);
      }
      render(controller.getState());
    } catch (error) {
      if (version === previewGeneration) el("code-review-summary").textContent = t(codeErrorText(error));
    }
  }

  function updateContext() {
    controller.setContext(getContext());
  }
  trigger.addEventListener("click", () => {
    updateContext();
    if (!controller.getState().context?.project) return;
    returnFocus = doc.activeElement;
    dialog.showModal();
    controller.open();
  });
  el("close-project-code-button").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    finishConfirmation(false);
    previewGeneration += 1;
    controller.close();
    returnFocus?.isConnected && returnFocus.focus({ preventScroll: true });
  });
  el("code-runtime-select").addEventListener("change", (event) => void controller.selectRuntime(event.target.value));
  el("code-refresh-button").addEventListener("click", async () => {
    await controller.refresh();
    await controller.queue("code_sync_status");
  });
  el("code-confirm-accept").addEventListener("click", () => finishConfirmation(true));
  el("code-confirm-cancel").addEventListener("click", () => finishConfirmation(false));
  el("code-enable-button").addEventListener("click", async () => {
    if (await confirm(t("Enable Git storage for this project? Uploaded code will be readable by every project member. No local files are uploaded until you authorize a connector and choose an upload action."))) void controller.mutate("enable");
  });
  el("code-upload-button").addEventListener("click", async () => {
    if (await confirm(t("Upload selected local project files to your cloud branch? All project members can read them. Check exclusions and credentials before continuing."))) void controller.queue("code_upload");
  });
  el("code-download-button").addEventListener("click", async () => {
    if (await confirm(t("Download your cloud branch to the selected device? Local changes or an active Agent will block the update. Nothing is force-overwritten."))) void controller.queue("code_download");
  });
  el("code-recover-button").addEventListener("click", async () => {
    if (await confirm(t("Restore the last uploaded version into a new local folder on this device? Existing files and the Agent workspace will not be changed."))) void controller.queue("code_recover");
  });
  el("code-auto-upload-toggle").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    event.target.checked = controller.getState().local?.automatic_upload === true;
    if (enabled && !await confirm(t("Automatically upload settled local code changes to your branch? All project members can read uploaded files. Conversation upload settings stay unchanged."))) return;
    void controller.queue(enabled ? "code_auto_upload_enable" : "code_auto_upload_disable");
  });
  el("code-review-button").addEventListener("click", () => void controller.mutate("review"));
  el("code-update-button").addEventListener("click", async () => {
    if (await confirm(t("Merge the current main version into your cloud branch? Your local files stay unchanged until you download the result. Conflicts stop safely."))) void controller.mutate("update");
  });
  el("code-merge-button").addEventListener("click", async () => {
    const preview = reviewed;
    if (preview && !el("code-merge-button").disabled && await confirm(t("Approve these reviewed changes and merge them into main? Other members can then download this version.")) && reviewed === preview && !el("code-merge-button").disabled) void controller.mutate("merge", preview.branchId);
  });
  return {
    updateContext,
    close() { if (dialog.open) dialog.close(); controller.close(); },
  };
}
