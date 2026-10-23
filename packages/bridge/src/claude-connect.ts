import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { redactText } from "@gatherthread/adapters";
import { GitHubBranchSchema, GitHubProjectStatusSchema, GitHubRepositorySchema } from "@gatherthread/protocol";
import { ClaudeCodeProjectHarness } from "./claude-code-project-harness.js";
import { ProjectLocalSyncRegistry, runProjectConnector } from "./codex-connect.js";
import { ProjectCodeSync } from "./code-sync.js";
import { createGitHubCodeSync } from "./github-code-sync.js";
import { connectGitHubAccount } from "./github-auth.js";
import { resolveDeviceCredential } from "./device-credential.js";
import { HttpCollaborationClient } from "./http-client.js";
import { LocalConnectorApiRelayServer, resolveWorkspaceConnectorApiPath } from "./local-api-relay.js";
import { ensureProjectWorkspace } from "./project-workspace.js";
import type { ProjectSummary } from "./types.js";

export interface ClaudeConnectOptions {
  apiUrl: string; workspacePath: string; model: string; projectId?: string; claudeCommand: string;
  permissionMode: "native" | "manual" | "plan"; effort?: "low" | "medium" | "high" | "xhigh" | "max";
  createWorkspace: boolean; pluginHooks: boolean; codeSync: boolean; githubCodeSync?: string;
  githubBaseBranch: string; preflightOnly: boolean; shareToolEvents: boolean;
}
const HELP = `GatherThread Claude Code connector

Usage:
  gatherthread-claude-connect --url <origin> --model <exact-model-id> [options]
  npm run claude:connect -- --url <origin> --model <exact-model-id> [options]

Options:
  --url <url>                 HTTPS server origin or /v1 (loopback HTTP allowed)
  --model <id>                Required exact Claude model ID, never an alias or fallback
  --project <id>              Accessible project; otherwise choose interactively
  --workspace <path>          Authorized local workspace (default: current directory)
  --create-workspace          Create/reuse the project's GatherThread Projects folder
  --claude-command <path>     Existing Claude Code executable (default: claude)
  --permission-mode <mode>    native (default), manual or plan; native keeps local settings
  --effort <effort>           low, medium, high, xhigh or max; applied exactly
  --plugin-hooks             Enable explicitly installed/reviewed native plugin hooks
  --code-sync                Authorize GT Cloud file sync separately (requires hooks)
  --github-code-sync <slug>   Authorize exact owner/repository GitHub sync (requires hooks)
  --github-base-branch <name> Exact configured GitHub base branch (default: main)
  --no-share-tool-events     Share final answer only, not redacted native tool work
  --preflight-only           Check server/project/local CLI/login without model calls
  --help                     Show help

Use the website's Connect Claude Code and Launcher: email/environment are filled
in, and you enter your password only in the Launcher. Advanced terminal setup
uses a one-use Web device authorization in a hidden prompt. No password/token
argument is accepted. Existing private Launcher credentials use GATHERTHREAD_TOKEN
inside this connector only; they are never passed to Claude or user MCP.
`;

