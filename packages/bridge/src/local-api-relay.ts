import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { redactText } from "@gatherthread/adapters";
import { parseHistoryContext, validateContextReadInput } from "./http-client.js";
import type {
  AgentRequestClaim,
  AppendEventInput,
  CanonicalEvent,
  CollaborationApi,
  CompleteAgentRequestInput,
  HistoryContext,
  ProjectSummary,
  ReadEventsResult,
  RegisteredRuntime,
  RuntimeRegistration,
  SessionMemberSummary,
  SessionSummary,
} from "./types.js";
import type {
  LocalConversationSyncControl,
  LocalConversationSyncStatus,
  LocalConversationUploadResult,
  VisibleHistorySnapshotResult,
} from "./project-harness.js";

interface RelayRequest {
  id: string;
  method: string;
  params: unknown[];
  capability: string;
}

interface RelayResponse {
  id: string;
  result?: unknown;
  error?: string;
}

interface ActiveConnectorRegistration {
  version: 1;
  instanceId: string;
  endpoint: string;
  projectId: string;
  leaseExpiresAt: string;
}

interface ConnectorConnection extends ActiveConnectorRegistration {
  capability: string;
  registrationPath?: string;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const ACTIVE_LEASE_MS = 120_000;
const ACTIVE_LEASE_REFRESH_MS = 20_000;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const USER_METHODS = new Set([
  "listProjects",
  "listProjectSessions",
  "listSessions",
  "listSessionMembers",
  "readEvents",
  "readContext",
  "appendEvent",
  "getLocalSyncStatus",
  "setLocalAutoUpload",
  "uploadLocalTurns",
  "importVisibleHistorySnapshot",
]);

export function resolveWorkspaceConnectorApiPath(
  workspacePath: string,
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const resolvedWorkspace = path.resolve(workspacePath);
  const id = createHash("sha256")
    .update(platform === "win32" ? resolvedWorkspace.toLowerCase() : resolvedWorkspace)
    .digest("hex")
    .slice(0, 24);
  if (platform === "win32") return `\\\\.\\pipe\\gatherthread-${id}-user-api`;
  return path.join(homeDirectory, ".gatherthread", "codex", "ipc", id, "user-api.sock");
}

export class LocalConnectorApiRelayServer {
  readonly #endpoint: string;
  readonly #api: CollaborationApi;
  readonly #platform: NodeJS.Platform;
  readonly #homeDirectory: string;
  readonly #projectId: string;
  readonly #localSync: LocalConversationSyncControl | undefined;
  readonly #instanceId = randomUUID();
  readonly #capabilityPath: string;
  readonly #registrationPath: string;
  readonly #capability = randomBytes(32).toString("base64url");
  #server: net.Server | undefined;
  #leaseTimer: NodeJS.Timeout | undefined;

