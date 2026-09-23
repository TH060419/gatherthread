import { createIdempotencyKey, isExecutionRuntime } from "./domain.js";

export const CODE_JOB_KINDS = new Set([
  "code_sync_status", "code_upload", "code_download", "code_recover",
  "code_auto_upload_enable", "code_auto_upload_disable",
]);
const ACTIVE_JOBS = new Set(["queued", "claimed", "importing", "compacting"]);

export function codeRuntimeChoices(context) {
  return (context?.runtimes ?? []).filter((runtime) =>
    isExecutionRuntime(runtime) && ["codex", "deepseek-harness"].includes(runtime.harness)
    && (!runtime.userId || runtime.userId === context.userId)
    && (!context.enabledHarnesses || context.enabledHarnesses.includes(runtime.harness)));
}

export function codePermissions(context, state) {
  const writable = ["owner", "participant"].includes(context?.project?.role);
  const own = state.repository?.branches?.find((branch) => branch.id === state.repository.own_branch_id);
  const runtime = codeRuntimeChoices(context).find((item) => item.id === state.runtimeId);
  const idle = !state.busy && !state.loading && !ACTIVE_JOBS.has(state.job?.status);
  const enabled = Boolean(state.repository?.repository?.enabled);
  return {
    enable: idle && context?.project?.role === "owner" && !enabled,
    review: idle && writable && enabled && Boolean(own?.head_commit) && own.review_status === "draft"
      && own.head_commit !== state.repository.repository.main_commit,
    merge: idle && context?.project?.role === "owner" && enabled,
    update: idle && writable && enabled && Boolean(own?.head_commit),
    local: idle && writable && enabled && Boolean(context?.sessionWritable && runtime),
    transfer: idle && writable && enabled && Boolean(context?.sessionWritable && runtime && state.local?.enabled),
  };
}

export function codeErrorText(error) {
  const code = typeof error === "string" ? error : error?.code;
  const messages = {
    code_sync_disabled: "Enable code access in the local connector first, then reconnect and refresh.",
    code_sync_busy: "The local Agent is busy. Wait for it to finish, then retry.",
    code_sync_conflict: "The cloud branch changed on another device. Your local files are unchanged. Recover a separate copy before resolving the difference.",
    code_sync_dirty: "Local files have changes. Upload or preserve them before downloading; nothing was overwritten.",
    code_sync_secret: "Upload blocked: a file may contain credentials. Remove private files from the shared selection and retry.",
    code_sync_unsafe_path: "A file path is not safe to synchronize. Check symbolic links and private directories locally.",
    code_sync_limit: "The selected files exceed the code storage limit. Exclude generated or large files and retry.",
    code_sync_binding: "This local workspace belongs to a different account, project, or server. Reconnect using the correct workspace.",
    code_sync_locked: "Another local code operation is running. Wait, then retry.",
    code_sync_unavailable: "Code synchronization is temporarily unavailable. Check the connection and retry.",
    code_sync_recovery_required: "The local folder is missing or a download was interrupted. Recover the cloud copy to a new folder before continuing.",
    code_sync_forbidden: "Code access was denied. Check this device's sign-in and project permissions.",
    code_conflict: "The branch changed or could not be merged cleanly. Refresh and resolve conflicts locally; no work was overwritten.",
    code_stale_head: "The cloud branch changed. Refresh and review the latest changes before retrying.",
    code_merge_conflict: "The branches have conflicting changes. Resolve them locally and upload a new version for review.",
    code_review_required: "Request a review of the latest branch version before merging.",
    code_secret_detected: "Upload blocked: a file may contain credentials. Remove private files from the shared selection and retry.",
    code_storage_quota_exceeded: "Project code storage is full. Contact the server administrator before uploading more files.",
    code_storage_check_required: "Code writes are paused for a storage check. Contact the server administrator; conversation sync remains available.",
    code_git_unavailable: "Git code storage is unavailable on the server. Contact the server administrator.",
    conflict: "The branch changed or could not be merged cleanly. Refresh and resolve conflicts locally; no work was overwritten.",
    forbidden: "You no longer have permission for this operation. Refresh the project.",
    unauthorized: "Your sign-in expired. Sign in again to continue.",
  };
  return messages[code] ?? "Code operation failed. Refresh the status and check the local connector before retrying.";
}

