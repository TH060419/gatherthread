import { codeRuntimeChoices } from "./code-sync.js";
import { createGithubCodeSyncController, githubLinks } from "./github-code-sync.js";

export function mountGithubCodeSync({ document: doc, api, localizer, confirm, mockEnabled = false }) {
  const el = (id) => doc.getElementById(id);
  const t = (text) => localizer.t(text);
  const controller = createGithubCodeSyncController({ api, onChange: render, pollMs: mockEnabled ? 120 : 1800 });
  let formBinding;
  const route = () => {
    const state = controller.getState();
    return JSON.stringify([state.context?.project?.id, state.context?.sessionId, state.context?.userId,
      state.runtimeId, state.github?.connection?.revision]);
  };
  async function confirmed(message, action) {
    const before = route();
    if (await confirm(t(message)) && before === route()) await action();
  }

  function render(state) {
    const { context, github, local, permissions } = state;
    el("github-code-section").hidden = !context?.project;
    const connection = github?.connection;
    el("github-code-status").textContent = t(state.loading ? "Reading GitHub status…" : !github ? "GitHub status unavailable" : !connection ? "GitHub is not connected" : connection.enabled ? "GitHub sync enabled" : "GitHub sync paused");
    el("github-code-error").textContent = t(state.error);
    el("github-code-form").hidden = github?.can_configure !== true;
    el("github-code-owner-note").hidden = github?.can_configure === true;
    const binding = JSON.stringify([context?.project?.id, connection?.revision]);
    if (formBinding !== binding) {
      formBinding = binding;
      el("github-code-repository").value = connection?.repository ?? "";
      el("github-code-base").value = connection?.base_branch ?? "main";
    }
    for (const id of ["github-code-repository", "github-code-base", "github-code-save"]) el(id).disabled = !permissions.configure;
    el("github-code-save").textContent = t(connection ? "Save GitHub connection" : "Connect repository");
    el("github-code-pause").hidden = !connection || github?.can_configure !== true;
    el("github-code-pause").disabled = !permissions.configure;
    el("github-code-pause").textContent = t(connection?.enabled ? "Pause GitHub sync" : "Resume GitHub sync");
    el("github-code-refresh").disabled = state.loading || state.busy;
    const links = githubLinks(github);
    el("github-code-links").hidden = !links;
    for (const key of ["files", "branches", "compare"]) el(`github-code-${key}`).href = links?.[key] ?? "";
    el("github-code-branch").textContent = connection ? `${connection.repository} · ${connection.base_branch} → ${github.branch}` : "";
    el("github-code-device").hidden = !connection;
    const runtimes = codeRuntimeChoices(context);
    const options = [{ value: "", label: t("Choose a local Agent device") }, ...runtimes.map((runtime) => ({
      value: runtime.id, label: `${runtime.harness === "codex" ? "Codex" : "DeepSeek Harness"} · ${context.devices?.find((device) => device.id === runtime.deviceId)?.name ?? runtime.deviceId ?? t("Unnamed device")}`,
    }))];
    if (state.runtimeId && !runtimes.some((runtime) => runtime.id === state.runtimeId)) options.push({ value: state.runtimeId, label: t("Selected device is offline") });
    const select = el("github-code-runtime");
    const signature = JSON.stringify(options);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...options.map(({ value, label }) => {
        const option = doc.createElement("option"); option.value = value; option.textContent = label;
        option.setAttribute("data-i18n-skip", ""); return option;
      }));
      select.dataset.options = signature;
    }
    select.value = state.runtimeId;
    const running = ["queued", "claimed", "importing", "compacting"].includes(state.job?.status);
    select.disabled = state.busy || state.loading || running || !context?.sessionWritable || github?.can_write !== true;
    let status = "Choose a device to inspect its local code status.";
    if (!context?.sessionWritable || !github?.can_write) status = "Select a writable session to use a local Agent device.";
    else if (state.runtimeId && !runtimes.some((runtime) => runtime.id === state.runtimeId)) status = "Selected device is offline";
    else if (state.busy || running) status = "Code operation queued or running on the selected device…";
    else if (connection && !connection.enabled) status = "GitHub sync is paused. Resuming requires local authorization again.";
    else if (state.authConnected && !local) status = "GitHub sign-in complete on this device. Authorize this project in the local connector, then check status.";
    else if (state.runtimeId && !local) status = "Local code status is not available. Refresh to retry.";
    else if (local && !local.enabled) status = "Authorize GitHub locally, then check status again.";
    else if (local?.recovery_directory) status = "Recovery copy created. Open the new folder locally to continue.";
    else if (local?.needs_download) status = "Your GitHub branch has a different version. Preserve local changes before downloading.";
    else if (local) status = local.local_changes > 0 ? "Local code changes are waiting to be uploaded." : "Local code matches the last synchronized version.";
    el("github-code-local-state").textContent = t(status);
    el("github-code-local-detail").textContent = local ? [
      `${t("Changed files")}: ${Number(local.local_changes) || 0}`,
      ...(local.recovery_directory ? [`${t("Recovery folder")}: ${local.recovery_directory}`] : []),
    ].join(" · ") : "";
    el("github-code-auto").checked = local?.automatic_upload === true;
    el("github-code-auto").disabled = !permissions.transfer && !permissions.stopAutomaticUpload;
    const authRuntime = runtimes.find((runtime) => runtime.id === state.runtimeId);
    el("github-code-auth").disabled = !permissions.local || connection?.enabled !== true || authRuntime?.harness !== "codex";
    el("github-code-auth").hidden = authRuntime?.harness === "deepseek-harness";
    el("github-code-auth").textContent = t(state.authConnected ? "GitHub signed in on this device" : "Connect GitHub on this device");
    for (const action of ["upload", "download", "recover", "update"]) el(`github-code-${action}`).disabled = !permissions.transfer;
  }

  el("github-code-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = { repository: el("github-code-repository").value.trim(), base_branch: el("github-code-base").value.trim(), enabled: controller.getState().github?.connection?.enabled ?? true };
    await confirmed("Connect this GitHub repository? Check its visibility and collaborators on GitHub. This does not upload files or change GT Cloud storage.", () => controller.configure(input));
  });
  el("github-code-pause").addEventListener("click", async () => {
    const connection = controller.getState().github?.connection;
    if (!connection) return;
    await confirmed(connection.enabled
      ? "Pause GitHub sync? Existing GitHub files and access remain. Stop active transfers first. Resuming requires local authorization again."
      : "Resume GitHub sync? Restart and authorize the current configuration in Codex, or authorize it again in DSH, before transferring files.",
    () => controller.configure({ ...connection, enabled: !connection.enabled }));
  });
  el("github-code-runtime").addEventListener("change", (event) => void controller.selectRuntime(event.target.value));
  el("github-code-refresh").addEventListener("click", async () => { await controller.refresh(); await controller.queue("github_code_sync_status"); });
  el("github-code-auth").addEventListener("click", () => confirmed("Open GitHub sign-in on the selected local device? Complete the browser confirmation there. No credential is sent to GatherThread.", () => controller.queue("github_auth_connect")));
  const messages = {
    upload: "Upload eligible files to your GitHub branch? Review secrets and repository access first. This push may trigger GitHub workflows.",
    download: "Download your GitHub branch to this device? Unsaved local changes or an active Agent block the operation.",
    recover: "Restore your GitHub copy into a new folder? Existing files and the Agent workspace stay unchanged.",
    update: "Merge the base branch into your GitHub branch? Conflicts stop safely. Download afterwards to update local files. This push may trigger GitHub workflows.",
  };
  for (const [action, message] of Object.entries(messages)) el(`github-code-${action}`).addEventListener("click", () => confirmed(message, () => controller.queue(`github_code_${action}`)));
  el("github-code-auto").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    event.target.checked = controller.getState().local?.automatic_upload === true;
    if (!enabled) { await controller.queue("github_code_auto_upload_disable"); return; }
    await confirmed("Automatically upload settled changes to your GitHub branch while idle? Review secrets and GitHub access first. Pushes may trigger workflows. Conversation upload remains separate.", () => controller.queue("github_code_auto_upload_enable"));
  });
  return controller;
}
