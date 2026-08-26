import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, chmod, link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export type CodexHookEvent = CodexUserPromptHookEvent | CodexStopHookEvent;

export interface CodexUserPromptHookEvent {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  turn_id: string;
  cwd: string;
  model: string;
  reasoning_effort?: string;
  prompt: string;
}

export interface CodexStopHookEvent {
  hook_event_name: "Stop";
  session_id: string;
  turn_id: string;
  cwd: string;
  model: string;
  reasoning_effort?: string;
  stop_hook_active: boolean;
  last_assistant_message: string | null;
}

export interface CodexHookRelayResult {
  additionalContext?: string;
}

export interface CodexHookRelayServerOptions {
  socketPath: string;
  platform?: NodeJS.Platform;
  serverFactory?: (connectionListener: (socket: net.Socket) => void) => net.Server;
  maxMessageBytes?: number;
  maxAdditionalContextBytes?: number;
  onEvent: (event: CodexHookEvent) => Promise<CodexHookRelayResult | void>;
}

export class CodexHookRelayServer {
  readonly #options: CodexHookRelayServerOptions;
  readonly #platform: NodeJS.Platform;
  #server: net.Server | undefined;
  #activeConnections = 0;

  constructor(options: CodexHookRelayServerOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    if (this.#platform !== "win32") await prepareUnixSocketPath(this.#options.socketPath);
    const server = this.#options.serverFactory
      ? this.#options.serverFactory((socket) => this.#handle(socket))
      : net.createServer({ allowHalfOpen: true }, (socket) => this.#handle(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#options.socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.#server = undefined;
      throw error;
    }
    server.on("error", () => undefined);
    if (this.#platform !== "win32") await chmod(this.#options.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (this.#platform === "win32") return;
    const metadata = await lstat(this.#options.socketPath).catch(() => undefined);
    if (metadata?.isSocket()) await unlink(this.#options.socketPath);
  }

  #handle(socket: net.Socket): void {
    if (this.#activeConnections >= 16) {
      socket.destroy();
      return;
    }
    this.#activeConnections += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#activeConnections -= 1;
    };
    socket.once("close", release);
    const maxBytes = this.#options.maxMessageBytes ?? 1024 * 1024;
    let buffer = Buffer.alloc(0);
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => undefined);
    let handling = false;
    const handleFrame = () => {
      if (handling) return;
      handling = true;
      void (async () => {
        let event: CodexHookEvent;
        try {
          event = validateCodexHookEvent(JSON.parse(buffer.toString("utf8")));
        } catch {
          socket.end("{}\n");
          return;
        }
        try {
          const result = await this.#options.onEvent(event) ?? {};
          const additionalContext = result.additionalContext;
          if (additionalContext !== undefined
            && Buffer.byteLength(additionalContext) > (this.#options.maxAdditionalContextBytes ?? 64 * 1024)) {
            throw new Error("Codex hook additional context exceeded its limit");
          }
          socket.end(`${JSON.stringify(additionalContext === undefined ? {} : { additionalContext })}\n`);
        } catch {
          socket.destroy();
        }
      })();
    };
    socket.on("data", (chunk: Buffer) => {
      if (handling) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) {
        socket.destroy();
        return;
      }
      if (buffer.includes(0x0a)) handleFrame();
    });
    // Keep accepting the pre-framing client until all installed project hooks
    // have been regenerated. Windows named pipes use the newline path because
    // they do not reliably support a request half-close followed by a response.
    socket.once("end", handleFrame);
  }
}

async function prepareUnixSocketPath(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath);
  await preparePrivateDirectory(directory, "Codex hook socket directory must be private (mode 0700 or stricter)");
  const metadata = await lstat(socketPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isSocket()) throw new Error("Refusing to replace a non-socket Codex hook relay path");
  const active = await new Promise<boolean>((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    const timer = setTimeout(() => { probe.destroy(); reject(new Error("Could not determine whether the Codex hook relay socket is active")); }, 500);
    probe.once("connect", () => { clearTimeout(timer); probe.end(); resolve(true); });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error("A Codex hook relay is already active at this socket path");
  await unlink(socketPath);
}

export function validateCodexHookEvent(value: unknown): CodexHookEvent {
  const input = requiredObject(value);
  const common = {
    session_id: requiredString(input.session_id, "session_id"),
    turn_id: requiredString(input.turn_id, "turn_id"),
    cwd: requiredString(input.cwd, "cwd"),
    model: requiredString(input.model, "model"),
    ...(input.reasoning_effort === undefined ? {} : {
      reasoning_effort: requiredBoundedLabel(input.reasoning_effort, "reasoning_effort", 80),
    }),
  };
  if (input.hook_event_name === "UserPromptSubmit") {
    return { hook_event_name: "UserPromptSubmit", ...common, prompt: requiredString(input.prompt, "prompt") };
  }
  if (input.hook_event_name === "Stop") {
    if (typeof input.stop_hook_active !== "boolean") throw new Error("Stop.stop_hook_active must be boolean");
    if (input.last_assistant_message !== null && typeof input.last_assistant_message !== "string") {
      throw new Error("Stop.last_assistant_message must be string or null");
    }
    return {
      hook_event_name: "Stop",
      ...common,
      stop_hook_active: input.stop_hook_active,
      last_assistant_message: input.last_assistant_message,
    };
  }
  throw new Error("Unsupported Codex hook event");
}

export function renderCodexHookConfig(input: {
  hookScriptPath: string;
  socketPath: string;
  spoolPath: string;
  registryPath: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
}): Record<string, unknown> {
  const command = [
    input.nodePath ?? process.execPath,
    input.hookScriptPath,
    "--socket",
    input.socketPath,
    "--spool",
    input.spoolPath,
    "--registry",
    input.registryPath,
  ].map((value) => shellQuote(value, input.platform ?? process.platform)).join(" ");
  return {
    description: "GatherThread local hook relay. Review with /hooks before trusting.",
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 5, additionalContextLimit: 2500 }] }],
      Stop: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  };
}