export function parseClaudeConnectArgs(argv: readonly string[]): ClaudeConnectOptions | "help" {
  if (argv.includes("--help")) return "help";
  const values = new Map<string, string>(), flags = new Set<string>();
  const booleanFlags = new Set(["--create-workspace", "--plugin-hooks", "--code-sync", "--preflight-only", "--no-share-tool-events"]);
  const valueFlags = new Set(["--url", "--model", "--project", "--workspace", "--claude-command", "--permission-mode", "--effort", "--github-code-sync", "--github-base-branch"]);
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!;
    if (booleanFlags.has(option)) { if (flags.has(option)) throw new Error(`Repeated option ${option}`); flags.add(option); }
    else if (valueFlags.has(option)) {
      const value = argv[++index];
      if (!value || value.startsWith("--") || values.has(option) || /[\r\n\0]/u.test(value)) throw new Error(`Invalid value for ${option}`);
      values.set(option, value);
    } else throw new Error("Unknown Claude connector option; use --help. Credentials are never command arguments.");
  }
  const model = values.get("--model") ?? "";
  if (!/^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(model)) throw new Error("--model requires an exact Claude model ID, not an alias or proxy route");
  const rawUrl = values.get("--url");
  if (!rawUrl) throw new Error("--url is required");
  const url = new URL(rawUrl);
  if (url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)
    || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Use a credential-free HTTPS server origin or loopback HTTP");
  const permissionMode = values.get("--permission-mode") ?? "native";
  if (!["native", "manual", "plan"].includes(permissionMode)) throw new Error("Permission mode must be native, manual or plan");
  const effort = values.get("--effort");
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("Unsupported Claude effort");
  const projectId = values.get("--project");
  if (projectId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(projectId)) throw new Error("Invalid project ID");
  const codeSync = flags.has("--code-sync"), githubCodeSync = values.get("--github-code-sync");
  if ((codeSync || githubCodeSync) && !flags.has("--plugin-hooks")) throw new Error("File synchronization requires explicitly reviewed --plugin-hooks for native busy-state tracking");
  if (githubCodeSync) GitHubRepositorySchema.parse(githubCodeSync);
  const githubBaseBranch = GitHubBranchSchema.parse(values.get("--github-base-branch") ?? "main");
  return { apiUrl: `${url.origin}/v1`, workspacePath: path.resolve(values.get("--workspace") ?? process.cwd()), model,
    ...(projectId ? { projectId } : {}), claudeCommand: values.get("--claude-command") ?? "claude", permissionMode: permissionMode as ClaudeConnectOptions["permissionMode"],
    ...(effort ? { effort: effort as NonNullable<ClaudeConnectOptions["effort"]> } : {}),
    createWorkspace: flags.has("--create-workspace"), pluginHooks: flags.has("--plugin-hooks"), codeSync,
    ...(githubCodeSync ? { githubCodeSync } : {}), githubBaseBranch, preflightOnly: flags.has("--preflight-only"),
    shareToolEvents: !flags.has("--no-share-tool-events") };
}