// This controller owns code jobs only. Conversation uploads and their preferences
// deliberately remain in the existing conversation synchronization controller.
export function createCodeSyncController({ api, onChange = () => {}, schedule = setTimeout, cancel = clearTimeout, pollMs = 1800 }) {
  let context = null;
  let active = false;
  let generation = 0;
  let pollTimer;
  let state = freshState();
  const emit = () => onChange({ ...state, context, permissions: codePermissions(context, state) });
  const current = (version) => active && generation === version;
  const stopPoll = () => { if (pollTimer !== undefined) cancel(pollTimer); pollTimer = undefined; };

  function freshState() {
    return { repository: null, runtimeId: "", local: null, job: null, busy: false, loading: false, error: "" };
  }

  function setContext(next) {
    const changed = context?.project?.id !== next?.project?.id || context?.sessionId !== next?.sessionId || context?.userId !== next?.userId;
    context = next;
    if (changed) {
      generation += 1;
      stopPoll();
      state = freshState();
      if (active && context?.project) void refresh();
    }
    // Keep an unavailable selection instead of silently targeting a different device.
    emit();
  }

  async function refresh() {
    if (!active || !context?.project || state.loading) return;
    const version = generation;
    const projectId = context.project.id;
    state.loading = true;
    state.error = "";
    emit();
    try {
      const repository = await api.getProjectCode(projectId);
      if (current(version)) state.repository = repository;
    } catch (error) {
      if (current(version)) state.error = codeErrorText(error);
    } finally {
      if (current(version)) { state.loading = false; emit(); }
    }
  }

  async function pollJob(version, requestId) {
    if (!current(version)) return;
    try {
      const job = await api.getSnapshotRequest(requestId);
      if (!current(version)) return;
      state.job = job;
      state.error = "";
      if (job.status === "completed") {
        state.local = job.result ?? null;
        await refresh();
      } else if (job.status === "failed") {
        state.error = codeErrorText(job.failureCode || job.failureMessage);
      }
    } catch (error) {
      if (!current(version)) return;
      state.error = codeErrorText(error);
    }
    if (!current(version)) return;
    emit();
    if (ACTIVE_JOBS.has(state.job?.status)) {
      pollTimer = schedule(() => void pollJob(version, requestId), pollMs);
      pollTimer?.unref?.();
    }
  }

  async function selectRuntime(runtimeId) {
    if (!active || state.busy || state.loading || ACTIVE_JOBS.has(state.job?.status)) return;
    if (runtimeId && !codeRuntimeChoices(context).some((item) => item.id === runtimeId)) return;
    generation += 1;
    stopPoll();
    state.runtimeId = runtimeId;
    state.local = null;
    state.job = null;
    state.error = "";
    emit();
    if (!runtimeId || !codePermissions(context, state).local) return;
    const version = generation;
    state.busy = true;
    emit();
    try {
      const jobs = await api.listSnapshotRequests({ sessionId: context.sessionId, limit: 40 });
      if (!current(version)) return;
      const existing = jobs.find((job) => job.targetRuntimeId === runtimeId && CODE_JOB_KINDS.has(job.kind) && ACTIVE_JOBS.has(job.status));
      if (existing) {
        state.job = existing;
        void pollJob(version, existing.id);
        return;
      }
    } catch (error) {
      if (current(version)) state.error = codeErrorText(error);
      return;
    } finally {
      if (current(version)) { state.busy = false; emit(); }
    }
    if (current(version)) await queue("code_sync_status");
  }

  async function queue(kind) {
    const permissions = codePermissions(context, state);
    if (!active || !CODE_JOB_KINDS.has(kind) || !permissions.local || (kind !== "code_sync_status" && !permissions.transfer)) return false;
    const version = generation;
    const sessionId = context.sessionId;
    const runtimeId = state.runtimeId;
    state.busy = true;
    state.error = "";
    emit();
    try {
      const job = await api.createSnapshotRequest(sessionId, kind, runtimeId);
      if (!current(version)) return false;
      state.job = job;
      void pollJob(version, job.id);
      return true;
    } catch (error) {
      if (current(version)) state.error = codeErrorText(error);
      return false;
    } finally {
      if (current(version)) { state.busy = false; emit(); }
    }
  }

  async function mutate(operation, branchId) {
    const permissions = codePermissions(context, state);
    if (!active || !permissions[operation]) return false;
    const status = state.repository;
    const own = status.branches.find((branch) => branch.id === status.own_branch_id);
    const branch = status.branches.find((item) => item.id === branchId);
    if (operation === "merge" && (!branch || branch.review_status !== "requested")) return false;
    const input = { idempotency_key: createIdempotencyKey(`code-${operation}`) };
    if (operation === "review") input.head_commit = own.head_commit;
    if (operation === "update") Object.assign(input, { base_commit: own.head_commit, expected_main_commit: status.repository.main_commit });
    if (operation === "merge") Object.assign(input, { branch_id: branch.id, expected_main_commit: status.repository.main_commit, expected_head_commit: branch.head_commit });
    const version = generation;
    state.busy = true;
    state.error = "";
    emit();
    try {
      const result = await api.mutateProjectCode(context.project.id, operation, input);
      if (!current(version)) return false;
      state.repository = result.status;
      return true;
    } catch (error) {
      if (current(version)) state.error = codeErrorText(error);
      return false;
    } finally {
      if (current(version)) { state.busy = false; emit(); }
    }
  }

  return {
    setContext, refresh, selectRuntime, queue, mutate,
    getState: () => ({ ...state, context, permissions: codePermissions(context, state) }),
    open() { active = true; void refresh(); if (ACTIVE_JOBS.has(state.job?.status)) void pollJob(generation, state.job.id); },
    close() { active = false; generation += 1; stopPoll(); state.loading = false; state.busy = false; },
  };
}
