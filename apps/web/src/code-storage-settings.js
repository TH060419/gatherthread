import { createIdempotencyKey } from "./domain.js";

function bytesLabel(bytes) {
  const value = Number(bytes) || 0;
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MiB`
    : `${(value / 1024).toFixed(1)} KiB`;
}

export function mountCodeStorageSettings({ document, api, localizer, getUserId }) {
  const el = (id) => document.getElementById(id);
  const dialog = el("settings-dialog");
  const projectsNode = el("code-storage-projects");
  const selections = new Map();
  let generation = 0;
  let loaded = null;
  let plan = null;
  let busy = false;
  let userId = null;
  let selectionRevision = 0;

  function current() {
    return dialog.open && getUserId() === userId;
  }

  function translate(value) { return localizer.t(value); }

  function invalidatePlan() {
    selectionRevision += 1;
    plan = null;
    el("code-storage-confirmation").hidden = true;
    el("code-storage-review").disabled = busy || selections.size === 0;
    el("code-storage-error").textContent = "";
  }

  function renderProjects(projects) {
    selections.clear();
    projectsNode.replaceChildren();
    const withData = projects.filter((project) => Number(project.main_bytes) > 0
      || Number(project.own_branch_bytes) > 0 || Number(project.branch_count) > 0);
    if (!withData.length) {
      const empty = document.createElement("p");
      empty.className = "field-help";
      empty.textContent = translate("No cloud Git data is available to clear.");
      projectsNode.append(empty);
    }
    for (const project of withData) {
      const row = document.createElement("div");
      row.className = "code-storage-project";
      const label = document.createElement("label");
      label.className = "code-storage-project-label";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `${translate("Select cloud Git cleanup for")} ${project.project_title}`);
      const description = document.createElement("span");
      description.textContent = `${project.project_title} · ${translate("My branch")}: ${bytesLabel(project.own_branch_bytes)} · ${translate("Project main")}: ${bytesLabel(project.main_bytes)}`;
      label.append(checkbox, description);
      const action = document.createElement("select");
      action.setAttribute("aria-label", `${translate("Cleanup scope for")} ${project.project_title}`);
      if (project.own_branch_id) {
        const own = document.createElement("option");
        own.value = "own";
        own.textContent = translate("Only my cloud branch");
        action.append(own);
      }
      if (project.can_clear_project) {
        const whole = document.createElement("option");
        whole.value = "project";
        whole.textContent = translate("Entire project cloud Git repository");
        action.append(whole);
      }
      if (!action.children.length) continue;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selections.set(project.project_id, { project, action: action.value });
        else selections.delete(project.project_id);
        invalidatePlan();
      });
      action.addEventListener("change", () => {
        if (checkbox.checked) selections.set(project.project_id, { project, action: action.value });
        invalidatePlan();
      });
      row.append(label, action);
      projectsNode.append(row);
    }
    invalidatePlan();
  }

  async function load({ afterConfirmedAction = false } = {}) {
    if (busy && !afterConfirmedAction) return;
    const thisGeneration = ++generation;
    userId = getUserId();
    plan = null;
    selections.clear();
    el("code-storage-confirmation").hidden = true;
    el("code-storage-error").textContent = "";
    loaded = null;
    el("code-storage-summary").textContent = translate("Loading cloud Git storage…");
    el("code-storage-review").disabled = true;
    try {
      const result = await api.getCodeStorage();
      if (!current() || generation !== thisGeneration) return;
      loaded = result;
      el("code-storage-summary").textContent = `${translate("My logical cloud Git quota")}: ${bytesLabel(result.used_bytes)} / ${bytesLabel(result.limit_bytes)}`;
      renderProjects([...(result.projects ?? []), ...(result.detached_branches ?? []).map((branch) => ({
        ...branch, detached: true, repository_enabled: false, main_commit: null, main_bytes: 0,
        own_branch_id: "detached", branch_count: 1, can_clear_project: false,
        project_title: `${branch.project_title} (${translate("former member")})`,
      }))]);
    } catch (error) {
      if (!current() || generation !== thisGeneration) return;
      el("code-storage-summary").textContent = translate("Unable to load cloud Git storage.");
      el("code-storage-error").textContent = error.message ?? translate("Try refreshing.");
    }
  }

  async function review() {
    if (!current() || busy || !loaded || selections.size === 0) return;
    const thisGeneration = generation;
    const thisSelectionRevision = selectionRevision;
    const picked = [...selections.values()];
    busy = true;
    el("code-storage-review").disabled = true;
    el("code-storage-error").textContent = "";
    try {
      const nextPlan = [];
      for (const { project, action } of picked) {
        if (project.detached) {
          nextPlan.push({ project, action: "detached", input: {
            expected_head_commit: project.own_branch_head_commit,
            idempotency_key: createIdempotencyKey("clear-detached-branch"),
          } });
          continue;
        }
        const status = await api.getProjectCode(project.project_id);
        if (!current() || generation !== thisGeneration) return;
        if (action === "project") {
          if (!project.can_clear_project) throw new Error(translate("Only a project owner can clear its entire cloud repository."));
          nextPlan.push({ project, action, input: {
            expected_main_commit: status.repository.main_commit,
            expected_branches: status.branches.map((branch) => ({ branch_id: branch.id, head_commit: branch.head_commit })),
            idempotency_key: createIdempotencyKey("clear-project-code"),
          } });
        } else {
          const branch = status.branches.find((item) => item.id === status.own_branch_id && item.id === project.own_branch_id);
          if (!branch) throw new Error(translate("Your cloud branch changed. Refresh and try again."));
          nextPlan.push({ project, action, input: {
            expected_head_commit: branch.head_commit,
            idempotency_key: createIdempotencyKey("clear-own-branch"),
          } });
        }
      }
      if (selectionRevision !== thisSelectionRevision) return;
      plan = nextPlan;
      el("code-storage-confirmation-text").textContent = `${translate("You are about to clear cloud Git data for")}: ${nextPlan.map(({ project, action }) => `${project.project_title} (${translate(action === "project" ? "entire project" : "my branch")})`).join(", ")}. ${translate("Local Git is unchanged. Other members lose cloud access if you clear an entire project. Old objects and backups remain until separate operator cleanup; physical disk use is not immediately reduced.")}`;
      el("code-storage-confirmation").hidden = false;
    } catch (error) {
      if (current() && generation === thisGeneration) el("code-storage-error").textContent = error.message ?? translate("Unable to review cleanup.");
    } finally {
      busy = false;
      el("code-storage-review").disabled = !current() || selections.size === 0;
    }
  }

  async function confirm() {
    if (!current() || !plan || busy) return;
    const thisGeneration = generation;
    const thisUserId = userId;
    const approvedPlan = plan;
    plan = null;
    busy = true;
    el("code-storage-confirm").disabled = true;
    el("code-storage-cancel").disabled = true;
    let completed = 0;
    try {
      for (const item of approvedPlan) {
        if (item.action === "project") await api.clearProjectCode(item.project.project_id, item.input);
        else if (item.action === "detached") await api.clearDetachedCodeBranch(item.project.project_id, item.input);
        else await api.clearOwnCodeBranch(item.project.project_id, item.input);
        completed += 1;
        if (getUserId() !== thisUserId) return;
      }
      if (current() && generation === thisGeneration) {
        await load({ afterConfirmedAction: true });
        if (current()) el("code-storage-error").textContent = translate("Selected cloud Git references were cleared. Local Git is unchanged.");
      }
    } catch (error) {
      if (current() && generation === thisGeneration) {
        await load({ afterConfirmedAction: true });
        if (current()) el("code-storage-error").textContent = `${completed} / ${approvedPlan.length} ${translate("cleanup actions completed")}. ${error.message ?? translate("Refresh and review the remaining data.")}`;
      }
    } finally {
      busy = false;
      el("code-storage-confirm").disabled = false;
      el("code-storage-cancel").disabled = false;
      el("code-storage-confirmation").hidden = true;
    }
  }

  el("code-storage-refresh").addEventListener("click", () => void load());
  el("code-storage-review").addEventListener("click", () => void review());
  el("code-storage-confirm").addEventListener("click", () => void confirm());
  el("code-storage-cancel").addEventListener("click", invalidatePlan);
  return { load, cancel() { generation += 1; plan = null; selections.clear(); } };
}