export async function runCodexHookForwarder(input: {
  socketPath: string;
  spoolPath: string;
  registryPath: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  maxMessageBytes?: number;
  maxSpoolBytes?: number;
  maxSpoolEntries?: number;
}): Promise<void> {
  const raw = await readStream(input.stdin ?? process.stdin, input.maxMessageBytes ?? 1024 * 1024);
  const event = validateCodexHookEvent(JSON.parse(raw));
  if (!await isAllowedCodexHookEvent(input.registryPath, event)) {
    (input.stdout ?? process.stdout).write("{}\n");
    return;
  }
  let relay: CodexHookRelayResult = {};
  try {
    relay = await sendRelay(input.socketPath, event, input.maxMessageBytes ?? 1024 * 1024);
  } catch {
    await appendCodexHookSpool(input.spoolPath, event, {
      maxBytes: input.maxSpoolBytes,
      maxEntries: input.maxSpoolEntries,
    });
  }
  const output = event.hook_event_name === "UserPromptSubmit" && relay.additionalContext
    ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: relay.additionalContext } }
    : {};
  (input.stdout ?? process.stdout).write(`${JSON.stringify(output)}\n`);
}

interface CodexHookRegistry {
  version: 1;
  workspacePath: string;
  threads: Record<string, "execution" | "snapshot_connector">;
}

const REGISTRY_WRITERS = new Map<string, Promise<void>>();

export async function updateCodexHookRegistry(input: {
  registryPath: string;
  workspacePath: string;
  add?: Record<string, "execution" | "snapshot_connector">;
  remove?: readonly string[];
  removePurpose?: "execution" | "snapshot_connector";
}): Promise<void> {
  const key = path.resolve(input.registryPath);
  const previous = REGISTRY_WRITERS.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => updateCodexHookRegistryFile(input));
  REGISTRY_WRITERS.set(key, operation);
  try {
    await operation;
  } finally {
    if (REGISTRY_WRITERS.get(key) === operation) REGISTRY_WRITERS.delete(key);
  }
}

