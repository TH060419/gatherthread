import { codeRuntimeChoices, codeErrorText } from "./code-sync.js";

export const GITHUB_CODE_JOB_KINDS = new Set([
  "github_auth_connect",
  "github_code_sync_status", "github_code_upload", "github_code_download",
  "github_code_recover", "github_code_auto_upload_enable",
  "github_code_auto_upload_disable", "github_code_update",
]);
const ACTIVE = new Set(["queued", "claimed", "importing", "compacting"]);

export function githubRepositoryAllowed(value) {
  return typeof value === "string" && value.length <= 140
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/u.test(value)
    && !value.endsWith("/.") && !value.endsWith("/..") && !value.toLowerCase().endsWith(".git");
}

export function githubBaseBranchAllowed(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) && !value.includes("..")
    && !value.startsWith("gatherthread/") && value !== "HEAD"
    && value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.toLowerCase().endsWith(".lock"));
}

export function githubLinks(status) {
  const { repository, base_branch: base } = status?.connection ?? {};
  if (!githubRepositoryAllowed(repository) || typeof base !== "string" || !base
    || typeof status.branch !== "string" || !status.branch) return null;
  const root = `https://github.com/${repository}`;
  return { files: `${root}/tree/${encodeURIComponent(base)}`, branches: `${root}/branches`,
    compare: `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(status.branch)}?expand=1` };
}

export function githubErrorText(error) {
  const code = typeof error === "string" ? error : error?.code;
  if (["code_sync_disabled", "github_code_sync_disabled", "github_sync_disabled", "github_consent_required"].includes(code)) return "Authorize GitHub locally, then check status again.";
  if (["github_auth_required", "github_auth_failed", "github_cli_unavailable"].includes(code)) return "Install GitHub CLI and sign in on the selected device, then retry.";
  if (code === "code_sync_binding") return "GitHub configuration changed. Check the target and authorize it again in your local connector.";
  if (["conflict", "github_connection_conflict", "github_revision_conflict", "github_binding_changed"].includes(code)) return "GitHub configuration changed. Refresh and check the repository before retrying.";
  if (code === "code_sync_unavailable") return "Check Git, GitHub CLI login, repository access and network on the selected device, then retry.";
  if (code === "code_sync_unsupported") return "This GitHub tree contains unsupported files, LFS, links or submodules. Use native Git or a source-only repository.";
  if (code === "code_sync_empty") return "No uploaded GitHub version is available. Check the repository and base branch.";
  return codeErrorText(error);
}

export function githubPermissions(context, state) {
  const idle = !state.loading && !state.busy && !ACTIVE.has(state.job?.status);
  const writable = ["owner", "participant"].includes(context?.project?.role) && state.github?.can_write === true;
  // /sessions/:id/runtimes is server-filtered to the current user; older
  // responses intentionally omit user_id. Explicit foreign IDs still fail.
  const runtime = codeRuntimeChoices(context).find((item) => item.id === state.runtimeId);
  const local = idle && writable && Boolean(context?.sessionWritable && runtime && state.github?.connection);
  return {
    configure: idle && context?.project?.role === "owner" && state.github?.can_configure === true,
    local,
    transfer: local && state.github?.connection?.enabled === true && state.local?.enabled === true,
    stopAutomaticUpload: local && state.local?.automatic_upload === true,
  };
}

