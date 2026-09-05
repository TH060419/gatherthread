import { createHash, randomUUID } from "node:crypto";
import { redactText, redactValue } from "@gatherthread/adapters";
import type {
  CollaborationApi,
  RuntimeRegistration,
} from "@gatherthread/bridge";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface CollaborationMcpServiceOptions {
  api: CollaborationApi;
  serverName?: string;
  serverVersion?: string;
  allowProviderRequestCapture?: boolean;
  toolProfile?: "user" | "runtime";
}

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const MUTATING_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const USER_TOOL_DEFINITIONS = [
  tool("collaboration_list_projects", "List collaboration projects visible to the authenticated user", {}),
  tool("collaboration_list_project_sessions", "List sessions in one visible collaboration project", {
    project_id: stringSchema("Project identifier"),
  }, ["project_id"]),
  tool("collaboration_list_sessions", "List collaboration sessions visible to the authenticated user", {}),
  tool("collaboration_read_history", "Read canonical session events after a durable server sequence", {
    session_id: stringSchema("Session identifier"),
    after_sequence: integerSchema("Return events after this sequence", 0),
    limit: integerSchema("Maximum events to return", 1),
  }, ["session_id"]),
  tool("collaboration_append_chat", "Append human chat without triggering an agent", {
    session_id: stringSchema("Session identifier"),
    content: stringSchema("Visible chat content"),
    idempotency_key: idempotencySchema(),
    reply_to: stringSchema("Optional event ID being replied to"),
  }, ["session_id", "content", "idempotency_key"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_request_agent", "Mutating remote operation that requests an Agent run and may consume compute or other resources", {
    session_id: stringSchema("Session identifier"),
    content: stringSchema("Visible agent request"),
    idempotency_key: idempotencySchema(),
    reply_to: stringSchema("Optional event ID being replied to"),
  }, ["session_id", "content", "idempotency_key"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_get_connection_status", "Show sanitized connector presence for sessions in one visible project", {
    project_id: stringSchema("Project identifier"),
  }, ["project_id"]),
] as const;

const RUNTIME_TOOL_DEFINITIONS = [
  tool("collaboration_register_runtime", "Register a local Codex or Claude Code runtime", {
    session_id: stringSchema("Session identifier"),
    device_id: stringSchema("Stable local device identifier"),
    harness: enumSchema(["codex", "claude-code"]),
    provider: stringSchema("Provider name"),
    model: stringSchema("Model name"),
    local_session_id: stringSchema("Local harness session identifier"),
    capture_fidelity: enumSchema(["canonical_history", "harness_transcript", "provider_request"]),
    capabilities: { type: "array", items: { type: "string" } },
  }, ["session_id", "device_id", "harness", "provider", "model", "local_session_id", "capture_fidelity"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_claim_agent_request", "Claim an eligible agent request for a registered runtime", {
    session_id: stringSchema("Session identifier"),
    request_id: stringSchema("Agent request event ID"),
    runtime_id: stringSchema("Registered runtime ID"),
  }, ["session_id", "request_id", "runtime_id"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_complete_agent_request", "Complete a claimed request with one canonical agent response", {
    session_id: stringSchema("Session identifier"),
    request_id: stringSchema("Agent request event ID"),
    runtime_id: stringSchema("Registered runtime ID"),
    idempotency_key: idempotencySchema(),
    payload: {},
  }, ["session_id", "request_id", "runtime_id", "idempotency_key", "payload"], MUTATING_TOOL_ANNOTATIONS),
  tool("collaboration_upload_context_snapshot", "Upload an explicitly fidelity-labelled and redacted context snapshot", {
    session_id: stringSchema("Session identifier"),
    capture_fidelity: enumSchema(["canonical_history", "harness_transcript", "provider_request"]),
    content: {},
    idempotency_key: idempotencySchema("Stable retry key; generated if omitted"),
    covers_through_sequence: integerSchema("Required for canonical_history", 0),
    local_session_id: stringSchema("Required for harness_transcript; fingerprinted before append"),
    exact_provider_request: { type: "boolean" },
    observed_by: enumSchema(["harness_hook", "authorized_proxy"]),
    runtime_id: stringSchema("Runtime that observed the snapshot"),
  }, ["session_id", "capture_fidelity", "content"], MUTATING_TOOL_ANNOTATIONS),
] as const;

