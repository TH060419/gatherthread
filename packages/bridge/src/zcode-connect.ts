import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactText } from "@gatherthread/adapters";
import { HttpCollaborationClient } from "./http-client.js";
import type { ManagedSession } from "./codex-connect.js";
import { initializeProjectSession, runManagedSessionCycle, waitForConnectorPoll } from "./codex-connect.js";
import { ensureProjectWorkspace } from "./project-workspace.js";
import { isProjectAccessRevoked, refreshProjectSessionPermissions } from "./project-session-permissions.js";
import type { ProjectSummary, SessionSummary } from "./types.js";
import { validateZcodeWorkspace, ZcodeProjectHarness } from "./zcode-harness.js";
import { assertUsableZcodeCli, probeZcodeCli, resolveZcodeCommand } from "./zcode-compat.js";

export interface ZcodeConnectOptions {
  apiUrl: string;
  workspacePath: string;
  provider: string;
  model: string;
  projectId?: string;
  createWorkspace: boolean;
  zcodeCommand?: string;
  shareToolEvents: boolean;
  preflightOnly: boolean;
  executionTimeoutMs: number;
}

const HELP = `GatherThread ZCode connector

Usage:
  npx --yes @gatherthread/zcode-connect@0.1.0-alpha.5 --url <GatherThread URL> [options]

Repository development / compatibility entry:
  npm run zcode:connect -- --url <GatherThread URL> [options]

Options:
  --url <url>              GatherThread HTTPS origin or /v1 API URL (required)
  --workspace <path>       Local project directory ZCode may access (default: current directory)
  --project <id>           Project ID; otherwise choose from your writable projects
  --create-workspace       Create/reuse ~/GatherThread Projects/<project name>
  --provider <name>        Provenance provider label (default: zcode)
  --model <name>           Provenance model label until the first execution reports the observed model (default: default)
  --zcode-command <path>   ZCode CLI executable, or its bundled glm/zcode.cjs entry (default: discover automatically)
  --no-share-tool-events   Share only the final ZCode answer, not redacted tool events
  --execution-timeout-ms <n>
                           Per-request headless execution ceiling (default: 900000)
  --preflight-only         Validate server access, workspace, and the ZCode CLI, then exit
  --help                   Show this help

The device access token is read from GATHERTHREAD_TOKEN when set. Otherwise it
is requested using a hidden terminal prompt. It is kept only in this process
and is never passed to ZCode, written to session state, or printed. Each
writable session registers one execution runtime; a claimed Web Agent request
runs once in a headless ZCode child inside the workspace. Local-turn capture
through reviewed ZCode hooks is planned as a later phase and is not part of
this connector yet.
`;

export async function runZcodeConnectCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseZcodeConnectArgs(argv);
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }
  const token = env.GATHERTHREAD_TOKEN?.trim() || await readSecret("GatherThread device access token: ");
  if (!token || /[\r\n]/.test(token)) throw new Error("A valid GatherThread device access token is required");

  const api = new HttpCollaborationClient({ baseUrl: parsed.apiUrl, bearerToken: token });
  const actor = await api.getCurrentActor();
  const projects = (await api.listProjects()).filter((project) => project.state === "active");
  const selected = await selectProject(projects, parsed.projectId);
  const requestedWorkspacePath = parsed.createWorkspace
    ? await ensureProjectWorkspace({
      apiUrl: parsed.apiUrl,
      projectId: selected.id,
      projectName: selected.name,
    })
    : parsed.workspacePath;
  const workspacePath = await validateZcodeWorkspace(requestedWorkspacePath);
  const mappingId = createHash("sha256")
    .update([parsed.apiUrl, actor.deviceId, selected.id, path.resolve(workspacePath)].join("\0"))
    .digest("hex")
    .slice(0, 24);
  const stateRoot = path.join(homedir(), ".gatherthread", "zcode", mappingId);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });

  const spec = await resolveZcodeCommand(parsed.zcodeCommand, env);
  const probe = await probeZcodeCli(spec);
  assertUsableZcodeCli(probe);
  const harness = new ZcodeProjectHarness({
    probe,
    spec,
    workspacePath,
    provider: parsed.provider,
    model: parsed.model,
    shareToolEvents: parsed.shareToolEvents,
    stateRoot,
    timeoutMs: parsed.executionTimeoutMs,
  });
  const preflight = await harness.preflight();

  if (parsed.preflightOnly) {
    process.stdout.write(`GatherThread ZCode connector preflight succeeded.\n`);
    process.stdout.write(`Server: ${parsed.apiUrl}\n`);
    process.stdout.write(`Project: ${selected.name} (${selected.id}) as ${selected.role}\n`);
    process.stdout.write(`Workspace: ${preflight.workspacePath}\n`);
    process.stdout.write(`ZCode CLI: ${preflight.version} (${spec.source})\n`);
    return;
  }

  process.stdout.write(`Connecting GatherThread project ${selected.name} to ZCode at ${preflight.workspacePath}\n`);
  process.stdout.write(`ZCode CLI ${preflight.version}; headless execution ready.\n`);

  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error("ZCode connector shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const managed = new Map<string, ManagedSession>();
  const retryReporter = new ZcodeRetryReporter({ token });
  try {
    while (!shutdown.signal.aborted) {
      const refresh = await refreshProjectSessionPermissions({
        loadSessions: () => api.listProjectSessions(selected.id),
        actorUserId: actor.id,
        managed,
        harness,
      });
      if (refresh.status === "project_inaccessible") {
        for (const [sessionId, current] of [...managed]) {
          managed.delete(sessionId);
        }
        await harness.deactivateExecutionBindings?.().catch(() => undefined);
        throw new Error("GatherThread project access was revoked; ZCode execution has been disabled", {
          cause: refresh.error,
        });
      }
      if (refresh.status === "transient_failure") {
        retryReporter.retrying("project refresh", refresh.error);
        await waitForConnectorPoll(5_000, shutdown.signal);
        continue;
      }
      retryReporter.recovered("project refresh");
      for (const session of refresh.eligibleSessions) {
        if (shutdown.signal.aborted) break;
        try {
          let current = managed.get(session.id);
          if (!current) {
            current = await initializeProjectSession({
              api,
              actorDeviceId: actor.deviceId,
              stateRoot,
              harness,
              session,
            });
            managed.set(session.id, current);
            process.stdout.write(formatConnectedSessionOutput(selected.name, session));
          }
          if (Date.now() - current.lastHeartbeatAt >= 10_000) {
            await current.bridge.heartbeat();
            current.lastHeartbeatAt = Date.now();
          }
          await runManagedSessionCycle(current, api);
          retryReporter.recovered(session.id);
        } catch (error) {
          if (!shutdown.signal.aborted) retryReporter.retrying(session.id, error);
        }
      }
      await waitForConnectorPoll(1_000, shutdown.signal);
    }
  } finally {
    for (const current of managed.values()) {
      await current.deactivateLocalPublishing?.("project_inaccessible").catch(() => undefined);
    }
    await harness.close();
  }
}

