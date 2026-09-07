#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HttpCollaborationClient,
  isSessionWritableBy,
  type ProjectSummary,
} from "@gatherthread/bridge";
import {
  assertSafeProfileTarget,
  createDshConnectionPlan,
  DSH_CONNECTION_TOKEN_VARIABLE,
  dshLaunchSpec,
  inspectDshConnection,
  installDshConnection,
  preflightDshConnection,
  removeDshConnection,
  resolveDshConnectionId,
  restoreDshConnection,
  type DshConnectionManifest,
  type DshConnectionPlan,
  type DshConnectionProfile,
} from "./connection-install.js";
import { secureDirectoryChain } from "./path-security.js";

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-v4-flash";
const HELP = `GatherThread DeepSeek Harness connector

Usage:
  npm run dsh:connect -- [connect] --dsh-source <path> --url <url> [options]
  npm run dsh:connect -- plan --dsh-source <path> --url <url> --project <id> --project-name <name> --device <id> [options]
  npm run dsh:connect -- install --dsh-source <path> --url <url> [options]
  npm run dsh:connect -- start --dsh-source <path> [--connection <id>] [options]
  npm run dsh:connect -- status|remove|restore [--connection <id>] [options]

Options:
  --dsh-source <path>       Clean checkout at dsh-v0.1.3-alpha.1 (or GATHERTHREAD_DSH_SOURCE)
  --dsh-home <path>         Explicit DSH_HOME (or DSH_HOME; default ~/.dsh)
  --profile <name>          web or headless (default web)
  --url <url>               GatherThread origin or /v1 API URL
  --project <id>            Project id; otherwise choose an active project with writable Sessions
  --workspace <path>        Read-only DSH workspace (default current directory)
  --provider <name>         DSH provider (default deepseek-official)
  --model <name>            DSH model, spelling preserved (default deepseek-v4-flash)
  --share-tool-events       Publish the already-redacted public tool projection
  --connection <id>        Installed connection id (optional only when exactly one exists)
  --port <number>           Web listen port; 0 lets the OS choose
  --temporary               Use and remove a one-time DSH_HOME (connect only)
  --help                    Show this help

The GatherThread device token is read from GATHERTHREAD_TOKEN, or requested by
a hidden terminal prompt. It is passed only through the launched process's
GATHERTHREAD_DSH_TOKEN environment reference. It is never put in argv, the
managed patch, a URL, a status response, a state file, or printed output.
`;

export type DshConnectCommand = "connect" | "plan" | "install" | "start" | "status" | "remove" | "restore";

export interface DshConnectCliOptions {
  readonly command: DshConnectCommand;
  readonly dshSource?: string;
  readonly dshHome: string;
  readonly profile: DshConnectionProfile;
  readonly apiUrl?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly deviceId?: string;
  readonly workspacePath: string;
  readonly provider: string;
  readonly model: string;
  readonly shareToolEvents: boolean;
  readonly connectionId?: string;
  readonly port?: number;
  readonly temporary: boolean;
}

interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  readonly stderr: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  readonly stdin: NodeJS.ReadStream;
}

