import type { TranscriptAdapter, TranscriptEvent } from "./types.js";

interface JsonObject {
  [key: string]: unknown;
}

export class CodexRolloutAdapter implements TranscriptAdapter {
  readonly harness = "codex" as const;

  parseLine(line: string): TranscriptEvent[] {
    const record = JSON.parse(line) as JsonObject;
    if (record.type !== "response_item" || !isObject(record.payload)) return [];

    const payload = record.payload;
    const timestamp = asString(record.timestamp) ?? asString(payload.timestamp);
    const baseId = asString(payload.id)
      ?? asString(record.id)
      ?? stableLineId(line);

    if (payload.type === "message") {
      const role = asString(payload.role);
      if (role !== "user" && role !== "assistant") return [];
      const content = visibleText(payload.content);
      if (!content) return [];
      return [event(role, baseId, timestamp, { content })];
    }

    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      return [event("tool_call", baseId, timestamp, {
        toolName: asString(payload.name) ?? "unknown",
        toolCallId: asString(payload.call_id) ?? asString(payload.id) ?? baseId,
        arguments: parseMaybeJson(payload.arguments ?? payload.input),
      })];
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      return [event("tool_result", baseId, timestamp, {
        toolCallId: asString(payload.call_id) ?? baseId,
        result: parseMaybeJson(payload.output),
      })];
    }

    return [];
  }
}

function event(
  kind: TranscriptEvent["kind"],
  localEventId: string,
  timestamp: string | undefined,
  fields: Partial<TranscriptEvent>,
): TranscriptEvent {
  return {
    kind,
    localEventId,
    harness: "codex",
    captureFidelity: "harness_transcript",
    ...fields,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    if (!isObject(block)) return [];
    if (!["input_text", "output_text", "text"].includes(asString(block.type) ?? "")) return [];
    const text = asString(block.text);
    return text ? [text] : [];
  }).join("\n");
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stableLineId(line: string): string {
  let hash = 2166136261;
  for (const character of line) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `codex-${(hash >>> 0).toString(16)}`;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
