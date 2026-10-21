import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { CodeFilesSchema, HostedGithubTaskInputSchema, HostedGithubTaskSchema, HostedGithubTaskListSchema, containsCodeSyncSecret, isCodeSyncPathAllowed, type CodeFile,
  type HostedGithubTaskInput, type HostedGithubRepositoryInput, type HostedGithubPrInput } from "@gatherthread/protocol";
import type { Actor } from "./database.js";
import { ApiError } from "./errors.js";
import { HostedAgent, HOSTED_AGENT_TIMEOUT_MS, type HostedAgentOptions } from "./hosted-agent.js";
import { HostedRepositoryRunner } from "./hosted-repository-runner.js";
import type { CollaborationService } from "./service.js";
import { HOSTED_GITHUB_SCHEMA } from "./hosted-github-schema.js";
import { hostedFailureOutcome } from "./hosted-agent-errors.js";
import { redactJson } from "./redaction.js";
import { HostedExecutorCleanupError, stopHostedContainer } from "./hosted-agent-recovery.js";
import { createHostedLiveOutputConsumer } from "./hosted-live-output.js";

export interface HostedGithubOptions {
 clientId: string; clientSecret: string; encryptionKey: string; callbackUrl: string; appSlug: string;
 fetch?: typeof globalThis.fetch;
}
interface Credentials { access_token: string; refresh_token?: string; expires_at: number; refresh_expires_at: number }
interface Binding { repository: string; repository_id: number; base_branch: string; revision: string }
/** Internal requester-owned capability; credentials and arbitrary remote URLs remain private. */
export interface HostedGithubRepositoryGuard {
 repository: string; repository_id: number; base_branch: string; binding_revision: string;
 connection_revision: string; authorization_generation: number; own_branch: string; can_write: boolean;
 assertCurrent(): void;
 request(path: string, method?: "GET" | "POST" | "PATCH", body?: unknown): Promise<any>;
 fingerprint(input: string): string;
}
interface Task extends Binding {
 id: string; request_event_id: string; user_id: string; device_id: string; session_id: string; project_id: string;
  binding_revision: string; input_json: string; original_task_reference_ids: string | null; state: string; base_sha: string | null; base_tree: string | null;
 initial_files: string | null; starting_files: string | null; result_files: string | null; answer: string | null; error_code: string | null;
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
 github_task_timeout: "Cloud task timed out. Continue from the saved source snapshot to start a new round.",
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
 private readonly unsubscribeDeletion: () => void;
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
       if (/^gh-task-[a-f0-9]{32}$/u.test(id)) stopHostedContainer(`gt-repository-${id.slice(8)}`);
     }
   }
   this.sqlite.prepare("UPDATE hosted_github_tasks SET state='interrupted',error_code='github_task_interrupted' WHERE state='running'").run();
   this.runner = new HostedRepositoryRunner(runnerOptions);
   this.unsubscribeDeletion = service.onEvent((event) => {
     if (event.type !== "message_deleted") return;
     for (const [id, controller] of this.controllers) {
       const row = this.sqlite.prepare("SELECT session_id FROM hosted_github_tasks WHERE id=?").get(id);
       if (row?.session_id === event.session_id) controller.abort();
     }
   });
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
     if (!this.sqlite.prepare("PRAGMA table_info(hosted_github_oauth)").all().some((row) => row.name === "generation")) {
       // Earlier pending states have no cancellation fence and must be restarted.
       this.sqlite.exec("ALTER TABLE hosted_github_oauth ADD COLUMN generation INTEGER NOT NULL DEFAULT 0; DELETE FROM hosted_github_oauth");
     }
     this.sqlite.prepare("INSERT OR IGNORE INTO hosted_github_authorizations(user_id,generation) SELECT user_id,0 FROM hosted_github_accounts").run();
     // Earlier unfenced binds could leave consent behind after disconnect.
     for (const table of ["hosted_github_bindings", "hosted_github_binding_attempts"]) {
       this.sqlite.prepare(`DELETE FROM ${table} WHERE user_id NOT IN (SELECT user_id FROM hosted_github_accounts)`).run();
     }
     if (!this.sqlite.prepare("PRAGMA table_info(hosted_github_tasks)").all().some((row) => row.name === "input_fingerprint")) {
       this.sqlite.exec("ALTER TABLE hosted_github_tasks ADD COLUMN input_fingerprint TEXT");
     }
     if (!this.sqlite.prepare("PRAGMA table_info(hosted_github_tasks)").all().some((row) => row.name === "starting_files")) {
       this.sqlite.exec("ALTER TABLE hosted_github_tasks ADD COLUMN starting_files TEXT");
     }
     if (!this.sqlite.prepare("PRAGMA table_info(hosted_github_tasks)").all().some((row) => row.name === "original_task_reference_ids")) {
       this.sqlite.exec("ALTER TABLE hosted_github_tasks ADD COLUMN original_task_reference_ids TEXT");
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
     // References contain only canonical event IDs, never another copy of task
     // content. Backfill intact legacy chains before ordinary snapshot pruning.
     for (const row of this.sqlite.prepare("SELECT * FROM hosted_github_tasks WHERE original_task_reference_ids IS NULL").all()) {
       const task = row as unknown as Task;
       const ids = this.taskReferenceIds(task);
       if (ids) this.sqlite.prepare("UPDATE hosted_github_tasks SET original_task_reference_ids=? WHERE id=?")
         .run(JSON.stringify(ids), task.id);
     }
     // Legacy initial_files holds the cumulative repository baseline. Recover
     // the actual starting snapshot only while its saved parent still exists.
     for (const raw of this.sqlite.prepare("SELECT * FROM hosted_github_tasks WHERE starting_files IS NULL AND initial_files IS NOT NULL").all()) {
       const task = raw as unknown as Task;
       const input = JSON.parse(task.input_json) as HostedGithubTaskInput;
       let source = task.initial_files!, owner = task.id;
       if (input.continue_task_id) {
         const parent = this.sqlite.prepare("SELECT * FROM hosted_github_tasks WHERE id=? AND user_id=? AND session_id=?")
           .get(input.continue_task_id, task.user_id, task.session_id) as unknown as Task | undefined;
         if (!parent?.initial_files) continue;
         source = parent.result_files ?? parent.initial_files; owner = parent.id;
       }
       try {
         const files = CodeFilesSchema.parse(this.open<CodeFile[]>(source, owner));
         this.sqlite.prepare("UPDATE hosted_github_tasks SET starting_files=? WHERE id=?").run(this.seal(files, task.id), task.id);
       } catch { throw new Error("Invalid stored cloud task snapshot"); }
     }
     this.sqlite.exec("COMMIT");
   } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
 }
 private taskReferenceIds(task: Task): string[] | null {
   if (task.original_task_reference_ids !== null) {
     let ids: unknown;
     try { ids = JSON.parse(task.original_task_reference_ids); } catch { return null; }
     return Array.isArray(ids) && ids.length > 0 && ids.length <= 1000
       && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 128)
       && new Set(ids).size === ids.length ? ids as string[] : null;
   }
   // Legacy tasks have at most ten saved ancestors. An incomplete chain cannot
   // safely guess which earlier instruction was the original repository task.
   const ancestors: Task[] = [], visited = new Set<string>();
   let ancestor: Task | undefined = task;
   while (ancestor && !visited.has(ancestor.id) && visited.size < 10) {
     visited.add(ancestor.id); ancestors.push(ancestor);
     const input = JSON.parse(ancestor.input_json) as HostedGithubTaskInput;
     if (!input.continue_task_id) return ancestors.reverse()
       .filter(item => (JSON.parse(item.input_json) as HostedGithubTaskInput).content === input.content)
       .map(item => item.request_event_id);
     ancestor = this.sqlite.prepare("SELECT * FROM hosted_github_tasks WHERE id=? AND user_id=? AND session_id=?")
       .get(input.continue_task_id, task.user_id, task.session_id) as unknown as Task | undefined;
   }
   return null;
 }
 private prune() {
   this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE expires_at < ?").run(Date.now());
   this.sqlite.prepare("DELETE FROM hosted_github_tasks WHERE state != 'running' AND (expires_at < ? OR error_code='context_changed')").run(Date.now());
 }
 private async json(url: string, init: RequestInit, limit = 16 * 1024 * 1024): Promise<any> {
   const timeout = AbortSignal.timeout(30_000);
   const response = await (this.options.fetch ?? globalThis.fetch)(url,
     { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
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
 private async token(actor: Actor, authorize?: () => void) {
   authorize?.();
   this.service.database.assertActiveDevice(actor);
   const account = this.sqlite.prepare("SELECT credentials FROM hosted_github_accounts WHERE user_id=?").get(actor.user_id) as { credentials: string } | undefined;
   if (!account) throw safeError("github_access", 403);
   const credentials = this.open<Credentials>(account.credentials, actor.user_id);
   if (credentials.expires_at > Date.now() + 60000) return credentials.access_token;
   if (!credentials.refresh_token || credentials.refresh_expires_at < Date.now()) throw safeError("github_access", 403);
   const current = this.refreshing.get(actor.user_id); if (current) return current;
   const promise = (async () => {
     const next = await this.exchange({ grant_type: "refresh_token", refresh_token: credentials.refresh_token! });
     authorize?.();
     this.service.database.assertActiveDevice(actor);
     const result = this.sqlite.prepare("UPDATE hosted_github_accounts SET credentials=? WHERE user_id=? AND credentials=?")
       .run(this.seal(next, actor.user_id), actor.user_id, account.credentials);
     if (!result.changes) throw safeError("github_access", 403);
     return next.access_token;
   })();
   this.refreshing.set(actor.user_id, promise);
   try { return await promise; } finally { this.refreshing.delete(actor.user_id); }
 }
 private apiWithToken(token: string, path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
   return this.json(`https://api.github.com${path}`, { method,
     headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
       "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
     ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
 }
 private async api(actor: Actor, path: string, method = "GET", body?: unknown, authorize?: () => void, signal?: AbortSignal) {
   authorize?.();
   const token = await this.token(actor, authorize);
   this.service.database.assertActiveDevice(actor);
   authorize?.();
   return this.apiWithToken(token, path, method, body, signal);
 }
 /** Acquire browser source access using this requester's private App consent. */
 async repositoryGuard(actor: Actor, projectId: string, write = false, authorize: () => void = () => {}): Promise<HostedGithubRepositoryGuard> {
   const unavailable = () => new ApiError(403, "github_connection_required",
     "Connect your GitHub account and explicitly select this project's repository before browsing its files.",
     { action: "connect_github" });
   authorize(); this.service.requireProjectMembership(actor, projectId);
   const target = this.service.database.getProjectGitHub(actor, projectId);
   const binding = this.sqlite.prepare("SELECT * FROM hosted_github_bindings WHERE user_id=? AND project_id=?")
     .get(actor.user_id, projectId) as unknown as Binding | undefined;
   const authorization = this.sqlite.prepare(`SELECT generation FROM hosted_github_accounts
     JOIN hosted_github_authorizations USING(user_id) WHERE user_id=?`).get(actor.user_id);
   if (!target.connection?.enabled || !binding || !authorization
     || binding.repository.toLowerCase() !== target.connection.repository.toLowerCase()
     || binding.base_branch !== target.connection.base_branch) throw unavailable();
   const generation = Number(authorization.generation), revision = target.connection.revision;
   const assertCurrent = () => {
     authorize();
     if (this.closing) throw new ApiError(503, "github_access", "GitHub file access is shutting down. Retry after reconnecting.");
     const role = this.service.requireProjectMembership(actor, projectId);
     if (write && (role === "viewer" || this.service.database.requireProject(projectId).state !== "active")) {
       throw new ApiError(403, "file_read_only", "Only an active project writer can edit their own branch.");
     }
     const current = this.service.database.getProjectGitHub(actor, projectId).connection;
     const row = this.sqlite.prepare(`SELECT repository,repository_id,base_branch,revision,generation
       FROM hosted_github_bindings JOIN hosted_github_accounts USING(user_id)
       JOIN hosted_github_authorizations USING(user_id) WHERE user_id=? AND project_id=?`).get(actor.user_id, projectId);
     if (!current?.enabled || current.revision !== revision || !row || Number(row.generation) !== generation
       || row.repository_id !== binding.repository_id || row.repository !== binding.repository
       || row.base_branch !== binding.base_branch || row.revision !== binding.revision) {
       throw new ApiError(409, "github_binding_changed", "GitHub authorization or project repository changed. Reconnect and refresh the files.",
         { action: "connect_github" });
     }
   };
   const prefix = `/repos/${binding.repository}`;
   const request = async (path: string, method: "GET" | "POST" | "PATCH" = "GET", body?: unknown) => {
     if (!(path === prefix || path.startsWith(`${prefix}/`)) || path.includes("#") || path.includes("\\")
       || /(?:^|\/)\.\.(?:\/|$)|%2e|%5c|[\u0000-\u001f\u007f]/iu.test(path)) {
       throw new ApiError(400, "github_path", "Unsupported GitHub request.");
     }
     if (method !== "GET") {
       const data = body as Record<string, unknown> | undefined;
       const ownRef = `refs/heads/${target.branch}`;
       const createObject = method === "POST" && ["/git/blobs", "/git/trees", "/git/commits"].some(suffix => path === prefix + suffix);
       const createOwnRef = method === "POST" && path === `${prefix}/git/refs` && data?.ref === ownRef
         && typeof data.sha === "string" && /^[a-f0-9]{40}$/u.test(data.sha) && Object.keys(data).every(key => ["ref", "sha"].includes(key));
       const updateOwnRef = method === "PATCH" && path === `${prefix}/git/refs/heads/${encodeURIComponent(target.branch)}`
         && data?.force === false && typeof data.sha === "string" && /^[a-f0-9]{40}$/u.test(data.sha)
         && Object.keys(data).every(key => ["sha", "force"].includes(key));
       if (!write || !(createObject || createOwnRef || updateOwnRef)) {
         throw new ApiError(403, "file_read_only", "GitHub writes are restricted to your stable personal branch.");
       }
     }
     assertCurrent();
     const value = await this.api(actor, path, method, body, assertCurrent);
     assertCurrent();
     return value;
   };
   assertCurrent();
   const repository = await request(prefix);
   if (repository.id !== binding.repository_id || repository.full_name?.toLowerCase() !== binding.repository.toLowerCase()
     || !repository.permissions || !(repository.permissions.pull || repository.permissions.push || repository.permissions.admin)
     || write && (!repository.permissions.push || repository.archived || repository.disabled)) {
     throw new ApiError(403, "github_access", "Your GitHub account cannot access this repository with the required permission.");
   }
   const canWrite = () => {
     assertCurrent();
     return this.service.database.getProjectGitHub(actor, projectId).can_write
       && Boolean(repository.permissions.push) && !repository.archived && !repository.disabled;
   };
   return { repository: binding.repository, repository_id: binding.repository_id, base_branch: binding.base_branch,
     binding_revision: binding.revision, connection_revision: revision, authorization_generation: generation,
     own_branch: target.branch, get can_write() { return canWrite(); },
     assertCurrent, request, fingerprint: (input: string) => this.inputFingerprint(actor.user_id, `files:${projectId}`, input) };
 }
 authorize(actor: Actor) {
   this.prune(); this.service.database.assertActiveDevice(actor);
   const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
   this.sqlite.exec("BEGIN IMMEDIATE");
   try {
     const generation = this.nextAuthorizationGeneration(actor.user_id);
     this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE user_id=?").run(actor.user_id);
     this.sqlite.prepare("INSERT INTO hosted_github_oauth(state_hash,user_id,device_id,verifier,expires_at,generation) VALUES(?,?,?,?,?,?)")
       .run(digest(state), actor.user_id, actor.device_id, this.seal(verifier, actor.user_id), Date.now() + 600000, generation);
     this.sqlite.exec("COMMIT");
   } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
   const url = new URL("https://github.com/login/oauth/authorize");
   url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.callbackUrl,
     state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "select_account" }).toString();
   return { authorization_url: url.href };
 }
 async complete(actor: Actor, input: { state: string; code: string }, authorize: () => void = () => {}) {
   authorize();
   this.service.database.assertActiveDevice(actor);
   const state = this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE state_hash=? AND user_id=? AND device_id=? AND expires_at>? RETURNING verifier,generation")
     .get(digest(input.state), actor.user_id, actor.device_id, Date.now()) as { verifier: string; generation: number } | undefined;
   if (!state) throw safeError("github_state", 403);
   const assertCurrent = () => {
     authorize(); this.service.database.assertActiveDevice(actor);
     if (!this.sqlite.prepare("SELECT 1 FROM hosted_github_authorizations WHERE user_id=? AND generation=?").get(actor.user_id, state.generation)) {
       throw safeError("github_state", 403);
     }
   };
   assertCurrent();
   const credentials = await this.exchange({ code: input.code, redirect_uri: this.options.callbackUrl,
     code_verifier: this.open<string>(state.verifier, actor.user_id) });
   assertCurrent();
   const account = await this.apiWithToken(credentials.access_token, "/user");
   assertCurrent();
   if (!/^[A-Za-z0-9-]{1,39}$/u.test(account.login)) throw safeError("github_access");
   this.sqlite.exec("BEGIN IMMEDIATE");
   try {
     assertCurrent();
     // A bind started while this exchange was pending must not reuse its account.
     this.nextAuthorizationGeneration(actor.user_id);
     this.sqlite.prepare("INSERT INTO hosted_github_accounts VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET login=excluded.login,credentials=excluded.credentials")
       .run(actor.user_id, account.login, this.seal(credentials, actor.user_id));
     // Commit credentials and invalidated repository consent under the same fence.
     this.sqlite.prepare("DELETE FROM hosted_github_bindings WHERE user_id=?").run(actor.user_id);
     this.sqlite.prepare("DELETE FROM hosted_github_binding_attempts WHERE user_id=?").run(actor.user_id);
     this.sqlite.exec("COMMIT");
   } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
   return { connected: true, login: account.login };
 }
 status(actor: Actor, projectId: string) {
   this.prune(); this.service.requireProjectMembership(actor, projectId);
   const account = this.sqlite.prepare("SELECT login FROM hosted_github_accounts WHERE user_id=?").get(actor.user_id);
   const binding = this.sqlite.prepare("SELECT repository,base_branch FROM hosted_github_bindings WHERE user_id=? AND project_id=?").get(actor.user_id, projectId);
   return { enabled: true, connected: Boolean(account), login: account?.login ?? null, binding: binding ?? null,
     installation_url: `https://github.com/apps/${this.options.appSlug}/installations/new` };
 }
 async bind(actor: Actor, projectId: string, input: HostedGithubRepositoryInput, authorize: () => void = () => {}) {
   const assertAccess = () => {
     authorize(); this.service.database.assertActiveDevice(actor);
     if (this.service.requireProjectMembership(actor, projectId) === "viewer") throw safeError("github_task_access", 403);
   };
   assertAccess();
   const attempt = randomBytes(16).toString("hex");
   let generation: number, revision: string | null;
   this.sqlite.exec("BEGIN IMMEDIATE");
   try {
     assertAccess();
     const account = this.sqlite.prepare(`SELECT generation FROM hosted_github_accounts
       JOIN hosted_github_authorizations USING(user_id) WHERE user_id=?`).get(actor.user_id);
     if (!account) throw safeError("github_access", 403);
     generation = Number(account.generation);
     revision = (this.sqlite.prepare("SELECT revision FROM hosted_github_bindings WHERE user_id=? AND project_id=?")
       .get(actor.user_id, projectId)?.revision as string | undefined) ?? null;
     // Reserve the latest explicit choice without replacing the last good consent.
     this.sqlite.prepare(`INSERT INTO hosted_github_binding_attempts VALUES(?,?,?) ON CONFLICT(user_id,project_id)
       DO UPDATE SET revision=excluded.revision`).run(actor.user_id, projectId, attempt);
     this.sqlite.exec("COMMIT");
   } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
   const assertCurrent = () => {
     assertAccess();
     if (!this.sqlite.prepare(`SELECT 1 FROM hosted_github_accounts JOIN hosted_github_authorizations USING(user_id)
       WHERE user_id=? AND generation=?`).get(actor.user_id, generation)) throw safeError("github_access", 403);
     const current = this.sqlite.prepare("SELECT revision FROM hosted_github_bindings WHERE user_id=? AND project_id=?")
       .get(actor.user_id, projectId)?.revision ?? null;
     if (current !== revision || !this.sqlite.prepare("SELECT 1 FROM hosted_github_binding_attempts WHERE user_id=? AND project_id=? AND revision=?")
       .get(actor.user_id, projectId, attempt)) throw safeError("github_binding_changed", 409);
   };
   const repository = await this.api(actor, `/repos/${input.repository}`, "GET", undefined, assertCurrent);
   assertCurrent();
   if (repository.full_name?.toLowerCase() !== input.repository.toLowerCase() || !Number.isSafeInteger(repository.id)
     || !repository.permissions?.push || repository.archived) throw safeError("github_access", 403);
   await this.api(actor, `/repos/${input.repository}/branches/${encodeURIComponent(input.base_branch)}`, "GET", undefined, assertCurrent);
   this.sqlite.exec("BEGIN IMMEDIATE");
   try {
     assertCurrent();
     this.sqlite.prepare(`INSERT INTO hosted_github_bindings VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,project_id)
       DO UPDATE SET repository=excluded.repository,repository_id=excluded.repository_id,base_branch=excluded.base_branch,revision=excluded.revision`)
       .run(actor.user_id, projectId, repository.full_name, repository.id, input.base_branch, randomBytes(16).toString("hex"));
     this.sqlite.exec("COMMIT");
   } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
   return this.status(actor, projectId);
 }
 disconnect(actor: Actor) {
   this.service.database.assertActiveDevice(actor);
   this.sqlite.exec("BEGIN IMMEDIATE");
   try {
     this.nextAuthorizationGeneration(actor.user_id);
     this.sqlite.prepare("DELETE FROM hosted_github_accounts WHERE user_id=?").run(actor.user_id);
     this.sqlite.prepare("DELETE FROM hosted_github_bindings WHERE user_id=?").run(actor.user_id);
     this.sqlite.prepare("DELETE FROM hosted_github_binding_attempts WHERE user_id=?").run(actor.user_id);
     this.sqlite.prepare("DELETE FROM hosted_github_oauth WHERE user_id=?").run(actor.user_id);
     this.sqlite.exec("COMMIT");
   } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
   for (const row of this.sqlite.prepare("SELECT id FROM hosted_github_tasks WHERE user_id=? AND state='running'").all(actor.user_id)) {
     this.controllers.get(String(row.id))?.abort();
   }
   return { connected: false };
 }
 private nextAuthorizationGeneration(userId: string): number {
   return Number(this.sqlite.prepare(`INSERT INTO hosted_github_authorizations(user_id,generation) VALUES(?,1)
     ON CONFLICT(user_id) DO UPDATE SET generation=generation+1 RETURNING generation`).get(userId)!.generation);
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
   this.service.database.assertRequestContextCurrent(row.session_id, row.request_event_id);
   if (role === "viewer" || session.state !== "active" || session.mode === "solo" && session.owner_user_id !== actor.user_id) throw safeError("github_task_access", 403);
   return row;
 }
 private assertBinding(actor: Actor, task: Task) {
   const binding = this.binding(actor, task.project_id);
   if (binding.revision !== task.binding_revision || binding.repository_id !== task.repository_id) throw safeError("github_binding_changed", 409);
 }
 private persistTask(actor: Actor, task: Task, write: () => void, authorizeRequest: () => void = () => {}) {
   this.sqlite.exec("BEGIN IMMEDIATE");
   try {
     authorizeRequest(); this.task(actor, task.id); this.assertBinding(actor, task);
     write();
     this.sqlite.exec("COMMIT");
   } catch (error) { if (this.sqlite.isTransaction) this.sqlite.exec("ROLLBACK"); throw error; }
 }
 list(actor: Actor, projectId: string) {
   this.service.requireProjectMembership(actor, projectId); this.prune();
   const tasks = (this.sqlite.prepare("SELECT id FROM hosted_github_tasks WHERE user_id=? AND project_id=? ORDER BY created_at DESC LIMIT 10")
     .all(actor.user_id, projectId) as { id: string }[]).flatMap(({ id }) => { try {
       const { answer: _answer, changes: _changes, ...summary } = this.view(actor, id, false); return [summary];
     } catch { return []; } });
   return HostedGithubTaskListSchema.parse({ tasks }).tasks;
 }
 view(actor: Actor, id: string, includeChanges = true) {
   const task = this.task(actor, id);
   const initial = includeChanges && task.initial_files ? this.open<CodeFile[]>(task.initial_files, id) : [];
   const files = includeChanges && (task.result_files ?? task.starting_files)
     ? this.open<CodeFile[]>((task.result_files ?? task.starting_files)!, id) : initial;
   const before = new Map(initial.map((f) => [f.path, f])); const after = new Map(files.map((f) => [f.path, f]));
   const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
     const a = before.get(path), b = after.get(path);
     if (JSON.stringify(a) === JSON.stringify(b)) return [];
     return [{ path, before_base64: a?.content_base64 ?? null, after_base64: b?.content_base64 ?? null,
       before_executable: a?.executable ?? null, after_executable: b?.executable ?? null }];
   });
   const input = JSON.parse(task.input_json) as HostedGithubTaskInput;
   return HostedGithubTaskSchema.parse({ id, session_id: task.session_id, profile_id: input.profile_id,
     resumable: Boolean(task.initial_files && (task.result_files ?? task.starting_files) && this.taskReferenceIds(task))
       && ["completed", "failed", "interrupted"].includes(task.state) && !task.pr_url,
     state: task.state, repository: task.repository, base_branch: task.base_branch,
     base_sha: task.base_sha, revision: task.revision ?? null, answer: task.answer ?? null,
     error_code: task.error_code, pull_request_url: task.pr_url, changes, expires_at: task.expires_at,
     ...(input.api_config_revision ? { api_config_revision: input.api_config_revision } : {}) });
 }
 start(actor: Actor, sessionId: string, rawInput: HostedGithubTaskInput) {
   const fingerprint = this.inputFingerprint(actor.user_id, sessionId, JSON.stringify(rawInput));
   const input = this.redactInput(rawInput);
   if (this.closing) throw safeError("github_task_access", 503);
   const session = this.service.database.requireSession(sessionId);
   const binding = this.binding(actor, session.project_id);
   const id = `gh-task-${digest(`${actor.user_id}:${sessionId}:${input.idempotency_key}`).slice(0, 32)}`;
   const previous = this.sqlite.prepare("SELECT request_event_id,input_json,input_fingerprint FROM hosted_github_tasks WHERE id=? AND user_id=?").get(id, actor.user_id);
   if (previous) {
     this.agent.selection(actor, sessionId, String(previous.request_event_id));
     if (previous.input_fingerprint !== fingerprint || previous.input_json !== JSON.stringify(input)) throw safeError("github_revision", 409);
     return this.view(actor, id);
   }
   const parent = input.continue_task_id ? this.task(actor, input.continue_task_id) : null;
   if (parent) { this.assertBinding(actor, parent);
     if (!["completed", "interrupted", "failed"].includes(parent.state) || !parent.initial_files
       || !(parent.result_files ?? parent.starting_files) || parent.pr_url
       || parent.session_id !== sessionId) throw safeError("github_task_access", 409);
     const selection = this.agent.selection(actor, sessionId, parent.request_event_id);
     if (selection.profile_id !== input.profile_id || selection.api_config_revision !== input.api_config_revision) {
       throw new ApiError(409, selection.api_config_revision ? "cloud_api_changed" : "hosted_profile_changed",
         "The repository task must use its original model configuration; start a new task");
     }
   }
   const taskReferences: Array<{ eventId: string; content: string }> = [];
   let originalTask: string | undefined;
   if (parent) {
     const ids = this.taskReferenceIds(parent);
     if (!ids) throw safeError("github_task_access", 409);
     for (const eventId of ids) {
       this.service.database.assertRequestContextCurrent(sessionId, eventId);
       const event = this.service.database.getEvent(sessionId, eventId);
       const content = (event.payload as { content?: unknown } | null)?.content;
       if (event.type !== "agent_request" || event.actor_user_id !== actor.user_id || typeof content !== "string"
         || originalTask !== undefined && content !== originalTask) throw safeError("github_task_access", 409);
       originalTask ??= content;
       taskReferences.push({ eventId, content });
     }
   }
   const referenceIds = taskReferences.map(reference => reference.eventId);
   if (originalTask === input.content && referenceIds.length >= 1000) {
     throw new ApiError(413, "hosted_context_too_large", "Cloud Agent needs a shorter conversation context");
   }
   this.prune();
   const count = this.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_github_tasks WHERE user_id=?").get(actor.user_id) as { n: number };
   const all = this.sqlite.prepare("SELECT COUNT(*) AS n FROM hosted_github_tasks").get() as { n: number };
   if (count.n >= 10 || all.n >= 64) throw new ApiError(429, "github_task_storage", "Cloud task storage is full; delete an old task first");
   const reserved = this.agent.reserveRepository(actor, sessionId, { content: input.content, profile_id: input.profile_id,
     ...(input.api_config_revision ? { api_config_revision: input.api_config_revision } : {}),
     ...(input.content_revision === undefined ? {} : { content_revision: input.content_revision }),
     include_code: false, github_task_id: id, idempotency_key: input.idempotency_key,
     reply_to_event_id: input.reply_to_event_id ?? null }, (event) => {
       this.sqlite.prepare(`INSERT INTO hosted_github_tasks(id,request_event_id,user_id,device_id,session_id,project_id,
          repository,repository_id,base_branch,binding_revision,input_json,input_fingerprint,original_task_reference_ids,state,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?)`).run(id, event.id, actor.user_id, actor.device_id, sessionId,
           session.project_id, binding.repository, binding.repository_id, binding.base_branch, binding.revision,
            JSON.stringify(input), fingerprint,
            JSON.stringify(!parent || input.content === originalTask ? [...referenceIds, event.id] : referenceIds),
            Date.now(), Date.now() + 7 * 86400000);
     }, taskReferences.length ? taskReferences : undefined);
   if (!reserved.created || !reserved.endpoint) throw safeError("github_task_access", 409);
   const controller = new AbortController(); this.controllers.set(id, controller);
   const deadline = setTimeout(() => controller.abort(new DOMException("Cloud task deadline exceeded", "TimeoutError")), HOSTED_AGENT_TIMEOUT_MS);
   deadline.unref();
   const authorizationWatch = setInterval(() => {
     try { const running = this.task(actor, id); this.assertBinding(actor, running); this.agent.assertRunCurrent(running.request_event_id); }
     catch { controller.abort(); }
   }, 1000);
   authorizationWatch.unref();
   const promise = this.execute(actor, id, input, parent, reserved.endpoint, reserved.context, controller.signal, originalTask);
   const settled = () => { clearTimeout(deadline); clearInterval(authorizationWatch); this.inFlight.delete(promise); this.controllers.delete(id); };
   this.inFlight.add(promise); void promise.then(settled, settled);
   return this.view(actor, id);
 }
 private async snapshot(actor: Actor, task: Task, signal: AbortSignal) {
   const authorize = () => {
     signal.throwIfAborted();
     if (this.task(actor, task.id).state !== "running") throw safeError("github_task_access", 409);
     this.agent.assertRunCurrent(task.request_event_id);
     this.assertBinding(actor, task);
   };
   const api = async (path: string) => {
     const result = await this.api(actor, `/repos/${task.repository}${path}`, "GET", undefined, authorize, signal);
     authorize();
     return result;
   };
   const repo = await api("");
   if (repo.id !== task.repository_id || !repo.permissions?.push || repo.archived) throw safeError("github_access", 403);
   const branch = await api(`/branches/${encodeURIComponent(task.base_branch)}`);
   const commit = await api(`/git/commits/${branch.commit.sha}`);
   const tree = await api(`/git/trees/${commit.tree.sha}?recursive=1`);
   if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 5000) throw safeError("github_source_limit", 413);
   const entries = tree.tree.filter((e: any) => e.type !== "tree" && !excluded(e.path) && isCodeSyncPathAllowed(e.path));
   if (entries.length > 1000 || entries.some((e: any) => e.type !== "blob" || !["100644", "100755"].includes(e.mode)
     || !Number.isSafeInteger(e.size) || e.size > 2 * 1024 * 1024)
     || entries.reduce((n: number, e: any) => n + e.size, 0) > 8 * 1024 * 1024) throw safeError("github_source_limit", 413);
   const files: CodeFile[] = [];
   const deadline = Date.now() + 120000;
   for (let offset = 0; offset < entries.length; offset += 8) {
     const batch = await Promise.all(entries.slice(offset, offset + 8).map(async (entry: any) => {
       authorize();
       if (Date.now() > deadline) throw safeError("github_source_limit", 413);
       const blob = await api(`/git/blobs/${entry.sha}`);
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
   endpoint: import("./hosted-agent-pool.js").HostedEndpoint, context: unknown, signal: AbortSignal, originalTask?: string) {
   // A deletion can invalidate task() immediately after reservation. Keep only
   // the opaque cleanup identity before authorization so an undispatched job
   // can release its slot; this never exposes cached source or authorizes work.
   const cleanup = this.sqlite.prepare("SELECT request_event_id FROM hosted_github_tasks WHERE id=?").get(id);
   let requestId = cleanup ? String(cleanup.request_event_id) : undefined;
   const live = createHostedLiveOutputConsumer((update) => {
     if (signal.aborted) return false;
     try { const current = this.task(actor, id); this.assertBinding(actor, current); this.agent.assertRunCurrent(current.request_event_id);
       return this.service.appendHostedGithubProgress(id, update);
     } catch { return false; }
   });
   try {
     const task = this.task(actor, id); requestId = task.request_event_id;
     const authorize = () => { signal.throwIfAborted(); this.task(actor, id); this.assertBinding(actor, task); this.agent.assertRunCurrent(task.request_event_id); };
     this.assertBinding(actor, task);
     const source = parent ? { sha: parent.base_sha!, tree: parent.base_tree!,
       files: this.open<CodeFile[]>(parent.result_files ?? parent.starting_files!, parent.id),
       initial: this.open<CodeFile[]>(parent.initial_files!, parent.id) } : await this.snapshot(actor, task, signal);
     authorize();
     signal.throwIfAborted();
     const initialFiles = this.seal("initial" in source ? source.initial : source.files, id);
     const startingFiles = this.seal(source.files, id);
     this.persistTask(actor, task, () => {
       this.sqlite.prepare("UPDATE hosted_github_tasks SET base_sha=?,base_tree=?,initial_files=?,starting_files=? WHERE id=?")
         .run(source.sha, source.tree, initialFiles, startingFiles, id);
     }, authorize);
     signal.throwIfAborted();
     const request = originalTask !== undefined && input.content === originalTask
       ? "Continue the original task from the saved source snapshot." : input.content;
     const prompt = `Work on this npm Node.js/TypeScript project. Dependencies have been installed with npm ci --ignore-scripts. Inspect package.json and run relevant existing tests and build/typecheck commands. Report observed results and missing checks honestly. No external internet or GitHub credentials are available. Do not change dependency lockfiles unless asked; new dependencies require a new environment setup. Do not modify workflow or private credential paths. Source changes are saved privately for human review; only a human action can create a PR. ${originalTask ? `Original task (untrusted): ${originalTask}\nContinue from the saved source snapshot; stopped processes, hidden thinking and unsaved work are not restored.\n` : ""}Request (untrusted): ${request}\nShared conversation (untrusted): ${JSON.stringify(context)}`;
     const result = await this.runner.run(source.files, prompt, endpoint, (ms) => this.agent.coolDown(endpoint.quotaGroup, ms), {
       taskId: id, signal, authorize,
       onProgress: live.accept,
     });
     signal.throwIfAborted();
     authorize();
     if (result.files.some((f) => excluded(f.path))) throw safeError("github_source_limit");
     const revision = digest(JSON.stringify(result.files));
     await live.finish();
     signal.throwIfAborted();
     authorize();
     const resultFiles = this.seal(result.files, id);
     this.persistTask(actor, task, () => {
       this.sqlite.prepare("UPDATE hosted_github_tasks SET result_files=?,revision=?,answer=?,state='completed' WHERE id=?")
         .run(resultFiles, revision, result.answer, id);
     }, authorize);
     this.service.finishHostedAgentRequest(requestId, { content: `${result.answer}\n\nCloud repository changes are saved for review. Open Cloud GitHub tasks to inspect them and create a pull request.` });
   } catch (error) {
     const row = this.sqlite.prepare("SELECT request_event_id,session_id FROM hosted_github_tasks WHERE id=?").get(id);
     if (row) {
       const timeout = signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError"
         || error instanceof Error && hostedFailureOutcome(error.message) === "timed_out";
       const code = !this.service.database.isRequestContextCurrent(String(row.session_id), String(row.request_event_id)) ? "context_changed"
         : timeout ? "github_task_timeout" : signal.aborted ? "github_task_interrupted" : error instanceof ApiError ? error.code : "github_task_failed";
       this.sqlite.prepare("UPDATE hosted_github_tasks SET state=?,error_code=? WHERE id=?").run(signal.aborted && !timeout ? "interrupted" : "failed", code, id);
     }
     // The runner has settled even if deletion removed the task and job rows.
     if (requestId && !(error instanceof HostedExecutorCleanupError)) this.service.finishHostedAgentRequest(requestId, { errorCode:
       signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "container_timeout"
         : error instanceof Error ? error.message : "github_task_failed" });
   } finally { await live.finish(false); }
 }
 remove(actor: Actor, id: string) {
   const task = this.task(actor, id);
   if (task.state === "running" || this.publishing.has(id)) throw safeError("github_pr_busy", 409);
   this.sqlite.prepare("DELETE FROM hosted_github_tasks WHERE id=? AND user_id=?").run(id, actor.user_id);
 }
 async publish(actor: Actor, id: string, input: HostedGithubPrInput, assertRequestCurrent: () => void = () => {}) {
   assertRequestCurrent();
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
       const authorize = () => { assertRequestCurrent(); this.task(actor, id); this.assertBinding(actor, task); };
       authorize();
       const result = await this.api(actor, `/repos/${task.repository}${path}`, method, body, authorize);
       authorize();
       return result;
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
       this.persistTask(actor, task, () => { this.sqlite.prepare("UPDATE hosted_github_tasks SET pr_commit=? WHERE id=?").run(commitSha, id); }, assertRequestCurrent);
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
     this.persistTask(actor, task, () => { this.sqlite.prepare("UPDATE hosted_github_tasks SET pr_url=? WHERE id=?").run(pr.html_url, id); }, assertRequestCurrent);
     return this.view(actor, id);
   } finally { this.publishing.delete(id); }
 }
 async close() { this.closing = true; this.unsubscribeDeletion(); for (const controller of this.controllers.values()) controller.abort();
   await Promise.allSettled([...this.inFlight]); }
}