async function updateCodexHookRegistryFile(input: {
  registryPath: string;
  workspacePath: string;
  add?: Record<string, "execution" | "snapshot_connector">;
  remove?: readonly string[];
  removePurpose?: "execution" | "snapshot_connector";
}): Promise<void> {
  let registry: CodexHookRegistry = { version: 1, workspacePath: path.resolve(input.workspacePath), threads: {} };
  try {
    const parsed = JSON.parse(await readFile(input.registryPath, "utf8")) as unknown;
    if (!isHookRegistry(parsed) || parsed.workspacePath !== registry.workspacePath) {
      throw new Error("Codex hook registry belongs to a different workspace");
    }
    registry = parsed;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const threadId of input.remove ?? []) delete registry.threads[threadId];
  if (input.removePurpose) {
    for (const [threadId, purpose] of Object.entries(registry.threads)) {
      if (purpose === input.removePurpose) delete registry.threads[threadId];
    }
  }
  Object.assign(registry.threads, input.add ?? {});
  await preparePrivateDirectory(
    path.dirname(input.registryPath),
    "Codex hook registry directory must be private (mode 0700 or stricter)",
  );
  const temporary = `${input.registryPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, input.registryPath);
  await chmod(input.registryPath, 0o600);
}

export async function installCodexHookConfig(input: {
  workspacePath: string;
  config: Record<string, unknown>;
}): Promise<string> {
  const configPath = path.join(path.resolve(input.workspacePath), ".codex", "hooks.json");
  let output = input.config;
  try {
    const existing = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const current = requiredObject(existing);
    const incomingHooks = requiredObject(input.config.hooks);
    const currentHooks = current.hooks === undefined ? {} : requiredObject(current.hooks);
    const mergedHooks: Record<string, unknown> = { ...currentHooks };
    for (const [eventName, definitions] of Object.entries(incomingHooks)) {
      if (!Array.isArray(definitions)) throw new Error("Generated Codex hook definition is invalid");
      const existingDefinitions = mergedHooks[eventName];
      if (existingDefinitions !== undefined && !Array.isArray(existingDefinitions)) {
        throw new Error(`Existing Codex ${eventName} hook configuration cannot be merged safely`);
      }
      const currentDefinitions = existingDefinitions ?? [];
      const serialized = new Set(currentDefinitions.map((definition: unknown) => JSON.stringify(definition)));
      mergedHooks[eventName] = [
        ...currentDefinitions,
        ...definitions.filter((definition) => !serialized.has(JSON.stringify(definition))),
      ];
    }
    output = { ...current, hooks: mergedHooks };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  return configPath;
}

export async function readCodexHookSpool(spoolPath: string): Promise<CodexHookEvent[]> {
  try {
    return parseCodexHookSpool(await readFile(spoolPath, "utf8")).events;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function drainCodexHookSpool(
  spoolPath: string,
  onEvent: (event: CodexHookEvent) => Promise<void>,
): Promise<number> {
  return serializeSpoolDrain(spoolPath, async () => {
    const drainingPaths = await rotateAndListDrainingSpools(spoolPath);
    let processed = 0;
    for (const drainingPath of drainingPaths) {
      const raw = await readFile(drainingPath, "utf8");
      const parsed = parseCodexHookSpool(raw);
      let fileProcessed = 0;
      try {
        for (const event of parsed.events) {
          await onEvent(event);
          fileProcessed += 1;
          processed += 1;
        }
      } catch (error) {
        await rewriteDrainingSpool(drainingPath, parsed.events.slice(fileProcessed), parsed.invalidLines);
        throw error;
      }
      if (parsed.invalidLines.length > 0) {
        await rewriteDrainingSpool(drainingPath, [], parsed.invalidLines);
        await quarantineDrainingSpool(spoolPath, drainingPath);
      } else {
        await unlink(drainingPath);
      }
    }
    return processed;
  });
}

const DEFAULT_SPOOL_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_SPOOL_MAX_ENTRIES = 4_096;
const SPOOL_DRAINERS = new Map<string, Promise<number>>();

interface SpoolLimits {
  maxBytes?: number | undefined;
  maxEntries?: number | undefined;
}

interface ParsedSpool {
  events: CodexHookEvent[];
  invalidLines: string[];
}

async function appendCodexHookSpool(spoolPath: string, event: CodexHookEvent, limits: SpoolLimits): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  const maxBytes = positiveInteger(limits.maxBytes ?? DEFAULT_SPOOL_MAX_BYTES, "Codex hook spool byte limit");
  const maxEntries = positiveInteger(limits.maxEntries ?? DEFAULT_SPOOL_MAX_ENTRIES, "Codex hook spool entry limit");
  await withSpoolLock(spoolPath, async () => {
    const usage = await codexHookSpoolUsage(spoolPath, maxBytes);
    const lineBytes = Buffer.byteLength(line);
    if (usage.bytes + lineBytes > maxBytes || usage.entries + 1 > maxEntries) {
      throw new Error("Codex hook offline spool is full; the event was not acknowledged");
    }
    await appendFile(spoolPath, line, { mode: 0o600 });
    await chmod(spoolPath, 0o600);
  });
}

function parseCodexHookSpool(raw: string): ParsedSpool {
  const events: CodexHookEvent[] = [];
  const invalidLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      events.push(validateCodexHookEvent(JSON.parse(line)));
    } catch {
      invalidLines.push(line);
    }
  }
  return { events, invalidLines };
}

async function rotateAndListDrainingSpools(spoolPath: string): Promise<string[]> {
  return withSpoolLock(spoolPath, async () => {
    const directory = path.dirname(spoolPath);
    const basename = path.basename(spoolPath);
    const staleNames = (await readdir(directory))
      .filter((name) => name.startsWith(`${basename}.draining-`))
      .sort((left, right) => left.localeCompare(right, "en"));
    const names = [...staleNames];
    const activeMetadata = await lstat(spoolPath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (activeMetadata) {
      if (!activeMetadata.isFile()) throw new Error("Codex hook spool must be a regular file");
      const drainingPath = `${spoolPath}.draining-${Date.now().toString().padStart(13, "0")}-${process.pid}-${randomUUID()}`;
      await rename(spoolPath, drainingPath);
      await chmod(drainingPath, 0o600);
      names.push(path.basename(drainingPath));
    }
    const result: string[] = [];
    for (const name of names) {
      const candidate = path.join(directory, name);
      const metadata = await lstat(candidate);
      if (!metadata.isFile()) throw new Error("Codex hook draining spool must be a regular file");
      await chmod(candidate, 0o600);
      result.push(candidate);
    }
    return result;
  });
}

async function rewriteDrainingSpool(
  drainingPath: string,
  remaining: readonly CodexHookEvent[],
  invalidLines: readonly string[],
): Promise<void> {
  const content = [
    ...remaining.map((event) => JSON.stringify(event)),
    ...invalidLines,
  ];
  const temporary = `${drainingPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content.length === 0 ? "" : `${content.join("\n")}\n`, { mode: 0o600 });
  await rename(temporary, drainingPath);
  await chmod(drainingPath, 0o600);
}