export function parseZcodeConnectArgs(argv: readonly string[]): ZcodeConnectOptions | "help" {
  const options: ZcodeConnectOptions = {
    apiUrl: "",
    workspacePath: process.cwd(),
    provider: "zcode",
    model: "default",
    createWorkspace: false,
    shareToolEvents: true,
    preflightOnly: false,
    executionTimeoutMs: 900_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--help" || argument === "-h") return "help";
    else if (argument === "--url") options.apiUrl = normalizeApiUrl(value());
    else if (argument === "--workspace") options.workspacePath = value();
    else if (argument === "--project") options.projectId = value();
    else if (argument === "--create-workspace") options.createWorkspace = true;
    else if (argument === "--provider") options.provider = validateLabel(value(), "--provider");
    else if (argument === "--model") options.model = validateLabel(value(), "--model");
    else if (argument === "--zcode-command") options.zcodeCommand = value();
    else if (argument === "--no-share-tool-events") options.shareToolEvents = false;
    else if (argument === "--execution-timeout-ms") {
      const parsedValue = Number(value());
      if (!Number.isSafeInteger(parsedValue) || parsedValue < 1_000 || parsedValue > 3_600_000) {
        throw new Error("--execution-timeout-ms must be an integer between 1000 and 3600000");
      }
      options.executionTimeoutMs = parsedValue;
    } else if (argument === "--preflight-only") options.preflightOnly = true;
    else throw new Error(`Unknown option: ${argument ?? "(empty)"}. Pass --help for usage.`);
  }
  if (!options.apiUrl) throw new Error("--url is required. Pass --help for usage.");
  return options;
}

function validateLabel(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) {
    throw new Error(`${flag} must be 1-80 printable characters`);
  }
  return trimmed;
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

async function selectProject(
  projects: readonly ProjectSummary[],
  requestedId: string | undefined,
): Promise<ProjectSummary> {
  const writable = projects.filter((project) => project.role !== "viewer");
  if (requestedId !== undefined) {
    const selected = projects.find((project) => project.id === requestedId);
    if (!selected) throw new Error("The requested GatherThread project was not found or is not active");
    if (selected.role === "viewer") throw new Error("A viewer cannot register a ZCode execution runtime");
    return selected;
  }
  if (writable.length === 0) throw new Error("No active writable GatherThread project is available for this device");
  if (writable.length === 1) return writable[0] as ProjectSummary;
  throw new Error(
    `Multiple writable projects are available; pass --project <id> with one of: ${writable.map((project) => project.id).join(", ")}`,
  );
}

async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("Set GATHERTHREAD_TOKEN when no interactive terminal is available");
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  let secret = "";
  for await (const chunk of process.stdin) {
    const characters = String(chunk);
    for (const character of characters) {
      if (character === "\r" || character === "\n") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        return secret;
      }
      if (character === "\u0003") {
        process.stdin.setRawMode(false);
        throw new Error("Device access token entry cancelled");
      }
      if (character === "\u007f" || character === "\b") {
        secret = secret.slice(0, -1);
        continue;
      }
      secret += character;
    }
  }
  process.stdin.setRawMode(false);
  process.stdout.write("\n");
  return secret;
}

function formatConnectedSessionOutput(_projectName: string, session: SessionSummary): string {
  return `Connected session: ${session.name ?? session.id} [${session.mode}]\n`;
}

class ZcodeRetryReporter {
  readonly #token: string;
  readonly #failures = new Map<string, { message: string; lastReportedAt: number }>();

  constructor(options: { token: string }) {
    this.#token = options.token;
  }

  retrying(scope: string, error: unknown): void {
    const message = formatZcodeConnectFailure(error, this.#token);
    const now = Date.now();
    const previous = this.#failures.get(scope);
    if (!previous || previous.message !== message || now - previous.lastReportedAt >= 60_000) {
      this.#write(`gatherthread-zcode (${scope}): ${message}; retrying\n`);
      this.#failures.set(scope, { message, lastReportedAt: now });
    }
  }

  recovered(scope: string): void {
    if (!this.#failures.delete(scope)) return;
    this.#write(`gatherthread-zcode (${scope}): recovered\n`);
  }

  #write(message: string): void {
    process.stderr.write(message);
  }
}

function formatZcodeConnectFailure(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactText(token ? raw.split(token).join("[REDACTED]") : raw);
  return redacted.replace(/[\r\n]+/g, " ").slice(0, 400) || "unknown failure";
}
