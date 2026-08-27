#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactText } from "@gatherthread/adapters";
import { LocalBridge } from "./bridge.js";
import { CodexProjectHarness, codexSessionKey } from "./codex-app-server.js";
import {
  CodexHookRelayServer,
  drainCodexHookSpool,
  installCodexHookConfig,
  isAllowedCodexHookEvent,
  renderCodexHookConfig,
  updateCodexHookRegistry,
  type CodexHookEvent,
} from "./codex-hooks.js";
import { validateCodexWorkspace, type CodexSandboxMode } from "./codex-executor.js";
import { FileCursorStore } from "./cursors.js";
import { CollaborationHttpError, HttpCollaborationClient } from "./http-client.js";
import { withoutGatherThreadCredentials } from "./executor.js";
import { ensureProjectWorkspace } from "./project-workspace.js";
import type {
  ProjectHarnessAdapter,
  ProjectHarnessDeactivationReason,
  ProjectHarnessSessionBinding,
} from "./project-harness.js";
import type { CollaborationApi, HarnessExecutor, ProjectSummary, SessionSummary } from "./types.js";

interface CodexConnectOptions {
  apiUrl: string;
  workspacePath: string;
  model: string;
  projectId?: string;
  createWorkspace: boolean;
  sandbox: CodexSandboxMode;
  codexCommand: string;
  shareToolEvents: boolean;
  resetCodexSession: boolean;
  installHooks: boolean;
}

export type CodexDesktopRevealResult =
  | { status: "skipped" }
  | { status: "opened" }
  | { status: "failed"; error: Error };

export type CodexDesktopThreadLaunchResult =
  | { status: "launched" }
  | { status: "failed"; error: Error };

type CodexDesktopPlatform = NodeJS.Platform;

interface DesktopRevealChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

type DesktopRevealSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["ignore", "ignore", "ignore"];
    windowsHide: boolean;
  },
) => DesktopRevealChild;

const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const HELP = `GatherThread Codex connector

Usage:
  npm run codex:connect -- --url <GatherThread URL> [options]

Options:
  --url <url>              GatherThread HTTPS origin or /v1 API URL (required)
  --workspace <path>       Local project Codex may access (default: current directory)
  --model <model>          Codex model (default: gpt-5.6-sol)
  --project <id>           Project ID; otherwise choose from your writable projects
  --create-workspace       Create/reuse ~/GatherThread Projects/<project name>
  --sandbox <mode>         workspace-write or read-only (default: workspace-write)
  --codex-command <path>   Codex executable (default: codex)
  --no-share-tool-events   Share only the final Codex answer, not redacted tool events
  --reset-codex-session    Reset all local Codex App Server threads for this project binding
  --install-hooks          Enable trusted direct-desktop publishing via reviewed project hooks
  --help                   Show this help

The device access token is read from GATHERTHREAD_TOKEN when set. Otherwise it
is requested using a hidden terminal prompt. It is kept only in this process
and is never passed to Codex, written to the session state, or printed. Each
writable session uses a Desktop-owned task for trusted local hooks and a separate
exec-source background projection for Web requests and canonical hydration.
`;