/** Parse only non-secret CLI configuration. There intentionally is no token option. */
export function parseDshConnectArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): DshConnectCliOptions | "help" {
  const values = [...argv];
  if (values.includes("--help") || values.includes("-h")) return "help";
  const first = values[0];
  const commands = new Set<DshConnectCommand>([
    "connect", "plan", "install", "start", "status", "remove", "restore",
  ]);
  const command = typeof first === "string" && commands.has(first as DshConnectCommand)
    ? values.shift() as DshConnectCommand
    : "connect";
  const options = new Map<string, string>();
  let temporary = false;
  let shareToolEvents = false;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--temporary") {
      temporary = true;
      continue;
    }
    if (argument === "--share-tool-events") {
      shareToolEvents = true;
      continue;
    }
    if (argument === "--token" || argument?.startsWith("--token=")) {
      throw new Error("Tokens are forbidden in command arguments; use the hidden prompt or GATHERTHREAD_TOKEN");
    }
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${String(argument)}`);
    const name = argument.slice(2);
    if (![
      "dsh-source", "dsh-home", "profile", "url", "project", "project-name", "device",
      "workspace", "provider", "model", "connection", "port",
    ].includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Option --${name} requires a value`);
    if (options.has(name)) throw new Error(`Option --${name} was provided more than once`);
    options.set(name, value);
    index += 1;
  }
  if (temporary && command !== "connect") {
    throw new Error("--temporary is supported only by the connect command");
  }
  const sourceValue = options.get("dsh-source") ?? (env.GATHERTHREAD_DSH_SOURCE?.trim() || undefined);
  const profileValue = options.get("profile") ?? "web";
  if (profileValue !== "web" && profileValue !== "headless") {
    throw new Error("--profile must be web or headless");
  }
  const dshHomeValue = options.get("dsh-home")
    ?? (env.DSH_HOME?.trim() || undefined)
    ?? path.join(homedir(), ".dsh");
  const portValue = options.get("port");
  const port = portValue === undefined ? undefined : parsePort(portValue);
  const apiUrl = options.get("url");
  const projectId = options.get("project");
  const projectName = options.get("project-name");
  const deviceId = options.get("device");
  const connectionId = options.get("connection");
  const parsed: DshConnectCliOptions = {
    command,
    ...(sourceValue === undefined ? {} : { dshSource: resolveUserPath(sourceValue) }),
    dshHome: resolveUserPath(dshHomeValue),
    profile: profileValue,
    workspacePath: resolveUserPath(options.get("workspace") ?? cwd),
    provider: safeArgument(options.get("provider") ?? DEFAULT_PROVIDER, "provider", 80),
    model: safeArgument(options.get("model") ?? DEFAULT_MODEL, "model", 160),
    shareToolEvents,
    temporary,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(projectId === undefined ? {} : { projectId: safeArgument(projectId, "project", 128) }),
    ...(projectName === undefined ? {} : { projectName: safeArgument(projectName, "project-name", 160) }),
    ...(deviceId === undefined ? {} : { deviceId: safeArgument(deviceId, "device", 128) }),
    ...(connectionId === undefined ? {} : { connectionId: safeArgument(connectionId, "connection", 64) }),
    ...(port === undefined ? {} : { port }),
  };
  validateCommandOptions(parsed);
  return parsed;
}