async function quarantineDrainingSpool(spoolPath: string, drainingPath: string): Promise<void> {
  const quarantinePath = `${spoolPath}.quarantine-${Date.now().toString().padStart(13, "0")}-${randomUUID()}.jsonl`;
  await rename(drainingPath, quarantinePath);
  await chmod(quarantinePath, 0o600);
}

async function serializeSpoolDrain(spoolPath: string, operation: () => Promise<number>): Promise<number> {
  const key = path.resolve(spoolPath);
  const previous = SPOOL_DRAINERS.get(key) ?? Promise.resolve(0);
  const current = previous.catch(() => 0).then(operation);
  SPOOL_DRAINERS.set(key, current);
  try {
    return await current;
  } finally {
    if (SPOOL_DRAINERS.get(key) === current) SPOOL_DRAINERS.delete(key);
  }
}

async function withSpoolLock<T>(spoolPath: string, operation: () => Promise<T>): Promise<T> {
  const directory = path.dirname(spoolPath);
  await preparePrivateDirectory(directory);
  const lockPath = `${spoolPath}.lock`;
  const ownerPath = `${spoolPath}.lock-owner-${process.pid}-${randomUUID()}`;
  await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const deadline = Date.now() + 1_000;
  let acquired = false;
  try {
    while (true) {
      try {
        await link(ownerPath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const owner = await readSpoolLockOwner(lockPath);
        if (!isProcessAlive(owner.pid)) {
          await unlink(lockPath).catch((unlinkError: unknown) => {
            if (!(unlinkError instanceof Error && "code" in unlinkError && unlinkError.code === "ENOENT")) throw unlinkError;
          });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Codex hook offline spool is busy; the event was not acknowledged");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return await operation();
  } finally {
    if (acquired) await unlink(lockPath).catch(() => undefined);
    await unlink(ownerPath).catch(() => undefined);
  }
}

async function readSpoolLockOwner(lockPath: string): Promise<{ pid: number; created_at: string }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    throw new Error("Codex hook offline spool lock metadata is unreadable; refusing unsafe recovery");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex hook offline spool lock metadata is invalid; refusing unsafe recovery");
  }
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.pid) || (input.pid as number) <= 0
    || typeof input.created_at !== "string" || !Number.isFinite(Date.parse(input.created_at))) {
    throw new Error("Codex hook offline spool lock metadata is invalid; refusing unsafe recovery");
  }
  return { pid: input.pid as number, created_at: input.created_at };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

async function preparePrivateDirectory(
  directory: string,
  errorMessage = "Codex hook spool directory must be private (mode 0700 or stricter)",
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    if (!(await stat(directory)).isDirectory()) throw new Error(errorMessage);
    return;
  }

  const pathMetadata = await lstat(directory);
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()
    || (currentUserId !== undefined && pathMetadata.uid !== currentUserId)) {
    throw new Error(errorMessage);
  }

  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(errorMessage);
  }
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isDirectory()
      || openedMetadata.dev !== pathMetadata.dev
      || openedMetadata.ino !== pathMetadata.ino
      || (currentUserId !== undefined && openedMetadata.uid !== currentUserId)) {
      throw new Error(errorMessage);
    }
    if ((openedMetadata.mode & 0o077) !== 0) await handle.chmod(0o700);
    const securedMetadata = await handle.stat();
    if ((securedMetadata.mode & 0o077) !== 0) throw new Error(errorMessage);
  } finally {
    await handle.close();
  }
}

