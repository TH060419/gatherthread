import { LocalConnectorCollaborationClient } from "../../bridge/src/local-api-relay.js";
import { CollaborationMcpService, type JsonRpcResponse } from "../../mcp/src/service.js";
import { StdioMcpServer } from "../../mcp/src/stdio.js";
import { redactValue } from "../../adapters/src/redaction.js";

/** A Claude plugin can use public user tools, never another host's native controls. */
class ClaudeUserMcpService extends CollaborationMcpService {
  readonly #localApi: LocalConnectorCollaborationClient;
  constructor(api: LocalConnectorCollaborationClient) { super({ api, localSync: api, toolProfile: "user" }); this.#localApi = api; }
  override async handle(input: unknown): Promise<JsonRpcResponse | undefined> {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const request = input as { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string } };
      if (request.jsonrpc !== "2.0" || !(request.id === undefined || request.id === null || typeof request.id === "string"
        || typeof request.id === "number" && Number.isFinite(request.id))) return super.handle(input);
      if (request.method === "tools/call" && request.params?.name === "collaboration_get_code_sync_status") {
        if (request.id === undefined) return undefined;
        const args = (request.params as { arguments?: unknown }).arguments;
        try {
          if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "project_id")) throw new Error("Pass one exact project_id");
          const projectId = (args as Record<string, unknown>).project_id;
          if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(projectId)) throw new Error("Pass one exact project_id");
          const result = redactValue(await this.#localApi.getCodeSyncStatus(projectId));
          return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } } };
        } catch { return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Project file status is unavailable; check this workspace's separate sync authorization" } }; }
      }
      if (request.method === "tools/call" && request.params?.name === "collaboration_import_codex_history") {
        return request.id === undefined ? undefined : { jsonrpc: "2.0", id: request.id,
          error: { code: -32601, message: "Codex history import is not a Claude Code operation" } };
      }
      const response = await super.handle(input);
      if (request.method === "tools/list" && response && "result" in response) {
        const result = response.result as { tools: Array<{ name: string }> };
        return { ...response, result: { ...result, tools: [...result.tools.filter(({ name }) => name !== "collaboration_import_codex_history"), {
          name: "collaboration_get_code_sync_status", description: "Read this exact project's separately authorized GitHub and GT Cloud file-sync status. Never uploads, downloads, enables or merges files.",
          inputSchema: { type: "object", additionalProperties: false, properties: { project_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["project_id"] },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        }] } };
      }
      return response;
    }
    return super.handle(input);
  }
}

export async function runClaudeMcp(): Promise<void> {
  const api = new LocalConnectorCollaborationClient({ workspacePath: process.cwd(), harness: "claude-code", workspaceOnly: true });
  const service = new ClaudeUserMcpService(api);
  await new StdioMcpServer(service).run();
}