/** User-facing entry; all writes stay under the selected or one-time DSH_HOME. */
export async function runDshConnectCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  const parsed = parseDshConnectArgs(argv, env);
  if (parsed === "help") {
    io.stdout.write(HELP);
    return;
  }
  let temporaryRoot: string | undefined;
  let secret: string | undefined;
  try {
    let options = parsed;
    if (options.temporary) {
      temporaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-connect-")));
      await chmod(temporaryRoot, 0o700);
      options = { ...options, dshHome: path.join(temporaryRoot, "dsh-home") };
    }
    if (options.command === "plan") {
      const plan = planFromExplicitOptions(options);
      const preflight = await preflightDshConnection(plan);
      printPlan(io.stdout, plan, preflight.profileExists);
      return;
    }
    if (options.command === "status"
      || options.command === "remove"
      || options.command === "restore"
      || options.command === "start") {
      const connectionId = await resolveDshConnectionId(options.dshHome, options.connectionId);
      const artifact = await inspectDshConnection(options.dshHome, connectionId);
      if (artifact.status === "missing") throw new Error("GatherThread DSH connection is missing");
      if (options.command === "status") {
        printStatus(io.stdout, artifact.status, artifact.manifest);
        return;
      }
      if (options.command === "remove") {
        const result = await removeDshConnection(options.dshHome, connectionId);
        io.stdout.write(`GatherThread DSH connection ${connectionId}: ${result.replaceAll("_", " ")}\n`);
        return;
      }
      if (options.command === "restore") {
        const result = await restoreDshConnection(options.dshHome, connectionId);
        io.stdout.write(`GatherThread DSH connection ${connectionId}: ${result.replaceAll("_", " ")}\n`);
        return;
      }
      if (artifact.status !== "installed") throw new Error("GatherThread DSH connection is removed; restore it before start");
      if (artifact.manifest.profile === "headless" && options.port !== undefined) {
        throw new Error("--port is available only for an installed web profile");
      }
      const plan = planFromManifest(options, artifact.manifest);
      await preflightDshConnection(plan);
      secret = await readDeviceToken(env, io);
      await verifyInstalledBinding(plan, secret);
      await launchDsh(plan, secret, options.port, env, io);
      return;
    }

    secret = await readDeviceToken(env, io);
    const resolved = await resolveRemoteBinding(options, secret, io);
    const plan = createDshConnectionPlan({
      dshSource: required(options.dshSource, "--dsh-source"),
      dshHome: options.dshHome,
      packageRoot: packageRoot(),
      profile: options.profile,
      apiUrl: required(options.apiUrl, "--url"),
      projectId: resolved.project.id,
      projectName: resolved.project.name,
      deviceId: resolved.deviceId,
      workspacePath: options.workspacePath,
      provider: options.provider,
      model: options.model,
      shareToolEvents: options.shareToolEvents,
    });
    await preflightDshConnection(plan);
    await initializeProfile(plan, env);
    const installed = await installDshConnection(plan);
    io.stdout.write(
      `GatherThread DSH connection ${plan.connectionId}: ${installed.status.replaceAll("_", " ")}\n`,
    );
    if (options.command === "install") {
      printStatus(io.stdout, "installed", plan.manifest);
      return;
    }
    await launchDsh(plan, secret, options.port, env, io);
  } catch (error) {
    throw new Error(safeMessage(error, secret));
  } finally {
    if (temporaryRoot !== undefined) await removeTemporaryHome(temporaryRoot);
  }
}

