#!/usr/bin/env node
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { redactText } from "@gatherthread/adapters";
import { LocalBridge } from "./bridge.js";
import { CodexCliExecutor, type CodexSandboxMode } from "./codex-executor.js";
import { FileCursorStore } from "./cursors.js";
import { BridgeDaemon } from "./daemon.js";
import { HttpCollaborationClient } from "./http-client.js";
import type { SessionSummary } from "./types.js";

interface CodexConnectOptions {
  apiUrl: string;
  workspacePath: string;
  model: string;
  sessionId?: string;
  sandbox: CodexSandboxMode;
  codexCommand: string;
  shareToolEvents: boolean;
  resetCodexSession: boolean;
}

const HELP = `GatherThread Codex connector

Usage:
  npm run codex:connect -- --url <GatherThread URL> [options]

Options:
  --url <url>              GatherThread HTTPS origin or /v1 API URL (required)
  --workspace <path>       Local project Codex may access (default: current directory)
  --model <model>          Codex model (default: gpt-5.6-sol)
  --session <id>           Session ID; otherwise choose from your writable sessions
  --sandbox <mode>         workspace-write or read-only (default: workspace-write)
  --codex-command <path>   Codex executable (default: codex)
  --no-share-tool-events   Share only the final Codex answer, not redacted tool events
  --reset-codex-session    Start a new local Codex thread for this mapping
  --help                   Show this help

The device access token is read from GATHERTHREAD_TOKEN when set. Otherwise it
is requested using a hidden terminal prompt. It is kept only in this process
and is never passed to Codex, written to the session state, or printed.
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
  const sessions = (await api.listSessions()).filter((session) => session.role !== "viewer");
  const selected = await selectSession(sessions, parsed.sessionId);
  const mappingId = createHash("sha256")
    .update([parsed.apiUrl, actor.deviceId, selected.id, path.resolve(parsed.workspacePath)].join("\0"))
    .digest("hex")
    .slice(0, 24);
  const stateRoot = path.join(homedir(), ".gatherthread", "codex");
  const statePath = path.join(stateRoot, `${mappingId}-session.json`);
  const cursorPath = path.join(stateRoot, `${mappingId}-cursor.json`);
  if (parsed.resetCodexSession) await unlinkIfPresent(statePath);

  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error("Codex connector shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const executor = new CodexCliExecutor({
      workspacePath: parsed.workspacePath,
      statePath,
      model: parsed.model,
      command: parsed.codexCommand,
      sandbox: parsed.sandbox,
      shareToolEvents: parsed.shareToolEvents,
      signal: shutdown.signal,
      env,
    });
    const preflight = await executor.preflight();
    process.stdout.write(`Codex ready: ${oneLine(preflight.version)}; ${oneLine(preflight.authentication)}\n`);
    process.stdout.write(`Workspace: ${preflight.workspacePath}\n`);
    process.stdout.write(`GatherThread: ${actor.displayName} -> ${selected.name ?? selected.id} (${selected.mode})\n`);

    const bridge = new LocalBridge({
      api,
      cursorStore: new FileCursorStore(cursorPath),
      runtime: {
        sessionId: selected.id,
        deviceId: actor.deviceId,
        harness: "codex",
        provider: "openai",
        model: parsed.model,
        localSessionId: `gatherthread-codex:${mappingId}`,
        captureFidelity: "harness_transcript",
        capabilities: ["canonical_history", "persistent_thread", "structured_tool_events"],
      },
      transcriptRoots: {},
    });
    const daemon = new BridgeDaemon({
      bridge,
      executor,
      signal: shutdown.signal,
      onPollError(error) {
        process.stderr.write(`gatherthread-codex: ${safeError(error, token)}; retrying\n`);
      },
    });
    process.stdout.write("Runtime is connecting. Keep this terminal open; press Control-C to stop.\n");
    await daemon.run();
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export function parseCodexConnectArgs(argv: readonly string[]): CodexConnectOptions | "help" {
  let url: string | undefined;
  let workspacePath = process.cwd();
  let model = "gpt-5.6-sol";
  let sessionId: string | undefined;
  let sandbox: CodexSandboxMode = "workspace-write";
  let codexCommand = "codex";
  let shareToolEvents = true;
  let resetCodexSession = false;
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
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument ?? "option"} requires a value`);
    index += 1;
    if (argument === "--url") url = value;
    else if (argument === "--workspace") workspacePath = value;
    else if (argument === "--model") model = value;
    else if (argument === "--session") sessionId = value;
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
  if (!model.trim() || model.length > 200 || model.startsWith("-") || /[\0\r\n]/.test(model)) {
    throw new Error("--model must be a valid non-empty model identifier");
  }
  if (!codexCommand.trim()) throw new Error("--codex-command must be non-empty");
  return {
    apiUrl: normalizeApiUrl(url),
    workspacePath: path.resolve(workspacePath),
    model,
    ...(sessionId === undefined ? {} : { sessionId }),
    sandbox,
    codexCommand,
    shareToolEvents,
    resetCodexSession,
  };
}

async function selectSession(
  sessions: SessionSummary[],
  requestedSessionId: string | undefined,
): Promise<SessionSummary> {
  if (requestedSessionId) {
    const selected = sessions.find((session) => session.id === requestedSessionId);
    if (!selected) throw new Error("The requested session is unavailable or read-only for this user");
    return selected;
  }
  if (sessions.length === 0) throw new Error("No writable GatherThread sessions are available for this user");
  if (sessions.length === 1) return sessions[0] as SessionSummary;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Multiple writable sessions are available; pass --session <id>");
  }
  process.stdout.write("Writable GatherThread sessions:\n");
  sessions.forEach((session, index) => {
    process.stdout.write(`  ${index + 1}. ${session.name ?? session.id} [${session.mode}] (${session.id})\n`);
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question("Choose a session number: ");
    const index = Number(answer) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= sessions.length) {
      throw new Error("Session selection is invalid");
    }
    return sessions[index] as SessionSummary;
  } finally {
    readline.close();
  }
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

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function safeError(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : "Codex connector failed";
  const withoutToken = token ? message.replaceAll(token, "[REDACTED]") : message;
  return redactText(withoutToken.replace(/[\r\n]+/g, " "));
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runCodexConnectCli().catch((error) => {
    process.stderr.write(`gatherthread-codex: ${safeError(error, process.env.GATHERTHREAD_TOKEN ?? "")}\n`);
    process.exitCode = 1;
  });
}