// Separate state and consent from GT Cloud; no file content passes through this API.
export function createGithubCodeSyncController({ api, onChange = () => {}, schedule = setTimeout, cancel = clearTimeout, pollMs = 1800 }) {
  let context = null, active = false, generation = 0, timer;
  const fresh = () => ({ github: null, runtimeId: "", local: null, job: null, loading: false, busy: false, error: "", authConnected: false });
  let state = fresh();
  const getState = () => ({ ...state, context, permissions: githubPermissions(context, state) });
  const emit = () => onChange(getState());
  const current = (version) => active && version === generation;
  const stop = () => { if (timer !== undefined) cancel(timer); timer = undefined; };

  async function refresh() {
    if (!active || !context?.project || state.loading) return;
    const version = generation;
    state.loading = true; state.error = ""; emit();
    try {
      const github = await api.getProjectGithub(context.project.id);
      if (!current(version)) return;
      if (state.github?.connection?.revision !== github.connection?.revision) {
        state.local = null;
        state.authConnected = false;
      }
      state.github = github;
    } catch (error) { if (current(version)) { state.github = null; state.local = null; state.error = githubErrorText(error); } }
    finally { if (current(version)) { state.loading = false; emit(); } }
  }

  async function poll(version, id, revision = state.github?.connection?.revision) {
    if (!current(version)) return;
    try {
      const job = await api.getSnapshotRequest(id);
      if (!current(version)) return;
      state.job = job;
      if (job.status === "completed") {
        const binding = state.github?.connection;
        const result = job.result;
        if (job.kind === "github_auth_connect") {
          state.authConnected = revision === binding?.revision && result?.provider === "github" && result.connected === true;
          state.error = state.authConnected ? "" : "GitHub configuration changed. Refresh and check the repository before retrying.";
        } else {
          // A result for a previous binding must not authorize the next transfer.
          if (revision === binding?.revision && result?.provider === "github" && result.repository === binding?.repository
            && result.base_branch === binding?.base_branch && result.branch === state.github?.branch) {
            state.local = result;
            state.error = "";
          } else { state.local = null; state.error = "GitHub configuration changed. Refresh and check the repository before retrying."; }
        }
      } else if (job.status === "failed") state.error = githubErrorText(job.failureCode);
    } catch (error) { if (current(version)) state.error = githubErrorText(error); }
    if (!current(version)) return;
    emit();
    if (ACTIVE.has(state.job?.status)) { timer = schedule(() => void poll(version, id, revision), pollMs); timer?.unref?.(); }
  }

  async function queue(kind) {
    const permissions = githubPermissions(context, state);
    if (!active || !GITHUB_CODE_JOB_KINDS.has(kind) || !permissions.local
      || (kind !== "github_auth_connect" && kind !== "github_code_sync_status" && !(kind === "github_code_auto_upload_disable" ? permissions.stopAutomaticUpload : permissions.transfer))) return false;
    const version = generation;
    const revision = state.github?.connection?.revision;
    state.busy = true; state.error = ""; emit();
    try {
      const job = await api.createSnapshotRequest(context.sessionId, kind, state.runtimeId);
      if (!current(version)) return false;
      state.job = job; void poll(version, job.id, revision); return true;
    } catch (error) { if (current(version)) state.error = githubErrorText(error); return false; }
    finally { if (current(version)) { state.busy = false; emit(); } }
  }

  async function selectRuntime(id) {
    if (!active || state.loading || state.busy || ACTIVE.has(state.job?.status)) return;
    if (id && !codeRuntimeChoices(context).some((runtime) => runtime.id === id)) return;
    generation += 1; stop(); state.runtimeId = id; state.local = null; state.job = null; state.error = ""; state.authConnected = false; emit();
    if (!id || !githubPermissions(context, state).local) return;
    const version = generation;
    state.busy = true; emit();
    try {
      const jobs = await api.listSnapshotRequests({ sessionId: context.sessionId, limit: 40 });
      if (!current(version)) return;
      const existing = jobs.find((job) => job.targetRuntimeId === id && GITHUB_CODE_JOB_KINDS.has(job.kind) && ACTIVE.has(job.status));
      if (existing) { state.job = existing; void poll(version, existing.id); return; }
    } catch (error) { if (current(version)) state.error = githubErrorText(error); return; }
    finally { if (current(version)) { state.busy = false; emit(); } }
    if (current(version)) await queue("github_code_sync_status");
  }

  async function configure(input) {
    if (!active || !githubPermissions(context, state).configure) return false;
    if (!githubRepositoryAllowed(input.repository)) {
      state.error = "Enter OWNER/REPO only, without a URL, credentials or .git suffix."; emit(); return false;
    }
    if (!githubBaseBranchAllowed(input.base_branch)) {
      state.error = "Choose a valid base branch outside the reserved gatherthread/ namespace."; emit(); return false;
    }
    const version = generation;
    const expected_revision = state.github?.connection?.revision ?? null;
    state.busy = true; state.error = ""; emit();
    try {
      const github = await api.putProjectGithub(context.project.id, {
        repository: input.repository, base_branch: input.base_branch, enabled: input.enabled, expected_revision,
      });
      if (!current(version)) return false;
      state.github = github; state.local = null; state.job = null; state.authConnected = false; return true;
    } catch (error) { if (current(version)) state.error = githubErrorText(error); return false; }
    finally { if (current(version)) { state.busy = false; emit(); } }
  }

  return { getState, refresh, selectRuntime, queue, configure,
    setContext(next) {
      const changed = context?.project?.id !== next?.project?.id || context?.sessionId !== next?.sessionId || context?.userId !== next?.userId;
      context = next;
      if (changed) { generation += 1; stop(); state = fresh(); if (active && context?.project) void refresh(); }
      emit();
    },
    open() { active = true; void refresh(); if (ACTIVE.has(state.job?.status)) void poll(generation, state.job.id); },
    close() { active = false; generation += 1; stop(); state.loading = false; state.busy = false; },
  };
}