/** Initialize a missing profile only through the pinned official CLI. */
export async function initializeProfile(
  plan: DshConnectionPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"existing" | "initialized"> {
  try {
    await readFile(path.join(plan.profileDirectory, "package.json"), "utf8");
    return "existing";
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  await secureDirectoryChain(path.dirname(plan.dshHome));
  await mkdir(plan.dshHome, { recursive: true, mode: 0o700 });
  await chmod(plan.dshHome, 0o700);
  const spec = dshLaunchSpec(plan);
  const cliIndex = spec.args.indexOf("--profile");
  const initArgs = [
    ...spec.args.slice(0, cliIndex),
    "--profile",
    plan.manifest.profile,
    "--dump-default-config",
  ];
  const result = await runCaptured(spec.command, initArgs, {
    cwd: plan.dshSource,
    env: safeDshEnvironment(env, plan.dshHome),
  });
  if (result.code !== 0) throw new Error("Pinned DSH could not initialize the target profile");
  await assertSafeProfileTarget(plan);
  try {
    await readFile(path.join(plan.profileDirectory, "package.json"), "utf8");
  } catch {
    throw new Error("Pinned DSH did not initialize the target profile");
  }
  return "initialized";
}

/** Child environment contains the token, while the invocation never does. */
export function dshChildEnvironment(
  env: NodeJS.ProcessEnv,
  plan: DshConnectionPlan,
  token: string,
): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.GATHERTHREAD_TOKEN;
  child.DSH_HOME = plan.dshHome;
  child.DSH_PERMISSION_MODE = "read-only";
  child.DSH_TELEMETRY_MODE = "DISABLED";
  child.DSH_TELEMETRY_DISABLED = "1";
  child[DSH_CONNECTION_TOKEN_VARIABLE] = token;
  child.TSX_TSCONFIG_PATH = path.join(plan.dshSource, "tsconfig.json");
  return child;
}

async function resolveRemoteBinding(
  options: DshConnectCliOptions,
  token: string,
  io: CliIo,
): Promise<{ project: ProjectSummary; deviceId: string }> {
  const apiUrl = required(options.apiUrl, "--url");
  const api = new HttpCollaborationClient({ baseUrl: apiUrl, bearerToken: token });
  const actor = await api.getCurrentActor();
  const active = (await api.listProjects()).filter((project) => project.state === "active");
  const candidates: Array<{ project: ProjectSummary; writable: number }> = [];
  for (const project of active) {
    if (options.projectId !== undefined && project.id !== options.projectId) continue;
    const sessions = await api.listProjectSessions(project.id);
    const writable = sessions.filter((session) => isSessionWritableBy(session, actor.id)).length;
    if (writable > 0) candidates.push({ project, writable });
  }
  if (options.projectId !== undefined && candidates.length === 0) {
    throw new Error("Selected GatherThread Project has no Session writable by the current actor");
  }
  if (candidates.length === 0) {
    throw new Error("No active GatherThread Project has a Session writable by the current actor");
  }
  let selected = candidates[0];
  if (candidates.length > 1) {
    if (!io.stdin.isTTY || !io.stdout.isTTY) {
      throw new Error("Multiple writable GatherThread Projects exist; pass --project");
    }
    io.stdout.write("Writable GatherThread Projects:\n");
    candidates.forEach((candidate, index) => {
      io.stdout.write(`  ${String(index + 1)}. ${oneLine(candidate.project.name)} (${String(candidate.writable)} Sessions)\n`);
    });
    const readline = createInterface({ input: io.stdin, output: io.stdout as NodeJS.WriteStream });
    try {
      const answer = await readline.question("Choose a Project number: ");
      const index = Number.parseInt(answer, 10) - 1;
      selected = candidates[index];
      if (selected === undefined) throw new Error("Project selection is invalid");
    } finally {
      readline.close();
    }
  }
  if (selected === undefined) throw new Error("No writable GatherThread Project was selected");
  return { project: selected.project, deviceId: actor.deviceId };
}

async function verifyInstalledBinding(plan: DshConnectionPlan, token: string): Promise<void> {
  const api = new HttpCollaborationClient({
    baseUrl: plan.manifest.binding.apiUrl,
    bearerToken: token,
  });
  const actor = await api.getCurrentActor();
  if (actor.deviceId !== plan.manifest.binding.deviceId) {
    throw new Error("Installed DSH connection belongs to a different authenticated device");
  }
  const projects = await api.listProjects();
  const project = projects.find((candidate) => candidate.id === plan.manifest.binding.projectId);
  if (project === undefined || project.state !== "active") {
    throw new Error("Installed GatherThread Project is unavailable");
  }
  const sessions = await api.listProjectSessions(project.id);
  if (!sessions.some((session) => isSessionWritableBy(session, actor.id))) {
    throw new Error("Installed GatherThread Project has no Session writable by the current actor");
  }
}

async function launchDsh(
  plan: DshConnectionPlan,
  token: string,
  port: number | undefined,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<void> {
  const artifact = await inspectDshConnection(plan.dshHome, plan.connectionId);
  if (artifact.status !== "installed") throw new Error("GatherThread DSH connection is not installed");
  const spec = dshLaunchSpec(plan, port);
  if (JSON.stringify(spec.args).includes(token)) throw new Error("Internal safety check rejected a credential-bearing argv");
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: dshChildEnvironment(env, plan, token),
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
  });
  pipeRedacted(child.stdout, io.stdout, token);
  pipeRedacted(child.stderr, io.stderr, token);
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0 && result.signal === null) {
      throw new Error(`DeepSeek Harness exited with code ${String(result.code)}`);
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

function planFromExplicitOptions(options: DshConnectCliOptions): DshConnectionPlan {
  return createDshConnectionPlan({
    dshSource: required(options.dshSource, "--dsh-source"),
    dshHome: options.dshHome,
    packageRoot: packageRoot(),
    profile: options.profile,
    apiUrl: required(options.apiUrl, "--url"),
    projectId: required(options.projectId, "--project"),
    projectName: required(options.projectName, "--project-name"),
    deviceId: required(options.deviceId, "--device"),
    workspacePath: options.workspacePath,
    provider: options.provider,
    model: options.model,
    shareToolEvents: options.shareToolEvents,
  });
}

function planFromManifest(
  options: DshConnectCliOptions,
  manifest: DshConnectionManifest,
): DshConnectionPlan {
  const plan = createDshConnectionPlan({
    dshSource: required(options.dshSource, "--dsh-source"),
    dshHome: options.dshHome,
    packageRoot: packageRoot(),
    profile: manifest.profile,
    ...manifest.binding,
  });
  if (plan.connectionId !== manifest.connectionId
    || JSON.stringify(plan.manifest) !== JSON.stringify(manifest)) {
    throw new Error("Installed GatherThread DSH connection no longer matches this package");
  }
  return plan;
}

function printPlan(
  output: Pick<NodeJS.WriteStream, "write">,
  plan: DshConnectionPlan,
  profileExists: boolean,
): void {
  output.write([
    `DSH: ${plan.manifest.deepseekHarness.tag} (${plan.manifest.deepseekHarness.commit})`,
    `Profile: ${plan.manifest.profile} (${profileExists ? "existing" : "will be initialized by the official CLI"})`,
    `GatherThread Project: ${oneLine(plan.manifest.binding.projectName)} (${plan.manifest.binding.projectId})`,
    `Workspace: ${plan.manifest.binding.workspacePath} (read-only)`,
    `Model: ${oneLine(plan.manifest.binding.provider)} / ${oneLine(plan.manifest.binding.model)}`,
    `Connection: ${plan.connectionId}`,
    "Credential: hidden prompt or GATHERTHREAD_TOKEN; process-only environment reference",
    "Profile files: unchanged; GatherThread owns one separate reversible --patch overlay",
    "",
  ].join("\n"));
}

function printStatus(
  output: Pick<NodeJS.WriteStream, "write">,
  status: "installed" | "removed",
  manifest: DshConnectionManifest,
): void {
  output.write([
    `GatherThread DSH connection ${manifest.connectionId}: ${status}`,
    `DSH compatibility: ${manifest.deepseekHarness.tag} / ${manifest.deepseekHarness.commit}`,
    `Profile: ${manifest.profile}`,
    `Project: ${oneLine(manifest.binding.projectName)}`,
    `Model: ${oneLine(manifest.binding.provider)} / ${oneLine(manifest.binding.model)}`,
    "Credential persisted: no",
    "",
  ].join("\n"));
}

async function readDeviceToken(env: NodeJS.ProcessEnv, io: CliIo): Promise<string> {
  const fromEnvironment = env.GATHERTHREAD_TOKEN?.trim();
  if (fromEnvironment) return validToken(fromEnvironment);
  if (!io.stdin.isTTY || !io.stderr.isTTY || typeof io.stdin.setRawMode !== "function") {
    throw new Error("GATHERTHREAD_TOKEN is unset and a hidden terminal prompt is unavailable");
  }
  io.stderr.write("GatherThread device access token: ");
  io.stdin.setRawMode(true);
  io.stdin.resume();
  io.stdin.setEncoding("utf8");
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { value: string } | { error: Error }) => {
        if (settled) return;
        settled = true;
        cleanup();
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            finish({ error: new Error("Credential prompt interrupted") });
            return;
          }
          if (character === "\r" || character === "\n") {
            try {
              finish({ value: validToken(value) });
            } catch (error) {
              finish({ error: error instanceof Error ? error : new Error("Invalid credential") });
            }
            return;
          }
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else {
            value += character;
            if (value.length > 4096) {
              finish({ error: new Error("A valid GatherThread device access token is required") });
              return;
            }
          }
        }
      };
      const cleanup = () => {
        io.stdin.removeListener("data", onData);
        io.stdin.setRawMode(false);
        io.stdin.pause();
        io.stderr.write("\n");
      };
      io.stdin.on("data", onData);
    });
  } finally {
    if (io.stdin.isRaw) io.stdin.setRawMode(false);
  }
}

