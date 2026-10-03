import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CodeFilesSchema, HostedGithubTaskInputSchema, containsCodeSyncSecret, isCodeSyncPathAllowed, type CodeFile,
  type HostedGithubTaskInput, type HostedGithubRepositoryInput, type HostedGithubPrInput } from "@gatherthread/protocol";
import type { Actor } from "./database.js";
import { ApiError } from "./errors.js";
import { HostedAgent, type HostedAgentOptions } from "./hosted-agent.js";
import { HostedRepositoryRunner } from "./hosted-repository-runner.js";
import type { CollaborationService } from "./service.js";
import { HOSTED_GITHUB_SCHEMA } from "./hosted-github-schema.js";
import { redactJson } from "./redaction.js";

export interface HostedGithubOptions {
 clientId: string; clientSecret: string; encryptionKey: string; callbackUrl: string; appSlug: string;
 fetch?: typeof globalThis.fetch;
}
interface Credentials { access_token: string; refresh_token?: string; expires_at: number; refresh_expires_at: number }
interface Binding { repository: string; repository_id: number; base_branch: string; revision: string }
interface Task extends Binding {
 id: string; request_event_id: string; user_id: string; device_id: string; session_id: string; project_id: string;
 binding_revision: string; input_json: string; state: string; base_sha: string | null; base_tree: string | null;
 initial_files: string | null; result_files: string | null; answer: string | null; error_code: string | null;
 pr_commit: string | null; pr_url: string | null; expires_at: number;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const excluded = (path: string) => path.split("/").some((p) => ["node_modules", "dist", "coverage", ".next", ".turbo"].includes(p))
 || path.startsWith(".github/workflows/");
const safeError = (code: string, status = 400) => new ApiError(status, code, {
 github_access: "GitHub access is unavailable. Reconnect and check repository permissions.",
 github_state: "GitHub authorization expired or belongs to another browser account. Start again.",
 github_binding_changed: "Repository settings changed. Start a new cloud task.",
 github_task_access: "Cloud task is unavailable.",
 github_task_failed: "Cloud task failed. Check the npm lockfile, project size and model availability; start a new request to retry.",
 github_task_interrupted: "Cloud task was interrupted. Saved files remain available for an explicit new run.",
 github_revision: "The reviewed files changed. Refresh the changes before creating a pull request.",
 github_source_limit: "This repository exceeds the cloud source limits or contains unsupported files.",
 github_base_changed: "The GitHub base branch changed. Start a new task from the latest branch.",
 github_pr_busy: "Pull request creation is already in progress. Refresh this task shortly.",
}[code] ?? "Cloud repository operation is unavailable.");

export class HostedGithub {
 private readonly sqlite;
 private readonly key: Buffer;
 private readonly inFlight = new Set<Promise<unknown>>();
 private readonly publishing = new Set<string>();
 private readonly refreshing = new Map<string, Promise<string>>();
 private readonly controllers = new Map<string, AbortController>();
 private readonly runner: HostedRepositoryRunner;
 private closing = false;
 constructor(private readonly service: CollaborationService, private readonly agent: HostedAgent,
   runnerOptions: HostedAgentOptions, private readonly options: HostedGithubOptions) {
   this.key = Buffer.from(options.encryptionKey, "base64");
   const callback = new URL(options.callbackUrl);
   if (this.key.length !== 32 || this.key.toString("base64") !== options.encryptionKey
     || !/^[A-Za-z0-9_.-]+$/u.test(options.appSlug) || !options.clientId || !options.clientSecret
     || callback.protocol !== "https:" || callback.pathname !== "/v1/hosted-github/callback" || callback.search || callback.hash) {
     throw new Error("Invalid cloud GitHub configuration");
   }
   this.sqlite = service.database.sqlite;
   this.sqlite.exec(HOSTED_GITHUB_SCHEMA);
   this.migrateTaskInputs();
   if (!runnerOptions.runContainer) {
     for (const row of this.sqlite.prepare("SELECT id FROM hosted_github_tasks WHERE state='running'").all()) {
       const id = String(row.id);
       if (/^gh-task-[a-f0-9]{32}$/u.test(id)) spawnSync("docker", ["rm", "-f", `gt-repository-${id.slice(8)}`], { timeout: 5000, stdio: "ignore" });
     }
   }
   this.sqlite.prepare("UPDATE hosted_github_tasks SET state='interrupted',error_code='github_task_interrupted' WHERE state='running'").run();
   this.runner = new HostedRepositoryRunner(runnerOptions);
   this.prune();
 }
 private seal(value: unknown, owner: string) {
   const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv);
   cipher.setAAD(Buffer.from(owner));
   return Buffer.concat([iv,
     cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
 }
 private open<T>(text: string, owner: string): T {
   const data = Buffer.from(text, "base64");
   const cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
   cipher.setAAD(Buffer.from(owner)); cipher.setAuthTag(data.subarray(-16));
   return JSON.parse(Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString("utf8"));
 }
 private inputFingerprint(userId: string, sessionId: string, inputJson: string) {
   // Keyed, identity-bound receipt preserves exact retry checks without storing the raw request.
   return createHmac("sha256", this.key).update(JSON.stringify(["hosted-github-input-v1", userId, sessionId, inputJson])).digest("hex");
 }
 private redactInput(input: HostedGithubTaskInput): HostedGithubTaskInput {
   return { ...input, content: String(redactJson(input.content)) };
 }
 private migrateTaskInputs() {
   this.sqlite.exec("BEGIN IMMEDIATE");
   try {
     if (!this.sqlite.prepare("PRAGMA table_info(hosted_github_tasks)").all().some((row) => row.name === "input_fingerprint")) {
       this.sqlite.exec("ALTER TABLE hosted_github_tasks ADD COLUMN input_fingerprint TEXT");
     }
     const rows = this.sqlite.prepare("SELECT id,user_id,session_id,input_json,input_fingerprint FROM hosted_github_tasks").all() as
       Array<{ id: string; user_id: string; session_id: string; input_json: string; input_fingerprint: string | null }>;
     for (const row of rows) {
       let input: HostedGithubTaskInput;
       try {
         input = JSON.parse(row.input_json) as HostedGithubTaskInput;
         HostedGithubTaskInputSchema.parse(input);
       } catch { throw new Error("Invalid stored cloud task input"); }
       const fingerprint = row.input_fingerprint ?? this.inputFingerprint(row.user_id, row.session_id, row.input_json);
       this.sqlite.prepare("UPDATE hosted_github_tasks SET input_json=?,input_fingerprint=? WHERE id=?")
         .run(JSON.stringify(this.redactInput(input)), fingerprint, row.id);
     }
     this.sqlite.exec("COMMIT");
   } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
 }
 private prune() {
   this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE expires_at < ?").run(Date.now());
   this.sqlite.prepare("DELETE FROM hosted_github_tasks WHERE expires_at < ? AND state != 'running'").run(Date.now());
 }
 private async json(url: string, init: RequestInit, limit = 16 * 1024 * 1024): Promise<any> {
   const response = await (this.options.fetch ?? globalThis.fetch)(url,
     { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
   if (!response.ok || !response.body) throw safeError("github_access", 502);
   let size = 0; const chunks: Uint8Array[] = [];
   for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw safeError("github_source_limit", 413); chunks.push(chunk); }
   return JSON.parse(Buffer.concat(chunks).toString("utf8"));
 }
 private async exchange(body: Record<string, string>): Promise<Credentials> {
   const data = await this.json("https://github.com/login/oauth/access_token", { method: "POST",
     headers: { accept: "application/json", "content-type": "application/json" },
     body: JSON.stringify({ client_id: this.options.clientId, client_secret: this.options.clientSecret, ...body }) }, 16000);
   if (typeof data.access_token !== "string" || !data.access_token.startsWith("ghu_") || data.scope
     || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1
     || typeof data.refresh_token !== "string" || !data.refresh_token.startsWith("ghr_")
     || !Number.isSafeInteger(data.refresh_token_expires_in) || data.refresh_token_expires_in < 1) throw safeError("github_access", 502);
   return { access_token: data.access_token, refresh_token: data.refresh_token,
     expires_at: Date.now() + data.expires_in * 1000, refresh_expires_at: Date.now() + data.refresh_token_expires_in * 1000 };
 }
 private async token(actor: Actor) {
   this.service.database.assertActiveDevice(actor);
   const account = this.sqlite.prepare("SELECT credentials FROM hosted_github_accounts WHERE user_id=?").get(actor.user_id) as { credentials: string } | undefined;
   if (!account) throw safeError("github_access", 403);
   const credentials = this.open<Credentials>(account.credentials, actor.user_id);
   if (credentials.expires_at > Date.now() + 60000) return credentials.access_token;
   if (!credentials.refresh_token || credentials.refresh_expires_at < Date.now()) throw safeError("github_access", 403);
   const current = this.refreshing.get(actor.user_id); if (current) return current;
   const promise = (async () => {
     const next = await this.exchange({ grant_type: "refresh_token", refresh_token: credentials.refresh_token! });
     this.service.database.assertActiveDevice(actor);
     const result = this.sqlite.prepare("UPDATE hosted_github_accounts SET credentials=? WHERE user_id=? AND credentials=?")
       .run(this.seal(next, actor.user_id), actor.user_id, account.credentials);
     if (!result.changes) throw safeError("github_access", 403);
     return next.access_token;
   })();
   this.refreshing.set(actor.user_id, promise);
   try { return await promise; } finally { this.refreshing.delete(actor.user_id); }
 }
 private apiWithToken(token: string, path: string, method = "GET", body?: unknown) {
   return this.json(`https://api.github.com${path}`, { method,
     headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
       "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
     ...(body ? { body: JSON.stringify(body) } : {}) });
 }
 private async api(actor: Actor, path: string, method = "GET", body?: unknown) {
   return this.apiWithToken(await this.token(actor), path, method, body);
 }
 authorize(actor: Actor) {
   this.prune(); this.service.database.assertActiveDevice(actor);
   this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE user_id=? AND device_id=?").run(actor.user_id, actor.device_id);
   const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
   this.sqlite.prepare("INSERT INTO hosted_github_oauth VALUES(?,?,?,?,?)")
     .run(digest(state), actor.user_id, actor.device_id, this.seal(verifier, actor.user_id), Date.now() + 600000);
   const url = new URL("https://github.com/login/oauth/authorize");
   url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.callbackUrl,
     state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "select_account" }).toString();
   return { authorization_url: url.href };
 }
 async complete(actor: Actor, input: { state: string; code: string }) {
   this.service.database.assertActiveDevice(actor);
   const state = this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE state_hash=? AND user_id=? AND device_id=? AND expires_at>? RETURNING verifier")
     .get(digest(input.state), actor.user_id, actor.device_id, Date.now()) as { verifier: string } | undefined;
   if (!state) throw safeError("github_state", 403);
   const credentials = await this.exchange({ code: input.code, redirect_uri: this.options.callbackUrl,
     code_verifier: this.open<string>(state.verifier, actor.user_id) });
   const account = await this.apiWithToken(credentials.access_token, "/user");
   if (!/^[A-Za-z0-9-]{1,39}$/u.test(account.login)) throw safeError("github_access");
   this.service.database.assertActiveDevice(actor);
   this.sqlite.prepare("INSERT INTO hosted_github_accounts VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET login=excluded.login,credentials=excluded.credentials")
     .run(actor.user_id, account.login, this.seal(credentials, actor.user_id));
   // Reauthorization invalidates every earlier repository consent and task binding.
   this.sqlite.prepare("DELETE FROM hosted_github_bindings WHERE user_id=?").run(actor.user_id);
   return { connected: true, login: account.login };
 }
 status(actor: Actor, projectId: string) {
   this.prune(); this.service.requireProjectMembership(actor, projectId);
   const account = this.sqlite.prepare("SELECT login FROM hosted_github_accounts WHERE user_id=?").get(actor.user_id);
   const binding = this.sqlite.prepare("SELECT repository,base_branch FROM hosted_github_bindings WHERE user_id=? AND project_id=?").get(actor.user_id, projectId);
   return { enabled: true, connected: Boolean(account), login: account?.login ?? null, binding: binding ?? null,
     installation_url: `https://github.com/apps/${this.options.appSlug}/installations/new` };
 }
 async bind(actor: Actor, projectId: string, input: HostedGithubRepositoryInput) {
   const role = this.service.requireProjectMembership(actor, projectId);
   if (role === "viewer") throw safeError("github_task_access", 403);
   const repository = await this.api(actor, `/repos/${input.repository}`);
   if (repository.full_name?.toLowerCase() !== input.repository.toLowerCase() || !Number.isSafeInteger(repository.id)
     || !repository.permissions?.push || repository.archived) throw safeError("github_access", 403);
   await this.api(actor, `/repos/${input.repository}/branches/${encodeURIComponent(input.base_branch)}`);
   if (this.service.requireProjectMembership(actor, projectId) === "viewer") throw safeError("github_task_access", 403);
   this.sqlite.prepare(`INSERT INTO hosted_github_bindings VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,project_id)
     DO UPDATE SET repository=excluded.repository,repository_id=excluded.repository_id,base_branch=excluded.base_branch,revision=excluded.revision`)
     .run(actor.user_id, projectId, repository.full_name, repository.id, input.base_branch, randomBytes(16).toString("hex"));
   return this.status(actor, projectId);
 }
 disconnect(actor: Actor) {
   this.service.database.assertActiveDevice(actor);
   this.sqlite.prepare("DELETE FROM hosted_github_accounts WHERE user_id=?").run(actor.user_id);
   this.sqlite.prepare("DELETE FROM hosted_github_bindings WHERE user_id=?").run(actor.user_id);
   this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE user_id=?").run(actor.user_id);
   for (const row of this.sqlite.prepare("SELECT id FROM hosted_github_tasks WHERE user_id=? AND state='running'").all(actor.user_id)) {
     this.controllers.get(String(row.id))?.abort();
   }
   return { connected: false };
 }
 private binding(actor: Actor, projectId: string): Binding {
   if (this.service.requireProjectMembership(actor, projectId) === "viewer") throw safeError("github_task_access", 403);
   const row = this.sqlite.prepare("SELECT * FROM hosted_github_bindings WHERE user_id=? AND project_id=?").get(actor.user_id, projectId) as unknown as Binding | undefined;
   if (!row || !this.sqlite.prepare("SELECT 1 FROM hosted_github_accounts WHERE user_id=?").get(actor.user_id)) throw safeError("github_access", 403);
   return row;
 }
 private task(actor: Actor, id: string): Task {
   this.service.database.assertActiveDevice(actor);
   const row = this.sqlite.prepare("SELECT * FROM hosted_github_tasks WHERE id=? AND user_id=?").get(id, actor.user_id) as unknown as Task | undefined;
   if (!row || row.expires_at < Date.now()) throw safeError("github_task_access", 404);
   const role = this.service.requireMembership(actor, row.session_id);
   const session = this.service.database.requireSession(row.session_id);
   if (role === "viewer" || session.state !== "active" || session.mode === "solo" && session.owner_user_id !== actor.user_id) throw safeError("github_task_access", 403);
   return row;
 }
 private assertBinding(actor: Actor, task: Task) {
   const binding = this.binding(actor, task.project_id);
   if (binding.revision !== task.binding_revision || binding.repository_id !== task.repository_id) throw safeError("github_binding_changed", 409);
 }
 list(actor: Actor, projectId: string) {
   this.service.requireProjectMembership(actor, projectId); this.prune();
   return (this.sqlite.prepare("SELECT id FROM hosted_github_tasks WHERE user_id=? AND project_id=? ORDER BY created_at DESC LIMIT 10")
     .all(actor.user_id, projectId) as { id: string }[]).flatMap(({ id }) => { try { return [this.view(actor, id, false)]; } catch { return []; } });
 }
 view(actor: Actor, id: string, includeChanges = true) {
   const task = this.task(actor, id);
   const initial = includeChanges && task.initial_files ? this.open<CodeFile[]>(task.initial_files, id) : [];
   const files = includeChanges && task.result_files ? this.open<CodeFile[]>(task.result_files, id) : initial;
   const before = new Map(initial.map((f) => [f.path, f])); const after = new Map(files.map((f) => [f.path, f]));
   const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
     const a = before.get(path), b = after.get(path);
     if (JSON.stringify(a) === JSON.stringify(b)) return [];
     return [{ path, before_base64: a?.content_base64 ?? null, after_base64: b?.content_base64 ?? null,
       before_executable: a?.executable ?? null, after_executable: b?.executable ?? null }];
   });
   const input = JSON.parse(task.input_json) as HostedGithubTaskInput;
   return { id, session_id: task.session_id, profile_id: input.profile_id,
     resumable: Boolean(task.initial_files) && ["completed", "failed", "interrupted"].includes(task.state) && !task.pr_url,
     state: task.state, repository: task.repository, base_branch: task.base_branch,
     base_sha: task.base_sha, revision: task.revision ?? null, answer: task.answer ?? null,
     error_code: task.error_code, pull_request_url: task.pr_url, changes, expires_at: task.expires_at };
 }
 start(actor: Actor, sessionId: string, rawInput: HostedGithubTaskInput) {
   const fingerprint = this.inputFingerprint(actor.user_id, sessionId, JSON.stringify(rawInput));
   const input = this.redactInput(rawInput);
   if (this.closing) throw safeError("github_task_access", 503);
   const session = this.service.database.requireSession(sessionId);
   const binding = this.binding(actor, session.project_id);
   const id = `gh-task-${digest(`${actor.user_id}:${sessionId}:${input.idempotency_key}`).slice(0, 32)}`;
   const previous = this.sqlite.prepare("SELECT input_json,input_fingerprint FROM hosted_github_tasks WHERE id=? AND user_id=?").get(id, actor.user_id);
   if (previous) {
     if (previous.input_fingerprint !== fingerprint || previous.input_json !== JSON.stringify(input)) throw safeError("github_revision", 409);
     return this.view(actor, id);
   }
   const parent = input.continue_task_id ? this.task(actor, input.continue_task_id) : null;
   if (parent) { this.assertBinding(actor, parent);
     if (!["completed", "interrupted", "failed"].includes(parent.state) || !parent.initial_files || parent.pr_url
       || parent.session_id !== sessionId) throw safeError("github_task_access", 409); }
   this.prune();
   const count = this.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_github_tasks WHERE user_id=?").get(actor.user_id) as { n: number };
   const all = this.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_github_tasks").get() as { n: number };
   if (count.n >= 10 || all.n >= 64) throw new ApiError(429, "github_task_storage", "Cloud task storage is full; delete an old task first");
   const reserved = this.agent.reserveRepository(actor, sessionId, { content: input.content, profile_id: input.profile_id,
     include_code: false, github_task_id: id, idempotency_key: input.idempotency_key,
     reply_to_event_id: input.reply_to_event_id ?? null }, (event) => {
       this.sqlite.prepare(`INSERT INTO hosted_github_tasks(id,request_event_id,user_id,device_id,session_id,project_id,
         repository,repository_id,base_branch,binding_revision,input_json,input_fingerprint,state,created_at,expires_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?)`).run(id, event.id, actor.user_id, actor.device_id, sessionId,
           session.project_id, binding.repository, binding.repository_id, binding.base_branch, binding.revision,
           JSON.stringify(input), fingerprint, Date.now(), Date.now() + 7 * 86400000);
     });
   if (!reserved.created || !reserved.endpoint) throw safeError("github_task_access", 409);
   const controller = new AbortController(); this.controllers.set(id, controller);
   const authorizationWatch = setInterval(() => {
     try { const running = this.task(actor, id); this.assertBinding(actor, running); }
     catch { controller.abort(); }
   }, 2000);
   authorizationWatch.unref();
   const promise = this.execute(actor, id, input, parent, reserved.endpoint, reserved.context, controller.signal);
   const settled = () => { clearInterval(authorizationWatch); this.inFlight.delete(promise); this.controllers.delete(id); };
   this.inFlight.add(promise); void promise.then(settled, settled);
   return this.view(actor, id);
 }
 private async snapshot(actor: Actor, task: Task) {
   const repo = await this.api(actor, `/repos/${task.repository}`);
   if (repo.id !== task.repository_id || !repo.permissions?.push || repo.archived) throw safeError("github_access", 403);
   const branch = await this.api(actor, `/repos/${task.repository}/branches/${encodeURIComponent(task.base_branch)}`);
   const commit = await this.api(actor, `/repos/${task.repository}/git/commits/${branch.commit.sha}`);
   const tree = await this.api(actor, `/repos/${task.repository}/git/trees/${commit.tree.sha}?recursive=1`);
   if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 5000) throw safeError("github_source_limit", 413);
   const entries = tree.tree.filter((e: any) => e.type !== "tree" && !excluded(e.path) && isCodeSyncPathAllowed(e.path));
   if (entries.length > 1000 || entries.some((e: any) => e.type !== "blob" || !["100644", "100755"].includes(e.mode)
     || !Number.isSafeInteger(e.size) || e.size > 2 * 1024 * 1024)
     || entries.reduce((n: number, e: any) => n + e.size, 0) > 8 * 1024 * 1024) throw safeError("github_source_limit", 413);
   const files: CodeFile[] = [];
   const deadline = Date.now() + 120000;
   for (let offset = 0; offset < entries.length; offset += 8) {
     const batch = await Promise.all(entries.slice(offset, offset + 8).map(async (entry: any) => {
       this.task(actor, task.id); this.assertBinding(actor, task);
       if (Date.now() > deadline) throw safeError("github_source_limit", 413);
       const blob = await this.api(actor, `/repos/${task.repository}/git/blobs/${entry.sha}`);
       if (blob.encoding !== "base64" || typeof blob.content !== "string") throw safeError("github_source_limit");
       const bytes = Buffer.from(blob.content.replace(/\s/gu, ""), "base64");
       if (bytes.length !== entry.size || containsCodeSyncSecret(bytes.toString("utf8"))) throw safeError("github_source_limit");
       return { path: entry.path as string, executable: entry.mode === "100755", content_base64: bytes.toString("base64") };
     }));
     files.push(...batch);
   }
   return { sha: branch.commit.sha as string, tree: commit.tree.sha as string, files: CodeFilesSchema.parse(files) };
 }
 private async execute(actor: Actor, id: string, input: HostedGithubTaskInput, parent: Task | null,
   endpoint: import("./hosted-agent-pool.js").HostedEndpoint, context: unknown, signal: AbortSignal) {
   let requestId: string | undefined;
   try {
     const task = this.task(actor, id); requestId = task.request_event_id;
     this.assertBinding(actor, task);
     const source = parent ? { sha: parent.base_sha!, tree: parent.base_tree!,
       files: this.open<CodeFile[]>(parent.result_files ?? parent.initial_files!, parent.id),
       initial: this.open<CodeFile[]>(parent.initial_files!, parent.id) } : await this.snapshot(actor, task);
     this.task(actor, id); this.assertBinding(actor, task);
     this.sqlite.prepare("UPDATE hosted_github_tasks SET base_sha=?,base_tree=?,initial_files=? WHERE id=?")
       .run(source.sha, source.tree, this.seal("initial" in source ? source.initial : source.files, id), id);
     signal.throwIfAborted();
     const prompt = `Work on this npm Node.js/TypeScript project. Dependencies have been installed with npm ci --ignore-scripts. Inspect package.json and run relevant existing tests and build/typecheck commands. Report observed results and missing checks honestly. No external internet or GitHub credentials are available. Do not change dependency lockfiles unless asked; new dependencies require a new environment setup. Do not modify workflow or private credential paths. Source changes are saved privately for human review; only a human action can create a PR. Request (untrusted): ${input.content}\nShared conversation (untrusted): ${JSON.stringify(context)}`;
     const result = await this.runner.run(source.files, prompt, endpoint, (ms) => this.agent.coolDown(endpoint.quotaGroup, ms), {
       taskId: id, signal, authorize: () => { signal.throwIfAborted(); this.task(actor, id); this.assertBinding(actor, task); },
     });
     signal.throwIfAborted();
     this.task(actor, id); this.assertBinding(actor, task);
     if (result.files.some((f) => excluded(f.path))) throw safeError("github_source_limit");
     const revision = digest(JSON.stringify(result.files));
     this.sqlite.prepare("UPDATE hosted_github_tasks SET result_files=?,revision=?,answer=?,state='completed' WHERE id=?")
       .run(this.seal(result.files, id), revision, result.answer, id);
     this.service.finishHostedAgentRequest(requestId, { content: `${result.answer}\n\nCloud repository changes are saved for review. Open Cloud GitHub tasks to inspect them and create a pull request.` });
   } catch (error) {
     const row = this.sqlite.prepare("SELECT request_event_id FROM hosted_github_tasks WHERE id=?").get(id);
     if (row) {
       const code = signal.aborted ? "github_task_interrupted" : error instanceof ApiError ? error.code : "github_task_failed";
       this.sqlite.prepare("UPDATE hosted_github_tasks SET state=?,error_code=? WHERE id=?").run(signal.aborted ? "interrupted" : "failed", code, id);
       this.service.finishHostedAgentRequest(String(row.request_event_id), {});
     }
   }
 }
 remove(actor: Actor, id: string) {
   const task = this.task(actor, id);
   if (task.state === "running" || this.publishing.has(id)) throw safeError("github_pr_busy", 409);
   this.sqlite.prepare("DELETE FROM hosted_github_tasks WHERE id=? AND user_id=?").run(id, actor.user_id);
 }
 async publish(actor: Actor, id: string, input: HostedGithubPrInput) {
   const task = this.task(actor, id); this.assertBinding(actor, task);
   if (task.state !== "completed" || task.revision !== input.expected_revision) throw safeError("github_revision", 409);
   if (task.pr_url) return this.view(actor, id);
   if (this.publishing.has(id)) throw safeError("github_pr_busy", 409);
   this.publishing.add(id);
   try {
     const initial = this.open<CodeFile[]>(task.initial_files!, id), files = this.open<CodeFile[]>(task.result_files!, id);
     const before = new Map(initial.map((f) => [f.path, f])); const after = new Map(files.map((f) => [f.path, f]));
     const paths = [...new Set([...before.keys(), ...after.keys()])].filter((p) => JSON.stringify(before.get(p)) !== JSON.stringify(after.get(p)));
     if (!paths.length) throw new ApiError(409, "github_no_changes", "This task has no source changes");
     const api = async (path: string, method = "GET", body?: unknown) => {
       this.task(actor, id); this.assertBinding(actor, task);
       return this.api(actor, `/repos/${task.repository}${path}`, method, body);
     };
     const repo = await api(""); if (repo.id !== task.repository_id || !repo.permissions?.push) throw safeError("github_access", 403);
     const base = await api(`/branches/${encodeURIComponent(task.base_branch)}`);
     if (base.commit.sha !== task.base_sha) throw safeError("github_base_changed", 409);
     let commitSha = task.pr_commit;
     if (!commitSha) {
       const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
       for (const path of paths) {
         if (!isCodeSyncPathAllowed(path) || excluded(path)) throw safeError("github_source_limit");
         const file = after.get(path);
         const blob = file ? await api("/git/blobs", "POST", { content: file.content_base64, encoding: "base64" }) : null;
         tree.push({ path, mode: (file ?? before.get(path))!.executable ? "100755" : "100644", type: "blob", sha: blob?.sha ?? null });
       }
       const result = await api("/git/trees", "POST", { base_tree: task.base_tree, tree });
       const commit = await api("/git/commits", "POST", { message: `GatherThread cloud task ${id}`, tree: result.sha, parents: [task.base_sha] });
       commitSha = commit.sha;
       this.sqlite.prepare("UPDATE hosted_github_tasks SET pr_commit=? WHERE id=?").run(commitSha, id);
     }
     const branch = `gatherthread/cloud/${id}`;
     // Reconcile after a dropped response/restart; never force-push a changed branch.
     const refs = await api(`/git/matching-refs/heads/${branch}`);
     const existing = refs.find((r: any) => r.ref === `refs/heads/${branch}`);
     if (existing && existing.object.sha !== commitSha) throw safeError("github_revision", 409);
     if (!existing) await api("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commitSha });
     const latest = await api(`/branches/${encodeURIComponent(task.base_branch)}`);
     if (latest.commit.sha !== task.base_sha) throw safeError("github_base_changed", 409);
     const pulls = await api(`/pulls?state=all&head=${encodeURIComponent(`${task.repository.split("/")[0]}:${branch}`)}&base=${encodeURIComponent(task.base_branch)}`);
     const pr = pulls.find((p: any) => p.head?.ref === branch && p.head?.sha === commitSha)
       ?? await api("/pulls", "POST", { title: input.title, body: input.body, head: branch, base: task.base_branch, draft: true });
     if (typeof pr.html_url !== "string" || !pr.html_url.startsWith(`https://github.com/${task.repository}/pull/`)) throw safeError("github_access", 502);
     this.task(actor, id); this.assertBinding(actor, task);
     this.sqlite.prepare("UPDATE hosted_github_tasks SET pr_url=? WHERE id=?").run(pr.html_url, id);
     return this.view(actor, id);
   } finally { this.publishing.delete(id); }
 }
 async close() { this.closing = true; for (const controller of this.controllers.values()) controller.abort();
   await Promise.allSettled([...this.inFlight]); }
}