export class CollaborationMcpService {
  readonly #api: CollaborationApi;
  readonly #serverName: string;
  readonly #serverVersion: string;
  readonly #allowProviderRequestCapture: boolean;
  readonly #toolProfile: "user" | "runtime";
  readonly #toolDefinitions: readonly (typeof USER_TOOL_DEFINITIONS[number] | typeof RUNTIME_TOOL_DEFINITIONS[number])[];
  readonly #toolNames: ReadonlySet<string>;

  constructor(options: CollaborationMcpServiceOptions) {
    this.#api = options.api;
    this.#serverName = options.serverName ?? "gatherthread";
    this.#serverVersion = options.serverVersion ?? "0.1.0";
    this.#allowProviderRequestCapture = options.allowProviderRequestCapture === true;
    this.#toolProfile = options.toolProfile ?? "user";
    this.#toolDefinitions = this.#toolProfile === "runtime" ? RUNTIME_TOOL_DEFINITIONS : USER_TOOL_DEFINITIONS;
    this.#toolNames = new Set(this.#toolDefinitions.map(({ name }) => name));
  }

  async handle(input: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isObject(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string") {
      const invalidId = isObject(input) && (typeof input.id === "string" || typeof input.id === "number")
        ? input.id
        : null;
      return failure(invalidId, -32600, "Invalid Request");
    }
    const request = input as unknown as JsonRpcRequest;
    if (request.id === undefined) return undefined;

    try {
      const result = await this.#dispatch(request.method, request.params);
      return { jsonrpc: "2.0", id: request.id ?? null, result };
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : "Unknown MCP error");
      const code = error instanceof MethodNotFoundError ? -32601 : -32602;
      return failure(request.id ?? null, code, message);
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: requestedProtocolVersion(params),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: this.#serverName, version: this.#serverVersion },
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: this.#toolDefinitions };
    if (method === "resources/list") {
      return { resources: this.#toolProfile === "user" ? await this.#listResources() : [] };
    }
    if (method === "resources/read") {
      if (this.#toolProfile !== "user") throw new MethodNotFoundError("Method not found: resources/read");
      return this.#readResource(requiredString(requiredObject(params), "uri"));
    }
    if (method === "tools/call") {
      const input = requiredObject(params);
      const name = requiredString(input, "name");
      if (!this.#toolNames.has(name)) throw new MethodNotFoundError(`Unknown tool: ${name}`);
      return this.#callTool(name, optionalObject(input.arguments));
    }
    throw new MethodNotFoundError(`Method not found: ${method}`);
  }

  async #callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result: unknown;
    switch (name) {
      case "collaboration_list_projects":
        result = await this.#requireProjectApi("listProjects")();
        break;
      case "collaboration_list_project_sessions":
        result = await this.#requireProjectApi("listProjectSessions")(requiredString(args, "project_id"));
        break;
      case "collaboration_list_sessions":
        result = await this.#api.listSessions();
        break;
      case "collaboration_read_history":
        result = await this.#api.readEvents(
          requiredString(args, "session_id"),
          optionalInteger(args.after_sequence, 0),
          optionalPositiveInteger(args.limit, 200),
        );
        break;
      case "collaboration_append_chat":
        result = await this.#appendVisibleMessage(args, "human_chat");
        break;
      case "collaboration_request_agent":
        result = await this.#appendVisibleMessage(args, "agent_request");
        break;
      case "collaboration_get_connection_status":
        result = await this.#connectionStatus(requiredString(args, "project_id"));
        break;
      case "collaboration_register_runtime":
        result = await this.#api.registerRuntime(runtimeInput(args));
        break;
      case "collaboration_claim_agent_request":
        result = await this.#api.claimAgentRequest(
          requiredString(args, "session_id"),
          requiredString(args, "request_id"),
          requiredString(args, "runtime_id"),
        );
        break;
      case "collaboration_complete_agent_request":
        result = await this.#api.completeAgentRequest(
          requiredString(args, "session_id"),
          requiredString(args, "request_id"),
          {
            runtimeId: requiredString(args, "runtime_id"),
            idempotencyKey: requiredIdempotencyKey(args, "idempotency_key"),
            payload: redactValue(requiredValue(args, "payload")),
          },
        );
        break;
      case "collaboration_upload_context_snapshot":
        result = await this.#uploadContextSnapshot(args);
        break;
      default:
        throw new MethodNotFoundError(`Unknown tool: ${name}`);
    }
    return toolResult(result);
  }

  async #connectionStatus(projectId: string): Promise<unknown> {
    const projects = await this.#requireProjectApi("listProjects")();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("The requested project is unavailable for this user");
    const listMembers = this.#api.listSessionMembers;
    if (!listMembers) throw new Error("The configured collaboration API does not support listSessionMembers");
    const sessions = await this.#requireProjectApi("listProjectSessions")(projectId);
    return {
      project: { id: project.id, name: project.name, role: project.role, state: project.state },
      sessions: await Promise.all(sessions.map(async (session) => ({
        id: session.id,
        name: session.name,
        mode: session.mode,
        members: (await listMembers.call(this.#api, session.id)).map((member) => ({
          displayName: member.displayName,
          role: member.role,
          runtime: member.runtime,
        })),
      }))),
    };
  }

  async #appendVisibleMessage(
    args: Record<string, unknown>,
    type: "human_chat" | "agent_request",
  ): Promise<unknown> {
    const replyTo = optionalString(args.reply_to);
    return this.#api.appendEvent(requiredString(args, "session_id"), {
      type,
      idempotencyKey: requiredIdempotencyKey(args, "idempotency_key"),
      payload: { text: redactText(requiredString(args, "content")) },
      ...(replyTo === undefined ? {} : { replyTo }),
    });
  }

  async #uploadContextSnapshot(args: Record<string, unknown>): Promise<unknown> {
    const fidelity = requiredEnum(args, "capture_fidelity", [
      "canonical_history", "harness_transcript", "provider_request",
    ] as const);
    const payload: Record<string, unknown> = {
      capture_fidelity: fidelity,
      content: redactValue(requiredValue(args, "content")),
    };
    if (fidelity === "canonical_history") {
      payload.covers_through_sequence = requiredInteger(args, "covers_through_sequence");
    } else if (fidelity === "harness_transcript") {
      payload.local_session_fingerprint = createHash("sha256")
        .update(requiredString(args, "local_session_id"))
        .digest("hex");
    } else {
      if (!this.#allowProviderRequestCapture
        || args.exact_provider_request !== true
        || !["harness_hook", "authorized_proxy"].includes(String(args.observed_by))) {
        throw new Error(
          "provider_request requires explicit service authorization, exact_provider_request=true, and hook/proxy observation",
        );
      }
      payload.exact_provider_request = true;
      payload.observed_by = args.observed_by;
      payload.runtime_id = requiredString(args, "runtime_id");
    }
    const runtimeId = optionalString(args.runtime_id);
    return this.#api.appendEvent(requiredString(args, "session_id"), {
      type: "context_snapshot",
      idempotencyKey: optionalIdempotencyKey(args.idempotency_key) ?? randomUUID(),
      payload,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    });
  }

  async #listResources(): Promise<unknown[]> {
    const sessions = await this.#api.listSessions();
    const projects = this.#api.listProjects ? await this.#api.listProjects() : [];
    return [
      ...(this.#api.listProjects ? [{
        uri: "collaboration://projects",
        name: "Collaboration projects",
        mimeType: "application/json",
      }] : []),
      ...projects.map((project) => ({
        uri: `collaboration://projects/${encodeURIComponent(project.id)}/sessions`,
        name: `${project.name} sessions`,
        mimeType: "application/json",
      })),
      {
        uri: "collaboration://sessions",
        name: "Collaboration sessions",
        mimeType: "application/json",
      },
      ...sessions.map((session) => ({
        uri: `collaboration://sessions/${encodeURIComponent(session.id)}/events`,
        name: session.name ? `${session.name} history` : `Session ${session.id} history`,
        mimeType: "application/json",
      })),
    ];
  }

  async #readResource(uri: string): Promise<unknown> {
    const parsed = new URL(uri);
    if (parsed.protocol !== "collaboration:") throw new Error("Unsupported resource URI");
    if (parsed.hostname === "projects" && (parsed.pathname === "" || parsed.pathname === "/")) {
      return resourceResult(uri, await this.#requireProjectApi("listProjects")());
    }
    if (parsed.hostname === "projects") {
      const projectMatch = parsed.pathname.match(/^\/([^/]+)\/sessions$/);
      if (!projectMatch) throw new Error("Unsupported resource URI");
      return resourceResult(
        uri,
        await this.#requireProjectApi("listProjectSessions")(decodeURIComponent(projectMatch[1] ?? "")),
      );
    }
    if (parsed.hostname === "sessions" && (parsed.pathname === "" || parsed.pathname === "/")) {
      return resourceResult(uri, await this.#api.listSessions());
    }
    if (parsed.hostname !== "sessions") throw new Error("Unsupported resource URI");
    const match = parsed.pathname.match(/^\/([^/]+)\/events$/);
    if (!match) throw new Error("Unsupported resource URI");
    const sessionId = decodeURIComponent(match[1] ?? "");
    const after = optionalInteger(parsed.searchParams.get("after_sequence"), 0);
    const limit = optionalPositiveInteger(parsed.searchParams.get("limit"), 200);
    return resourceResult(uri, await this.#api.readEvents(sessionId, after, limit));
  }

  #requireProjectApi<K extends "listProjects" | "listProjectSessions">(
    name: K,
  ): NonNullable<CollaborationApi[K]> {
    const operation = this.#api[name];
    if (!operation) throw new Error(`The configured collaboration API does not support ${name}`);
    return operation.bind(this.#api) as NonNullable<CollaborationApi[K]>;
  }
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  annotations: typeof READ_ONLY_TOOL_ANNOTATIONS | typeof MUTATING_TOOL_ANNOTATIONS = READ_ONLY_TOOL_ANNOTATIONS,
) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations,
  };
}