function validToken(value: string): string {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f-\u009f]/u.test(value)) {
    throw new Error("A valid GatherThread device access token is required");
  }
  return value;
}

function validateCommandOptions(options: DshConnectCliOptions): void {
  if (["connect", "install", "plan", "start"].includes(options.command)
    && options.dshSource === undefined) {
    throw new Error(`${options.command} requires --dsh-source or GATHERTHREAD_DSH_SOURCE`);
  }
  if (["connect", "install", "plan"].includes(options.command) && options.apiUrl === undefined) {
    throw new Error(`${options.command} requires --url`);
  }
  if (options.command === "plan"
    && (options.projectId === undefined || options.projectName === undefined || options.deviceId === undefined)) {
    throw new Error("plan requires --project, --project-name, and --device without reading a credential");
  }
  if (["status", "remove", "restore", "start"].includes(options.command)
    && (options.apiUrl !== undefined || options.projectId !== undefined
      || options.projectName !== undefined || options.deviceId !== undefined)) {
    throw new Error(`${options.command} reads binding data from the owned manifest`);
  }
  if (options.profile === "headless" && options.port !== undefined) {
    throw new Error("--port is available only for the web profile");
  }
}

function safeDshEnvironment(env: NodeJS.ProcessEnv, dshHome: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT",
    "ComSpec", "PATHEXT", "USERPROFILE",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (env[key] !== undefined) result[key] = env[key];
  result.DSH_HOME = dshHome;
  result.DSH_TELEMETRY_DISABLED = "1";
  result.DSH_TELEMETRY_MODE = "DISABLED";
  result.NO_COLOR = "1";
  return result;
}