export async function runCodexConnectCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseCodexConnectArgs(argv);
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }
  const token = env.GATHERTHREAD_TOKEN?.trim() || await readSecret("GatherThread device access token: ");
  if (!token || /[\r\n]/.test(token)) throw new Error("A valid GatherThread device access token is required");

  const api = new HttpCollaborationClient({
    baseUrl: parsed.apiUrl,
    bearerToken: token,
  });
  const actor = await api.getCurrentActor();
  const projects = (await api.listProjects()).filter((project) => project.state === "active");
  const selected = await selectProject(projects, parsed.projectId);
  const workspacePath = parsed.createWorkspace
    ? await ensureProjectWorkspace({
      apiUrl: parsed.apiUrl,
      projectId: selected.id,
      projectName: selected.name,
    })
    : parsed.workspacePath;
  const mappingId = createHash("sha256")
    .update([parsed.apiUrl, actor.deviceId, selected.id, path.resolve(workspacePath)].join("\0"))
    .digest("hex")
    .slice(0, 24);
  const stateRoot = path.join(homedir(), ".gatherthread", "codex", mappingId);
  if (parsed.resetCodexSession) await rm(stateRoot, { recursive: true, force: true });
  const codexCommand = await resolveCodexCommand(parsed.codexCommand, env);
  // Hook definitions are trusted by content hash. Keep every path embedded in
  // hooks.json stable for a workspace so switching GatherThread projects or
  // credentials does not silently invalidate the user's Codex approval.
  const { hookSocketPath, hookSpoolPath, hookRegistryPath } = resolveWorkspaceCodexHookPaths(workspacePath);
  if (!parsed.installHooks) {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await writeFile(hookRegistryPath, `${JSON.stringify({
      version: 1,
      workspacePath: path.resolve(workspacePath),
      threads: {},
    }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write("Desktop local-turn sync is disabled. Re-run with --install-hooks and approve the definition with /hooks to enable it.\n");
  }
  if (parsed.installHooks) {
    const configPath = await installCodexHookConfig({
      workspacePath,
      config: renderCodexHookConfig({
        hookScriptPath: fileURLToPath(new URL("./codex-hook.js", import.meta.url)),
        socketPath: hookSocketPath,
        spoolPath: hookSpoolPath,
        registryPath: hookRegistryPath,
      }),
    });
    process.stdout.write(`Installed GatherThread project hooks: ${configPath}\nOpen Codex Desktop Settings and enable Hooks, then review this exact generated file before use.\n`);
  }

  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error("Codex connector shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const harness = new CodexProjectHarness({
      workspacePath,
      stateRoot,
      mappingId,
      projectName: selected.name,
      model: parsed.model,
      command: codexCommand,
      sandbox: parsed.sandbox,
      shareToolEvents: parsed.shareToolEvents,
      signal: shutdown.signal,
      env,
      ...(parsed.installHooks ? { hookRegistryPath, localTurnsEnabled: true } : { localTurnsEnabled: false }),
      revealThread: async (threadId) => {
        const revealed = await revealCodexDesktopThread({
          threadId,
          workspacePath,
          env,
        });
        if (revealed.status === "failed") {
          process.stderr.write(`gatherthread-codex: ${safeError(new Error(
            `Could not reveal the Desktop-owned Codex task (${revealed.error.message}); synchronization remains active and a connector restart can retry`,
          ), token)}\n`);
        }
        return revealed.status === "launched";
      },
    });
    try {
      const preflight = await harness.preflight();
      process.stdout.write(`Codex App Server ready: ${oneLine(preflight.version)}; ${oneLine(preflight.authentication)}\n`);
      process.stdout.write(`Workspace: ${preflight.workspacePath}\n`);
      const desktopReveal = await revealCodexDesktopProject({
        enabled: parsed.createWorkspace,
        command: codexCommand,
        workspacePath: preflight.workspacePath,
        env,
      });
      if (desktopReveal.status === "opened") {
        process.stdout.write(`Opened Codex Desktop project: ${safeError(new Error(preflight.workspacePath), token)}\n`);
      } else if (desktopReveal.status === "failed") {
        process.stderr.write(`gatherthread-codex: ${formatCodexDesktopRevealWarning(
          desktopReveal.error,
          preflight.workspacePath,
          token,
        )}\n`);
      }
      process.stdout.write(`GatherThread project: ${actor.displayName} -> ${selected.name} (${selected.role})\n`);
      process.stdout.write(selected.role === "viewer"
        ? "Snapshot-only mode: visible sessions are monitored for immutable snapshot jobs; no execution runtime is registered.\n"
        : "Project runtime is connecting each writable session with a Desktop-owned task and an isolated background execution projection. New sessions are discovered automatically.\n");
      process.stdout.write("Keep this terminal open; press Control-C to stop.\n");
      await runProjectConnector({
        api,
        actorUserId: actor.id,
        actorDeviceId: actor.deviceId,
        project: selected,
        stateRoot,
        harness,
        signal: shutdown.signal,
        token,
        hookSocketPath,
        hookSpoolPath,
        hookRegistryPath,
        hookWorkspacePath: preflight.workspacePath,
        hooksEnabled: parsed.installHooks,
      });
    } finally {
      await harness.close();
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function revealCodexDesktopProject(options: {
  enabled: boolean;
  command: string;
  workspacePath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnProcess?: DesktopRevealSpawn;
}): Promise<CodexDesktopRevealResult> {
  if (!options.enabled) return { status: "skipped" };
  let workspacePath: string;
  try {
    workspacePath = await validateCodexWorkspace(path.resolve(options.workspacePath));
  } catch {
    return { status: "failed", error: new Error("Codex Desktop project workspace is unavailable") };
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    return { status: "failed", error: new Error("Codex Desktop project reveal timeout is invalid") };
  }
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    spawn(command, [...args], spawnOptions) as unknown as DesktopRevealChild);
  let child: DesktopRevealChild;
  try {
    child = spawnProcess(options.command, ["app", workspacePath], {
      cwd: workspacePath,
      env: stripGatherThreadEnvironment(options.env ?? process.env),
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: false,
    });
  } catch {
    return { status: "failed", error: new Error("Codex Desktop project reveal could not be started") };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CodexDesktopRevealResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* The reveal remains fail-soft if the launcher already exited. */ }
      finish({ status: "failed", error: new Error(`Codex Desktop project reveal timed out after ${timeoutMs} ms`) });
    }, timeoutMs);
    child.once("error", () => {
      finish({ status: "failed", error: new Error("Codex Desktop project reveal could not be started") });
    });
    child.once("close", (code, signal) => {
      if (code === 0) finish({ status: "opened" });
      else finish({
        status: "failed",
        error: new Error(`Codex Desktop project reveal exited unsuccessfully (${signal ?? code ?? "unknown"})`),
      });
    });
  });
}

export async function revealCodexDesktopThread(options: {
  threadId: string;
  workspacePath: string;
  env?: NodeJS.ProcessEnv;
  platform?: CodexDesktopPlatform;
  timeoutMs?: number;
  spawnProcess?: DesktopRevealSpawn;
}): Promise<CodexDesktopThreadLaunchResult> {
  if (!CODEX_THREAD_ID_PATTERN.test(options.threadId)) {
    return { status: "failed", error: new Error("Codex Desktop task id is invalid") };
  }
  let workspacePath: string;
  try {
    workspacePath = await validateCodexWorkspace(path.resolve(options.workspacePath));
  } catch {
    return { status: "failed", error: new Error("Codex Desktop task workspace is unavailable") };
  }
  const platform = options.platform ?? process.platform;
  const url = `codex://threads/${options.threadId}`;
  const launcher = platform === "darwin"
    ? { command: "open", args: [url] }
    : platform === "win32"
      ? {
        command: options.env?.ComSpec?.trim() || process.env.ComSpec?.trim() || "cmd.exe",
        args: ["/d", "/s", "/c", "start", "", url],
      }
      : { command: "xdg-open", args: [url] };
  const launched = await launchCodexDesktopTarget({
    command: launcher.command,
    args: launcher.args,
    workspacePath,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
    failureLabel: "Codex Desktop task reveal",
  });
  if (launched.status === "opened") return { status: "launched" };
  if (launched.status === "failed") return launched;
  return { status: "failed", error: new Error("Codex Desktop task reveal was unexpectedly skipped") };
}

async function launchCodexDesktopTarget(options: {
  command: string;
  args: readonly string[];
  workspacePath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnProcess?: DesktopRevealSpawn;
  failureLabel: string;
}): Promise<CodexDesktopRevealResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    return { status: "failed", error: new Error(`${options.failureLabel} timeout is invalid`) };
  }
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    spawn(command, [...args], spawnOptions) as unknown as DesktopRevealChild);
  let child: DesktopRevealChild;
  try {
    child = spawnProcess(options.command, options.args, {
      cwd: options.workspacePath,
      env: stripGatherThreadEnvironment(options.env ?? process.env),
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    return { status: "failed", error: new Error(`${options.failureLabel} could not be started`) };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CodexDesktopRevealResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* The launcher remains fail-soft if it already exited. */ }
      finish({ status: "failed", error: new Error(`${options.failureLabel} timed out after ${timeoutMs} ms`) });
    }, timeoutMs);
    child.once("error", () => {
      finish({ status: "failed", error: new Error(`${options.failureLabel} could not be started`) });
    });
    child.once("close", (code, signal) => {
      if (code === 0) finish({ status: "opened" });
      else finish({
        status: "failed",
        error: new Error(`${options.failureLabel} exited unsuccessfully (${signal ?? code ?? "unknown"})`),
      });
    });
  });
}