export async function runClaudeConnectCli(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = parseClaudeConnectArgs(argv);
  if (options === "help") { process.stdout.write(HELP); return; }
  const authorization = env.GATHERTHREAD_TOKEN?.trim() || await readSecret();
  const token = await resolveDeviceCredential(authorization, options.apiUrl);
  try {
    const api = new HttpCollaborationClient({ baseUrl: options.apiUrl, bearerToken: token });
    const actor = await api.getCurrentActor();
    const project = await selectProject((await api.listProjects()).filter(item => item.state === "active"), options.projectId);
    const workspacePath = await realpath(options.createWorkspace ? await ensureProjectWorkspace({ apiUrl: options.apiUrl,
      projectId: project.id, projectName: project.name }) : options.workspacePath);
    if (!(await lstat(workspacePath)).isDirectory()) throw new Error("Workspace must be an existing directory");
    const mapping = createHash("sha256").update([options.apiUrl, actor.deviceId, project.id, workspacePath].join("\0")).digest("hex").slice(0, 24);
    const stateRoot = path.join(homedir(), ".gatherthread", "claude-code", mapping);
    await privateDirectory(stateRoot);
    const shutdown = new AbortController(), stop = () => shutdown.abort(new Error("Claude connector stopped"));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const harness = new ClaudeCodeProjectHarness({ workspacePath, stateRoot, model: options.model, command: options.claudeCommand,
      permissionMode: options.permissionMode, ...(options.effort ? { reasoningEffort: options.effort } : {}),
      shareToolEvents: options.shareToolEvents, signal: shutdown.signal, env });
    const localSync = new ProjectLocalSyncRegistry(api);
    let codeSync: ProjectCodeSync | undefined, githubCodeSync: ProjectCodeSync | undefined;
    const relay = new LocalConnectorApiRelayServer({ endpoint: resolveWorkspaceConnectorApiPath(workspacePath, homedir(), process.platform, "claude-code"),
      api, projectId: project.id, harness: "claude-code", localSync,
      requestProfile: sessionId => {
        try { return localSync.getExecutionProfile(sessionId); }
        catch { throw new Error("Claude Code is not yet connected to this conversation; wait for registration or reconnect the Launcher"); }
      },
      codeSyncStatus: async () => ({ gt_cloud: codeSync ? await codeSync.status() : { authorized: false },
        github: githubCodeSync ? await githubCodeSync.status() : { authorized: false } }) });
    const nativeHookRelay = options.pluginHooks ? new ClaudeNativeHookRelay({ workspacePath, onEvent: event => harness.handleNativeHook(event,
      { api, actorUserId: actor.id, actorDeviceId: actor.deviceId, project }) }) : undefined;
    try {
      await relay.start();
      const preflight = await harness.preflight();
      process.stdout.write(`Claude Code ready: ${oneLine(preflight.version)}; ${oneLine(preflight.authentication)}\nWorkspace: ${preflight.workspacePath}\n`);
      if (options.preflightOnly) { process.stdout.write("Preflight complete; no session runtime was registered, no Agent request was claimed and no model was called.\n"); return; }
      codeSync = options.codeSync ? new ProjectCodeSync({ apiUrl: options.apiUrl, token, projectId: project.id, actorId: actor.id, workspacePath }) : undefined;
      if (options.githubCodeSync) {
        const response = await fetch(`${options.apiUrl}/projects/${encodeURIComponent(project.id)}/github`, {
          headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
        const state = GitHubProjectStatusSchema.parse(await boundedJson(response));
        if (!state.can_write || !state.connection?.enabled || state.connection.repository.toLowerCase() !== options.githubCodeSync.toLowerCase()
          || state.connection.base_branch !== options.githubBaseBranch) throw new Error("GitHub authorization must match the current project repository and base branch");
        await connectGitHubAccount();
        githubCodeSync = createGitHubCodeSync({ apiUrl: options.apiUrl, token, projectId: project.id, actorId: actor.id, workspacePath,
          repository: options.githubCodeSync, baseBranch: options.githubBaseBranch, revision: state.connection.revision });
      }
      process.stdout.write(`GatherThread project: ${oneLine(project.name)}. Keep the Launcher/connector running.\n`);
      if (options.pluginHooks) process.stdout.write("Native plugin hooks enabled only after your Claude review. Per-conversation automatic upload starts off; enable it explicitly or upload completed turns manually.\n");
      await runProjectConnector({ api, actorUserId: actor.id, actorDeviceId: actor.deviceId, project, stateRoot, harness,
        signal: shutdown.signal, token, hookSocketPath: "", hookSpoolPath: "", hookRegistryPath: "", hookWorkspacePath: workspacePath,
        hookMode: "disabled", localSync, ...(nativeHookRelay ? { nativeHookRelay } : {}),
        ...(codeSync ? { codeSync } : {}), ...(githubCodeSync ? { githubCodeSync } : {}) });
    } finally { await nativeHookRelay?.close(); await relay.close(); await harness.close();
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } catch (error) { throw new Error(redactText((error instanceof Error ? error.message : "Claude connection failed").replaceAll(token, "[REDACTED]").replaceAll(authorization, "[REDACTED]"))); }
}

export async function runClaudeConnectMain(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try { await runClaudeConnectCli(argv, env); }
  catch (error) { process.stderr.write(`gatherthread-claude: ${oneLine(redactText(error instanceof Error ? error.message : "Connection failed"))}\n`); process.exitCode = 1; }
}

/** Private, explicitly enabled Hook transport. Only the harness may verify an opted-in exact turn proof. */
interface ClaudeNativeHookResult { additionalContext?: string; block?: boolean; reason?: string }
const CLAUDE_WORKSPACE_BUSY_REASON = "GatherThread is syncing local files or running a remote Claude request. Wait for it to finish, then submit again.";
export class ClaudeNativeHookRelay {
  readonly #options: { workspacePath: string; homeDirectory?: string; onEvent(event: unknown): Promise<ClaudeNativeHookResult> };
  readonly #capability = randomBytes(32).toString("base64url");
  #server: net.Server | undefined; #directory = ""; #endpoint = ""; #active = 0;
  constructor(options: { workspacePath: string; homeDirectory?: string; onEvent(event: unknown): Promise<ClaudeNativeHookResult> }) { this.#options = options; }
  async start(): Promise<void> {
    if (this.#server) return;
    const workspacePath = await realpath(this.#options.workspacePath);
    const id = createHash("sha256").update(process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath).digest("hex").slice(0, 24);
    this.#directory = path.join(this.#options.homeDirectory ?? homedir(), ".gatherthread", "claude-code", "hooks", id);
    await privateDirectory(this.#directory, path.join(this.#options.homeDirectory ?? homedir(), ".gatherthread"));
    this.#endpoint = process.platform === "win32" ? `\\\\.\\pipe\\gatherthread-claude-code-${id}-hook-relay` : path.join(this.#directory, "hook-relay.sock");
    if (process.platform !== "win32") {
      const old = await lstat(this.#endpoint).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (old) { if (!old.isSocket()) throw new Error("Refusing non-socket Claude Hook endpoint");
        const active = await new Promise<boolean>((resolve, reject) => { const probe = net.createConnection(this.#endpoint);
          probe.setTimeout(500, () => probe.destroy(new Error("Hook probe timeout")));
          probe.once("connect", () => { probe.destroy(); resolve(true); });
          probe.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" || error.code === "ENOENT" ? resolve(false) : reject(error)); });
        if (active) throw new Error("Another Claude Hook connector is active"); await unlink(this.#endpoint); }
    }
    const server = net.createServer(socket => {
      if (++this.#active > 16) { this.#active--; socket.destroy(); return; }
      socket.once("close", () => this.#active--); socket.on("error", () => undefined); socket.setTimeout(4500, () => socket.destroy());
      let data = "", handling = false; socket.setEncoding("utf8");
      socket.on("data", chunk => {
        if (handling) { socket.destroy(); return; } data += chunk;
        if (Buffer.byteLength(data) > 1048576) { socket.destroy(); return; }
        const newline = data.indexOf("\n"); if (newline < 0) return; handling = true;
        void (async () => { try {
          const request = JSON.parse(data.slice(0, newline)), candidate = Buffer.from(typeof request.capability === "string" ? request.capability : ""), expected = Buffer.from(this.#capability);
          if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new Error();
          const event = normalizeClaudeNativeHookEvent(request.event, workspacePath);
          const result = await this.#options.onEvent(event);
          // An explicit conflict from the trusted harness is the only blocking
          // response. Never echo arbitrary diagnostics, paths or queued context.
          if (event.hook_event_name === "UserPromptSubmit" && result.block === true) {
            socket.end(JSON.stringify({ block: true, reason: CLAUDE_WORKSPACE_BUSY_REASON }) + "\n"); return;
          }
          if (event.hook_event_name !== "UserPromptSubmit") { socket.end("{}\n"); return; }
          if (result.additionalContext !== undefined && Buffer.byteLength(result.additionalContext) > 65536) throw new Error();
          socket.end(JSON.stringify(result.additionalContext === undefined ? {} : { additionalContext: result.additionalContext }) + "\n");
        } catch { socket.end("{}\n"); } })();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.#endpoint, () => { server.removeListener("error", reject); resolve(); }); });
    this.#server = server;
    try { if (process.platform !== "win32") await chmod(this.#endpoint, 0o600);
      const target = path.join(this.#directory, "hook-registry.json"), temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, workspacePath, hookSource: "plugin", capability: this.#capability }), { mode: 0o600, flag: "wx" });
      await rename(temporary, target); if (process.platform !== "win32") await chmod(target, 0o600);
    } catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    const server = this.#server; this.#server = undefined; if (!server) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const registry = path.join(this.#directory, "hook-registry.json");
    const current = await readFile(registry, "utf8").then(value => JSON.parse(value)).catch(() => undefined);
    if (current?.capability === this.#capability) await unlink(registry).catch(() => undefined);
    if (process.platform !== "win32") await unlink(this.#endpoint).catch(() => undefined);
  }
}
export function normalizeClaudeNativeHookEvent(input: unknown, workspacePath: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Claude Hook event");
  const raw = input as Record<string, unknown>;
  if (raw.cwd !== workspacePath || typeof raw.session_id !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(raw.session_id)
    || typeof raw.hook_event_name !== "string" || !["UserPromptSubmit", "Stop", "SessionStart", "PostModelSwitch", "StopFailure", "SessionEnd"].includes(raw.hook_event_name)) throw new Error("Unbound Claude Hook event");
  const event: Record<string, unknown> = { hook_event_name: raw.hook_event_name, session_id: raw.session_id, cwd: workspacePath };
  if (raw.hook_event_name === "UserPromptSubmit") {
    if (typeof raw.prompt !== "string" || !raw.prompt.trim() || Buffer.byteLength(raw.prompt) > 65536) throw new Error("Invalid Claude public prompt");
    event.prompt = raw.prompt;
  } else if (raw.hook_event_name === "Stop") {
    if (typeof raw.last_assistant_message === "string" && Buffer.byteLength(raw.last_assistant_message) <= 128 * 1024) event.last_assistant_message = raw.last_assistant_message;
    event.stop_hook_active = raw.stop_hook_active === true;
    if (raw.transcript_path !== undefined) {
      if (typeof raw.transcript_path === "string" && raw.transcript_path.length <= 4096 && !/[\r\n\0]/u.test(raw.transcript_path)
        && path.isAbsolute(raw.transcript_path)) event.transcript_path = raw.transcript_path;
    }
  } else if (raw.hook_event_name === "SessionStart") {
    if (typeof raw.model === "string" && /^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(raw.model)) event.model = raw.model;
    if (typeof raw.source === "string" && raw.source.length <= 32) event.source = raw.source;
  } else if (raw.hook_event_name === "PostModelSwitch") {
    if (typeof raw.to_model !== "string" || !/^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(raw.to_model)) throw new Error("Invalid Claude model metadata");
    event.to_model = raw.to_model;
  }
  return event;
}
async function privateDirectory(directory: string, privateRoot = path.join(homedir(), ".gatherthread")): Promise<void> {
  const root = path.resolve(privateRoot), target = path.resolve(directory), relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
    || await realpath(path.dirname(root)) !== path.dirname(root)) throw new Error("Claude connector state must stay under its canonical private root");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let current = root;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || uid !== undefined && stat.uid !== uid
      || await realpath(current) !== current) throw new Error("Claude connector state must use owned private directories without ancestor links");
    if (process.platform !== "win32") await chmod(current, 0o700);
    const verified = await lstat(current);
    if (verified.dev !== stat.dev || verified.ino !== stat.ino || verified.isSymbolicLink()) throw new Error("Claude connector state directory changed during verification");
  }
}
async function selectProject(projects: ProjectSummary[], id?: string): Promise<ProjectSummary> {
  if (id) { const selected = projects.find(item => item.id === id); if (!selected) throw new Error("Requested project is unavailable"); return selected; }
  if (projects.length === 1) return projects[0]!;
  if (!projects.length || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Pass --project for an accessible project");
  projects.forEach((project, index) => process.stdout.write(`${index + 1}. ${oneLine(project.name)} [${project.role}]\n`));
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { const choice = Number(await input.question("Choose a project number: ")) - 1;
    if (!Number.isInteger(choice) || !projects[choice]) throw new Error("Invalid project selection"); return projects[choice]!; } finally { input.close(); }
}
function readSecret(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) throw new Error("Use the Launcher or a hidden interactive device-authorization prompt");
  const previousRaw = process.stdin.isRaw === true;
  process.stdout.write("GatherThread one-use device authorization (hidden): "); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => { let value = "", finished = false;
    const cleanup = () => { if (finished) return; finished = true; process.stdin.removeListener("data", data);
      process.stdin.removeListener("end", ended); process.stdin.removeListener("error", ended);
      process.removeListener("SIGINT", cancelled); process.removeListener("SIGTERM", cancelled);
      try { process.stdin.setRawMode(previousRaw); } catch { /* A closed TTY cannot be restored; no secret is echoed. */ }
      process.stdin.pause(); };
    const ended = () => { cleanup(); reject(new Error("Authorization input closed")); };
    const cancelled = () => { cleanup(); reject(new Error("Authorization cancelled")); };
    const data = (chunk: Buffer | string) => { for (const character of chunk.toString()) {
      if (character === "\u0003") { cleanup(); reject(new Error("Authorization cancelled")); return; }
      if (character === "\r" || character === "\n") { cleanup(); process.stdout.write("\n"); resolve(value); return; }
      if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
      else if (value.length < 1024) value += character; else { cleanup(); reject(new Error("Authorization is too long")); return; }
    } }; process.stdin.on("data", data); process.stdin.once("end", ended); process.stdin.once("error", ended);
    process.once("SIGINT", cancelled); process.once("SIGTERM", cancelled); });
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Could not verify GitHub project settings"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
    if (bytes > 16384) { await reader.cancel(); throw new Error("GitHub settings response is too large"); } chunks.push(chunk.value); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
}
function oneLine(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " "); }