async function runCaptured(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout = bounded(`${stdout}${chunk}`); });
  child.stderr.on("data", (chunk: string) => { stderr = bounded(`${stderr}${chunk}`); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

export function pipeRedacted(
  stream: NodeJS.ReadableStream,
  output: Pick<NodeJS.WriteStream, "write">,
  secret: string,
): void {
  let pending = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    pending += String(chunk);
    pending = pending.replaceAll(secret, "[REDACTED]");
    const keep = possibleSecretPrefixLength(pending, secret);
    const ready = keep === 0 ? pending : pending.slice(0, -keep);
    pending = keep === 0 ? "" : pending.slice(-keep);
    output.write(ready);
  });
  stream.on("end", () => {
    output.write(pending.replaceAll(secret, "[REDACTED]"));
    pending = "";
  });
}

function possibleSecretPrefixLength(value: string, secret: string): number {
  for (let length = Math.min(value.length, secret.length - 1); length > 0; length -= 1) {
    if (value.endsWith(secret.slice(0, length))) return length;
  }
  return 0;
}

async function removeTemporaryHome(root: string): Promise<void> {
  const resolved = await realpath(root).catch(() => undefined);
  if (resolved !== root || !path.basename(root).startsWith("gatherthread-dsh-connect-")) {
    throw new Error("Refusing to remove an unverified temporary DSH_HOME");
  }
  await rm(root, { recursive: true, force: false });
}

function packageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function resolveUserPath(value: string): string {
  const expanded = value === "~"
    ? homedir()
    : value.startsWith(`~${path.sep}`) ? path.join(homedir(), value.slice(2)) : value;
  if (/[\x00-\x1f\x7f-\u009f]/u.test(expanded)) throw new Error("Path contains control characters");
  return path.resolve(expanded);
}

function safeArgument(value: string | undefined, name: string, maximum: number): string {
  if (value === undefined) throw new Error(`--${name} requires a value`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\x00-\x1f\x7f-\u009f]/u.test(trimmed)) {
    throw new Error(`--${name} must be safe non-empty text`);
  }
  return trimmed;
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/u.test(value)) throw new Error("--port must be an integer from 0 through 65535");
  const parsed = Number(value);
  if (parsed > 65_535) throw new Error("--port must be an integer from 0 through 65535");
  return parsed;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").slice(0, 200);
}

function safeMessage(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : "GatherThread DSH connector failed";
  const redacted = secret === undefined ? message : message.replaceAll(secret, "[REDACTED]");
  return oneLine(redacted);
}

function bounded(value: string): string {
  return value.length <= 64 * 1024 ? value : value.slice(-64 * 1024);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runDshConnectCli().catch((error: unknown) => {
    process.stderr.write(`gatherthread-dsh: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
