import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { CollaborationMcpService, JsonRpcResponse } from "./service.js";
import { DEFAULT_MCP_MESSAGE_BYTES, payloadLimitError, validateMessageLimit } from "./input-limits.js";

export interface StdioMcpServerOptions {
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
  maxMessageBytes?: number;
}

export class StdioMcpServer {
  readonly #service: CollaborationMcpService;

  constructor(service: CollaborationMcpService) {
    this.#service = service;
  }

  async run(options: StdioMcpServerOptions = {}): Promise<void> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const maxMessageBytes = validateMessageLimit(options.maxMessageBytes ?? DEFAULT_MCP_MESSAGE_BYTES);
    const stop = () => input.destroy();
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const record of boundedJsonLines(input, maxMessageBytes)) {
        if (options.signal?.aborted) break;
        if (record.tooLarge) {
          await writeJsonLine(output, invalidRequest("Message exceeds the configured size limit"));
          continue;
        }
        const line = record.line ?? "";
        if (!line.trim()) continue;
        const response = await this.#handleLine(line);
        if (response !== undefined) await writeJsonLine(output, response);
      }
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
  }

  async #handleLine(line: string): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    const limitError = payloadLimitError(payload);
    if (limitError) return invalidRequest(limitError);
    if (!Array.isArray(payload)) return this.#service.handle(payload);
    if (payload.length === 0) return invalidRequest("Invalid Request");
    const responses: JsonRpcResponse[] = [];
    for (const item of payload) {
      const response = await this.#service.handle(item);
      if (response !== undefined) responses.push(response);
    }
    return responses.length === 0 ? undefined : responses;
  }
}

async function* boundedJsonLines(
  input: Readable,
  maxBytes: number,
): AsyncGenerator<{ line?: string; tooLarge: boolean }> {
  let parts: Buffer[] = [];
  let size = 0;
  let discarding = false;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(0x0a, offset);
      const end = newline === -1 ? buffer.length : newline;
      const segment = buffer.subarray(offset, end);
      if (!discarding) {
        if (size + segment.byteLength > maxBytes) {
          parts = [];
          size = 0;
          discarding = true;
        } else if (segment.byteLength > 0) {
          parts.push(segment);
          size += segment.byteLength;
        }
      }
      if (newline === -1) break;
      if (discarding) {
        yield { tooLarge: true };
      } else {
        const complete = Buffer.concat(parts, size);
        const withoutCarriageReturn = complete.at(-1) === 0x0d ? complete.subarray(0, -1) : complete;
        yield { line: withoutCarriageReturn.toString("utf8"), tooLarge: false };
      }
      parts = [];
      size = 0;
      discarding = false;
      offset = newline + 1;
    }
  }
  if (discarding) yield { tooLarge: true };
  else if (size > 0) yield { line: Buffer.concat(parts, size).toString("utf8"), tooLarge: false };
}

function invalidRequest(message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, error: { code: -32600, message } };
}

async function writeJsonLine(output: Writable, value: unknown): Promise<void> {
  if (output.destroyed) throw new Error("MCP stdout is closed");
  if (!output.write(`${JSON.stringify(value)}\n`, "utf8")) await once(output, "drain");
}