export function formatCodexDesktopRevealWarning(error: Error, workspacePath: string, token: string): string {
  return safeError(new Error(
    `Could not open the Codex Desktop project (${error.message}); synchronization will continue. Open it manually: ${workspacePath}`,
  ), token);
}

function stripGatherThreadEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const baseline = withoutGatherThreadCredentials(env);
  return Object.fromEntries(Object.entries(baseline).filter(([name]) =>
    !name.toUpperCase().startsWith("GATHERTHREAD_"),
  ));
}

export function parseCodexConnectArgs(argv: readonly string[]): CodexConnectOptions | "help" {
  let url: string | undefined;
  let workspacePath = process.cwd();
  let model = "gpt-5.6-sol";
  let projectId: string | undefined;
  let sandbox: CodexSandboxMode = "workspace-write";
  let codexCommand = "codex";
  let shareToolEvents = true;
  let resetCodexSession = false;
  let installHooks = false;
  let createWorkspace = false;
  let workspaceSpecified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--no-share-tool-events") {
      shareToolEvents = false;
      continue;
    }
    if (argument === "--reset-codex-session") {
      resetCodexSession = true;
      continue;
    }
    if (argument === "--install-hooks") {
      installHooks = true;
      continue;
    }
    if (argument === "--create-workspace") {
      createWorkspace = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument ?? "option"} requires a value`);
    index += 1;
    if (argument === "--url") url = value;
    else if (argument === "--workspace") {
      workspacePath = value;
      workspaceSpecified = true;
    }
    else if (argument === "--model") model = value;
    else if (argument === "--project") projectId = value;
    else if (argument === "--codex-command") codexCommand = value;
    else if (argument === "--sandbox") {
      if (value !== "read-only" && value !== "workspace-write") {
        throw new Error("--sandbox must be read-only or workspace-write");
      }
      sandbox = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!url) throw new Error("--url is required; run with --help for an example");
  if (createWorkspace && workspaceSpecified) {
    throw new Error("--create-workspace cannot be combined with --workspace");
  }
  if (!model.trim() || model.length > 200 || model.startsWith("-") || /[\0\r\n]/.test(model)) {
    throw new Error("--model must be a valid non-empty model identifier");
  }
  if (!codexCommand.trim()) throw new Error("--codex-command must be non-empty");
  return {
    apiUrl: normalizeApiUrl(url),
    workspacePath: path.resolve(workspacePath),
    model,
    ...(projectId === undefined ? {} : { projectId }),
    createWorkspace,
    sandbox,
    codexCommand,
    shareToolEvents,
    resetCodexSession,
    installHooks,
  };
}

async function selectProject(
  projects: ProjectSummary[],
  requestedProjectId: string | undefined,
): Promise<ProjectSummary> {
  if (requestedProjectId) {
    const selected = projects.find((project) => project.id === requestedProjectId);
    if (!selected) throw new Error("The requested project is unavailable for this user");
    return selected;
  }
  if (projects.length === 0) throw new Error("No active GatherThread projects are available for this user");
  if (projects.length === 1) return projects[0] as ProjectSummary;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Multiple writable projects are available; pass --project <id>");
  }
  process.stdout.write("Accessible GatherThread projects:\n");
  projects.forEach((project, index) => {
    process.stdout.write(`  ${index + 1}. ${project.name} [${project.role}] (${project.id})\n`);
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question("Choose a project number: ");
    const index = Number(answer) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= projects.length) {
      throw new Error("Project selection is invalid");
    }
    return projects[index] as ProjectSummary;
  } finally {
    readline.close();
  }
}

interface ManagedSession {
  bridge: LocalBridge;
  executor: HarnessExecutor;
  lastHeartbeatAt: number;
  name: string;
  rename?: ProjectHarnessSessionBinding["rename"];
  readNativeName?: ProjectHarnessSessionBinding["readNativeName"];
  localRename?: ManagedLocalRename;
  suppressLocalRenameForCloudName?: string;
  synchronize?: ProjectHarnessSessionBinding["synchronize"];
  activateLocalPublishing?: ProjectHarnessSessionBinding["activateLocalPublishing"];
  deactivateLocalPublishing?: ProjectHarnessSessionBinding["deactivateLocalPublishing"];
  relayLocalHarnessEvent?: ProjectHarnessSessionBinding["relayLocalHarnessEvent"];
}

interface ManagedLocalRename {
  baseCloudName: string;
  title: string;
  idempotencyKey: string;
  status: "pending" | "acknowledged";
}

interface ManagedPublishingBinding {
  deactivateLocalPublishing?: ProjectHarnessSessionBinding["deactivateLocalPublishing"];
}

export async function refreshManagedSessionName(
  current: Pick<ManagedSession, "name" | "rename" | "localRename" | "suppressLocalRenameForCloudName">,
  session: SessionSummary,
): Promise<boolean> {
  const sessionName = session.name ?? session.id;
  if (current.name === sessionName) return false;
  delete current.localRename;
  await current.rename?.(session);
  current.name = sessionName;
  current.suppressLocalRenameForCloudName = sessionName;
  return true;
}

export async function synchronizeManagedSessionTitle(input: {
  current: Pick<ManagedSession,
    "name" | "rename" | "readNativeName" | "localRename" | "suppressLocalRenameForCloudName">;
  session: SessionSummary;
  projectName: string;
  actorUserId?: string;
  actorDeviceId: string;
  api: CollaborationApi;
}): Promise<"unchanged" | "uploaded" | "awaiting_cloud" | "restored_cloud"> {
  const cloudName = input.session.name ?? input.session.id;
  if (input.current.suppressLocalRenameForCloudName === cloudName) {
    delete input.current.suppressLocalRenameForCloudName;
    return "unchanged";
  }
  if (input.current.localRename?.baseCloudName !== cloudName) delete input.current.localRename;
  const mayRename = input.session.mode === "solo"
    ? input.session.role !== "viewer" && (input.session.ownerUserId === undefined
      ? input.session.role === "owner"
      : input.session.ownerUserId === input.actorUserId)
    : input.session.role === "owner";
  if (!mayRename) {
    delete input.current.localRename;
    const nativeName = await input.current.readNativeName?.();
    if (nativeName !== undefined && nativeName !== null && nativeName !== managedThreadName(input.projectName, cloudName)) {
      await input.current.rename?.(input.session);
      return "restored_cloud";
    }
    return "unchanged";
  }
  const pending = input.current.localRename;
  if (pending) {
    if (pending.status === "acknowledged") return "awaiting_cloud";
    if (!input.api.updateSession) throw new Error("Collaboration API cannot update session titles");
    await input.api.updateSession(input.session.id, {
      title: pending.title,
      idempotencyKey: pending.idempotencyKey,
    });
    pending.status = "acknowledged";
    return "uploaded";
  }
  const nativeName = await input.current.readNativeName?.();
  if (nativeName === undefined || nativeName === null) return "unchanged";
  const canonicalNativeName = managedThreadName(input.projectName, cloudName);
  if (nativeName === canonicalNativeName) return "unchanged";
  const localTitle = localSessionTitle(nativeName, input.projectName);
  if (localTitle === undefined || localTitle === cloudName) {
    await input.current.rename?.(input.session);
    return "restored_cloud";
  }
  const idempotencyKey = `codex-title-${createHash("sha256")
    .update([input.actorDeviceId, input.session.id, cloudName, localTitle].join("\0"))
    .digest("hex")}`;
  input.current.localRename = {
    baseCloudName: cloudName,
    title: localTitle,
    idempotencyKey,
    status: "pending",
  };
  if (!input.api.updateSession) throw new Error("Collaboration API cannot update session titles");
  await input.api.updateSession(input.session.id, { title: localTitle, idempotencyKey });
  input.current.localRename.status = "acknowledged";
  return "uploaded";
}

function managedThreadName(projectName: string, sessionName: string): string {
  return ["GatherThread", projectName, sessionName].join(" · ").slice(0, 240);
}

export function formatConnectedCodexSessionOutput(projectName: string, session: SessionSummary): string {
  const sessionName = session.name ?? session.id;
  return `Connected session: ${sessionName} [${session.mode}] as ${terminalQuoted(managedThreadName(projectName, sessionName))}\n`;
}

function terminalQuoted(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/gu, (character) =>
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );
}

function localSessionTitle(nativeName: string, projectName: string): string | undefined {
  const prefix = ["GatherThread", projectName, ""].join(" · ");
  const candidate = (nativeName.startsWith(prefix) ? nativeName.slice(prefix.length) : nativeName).trim();
  if (candidate.length < 1 || candidate.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(candidate)) return undefined;
  return candidate;
}

export async function initializeProjectSession(options: {
  api: CollaborationApi;
  actorDeviceId: string;
  stateRoot: string;
  harness: ProjectHarnessAdapter;
  session: SessionSummary;
  adoptLocalConversationId?: string;
}): Promise<ManagedSession> {
  if (!Number.isSafeInteger(options.session.latestSequence) || Number(options.session.latestSequence) < 0) {
    throw new Error("Project session refresh omitted a valid authoritative latestSequence cursor");
  }
  const authoritativeCursor = options.session.latestSequence as number;
  const sessionKey = codexSessionKey(options.session.id);
  const binding = options.harness.createSessionBinding({
    session: options.session,
    sessionKey,
    statePath: path.join(options.stateRoot, `${sessionKey}-session.json`),
  });
  if (options.adoptLocalConversationId !== undefined) {
    if (!binding.adoptLocalConversation) {
      throw new Error("Selected harness cannot adopt a locally created conversation");
    }
    await binding.adoptLocalConversation(options.adoptLocalConversationId);
  }
  await binding.rename?.(options.session);
  await binding.deactivateLocalPublishing?.("initializing");
  const descriptor = options.harness.descriptor;
  const bridge = new LocalBridge({
    api: options.api,
    cursorStore: new FileCursorStore(path.join(options.stateRoot, `${sessionKey}-cursor.json`)),
    runtime: {
      sessionId: options.session.id,
      deviceId: options.actorDeviceId,
      harness: descriptor.harness,
      provider: descriptor.provider,
      model: descriptor.model,
      localSessionId: binding.localSessionId,
      captureFidelity: descriptor.captureFidelity,
      capabilities: descriptor.capabilities,
      purpose: "execution",
    },
    transcriptRoots: {},
  });
  await bridge.connect();
  await bridge.materializeAuthoritativeHistory(binding.executor, authoritativeCursor);
  try {
    await binding.activateLocalPublishing?.();
  } catch (activationError) {
    try {
      await binding.deactivateLocalPublishing?.("initializing");
    } catch (rollbackError) {
      throw new Error("Local publishing activation failed and its fail-closed rollback also failed", {
        cause: new AggregateError([activationError, rollbackError]),
      });
    }
    throw activationError;
  }
  return {
    bridge,
    executor: binding.executor,
    lastHeartbeatAt: Date.now(),
    name: options.session.name ?? options.session.id,
    ...(binding.synchronize === undefined ? {} : { synchronize: binding.synchronize }),
    ...(binding.rename === undefined ? {} : { rename: binding.rename }),
    ...(binding.readNativeName === undefined ? {} : { readNativeName: binding.readNativeName }),
    ...(binding.activateLocalPublishing === undefined ? {} : { activateLocalPublishing: binding.activateLocalPublishing }),
    ...(binding.deactivateLocalPublishing === undefined ? {} : { deactivateLocalPublishing: binding.deactivateLocalPublishing }),
    ...(binding.relayLocalHarnessEvent === undefined ? {} : { relayLocalHarnessEvent: binding.relayLocalHarnessEvent }),
  };
}

export async function reconcileProjectSessionPermissions<T extends ManagedPublishingBinding>(input: {
  sessions: readonly SessionSummary[];
  actorUserId?: string;
  managed: Map<string, T>;
  harness: ProjectHarnessAdapter;
}): Promise<{
  visibleSessions: SessionSummary[];
  eligibleSessions: SessionSummary[];
  errors: Error[];
}> {
  const visibleSessions = input.sessions.filter((session) => session.state !== "archived");
  const eligibleSessions = visibleSessions.filter((session) => isSessionWritableBy(session, input.actorUserId));
  const eligibleIds = new Set(eligibleSessions.map((session) => session.id));
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  const errors: Error[] = [];
  for (const [sessionId, current] of [...input.managed]) {
    if (eligibleIds.has(sessionId)) continue;
    input.managed.delete(sessionId);
    try {
      await current.deactivateLocalPublishing?.(deactivationReason(sessionsById.get(sessionId)));
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error("Local publishing deactivation failed"));
    }
  }
  try {
    await input.harness.deactivateExecutionBindings?.({
      retainSessionIds: [...input.managed.keys()],
      preserveSessionIds: [...eligibleIds],
    });
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error("Execution allowlist reconciliation failed"));
  }
  return { visibleSessions, eligibleSessions, errors };
}

export function isSessionWritableBy(session: SessionSummary, actorUserId?: string): boolean {
  if (session.role === "viewer") return false;
  if (session.mode === "solo") {
    return session.ownerUserId === undefined ? session.role === "owner" : session.ownerUserId === actorUserId;
  }
  return session.role === "owner" || session.role === "participant";
}

export async function refreshProjectSessionPermissions<T extends ManagedPublishingBinding>(input: {
  loadSessions: () => Promise<SessionSummary[]>;
  actorUserId?: string;
  managed: Map<string, T>;
  harness: ProjectHarnessAdapter;
}): Promise<
  | { status: "updated"; visibleSessions: SessionSummary[]; eligibleSessions: SessionSummary[]; errors: Error[] }
  | { status: "transient_failure"; error: unknown }
  | { status: "project_inaccessible"; error: CollaborationHttpError }
> {
  let sessions: SessionSummary[];
  try {
    sessions = await input.loadSessions();
  } catch (error) {
    return isProjectAccessRevoked(error)
      ? { status: "project_inaccessible", error }
      : { status: "transient_failure", error };
  }
  return { status: "updated", ...await reconcileProjectSessionPermissions({
    sessions,
    ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
    managed: input.managed,
    harness: input.harness,
  }) };
}

class LocalTaskDiscoveryDisabledError extends Error {}

export function localSoloCreationKey(actorDeviceId: string, projectId: string, localConversationId: string): string {
  return `codex-solo-${createHash("sha256")
    .update([actorDeviceId, projectId, localConversationId].join("\0"))
    .digest("hex")}`;
}

export function localSoloTitle(prompt: string): string {
  const normalized = prompt
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "Local Codex solo";
  return Array.from(normalized).slice(0, 120).join("");
}

function localSoloExpectedSessionId(actorUserId: string, idempotencyKey: string): string {
  return `session-${createHash("sha256")
    .update(`${actorUserId}\0${idempotencyKey}`)
    .digest("hex").slice(0, 32)}`;
}

export async function createPersonalSoloForLocalPrompt(input: {
  api: HttpCollaborationClient;
  actorUserId: string;
  actorDeviceId: string;
  projectId: string;
  localConversationId: string;
  prompt: string;
}): Promise<SessionSummary | null> {
  const project = (await input.api.listProjects()).find((candidate) => candidate.id === input.projectId);
  if (!project) throw new Error("GatherThread project access was revoked during local task discovery");
  if (project.role === "viewer") return null;
  const idempotencyKey = localSoloCreationKey(input.actorDeviceId, project.id, input.localConversationId);
  const expectedSessionId = localSoloExpectedSessionId(input.actorUserId, idempotencyKey);
  const created = await input.api.createSession(project.id, {
    title: localSoloTitle(input.prompt),
    mode: "solo",
    idempotencyKey,
  });
  if (created.id !== expectedSessionId || created.ownerUserId !== input.actorUserId || created.mode !== "solo") {
    throw new Error("Server returned an unexpected personal solo session binding");
  }
  return {
    ...created,
    projectId: project.id,
    ownerUserId: input.actorUserId,
    role: project.role,
    state: created.state ?? "active",
    latestSequence: created.latestSequence ?? 1,
  };
}

export async function runProjectConnector(options: {
  api: HttpCollaborationClient;
  actorUserId: string;
  actorDeviceId: string;
  project: ProjectSummary;
  stateRoot: string;
  harness: ProjectHarnessAdapter;
  signal: AbortSignal;
  token: string;
  hookSocketPath: string;
  hookSpoolPath: string;
  hookRegistryPath: string;
  hookWorkspacePath: string;
  hooksEnabled: boolean;
  hookRelay?: Pick<CodexHookRelayServer, "start" | "close">;
}): Promise<void> {
  const managed = new Map<string, ManagedSession>();
  const discoveries = new Map<string, Promise<ManagedSession>>();
  const discoverySessionIds = new Set<string>();
  const retryReporter = new ConnectorRetryReporter({ token: options.token });
  const setDiscoveryPermission = async (enabled: boolean) => {
    if (!options.hooksEnabled) return;
    await updateCodexHookRegistry({
      registryPath: options.hookRegistryPath,
      workspacePath: path.resolve(options.hookWorkspacePath),
      discoverUnregistered: enabled,
    });
  };
  const discoverLocalSolo = (event: Extract<CodexHookEvent, { hook_event_name: "UserPromptSubmit" }>) => {
    const existing = discoveries.get(event.session_id);
    if (existing) return existing;
    const operation = (async () => {
      const idempotencyKey = localSoloCreationKey(options.actorDeviceId, options.project.id, event.session_id);
      const expectedSessionId = localSoloExpectedSessionId(options.actorUserId, idempotencyKey);
      discoverySessionIds.add(expectedSessionId);
      try {
        const session = await createPersonalSoloForLocalPrompt({
          api: options.api,
          actorUserId: options.actorUserId,
          actorDeviceId: options.actorDeviceId,
          projectId: options.project.id,
          localConversationId: event.session_id,
          prompt: event.prompt,
        });
        if (session === null) {
          await setDiscoveryPermission(false);
          throw new LocalTaskDiscoveryDisabledError();
        }
        const current = managed.get(session.id) ?? await initializeProjectSession({
          api: options.api,
          actorDeviceId: options.actorDeviceId,
          stateRoot: options.stateRoot,
          harness: options.harness,
          session,
          adoptLocalConversationId: event.session_id,
        });
        managed.set(session.id, current);
        process.stdout.write(`${formatConnectedCodexSessionOutput(options.project.name, session).trimEnd()} (personal solo created from local task)\n`);
        return current;
      } finally {
        discoverySessionIds.delete(expectedSessionId);
      }
    })();
    discoveries.set(event.session_id, operation);
    void operation.finally(() => {
      if (discoveries.get(event.session_id) === operation) discoveries.delete(event.session_id);
    }).catch(() => undefined);
    return operation;
  };
  const dispatchHook = async (event: CodexHookEvent, replay: boolean): Promise<{ additionalContext?: string }> => {
    for (const current of managed.values()) {
      if (!current.relayLocalHarnessEvent || !current.bridge.runtime) continue;
      const result = await current.relayLocalHarnessEvent({
        api: options.api,
        runtime: current.bridge.runtime,
        event,
        replay,
      });
      if (result.handled) return result.additionalContext === undefined ? {} : { additionalContext: result.additionalContext };
    }
    if (event.hook_event_name === "UserPromptSubmit") {
      try {
        const current = await discoverLocalSolo(event);
        if (!current.relayLocalHarnessEvent || !current.bridge.runtime) {
          throw new Error("Discovered personal solo is not ready for local publishing");
        }
        const result = await current.relayLocalHarnessEvent({
          api: options.api,
          runtime: current.bridge.runtime,
          event,
          replay,
        });
        if (!result.handled) throw new Error("Discovered local Codex task did not match its personal solo binding");
        return result.additionalContext === undefined ? {} : { additionalContext: result.additionalContext };
      } catch (error) {
        if (error instanceof LocalTaskDiscoveryDisabledError) return {};
        throw error;
      }
    }
    throw new Error("Codex hook event does not match an active GatherThread session binding");
  };
  const relay = options.hooksEnabled
    ? options.hookRelay ?? new CodexHookRelayServer({
      socketPath: options.hookSocketPath,
      onEvent: async (event) => {
        if (!await isAllowedCodexHookEvent(options.hookRegistryPath, event)) return {};
        return dispatchHook(event, false);
      },
    })
    : undefined;
  if (options.hooksEnabled) {
    const currentProject = (await options.api.listProjects()).find((candidate) => candidate.id === options.project.id);
    if (!currentProject) throw new Error("GatherThread project access was revoked before Hook discovery activation");
    await updateCodexHookRegistry({
      registryPath: options.hookRegistryPath,
      workspacePath: path.resolve(options.hookWorkspacePath),
      discoverUnregistered: currentProject.role !== "viewer",
    });
  }
  await relay?.start();
  let nextRefreshAt = 0;
  let eligibleSessions: SessionSummary[] = [];
  let visibleSessions: SessionSummary[] = [];
  let nextSnapshotPollAt = 0;
  let authoritativeAclLoaded = false;
  try {
  while (!options.signal.aborted) {
    const now = Date.now();
    if (now >= nextRefreshAt) {
      const refresh = await refreshProjectSessionPermissions({
        loadSessions: () => options.api.listProjectSessions(options.project.id),
        actorUserId: options.actorUserId,
        managed,
        harness: options.harness,
      });
      if (refresh.status === "updated") {
        visibleSessions = refresh.visibleSessions;
        eligibleSessions = refresh.eligibleSessions;
        authoritativeAclLoaded = true;
        if (options.hooksEnabled) {
          try {
            const currentProject = (await options.api.listProjects()).find((candidate) => candidate.id === options.project.id);
            await setDiscoveryPermission(currentProject !== undefined && currentProject.role !== "viewer");
          } catch (error) {
            await setDiscoveryPermission(false).catch(() => undefined);
            refresh.errors.push(error instanceof Error ? error : new Error("Project discovery permission refresh failed"));
          }
        }
        if (refresh.errors.length > 0) {
          retryReporter.retrying("project refresh", new Error("Local execution permissions could not be reconciled safely", { cause: refresh.errors[0] }));
        } else {
          retryReporter.recovered("project refresh");
        }
      } else if (refresh.status === "project_inaccessible") {
        visibleSessions = [];
        eligibleSessions = [];
        authoritativeAclLoaded = true;
        for (const [sessionId, current] of [...managed]) {
          managed.delete(sessionId);
          await current.deactivateLocalPublishing?.("project_inaccessible").catch(() => undefined);
        }
        await options.harness.deactivateExecutionBindings?.().catch(() => undefined);
        if (options.hooksEnabled) {
          await drainCodexHookSpool(options.hookSpoolPath, async () => undefined).catch(() => undefined);
        }
        throw new Error("GatherThread project access was revoked; local execution publishing has been disabled", { cause: refresh.error });
      } else {
        retryReporter.retrying("project refresh", refresh.error);
      }
      nextRefreshAt = now + 5_000;
    }

    for (const session of eligibleSessions) {
      if (options.signal.aborted) break;
      if (discoverySessionIds.has(session.id)) continue;
      try {
        let current = managed.get(session.id);
        if (current) {
          await refreshManagedSessionName(current, session);
          await synchronizeManagedSessionTitle({
            current,
            session,
            projectName: options.project.name,
            actorUserId: options.actorUserId,
            actorDeviceId: options.actorDeviceId,
            api: options.api,
          });
        }
        if (!current) {
          current = await initializeProjectSession({
            api: options.api,
            actorDeviceId: options.actorDeviceId,
            stateRoot: options.stateRoot,
            harness: options.harness,
            session,
          });
          managed.set(session.id, current);
          process.stdout.write(formatConnectedCodexSessionOutput(options.project.name, session));
        }
        if (Date.now() - current.lastHeartbeatAt >= 10_000) {
          await current.bridge.heartbeat();
          current.lastHeartbeatAt = Date.now();
        }
        if (current.synchronize && current.bridge.runtime) {
          await current.synchronize({ api: options.api, runtime: current.bridge.runtime });
        }
        await current.bridge.processPendingAgentRequests(current.executor, 200);
        retryReporter.recovered(session.id);
      } catch (error) {
        if (!options.signal.aborted) {
          retryReporter.retrying(session.id, error);
        }
      }
    }
    if (options.harness.processSnapshotJobs && Date.now() >= nextSnapshotPollAt) {
      try {
        await options.harness.processSnapshotJobs({
          api: options.api,
          actorDeviceId: options.actorDeviceId,
          sessions: visibleSessions,
        });
        retryReporter.recovered("snapshots");
      } catch (error) {
        retryReporter.retrying("snapshots", error);
      }
      nextSnapshotPollAt = Date.now() + 5_000;
    }
    if (options.hooksEnabled) {
      try {
        await drainCodexHookSpool(options.hookSpoolPath, async (event) => {
          if (authoritativeAclLoaded && !await isAllowedCodexHookEvent(options.hookRegistryPath, event)) return;
          await dispatchHook(event, true);
        });
        retryReporter.recovered("hook outbox");
      } catch (error) {
        retryReporter.retrying("hook outbox", error);
      }
    }
    await waitForConnectorPoll(1_000, options.signal);
  }
  } finally {
    await relay?.close();
  }
}

interface ConnectorRetryReporterOptions {
  token: string;
  intervalMs?: number;
  now?: () => number;
  write?: (message: string) => void;
}

/** Coalesces stable retry failures so a one-second poll cannot flood a terminal. */
export class ConnectorRetryReporter {
  readonly #token: string;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #write: (message: string) => void;
  readonly #failures = new Map<string, { message: string; lastReportedAt: number }>();

  constructor(options: ConnectorRetryReporterOptions) {
    this.#token = options.token;
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#write = options.write ?? ((message) => process.stderr.write(message));
  }

  retrying(scope: string, error: unknown): void {
    const message = safeError(error, this.#token);
    const now = this.#now();
    const previous = this.#failures.get(scope);
    if (!previous || previous.message !== message || now - previous.lastReportedAt >= this.#intervalMs) {
      this.#write(`gatherthread-codex (${scope}): ${message}; retrying\n`);
      this.#failures.set(scope, { message, lastReportedAt: now });
    }
  }

  recovered(scope: string): void {
    if (!this.#failures.delete(scope)) return;
    this.#write(`gatherthread-codex (${scope}): recovered\n`);
  }
}

export function resolveCodexHookRelayPath(
  mappingId: string,
  stateRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!/^[a-f0-9]{24}$/.test(mappingId)) {
    throw new Error("Codex project mapping ID must contain exactly 24 lowercase hexadecimal characters");
  }
  return platform === "win32"
    ? `\\\\.\\pipe\\gatherthread-${mappingId}-hook-relay`
    : path.posix.join(stateRoot, "hook-relay.sock");
}

function deactivationReason(session: SessionSummary | undefined): ProjectHarnessDeactivationReason {
  if (!session) return "removed";
  if (session.state === "archived") return "archived";
  return "read_only";
}

function isProjectAccessRevoked(error: unknown): error is CollaborationHttpError {
  return error instanceof CollaborationHttpError && (error.status === 403 || error.status === 404);
}

export async function resolveCodexCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (command !== "codex" || command.includes(path.sep)) return command;
  const executableNames = platform === "win32"
    ? [`${command}.exe`, `${command}.com`]
    : [command];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue to the next directly executable candidate.
      }
    }
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const desktopBinRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
      try {
        const candidates = await Promise.all((await readdir(desktopBinRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const candidate = path.join(desktopBinRoot, entry.name, "codex.exe");
            try {
              await access(candidate, fsConstants.X_OK);
              const metadata = await stat(candidate);
              return metadata.isFile() ? { candidate, modifiedAt: metadata.mtimeMs } : undefined;
            } catch {
              return undefined;
            }
          }));
        const newest = candidates
          .filter((candidate): candidate is { candidate: string; modifiedAt: number } => candidate !== undefined)
          .sort((left, right) => right.modifiedAt - left.modifiedAt || right.candidate.localeCompare(left.candidate))[0];
        if (newest) return newest.candidate;
      } catch {
        // Fall through to the regular spawn error when Desktop is not installed.
      }
    }
  }
  if (platform === "darwin") {
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    try {
      await access(bundled, fsConstants.X_OK);
      return bundled;
    } catch {
      // The regular spawn error remains the most actionable fallback.
    }
  }
  return command;
}

export function resolveWorkspaceCodexHookPaths(
  workspacePath: string,
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform,
): { hookSocketPath: string; hookSpoolPath: string; hookRegistryPath: string } {
  const resolvedWorkspace = path.resolve(workspacePath);
  const hookId = createHash("sha256")
    .update(platform === "win32" ? resolvedWorkspace.toLowerCase() : resolvedWorkspace)
    .digest("hex")
    .slice(0, 24);
  const hookStateRoot = path.join(homeDirectory, ".gatherthread", "codex", "hooks", hookId);
  return {
    hookSocketPath: resolveCodexHookRelayPath(hookId, hookStateRoot, platform),
    hookSpoolPath: path.join(hookStateRoot, "hook-outbox.jsonl"),
    hookRegistryPath: path.join(hookStateRoot, "hook-registry.json"),
  };
}

export function waitForConnectorPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--url must be an absolute GatherThread HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("--url must use HTTPS or loopback HTTP");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("--url must use HTTPS except for a loopback host");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--url cannot contain credentials, a query, or a fragment");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "") url.pathname = "/v1";
  else if (pathname !== "/v1") throw new Error("--url path must be empty or exactly /v1");
  return url.toString().replace(/\/$/, "");
}

function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("Set GATHERTHREAD_TOKEN when no interactive terminal is available");
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Token entry cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (value.length >= 1_024) {
          cleanup();
          reject(new Error("Token entry is too long"));
          return;
        } else value += character;
      }
    };
    process.stdin.on("data", onData);
    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  });
}

function safeError(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : "Codex connector failed";
  const withoutToken = token ? message.replaceAll(token, "[REDACTED]") : message;
  return redactText(withoutToken.replace(/[\r\n]+/g, " "));
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  runCodexConnectCli().catch((error) => {
    process.stderr.write(`gatherthread-codex: ${safeError(error, process.env.GATHERTHREAD_TOKEN ?? "")}\n`);
    process.exitCode = 1;
  });
}
