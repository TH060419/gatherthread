import { FileBranchesInputSchema, FileTreeInputSchema, FileContentInputSchema, FileHistoryInputSchema,
  FileChangesInputSchema, FileMutationInputSchema, containsCodeSyncSecret } from "@gatherthread/protocol";

class MockFileError extends Error {
  constructor(code, message, status = 409) { super(message); this.name = "ApiError"; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new MockFileError(code, message, status); };
const clone = (value) => structuredClone(value);
const key = (path) => path.normalize("NFC").replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "").toLowerCase();
const byteLength = (file) => atob(file.content_base64).length;
const sourceSignature = (status) => JSON.stringify([status.repository, status.branches.map((branch) => [branch.id, branch.name, branch.user_id, branch.head_commit])]);

function assertLayout(files) {
  const nodes = new Map();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join("/"), existing = nodes.get(key(path));
      const isFile = index === parts.length;
      if (existing && (existing.path !== path || existing.file || isFile)) fail("file_path_conflict", "File and folder paths conflict.");
      nodes.set(key(path), { path, file: isFile });
    }
  }
}

function applyOperations(original, operations, provider) {
  let files = clone(original);
  for (const operation of operations) {
    if (operation.type === "write") {
      const text = new TextDecoder().decode(Uint8Array.from(atob(operation.content_base64), (character) => character.charCodeAt(0)));
      if (containsCodeSyncSecret(text)) fail("code_secret_detected", "Remove credentials or private keys before sharing.", 400);
      const previous = files.find((file) => file.path === operation.path);
      files = files.filter((file) => file.path !== operation.path);
      files.push({ path: operation.path, content_base64: operation.content_base64, executable: operation.executable ?? previous?.executable ?? false });
    } else {
      const source = files.filter((file) => file.path === operation.path || file.path.startsWith(`${operation.path}/`));
      if (!source.length) fail("not_found", "File or folder not found.", 404);
      if (operation.type !== "delete") {
        const destination = key(operation.destination), origin = key(operation.path);
        if (destination === origin || destination.startsWith(`${origin}/`)
          || files.some((file) => key(file.path) === destination || key(file.path).startsWith(`${destination}/`))) {
          fail("file_path_conflict", "The destination already exists.");
        }
      }
      if (operation.type !== "copy") {
        const removed = new Set(source.map((file) => file.path));
        files = files.filter((file) => !removed.has(file.path));
      }
      if (operation.type !== "delete") files.push(...source.map((file) => ({ ...file, path: operation.destination + file.path.slice(operation.path.length) })));
    }
    assertLayout(files);
  }
  const maxFile = provider === "gt-cloud" ? 2 * 1024 * 1024 : 20 * 1024 * 1024;
  const maxTotal = provider === "gt-cloud" ? 8 * 1024 * 1024 : 128 * 1024 * 1024;
  let total = 0;
  if (files.length > (provider === "gt-cloud" ? 1000 : 10000)) fail("code_storage_quota_exceeded", "Too many files.", 507);
  for (const file of files) {
    const bytes = byteLength(file); total += bytes;
    if (bytes > maxFile || total > maxTotal) fail("code_storage_quota_exceeded", "File storage limit exceeded.", 507);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Disposable in-memory file backend for ordinary mock mode and the isolated example. */
export class MockFileWorkspace {
  constructor(api) { this.api = api; this.states = new Map(); this.counter = 1000; }

  async branches(projectId, value) {
    const input = FileBranchesInputSchema.parse(value), context = await this.context(projectId, input);
    const { state, userId, writable } = context;
    const branches = [...state.branches.values()].map((branch) => ({ ...branch,
      can_write: writable && branch.user_id === userId }));
    const own = branches.find((branch) => branch.user_id === userId);
    if (!own && writable) branches.push({ id: "own", name: "My branch", user_id: userId,
      head_commit: state.branches.get(state.defaultBranch).head_commit, can_write: true });
    return { ...this.output(context), branches, default_branch_id: own?.id ?? (writable ? "own" : state.defaultBranch) };
  }

  async tree(projectId, value) {
    const input = FileTreeInputSchema.parse(value), context = await this.context(projectId, input);
    const { branch, commit } = this.selection(context, input);
    return { ...this.output(context, branch.id), commit: commit.id, head_commit: branch.head_commit,
      can_write: context.writable && branch.user_id === context.userId && commit.id === branch.head_commit,
      entries: commit.files.map((file) => ({ path: file.path, size: byteLength(file), executable: file.executable })) };
  }

  async content(projectId, value) {
    const input = FileContentInputSchema.parse(value), context = await this.context(projectId, input);
    const { branch, commit } = this.selection(context, input), file = commit.files.find((entry) => entry.path === input.path);
    if (!file) fail("not_found", "File not found.", 404);
    return { ...this.output(context, branch.id), commit: commit.id, ...clone(file), size: byteLength(file) };
  }

  async history(projectId, value) {
    const input = FileHistoryInputSchema.parse(value), context = await this.context(projectId, input);
    const { branch, commit } = this.selection(context, input);
    let ids = this.ancestors(context.state, commit.id);
    if (input.path) ids = ids.filter((id) => this.changedFiles(context.state, id).some((entry) => entry.path === input.path || entry.path.startsWith(`${input.path}/`)));
    const position = input.cursor ? ids.indexOf(input.cursor) : -1;
    if (input.cursor && position === -1) fail("not_found", "Branch history cursor not found.", 404);
    const selected = ids.slice(position + 1, position + 1 + input.limit);
    const commits = selected.map((id) => { const { files, ...metadata } = context.state.commits.get(id); return clone(metadata); });
    return { ...this.output(context, branch.id), commits,
      ...(position + 1 + selected.length < ids.length && selected.length ? { next_cursor: selected.at(-1) } : {}) };
  }

  async changes(projectId, value) {
    const input = FileChangesInputSchema.parse(value), context = await this.context(projectId, input);
    const { branch, commit } = this.selection(context, input);
    if (input.base_commit && !this.ancestors(context.state, commit.id).includes(input.base_commit)) fail("not_found", "Branch commit not found.", 404);
    const base = input.base_commit ?? commit.parent_ids[0] ?? null;
    return { ...this.output(context, branch.id), base_commit: base, commit: commit.id,
      files: this.changedFiles(context.state, commit.id, base) };
  }

  async mutate(projectId, value) {
    const input = FileMutationInputSchema.parse(value), context = await this.context(projectId, input);
    if (!context.writable) fail("forbidden", "Only a project writer can edit files.", 403);
    const receiptKey = input.idempotency_key, payload = JSON.stringify(input);
    const receipt = context.state.receipts.get(receiptKey);
    if (receipt) {
      if (receipt.userId !== context.userId || receipt.payload !== payload) fail("idempotency_conflict", "The retry key belongs to another operation.");
      const currentBranch = context.state.branches.get(receipt.result.branch_id);
      if (!currentBranch || !this.ancestors(context.state, currentBranch.head_commit).includes(receipt.result.commit)) {
        fail("code_data_cleared", "Cloud code data was cleared; refresh before retrying.");
      }
      return clone(receipt.result);
    }
    const { branch, commit: base } = this.selection(context, { branch_id: input.branch_id });
    if (branch.user_id !== context.userId) fail("forbidden", "Only your own code branch can be edited.", 403);
    if (base.id !== input.base_commit) fail("code_stale_head", "Cloud code changed. Refresh before saving.");
    const files = applyOperations(base.files, input.operations, input.provider);
    const commit = JSON.stringify(files) === JSON.stringify(base.files) ? base.id : this.nextCommit();
    const branchId = branch.id === "own" ? (input.provider === "gt-cloud" ? `branch-${this.nextCommit().slice(-24)}` : `gatherthread/mock/${context.userId}`) : branch.id;
    if (commit !== base.id) context.state.commits.set(commit, { id: commit, parent_ids: [base.id], files,
      message: input.message, author_name: this.api.currentUser.username ?? "Example collaborator", created_at: new Date().toISOString() });
    context.state.branches.set(branchId, { ...branch, id: branchId, name: branch.id === "own" ? `gt/${context.userId}` : branch.name, head_commit: commit });
    const result = { ...this.output(context, branchId), commit };
    context.state.receipts.set(receiptKey, { userId: context.userId, payload, result: clone(result) });
    if (input.provider === "gt-cloud") {
      const status = this.api.codeRepositories.get(projectId);
      const previous = status.branches.find((entry) => entry.id === branchId);
      if (previous) { previous.head_commit = commit; previous.review_status = "draft"; }
      else status.branches.push({ id: branchId, name: `gt/${context.userId}`, user_id: context.userId, head_commit: commit, review_status: "draft" });
      status.own_branch_id = branchId;
      context.state.sourceSignature = sourceSignature(status);
    }
    return clone(result);
  }

  async context(projectId, input) {
    const project = await this.api.getProject(projectId), userId = this.api.currentUser?.id;
    if (!userId) fail("unauthorized", "Sign in to read project files.", 401);
    const status = await this.api.getProjectCode(projectId);
    let revision, defaultBranch = "main";
    if (input.provider === "github") {
      const github = await this.api.getProjectGithub(projectId);
      if (!github.connection?.enabled) fail("file_provider_unavailable", "Connect a GitHub repository to browse its files.", 503);
      revision = github.connection.revision; defaultBranch = github.connection.base_branch;
      if (input.connection_revision !== undefined && input.connection_revision !== revision) fail("github_revision_conflict", "GitHub configuration changed.");
    } else {
      if (!status.repository.enabled) fail("code_not_enabled", "Enable project code collaboration first.");
      if (input.connection_revision !== undefined) fail("file_provider_mismatch", "GT Cloud does not use GitHub connection revisions.", 400);
    }
    const stateKey = `${projectId}:${input.provider}:${revision ?? "cloud"}`;
    let state = this.states.get(stateKey);
    if (!state) {
      state = this.seed(projectId, input.provider, status, defaultBranch);
      this.states.set(stateKey, state);
    }
    state = await state;
    if (input.provider === "gt-cloud" && state.sourceSignature !== sourceSignature(status)) await this.sync(state, projectId, status);
    return { provider: input.provider, revision, state, userId, writable: project.role !== "viewer" && project.state !== "archived" };
  }

  async seed(projectId, provider, status, defaultBranch) {
    const state = { provider, defaultBranch, branches: new Map(), commits: new Map(), receipts: new Map(), sourceSignature: "" };
    await this.sync(state, projectId, status);
    return state;
  }
  async sync(state, projectId, status) {
    const mainCommit = status.repository.main_commit ?? "1".repeat(40);
    const sources = [{ id: "main", name: state.defaultBranch, user_id: null, head_commit: mainCommit }, ...status.branches];
    const branches = new Map();
    for (const source of sources) {
      if (!state.commits.has(source.head_commit)) {
        const snapshot = status.repository.main_commit ? await this.api.getProjectCodeSnapshot(projectId, source.id) : { snapshot: { files: [] } };
        state.commits.set(source.head_commit, { id: source.head_commit,
          parent_ids: source.id === "main" || source.head_commit === mainCommit ? [] : [mainCommit],
          files: clone(snapshot.snapshot.files), message: source.id === "main" ? "Shared project version" : "Example code checkpoint",
          author_name: source.user_id === this.api.currentUser.id ? this.api.currentUser.username : "Example collaborator", created_at: new Date().toISOString() });
      }
      const id = source.id === "main" ? state.defaultBranch : state.provider === "github" ? source.name : source.id;
      branches.set(id, { id, name: source.name, user_id: source.user_id, head_commit: source.head_commit });
    }
    state.branches = branches; state.sourceSignature = sourceSignature(status);
  }
  selection(context, input) {
    let branch = input.branch_id === "own" ? [...context.state.branches.values()].find((entry) => entry.user_id === context.userId) : context.state.branches.get(input.branch_id);
    if (!branch && input.branch_id === "own" && context.writable) branch = { id: "own", name: "My branch", user_id: context.userId,
      head_commit: context.state.branches.get(context.state.defaultBranch).head_commit };
    if (!branch) fail("not_found", "Code branch not found.", 404);
    const id = input.commit ?? branch.head_commit;
    if (!this.ancestors(context.state, branch.head_commit).includes(id)) fail("not_found", "Branch commit not found.", 404);
    return { branch, commit: context.state.commits.get(id) };
  }
  ancestors(state, head) {
    const result = [], seen = new Set(), pending = [head];
    while (pending.length) { const id = pending.shift(); if (seen.has(id)) continue; seen.add(id);
      const commit = state.commits.get(id); if (!commit) continue; result.push(id); pending.push(...commit.parent_ids); }
    return result;
  }
  changedFiles(state, id, selectedBase) {
    const commit = state.commits.get(id), base = selectedBase === undefined ? commit.parent_ids[0] : selectedBase;
    const before = new Map((base ? state.commits.get(base)?.files ?? [] : []).map((file) => [file.path, file]));
    const after = new Map(commit.files.map((file) => [file.path, file]));
    return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
      const previous = before.get(path), current = after.get(path);
      if (previous?.content_base64 === current?.content_base64 && previous?.executable === current?.executable) return [];
      return [{ path, status: !previous ? "added" : !current ? "deleted" : "modified" }];
    });
  }
  output(context, branchId) { return { provider: context.provider, ...(branchId ? { branch_id: branchId } : {}),
    ...(context.revision !== undefined ? { connection_revision: context.revision } : {}) }; }
  nextCommit() { this.counter += 1; return this.counter.toString(16).padStart(40, "0"); }
}