  constructor(options: {
    endpoint: string;
    api: CollaborationApi;
    projectId: string;
    platform?: NodeJS.Platform;
    homeDirectory?: string;
    localSync?: LocalConversationSyncControl;
  }) {
    if (!PROJECT_ID_PATTERN.test(options.projectId)) throw new Error("Invalid local connector project route");
    this.#endpoint = options.endpoint;
    this.#api = options.api;
    this.#projectId = options.projectId;
    this.#localSync = options.localSync;
    this.#platform = options.platform ?? process.platform;
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#capabilityPath = capabilityPathForEndpoint(this.#endpoint, this.#platform, this.#homeDirectory);
    this.#registrationPath = path.join(activeRegistryRoot(this.#homeDirectory), `${this.#instanceId}.json`);
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await preparePrivateIpcDirectory(activeRegistryRoot(this.#homeDirectory), this.#platform);
    if (this.#platform !== "win32") {
      await preparePrivateIpcDirectory(path.dirname(this.#endpoint), this.#platform);
      await refuseActiveConnectorOrRemoveStaleSocket(this.#endpoint);
    } else {
      await mkdir(path.dirname(this.#capabilityPath), { recursive: true, mode: 0o700 });
      await refuseActiveConnectorOrRemoveStaleSocket(this.#endpoint, false);
    }
    const server = net.createServer((socket) => this.#handle(socket));
    this.#server = server;
    let listening = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#endpoint, () => {
          listening = true;
          server.removeListener("error", reject);
          resolve();
        });
      });
      if (this.#platform !== "win32") await chmod(this.#endpoint, 0o600);
      await writeFile(this.#capabilityPath, this.#capability, { mode: 0o600 });
      if (this.#platform !== "win32") await chmod(this.#capabilityPath, 0o600);
      await this.#refreshRegistration();
      this.#leaseTimer = setInterval(() => {
        void this.#refreshRegistration().catch(() => undefined);
      }, ACTIVE_LEASE_REFRESH_MS);
      this.#leaseTimer.unref();
    } catch (error) {
      if (this.#leaseTimer) clearInterval(this.#leaseTimer);
      this.#leaseTimer = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      await Promise.all([
        ...(listening && this.#platform !== "win32"
          ? [unlink(this.#endpoint).catch(() => undefined)]
          : []),
        unlink(this.#capabilityPath).catch(() => undefined),
        unlink(this.#registrationPath).catch(() => undefined),
      ]);
      this.#server = undefined;
      throw error;
    }
    server.on("error", () => undefined);
  }

  async close(): Promise<void> {
    if (this.#leaseTimer) clearInterval(this.#leaseTimer);
    this.#leaseTimer = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (!error || ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) resolve();
      else reject(error);
    }));
    if (this.#platform !== "win32") await unlink(this.#endpoint).catch(() => undefined);
    await Promise.all([
      unlink(this.#capabilityPath).catch(() => undefined),
      unlink(this.#registrationPath).catch(() => undefined),
    ]);
  }

  async #refreshRegistration(): Promise<void> {
    const registration: ActiveConnectorRegistration = {
      version: 1,
      instanceId: this.#instanceId,
      endpoint: this.#endpoint,
      projectId: this.#projectId,
      leaseExpiresAt: new Date(Date.now() + ACTIVE_LEASE_MS).toISOString(),
    };
    const temporaryPath = `${this.#registrationPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registration)}\n`, { mode: 0o600 });
    if (this.#platform !== "win32") await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.#registrationPath);
  }

  #handle(socket: net.Socket): void {
    socket.setTimeout(10_000, () => socket.destroy());
    let data = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const frame = data.slice(0, newline);
      data = "";
      void this.#respond(socket, frame);
    });
  }

  async #respond(socket: net.Socket, frame: string): Promise<void> {
    let id = "invalid";
    try {
      const request = parseRequest(JSON.parse(frame));
      id = request.id;
      if (!timingSafeCapabilityMatch(request.capability, this.#capability)) {
        throw new Error("Local connector capability was rejected");
      }
      if (!USER_METHODS.has(request.method)) throw new Error("Local method is not available");
      const result = await this.#invokeUserMethod(request.method, request.params);
      socket.end(`${JSON.stringify({ id, result } satisfies RelayResponse)}\n`);
    } catch (error) {
      const safe = redactText(error instanceof Error ? error.message : "Local connector request failed");
      socket.end(`${JSON.stringify({ id, error: safe } satisfies RelayResponse)}\n`);
    }
  }

  async #invokeUserMethod(method: string, params: unknown[]): Promise<unknown> {
    const listProjects = this.#api.listProjects;
    const listProjectSessions = this.#api.listProjectSessions;
    if (!listProjects || !listProjectSessions) throw new Error("Local connector project API is unavailable");
    if (method === "listProjects") {
      requireParameterCount(params, 0);
      return (await listProjects.call(this.#api)).filter((project) => project.id === this.#projectId);
    }
    if (method === "listProjectSessions") {
      requireParameterCount(params, 1);
      if (params[0] !== this.#projectId) throw new Error("Project is not routed by this connector");
      return listProjectSessions.call(this.#api, this.#projectId);
    }
    if (method === "listSessions") {
      requireParameterCount(params, 0);
      return listProjectSessions.call(this.#api, this.#projectId);
    }
    const sessionId = requiredLocalString(params[0], "session ID");
    const sessions = await listProjectSessions.call(this.#api, this.#projectId);
    if (!sessions.some((session) => session.id === sessionId)) {
      throw new Error("Session is not routed by this connector");
    }
    if (method === "listSessionMembers") {
      requireParameterCount(params, 1);
      if (!this.#api.listSessionMembers) throw new Error("Local connector member API is unavailable");
      return this.#api.listSessionMembers(sessionId);
    }
    if (method === "readEvents") {
      if (params.length < 2 || params.length > 3) throw new Error("Invalid local parameter count");
      return this.#api.readEvents(sessionId, params[1] as number, params[2] as number | undefined);
    }
    if (method === "readContext") {
      if (params.length < 1 || params.length > 3) throw new Error("Invalid local parameter count");
      // JSON arrays represent an omitted middle argument as null when only a fence is supplied.
      const view = params[1] == null ? undefined : params[1] as HistoryContext["view"];
      const throughSequence = params[2] as number | undefined;
      validateContextReadInput(sessionId, view, throughSequence);
      if (!this.#api.readContext) throw new Error("Context reading is unavailable on this connector; raw history was not substituted");
      return parseHistoryContext(await this.#api.readContext(sessionId, view, throughSequence), view, throughSequence);
    }
    if (method === "appendEvent") {
      requireParameterCount(params, 2);
      const event = params[1] as AppendEventInput;
      if (!event || typeof event !== "object"
        || (event.type !== "human_chat" && event.type !== "agent_request")) {
        throw new Error("Local user relay accepts only chat or agent request events");
      }
      return this.#api.appendEvent(sessionId, event);
    }
    if (method === "getLocalSyncStatus") {
      requireParameterCount(params, 1);
      if (!this.#localSync) throw new Error("Local conversation sync controls are unavailable");
      return this.#localSync.getLocalSyncStatus(sessionId);
    }
    if (method === "setLocalAutoUpload") {
      requireParameterCount(params, 2);
      if (typeof params[1] !== "boolean") throw new Error("Automatic upload must be true or false");
      if (!this.#localSync) throw new Error("Local conversation sync controls are unavailable");
      return this.#localSync.setLocalAutoUpload(sessionId, params[1]);
    }
    if (method === "uploadLocalTurns") {
      requireParameterCount(params, 1);
      if (!this.#localSync) throw new Error("Local conversation sync controls are unavailable");
      return this.#localSync.uploadLocalTurns(sessionId);
    }
    if (method === "importVisibleHistorySnapshot") {
      requireParameterCount(params, 1);
      if (!this.#localSync) throw new Error("Local conversation sync controls are unavailable");
      return this.#localSync.importVisibleHistorySnapshot(sessionId);
    }
    throw new Error("Local method is not available");
  }
}

export class LocalConnectorCollaborationClient implements CollaborationApi {
  readonly #explicitEndpoint: string | undefined;
  readonly #workspacePath: string;
  readonly #homeDirectory: string;
  readonly #platform: NodeJS.Platform;
  #projectRoutes = new Map<string, ConnectorConnection[]>();
  #sessionRoutes = new Map<string, ConnectorConnection[]>();

  constructor(options: { workspacePath?: string; endpoint?: string; homeDirectory?: string; platform?: NodeJS.Platform }) {
    this.#explicitEndpoint = options.endpoint;
    this.#workspacePath = path.resolve(options.workspacePath ?? process.cwd());
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#platform = options.platform ?? process.platform;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const rows = await this.#readAcross<ProjectSummary[]>("listProjects");
    this.#projectRoutes = new Map();
    const projects: ProjectSummary[] = [];
    for (const { connection, result } of rows) {
      for (const project of result) {
        rememberRoute(this.#projectRoutes, project.id, connection);
        projects.push(project);
      }
    }
    rejectAmbiguousRoutes(this.#projectRoutes, "project");
    return projects.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async listProjectSessions(projectId: string): Promise<SessionSummary[]> {
    const connection = await this.#projectRoute(projectId);
    const sessions = await this.#callConnection<SessionSummary[]>(connection, "listProjectSessions", [projectId]);
    this.#rememberSessions(connection, sessions);
    return sessions;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const rows = await this.#readAcross<SessionSummary[]>("listSessions");
    this.#sessionRoutes = new Map();
    const sessions: SessionSummary[] = [];
    for (const { connection, result } of rows) {
      this.#rememberSessions(connection, result);
      sessions.push(...result);
    }
    rejectAmbiguousRoutes(this.#sessionRoutes, "session");
    return sessions.sort((left, right) => (left.name ?? "").localeCompare(right.name ?? "") || left.id.localeCompare(right.id));
  }

  async listSessionMembers(sessionId: string): Promise<SessionMemberSummary[]> {
    return this.#callConnection(await this.#sessionRoute(sessionId), "listSessionMembers", [sessionId]);
  }

  async readEvents(sessionId: string, afterSequence: number, limit?: number): Promise<ReadEventsResult> {
    return this.#callConnection(await this.#sessionRoute(sessionId), "readEvents", [sessionId, afterSequence, limit]);
  }

  async readContext(sessionId: string, view?: HistoryContext["view"], throughSequence?: number): Promise<HistoryContext> {
    validateContextReadInput(sessionId, view, throughSequence);
    const params = throughSequence !== undefined ? [sessionId, view, throughSequence]
      : view !== undefined ? [sessionId, view] : [sessionId];
    const result = await this.#callConnection(await this.#sessionRoute(sessionId), "readContext", params);
    return parseHistoryContext(result, view, throughSequence);
  }

  async appendEvent(sessionId: string, event: AppendEventInput): Promise<CanonicalEvent> {
    return this.#callConnection(await this.#sessionRoute(sessionId), "appendEvent", [sessionId, event]);
  }

  async getLocalSyncStatus(sessionId: string): Promise<LocalConversationSyncStatus> {
    return this.#callConnection(await this.#sessionRoute(sessionId), "getLocalSyncStatus", [sessionId]);
  }

  async setLocalAutoUpload(sessionId: string, enabled: boolean): Promise<LocalConversationSyncStatus> {
    return this.#callConnection(await this.#sessionRoute(sessionId), "setLocalAutoUpload", [sessionId, enabled]);
  }

  async uploadLocalTurns(sessionId: string): Promise<LocalConversationUploadResult> {
    return this.#callConnection(await this.#sessionRoute(sessionId), "uploadLocalTurns", [sessionId]);
  }

  async importVisibleHistorySnapshot(sessionId: string): Promise<VisibleHistorySnapshotResult> {
    return this.#callConnection<VisibleHistorySnapshotResult>(
      await this.#sessionRoute(sessionId),
      "importVisibleHistorySnapshot",
      [sessionId],
    );
  }

  registerRuntime(_runtime: RuntimeRegistration): Promise<RegisteredRuntime> {
    return Promise.reject(new Error("Runtime controls are not available through the user MCP relay"));
  }

  claimAgentRequest(_sessionId: string, _requestId: string, _runtimeId: string): Promise<AgentRequestClaim> {
    return Promise.reject(new Error("Runtime controls are not available through the user MCP relay"));
  }

  completeAgentRequest(
    _sessionId: string,
    _requestId: string,
    _input: CompleteAgentRequestInput,
  ): Promise<CanonicalEvent> {
    return Promise.reject(new Error("Runtime controls are not available through the user MCP relay"));
  }

  async #projectRoute(projectId: string): Promise<ConnectorConnection> {
    if (!this.#projectRoutes.has(projectId)) await this.listProjects();
    return uniqueRoute(this.#projectRoutes, projectId, "project");
  }

  async #sessionRoute(sessionId: string): Promise<ConnectorConnection> {
    if (!this.#sessionRoutes.has(sessionId)) await this.listSessions();
    return uniqueRoute(this.#sessionRoutes, sessionId, "session");
  }

  #rememberSessions(connection: ConnectorConnection, sessions: SessionSummary[]): void {
    for (const session of sessions) rememberRoute(this.#sessionRoutes, session.id, connection);
    rejectAmbiguousRoutes(this.#sessionRoutes, "session");
  }

  async #readAcross<T>(method: string): Promise<Array<{ connection: ConnectorConnection; result: T }>> {
    const connections = await this.#resolveConnections();
    const rows: Array<{ connection: ConnectorConnection; result: T }> = [];
    let unavailable: Error | undefined;
    for (const connection of connections) {
      try {
        rows.push({ connection, result: await this.#callConnection<T>(connection, method, []) });
      } catch (error) {
        if (!(error instanceof LocalConnectorUnavailableError)) throw error;
        unavailable = error;
      }
    }
    if (unavailable) throw unavailable;
    if (rows.length === 0) throw new Error("No active GatherThread connector is available");
    return rows;
  }

  async #callConnection<T>(connection: ConnectorConnection, method: string, params: unknown[]): Promise<T> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(connection.capability)) {
      throw new Error("Local connector capability is invalid");
    }
    const request: RelayRequest = { id: randomUUID(), method, params, capability: connection.capability };
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(connection.endpoint);
      let data = "";
      socket.setEncoding("utf8");
      socket.setTimeout(10_000, () => socket.destroy(new Error("Local connector request timed out")));
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        data += chunk;
        if (Buffer.byteLength(data) > MAX_FRAME_BYTES) socket.destroy(new Error("Local connector response is too large"));
      });
      socket.once("error", (error) => {
        const unavailable = new LocalConnectorUnavailableError(
          error instanceof Error && "code" in error && error.code === "ENOENT"
            ? "The routed GatherThread connector is offline; start its fixed-version npx connector"
            : `Could not reach the routed GatherThread connector: ${redactText(error.message)}; start the corresponding fixed-version npx connector`,
        );
        void this.#cleanExpiredRegistration(connection).then(
          () => reject(unavailable),
          () => reject(unavailable),
        );
      });
      socket.once("end", () => {
        try {
          const response = parseResponse(JSON.parse(data.trim()));
          if (response.id !== request.id) throw new Error("Local connector returned a mismatched response");
          if (response.error) throw new Error(response.error);
          resolve(response.result as T);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async #resolveConnections(): Promise<ConnectorConnection[]> {
    if (this.#explicitEndpoint) {
      return [{
        version: 1,
        instanceId: "explicit",
        endpoint: this.#explicitEndpoint,
        projectId: "explicit",
        leaseExpiresAt: new Date(0).toISOString(),
        capability: await this.#readCapability(this.#explicitEndpoint),
      }];
    }
    const registrations = newestRegistrationPerEndpoint(
      await readActiveRegistrations(this.#homeDirectory, this.#platform),
    );
    const connections: ConnectorConnection[] = [];
    for (const registration of registrations) {
      try {
        connections.push({
          ...registration,
          capability: await this.#readCapability(registration.endpoint),
        });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (Date.parse(registration.leaseExpiresAt) <= Date.now()) {
          if (registration.registrationPath) await unlink(registration.registrationPath).catch(() => undefined);
          continue;
        }
        throw new LocalConnectorUnavailableError(
          `Active GatherThread connector ${registration.instanceId} is missing its private capability; restart the corresponding fixed-version npx connector`,
        );
      }
    }
    if (connections.length > 0) return connections;

    // Legacy fallback for a connector that predates the active registry. Once any
    // registered connector is present, discovery must aggregate all registrations
    // instead of silently preferring the caller's current workspace.
    let candidate: string;
    try {
      candidate = await realpath(this.#workspacePath);
    } catch {
      candidate = this.#workspacePath;
    }
    while (true) {
      const endpoint = resolveWorkspaceConnectorApiPath(candidate, this.#homeDirectory, this.#platform);
      try {
        return [{
          version: 1,
          instanceId: "workspace",
          endpoint,
          projectId: "workspace",
          leaseExpiresAt: new Date(0).toISOString(),
          capability: await this.#readCapability(endpoint),
        }];
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
      }
    }
    throw new Error("GatherThread connector is not running; start the fixed-version npx connector first");
  }

  async #readCapability(endpoint: string): Promise<string> {
    return (await readFile(
      capabilityPathForEndpoint(endpoint, this.#platform, this.#homeDirectory),
      "utf8",
    )).trim();
  }

  async #cleanExpiredRegistration(connection: ConnectorConnection): Promise<void> {
    if (!connection.registrationPath || Date.parse(connection.leaseExpiresAt) > Date.now()) return;
    // The endpoint capability may already have been replaced by a restarted
    // connector. Expiry proves ownership only of this registration record.
    await unlink(connection.registrationPath).catch(() => undefined);
  }
}

class LocalConnectorUnavailableError extends Error {}

function rememberRoute(
  routes: Map<string, ConnectorConnection[]>,
  id: string,
  connection: ConnectorConnection,
): void {
  const existing = routes.get(id) ?? [];
  if (!existing.some((candidate) => candidate.endpoint === connection.endpoint)) existing.push(connection);
  routes.set(id, existing);
}

function rejectAmbiguousRoutes(routes: Map<string, ConnectorConnection[]>, kind: "project" | "session"): void {
  const ambiguous = [...routes.entries()].find(([, connections]) => connections.length > 1);
  if (ambiguous) {
    throw new Error(`Multiple active connectors expose ${kind} ID ${ambiguous[0]}; stop the duplicate or ambiguous connector before writing`);
  }
}

function uniqueRoute(
  routes: Map<string, ConnectorConnection[]>,
  id: string,
  kind: "project" | "session",
): ConnectorConnection {
  const candidates = routes.get(id) ?? [];
  if (candidates.length === 0) {
    throw new Error(`No active connector routes ${kind} ID ${id}; select or start the corresponding fixed-version npx connector`);
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple active connectors expose ${kind} ID ${id}; stop the duplicate or ambiguous connector before writing`);
  }
  return candidates[0] as ConnectorConnection;
}

function parseRequest(value: unknown): RelayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local request");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.method !== "string"
    || typeof input.capability !== "string" || !Array.isArray(input.params)) {
    throw new Error("Invalid local request");
  }
  return { id: input.id, method: input.method, params: input.params, capability: input.capability };
}

function parseResponse(value: unknown): RelayResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local response");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string") throw new Error("Invalid local response");
  return {
    id: input.id,
    ...(typeof input.error === "string" ? { error: input.error } : { result: input.result }),
  };
}

function requiredLocalString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid local ${label}`);
  }
  return value;
}

function requireParameterCount(params: unknown[], count: number): void {
  if (params.length !== count) throw new Error("Invalid local parameter count");
}

function capabilityPathForEndpoint(
  endpoint: string,
  platform: NodeJS.Platform,
  homeDirectory = homedir(),
): string {
  if (platform !== "win32") return `${endpoint}.capability`;
  const id = endpoint.match(/gatherthread-([a-f0-9]{24})-user-api$/)?.[1];
  if (!id) throw new Error("Invalid GatherThread Windows IPC endpoint");
  return path.join(homeDirectory, ".gatherthread", "codex", "ipc", id, "user-api.capability");
}

function activeRegistryRoot(homeDirectory: string): string {
  return path.join(homeDirectory, ".gatherthread", "codex", "ipc", "active");
}

async function readActiveRegistrations(
  homeDirectory: string,
  platform: NodeJS.Platform,
): Promise<ConnectorConnection[]> {
  const root = activeRegistryRoot(homeDirectory);
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const registrations: ConnectorConnection[] = [];
  for (const name of names) {
    const registrationPath = path.join(root, name);
    try {
      const parsed = JSON.parse(await readFile(registrationPath, "utf8")) as unknown;
      if (!isActiveRegistration(parsed)
        || `${parsed.instanceId}.json` !== name
        || !isExpectedConnectorEndpoint(parsed.endpoint, homeDirectory, platform)) {
        continue;
      }
      if (Date.parse(parsed.leaseExpiresAt) <= Date.now()) {
        // The registration owns only this lease record. Its endpoint and
        // capability may already belong to a restarted instance, so discovery
        // removes neither when expiring the old entry.
        await unlink(registrationPath).catch(() => undefined);
        continue;
      }
      registrations.push({ ...parsed, capability: "", registrationPath });
    } catch {
      // Malformed local entries are never authority and are ignored.
    }
  }
  return registrations;
}

function newestRegistrationPerEndpoint(registrations: ConnectorConnection[]): ConnectorConnection[] {
  const byEndpoint = new Map<string, ConnectorConnection>();
  for (const registration of registrations) {
    const current = byEndpoint.get(registration.endpoint);
    const leaseOrder = current === undefined
      ? 1
      : Date.parse(registration.leaseExpiresAt) - Date.parse(current.leaseExpiresAt);
    if (current === undefined || leaseOrder > 0
      || (leaseOrder === 0 && registration.instanceId.localeCompare(current.instanceId, "en") > 0)) {
      byEndpoint.set(registration.endpoint, registration);
    }
  }
  return [...byEndpoint.values()].sort((left, right) =>
    left.endpoint.localeCompare(right.endpoint, "en") || left.instanceId.localeCompare(right.instanceId, "en"));
}

function isActiveRegistration(value: unknown): value is ActiveConnectorRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.version === 1
    && typeof input.instanceId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.instanceId)
    && typeof input.endpoint === "string"
    && typeof input.projectId === "string"
    && PROJECT_ID_PATTERN.test(input.projectId)
    && typeof input.leaseExpiresAt === "string"
    && Number.isFinite(Date.parse(input.leaseExpiresAt));
}

function isExpectedConnectorEndpoint(
  endpoint: string,
  homeDirectory: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") return /^\\\\\.\\pipe\\gatherthread-[a-f0-9]{24}-user-api$/.test(endpoint);
  const ipcRoot = path.join(homeDirectory, ".gatherthread", "codex", "ipc");
  const relative = path.relative(ipcRoot, endpoint);
  return /^[a-f0-9]{24}[\\/]user-api\.sock$/.test(relative) && !relative.startsWith("..");
}

async function refuseActiveConnectorOrRemoveStaleSocket(endpoint: string, removeStale = true): Promise<void> {
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error("Another GatherThread connector is already active for this project workspace");
  if (removeStale) await unlink(endpoint).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

function timingSafeCapabilityMatch(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

async function preparePrivateIpcDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)) {
    throw new Error("GatherThread local IPC directory must be owned by the current user");
  }
  if (platform !== "win32" && (metadata.mode & 0o077) !== 0) await chmod(directory, 0o700);
  if (platform !== "win32" && ((await lstat(directory)).mode & 0o077) !== 0) {
    throw new Error("GatherThread local IPC directory must be private");
  }
}
