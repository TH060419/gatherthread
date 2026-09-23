import type { CollaborationMcpService, JsonRpcResponse } from "./service.js";
import { DEFAULT_MCP_MESSAGE_BYTES, payloadLimitError, validateMessageLimit } from "./input-limits.js";

export interface McpHttpHandlerOptions {
  allowedOrigins?: readonly string[];
  maxMessageBytes?: number;
}

export function createMcpHttpHandler(
  service: CollaborationMcpService,
  options: McpHttpHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const maxMessageBytes = validateMessageLimit(options.maxMessageBytes ?? DEFAULT_MCP_MESSAGE_BYTES);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }
    const origin = request.headers.get("origin");
    if (origin && !options.allowedOrigins?.includes(origin)) {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return new Response("Content-Type must be application/json", { status: 415 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedBody(request, maxMessageBytes));
    } catch (error) {
      if (error instanceof MessageTooLargeError) return new Response("Message exceeds the configured size limit", { status: 413 });
      return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const limitError = payloadLimitError(payload);
    if (limitError) return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: limitError } });
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of payload) {
        const response = await service.handle(item);
        if (response !== undefined) responses.push(response);
      }
      return responses.length === 0 ? new Response(null, { status: 202 }) : jsonResponse(responses);
    }
    const response = await service.handle(payload);
    return response === undefined ? new Response(null, { status: 202 }) : jsonResponse(response);
  };
}

class MessageTooLargeError extends Error {}

async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) throw new MessageTooLargeError();
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new MessageTooLargeError();
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    // Do not buffer the rest of an oversized streamed body, even if its
    // Content-Length header is absent or smaller than the actual payload.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function jsonResponse(value: unknown): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}