function stringSchema(description: string) {
  return { type: "string", description };
}

function integerSchema(description: string, minimum: number) {
  return { type: "integer", minimum, description };
}

function idempotencySchema(description = "Stable retry key") {
  return { type: "string", minLength: 8, maxLength: 200, description };
}

function enumSchema(values: readonly string[]) {
  return { type: "string", enum: values };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

function resourceResult(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] };
}

function requestedProtocolVersion(params: unknown): string {
  const input = optionalObject(params);
  return optionalString(input.protocolVersion) ?? "2025-03-26";
}

function runtimeInput(args: Record<string, unknown>): RuntimeRegistration {
  const capabilities = optionalStringArray(args.capabilities);
  return {
    sessionId: requiredString(args, "session_id"),
    deviceId: requiredString(args, "device_id"),
    harness: requiredEnum(args, "harness", ["codex", "claude-code"] as const),
    provider: requiredString(args, "provider"),
    model: requiredString(args, "model"),
    localSessionId: requiredString(args, "local_session_id"),
    captureFidelity: requiredEnum(args, "capture_fidelity", [
      "canonical_history", "harness_transcript", "provider_request",
    ] as const),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : requiredObject(value);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function requiredIdempotencyKey(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (value.length < 8 || value.length > 200) {
    throw new Error(`${key} must contain 8 to 200 characters`);
  }
  return value;
}

function optionalIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const input = { value };
  return requiredIdempotencyKey(input, "value");
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

function requiredInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${key} must be a non-negative integer`);
  return Number(value);
}

function optionalInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw new Error("Expected a non-negative integer");
  return Number(parsed);
}

function optionalPositiveInteger(value: unknown, fallback: number): number {
  const parsed = optionalInteger(value, fallback);
  if (parsed < 1) throw new Error("Expected a positive integer");
  return parsed;
}

function requiredValue(input: Record<string, unknown>, key: string): unknown {
  if (!(key in input)) throw new Error(`${key} is required`);
  return input[key];
}

function requiredEnum<const T extends readonly string[]>(
  input: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const value = input[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected an array of strings");
  }
  return value as string[];
}

function failure(id: string | number | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

class MethodNotFoundError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
