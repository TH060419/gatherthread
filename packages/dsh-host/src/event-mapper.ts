import { redactText, redactValue } from "@gatherthread/adapters";
import type {
  DshMappedAssistantEvent,
  DshMappedEvent,
  DshMappedToolCallEvent,
  DshMappedToolResultEvent,
  DshSessionEventRecord,
} from "./types.js";

export interface DshEventMappingOptions {
  maxAssistantBytes?: number;
  maxToolBytes?: number;
}

const DEFAULT_ASSISTANT_BYTES = 112 * 1_024;
const DEFAULT_TOOL_BYTES = 32 * 1_024;

/**
 * Upload allowlist for DSH durable events. Unknown event types and unknown
 * fields are never copied. In particular, reasoning blocks, exact streams,
 * request headers/context, usage, replay state, and tool-private metadata have
 * no path into the returned values.
 */
export function mapDshSessionEvent(
  event: DshSessionEventRecord,
  options: DshEventMappingOptions = {},
): DshMappedEvent | undefined {
  const timestamp = safeTimestamp(event.time);
  if (timestamp === undefined) return undefined;
  const data = asObject(event.data);
  if (data === undefined) return undefined;
  const assistantBytes = checkedLimit(options.maxAssistantBytes, DEFAULT_ASSISTANT_BYTES);
  const toolBytes = checkedLimit(options.maxToolBytes, DEFAULT_TOOL_BYTES);

  if (event.type === "assistant/message") {
    const message = asObject(data.message);
    const content = visibleTextBlocks(message?.content);
    if (!content) return undefined;
    const mapped: DshMappedAssistantEvent = {
      kind: "assistant",
      localEventId: `dsh-assistant-${event.seq}`,
      sequence: event.seq,
      timestamp,
      content: boundText(redactText(content), assistantBytes),
    };
    return mapped;
  }

  if (event.type === "tool/call") {
    if (typeof data.callId !== "string" || typeof data.name !== "string" || typeof data.arguments !== "string") {
      return undefined;
    }
    const mapped: DshMappedToolCallEvent = {
      kind: "tool_call",
      localEventId: `dsh-tool-call-${event.seq}`,
      sequence: event.seq,
      timestamp,
      toolName: boundText(redactText(data.name), 512),
      toolCallId: boundText(redactText(data.callId), 512),
      arguments: redactAndBound(parseToolArguments(data.arguments), toolBytes),
    };
    return mapped;
  }

  if (event.type === "tool/result") {
    const message = asObject(data.message);
    const block = firstToolResultBlock(message?.content);
    if (block === undefined || typeof block.toolCallId !== "string") return undefined;
    const result = visibleTextBlocks(block.content);
    const error = asObject(data.error);
    const mapped: DshMappedToolResultEvent = {
      kind: "tool_result",
      localEventId: `dsh-tool-result-${event.seq}`,
      sequence: event.seq,
      timestamp,
      toolCallId: boundText(redactText(block.toolCallId), 512),
      result: redactAndBound(result, toolBytes),
      isError: block.isError === true || error !== undefined,
      ...(typeof error?.code === "string"
        ? { errorCode: boundText(redactText(error.code), 256) }
        : {}),
    };
    return mapped;
  }

  return undefined;
}

export function mapDshSessionEvents(
  events: readonly DshSessionEventRecord[],
  options: DshEventMappingOptions = {},
): DshMappedEvent[] {
  const seen = new Set<string>();
  const mapped: DshMappedEvent[] = [];
  for (const event of events) {
    const candidate = mapDshSessionEvent(event, options);
    if (candidate === undefined || seen.has(candidate.localEventId)) continue;
    seen.add(candidate.localEventId);
    mapped.push(candidate);
  }
  return mapped.sort((left, right) => left.sequence - right.sequence);
}

export function finalVisibleAssistant(events: readonly DshMappedEvent[]): DshMappedAssistantEvent | undefined {
  return events.findLast((event): event is DshMappedAssistantEvent =>
    event.kind === "assistant" && event.content.trim().length > 0,
  );
}

function visibleTextBlocks(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    const candidate = asObject(block);
    return candidate?.type === "text" && typeof candidate.text === "string"
      ? [candidate.text]
      : [];
  }).join("");
}

function firstToolResultBlock(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(asObject).find((block) => block?.type === "tool-result");
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function redactAndBound(value: unknown, maximumBytes: number): unknown {
  const redacted = redactValue(value);
  const encoded = safeJson(redacted);
  if (Buffer.byteLength(encoded, "utf8") <= maximumBytes) return redacted;
  return {
    truncated: true,
    preview: boundText(encoded, Math.max(256, maximumBytes - 128)),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[Unserializable tool value]";
  }
}

function boundText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "\n[TRUNCATED]";
  const target = Math.max(0, maximumBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= target) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function checkedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 2 * 1_024 * 1_024) {
    throw new Error("DSH event mapping byte limits must be integers from 1024 to 2097152");
  }
  return value;
}

function safeTimestamp(value: number): string | undefined {
  try {
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) return undefined;
    return timestamp.toISOString();
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
