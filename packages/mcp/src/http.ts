import type { CollaborationMcpService, JsonRpcResponse } from "./service.js";

export interface McpHttpHandlerOptions {
  allowedOrigins?: readonly string[];
}

export function createMcpHttpHandler(
  service: CollaborationMcpService,
  options: McpHttpHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }
    const origin = request.headers.get("origin");
    if (origin && !options.allowedOrigins?.includes(origin)) {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return new Response("Content-Type must be application/json", { status: 415 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      }
      const responses = (await Promise.all(payload.map((item) => service.handle(item as never))))
        .filter((item): item is JsonRpcResponse => item !== undefined);
      return responses.length === 0 ? new Response(null, { status: 202 }) : jsonResponse(responses);
    }
    const response = await service.handle(payload as never);
    return response === undefined ? new Response(null, { status: 202 }) : jsonResponse(response);
  };
}

function jsonResponse(value: unknown): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}