async function codexHookSpoolUsage(spoolPath: string, maxBytes: number): Promise<{ bytes: number; entries: number }> {
  const directory = path.dirname(spoolPath);
  const basename = path.basename(spoolPath);
  let bytes = 0;
  let entries = 0;
  for (const name of await readdir(directory)) {
    if (name !== basename
      && !name.startsWith(`${basename}.draining-`)
      && !name.startsWith(`${basename}.quarantine-`)) continue;
    const filePath = path.join(directory, name);
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) throw new Error("Codex hook spool storage must contain regular files only");
    bytes += metadata.size;
    if (bytes > maxBytes) return { bytes, entries: Number.MAX_SAFE_INTEGER };
    const raw = await readFile(filePath, "utf8");
    entries += raw.split("\n").filter(Boolean).length;
  }
  return { bytes, entries };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

async function sendRelay(socketPath: string, event: CodexHookEvent, maxBytes: number): Promise<CodexHookRelayResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.once("error", fail);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) socket.destroy(new Error("Codex hook relay response exceeded its limit"));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(event)}\n`));
    socket.once("end", () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
        const additionalContext = requiredObject(parsed).additionalContext;
        settled = true;
        resolve(typeof additionalContext === "string" ? { additionalContext } : {});
      } catch (error) {
        fail(error);
      }
    });
    socket.once("close", () => {
      if (!settled) fail(new Error("Codex hook relay closed before returning a complete response"));
    });
  });
}

async function readStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("Codex hook input exceeded its limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (!value || /[\0\r\n]/.test(value)) throw new Error("Codex hook command paths must be non-empty and single-line");
  if (platform === "win32") {
    if (/["%!$]/.test(value)) {
      throw new Error("Codex hook command paths contain Windows shell metacharacters");
    }
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex hook payload must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 * 1024) throw new Error(`Codex hook ${field} is invalid`);
  return value;
}

function requiredBoundedLabel(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`Codex hook ${field} is invalid`);
  }
  return value.trim();
}

export async function isAllowedCodexHookEvent(registryPath: string, event: CodexHookEvent): Promise<boolean> {
  try {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
    return isHookRegistry(registry)
      && registry.threads[event.session_id] === "execution"
      && path.resolve(event.cwd) === registry.workspacePath;
  } catch {
    return false;
  }
}

function isHookRegistry(value: unknown): value is CodexHookRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.workspacePath !== "string" || !input.threads || typeof input.threads !== "object" || Array.isArray(input.threads)) return false;
  return Object.values(input.threads as Record<string, unknown>).every((purpose) => purpose === "execution" || purpose === "snapshot_connector");
}
