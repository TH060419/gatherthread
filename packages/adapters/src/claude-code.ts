import type { TranscriptAdapter, TranscriptEvent } from "./types.js";

interface JsonObject {
  [key: string]: unknown;
}

export class ClaudeCodeProjectAdapter implements TranscriptAdapter {
  readonly harness = "claude-code" as const;

  parseLine(line: string): TranscriptEvent[] {
    const record = JSON.parse(line) as JsonObject;
    if (record.isMeta === true || record.isSidechain === true) return [];
    if ((record.type !== "user" && record.type !== "assistant") || !isObject(record.message)) {
      return [];
    }

    const message = record.message;
    const role = asString(message.role) ?? asString(record.type);
    if (role !== "user" && role !== "assistant") return [];
    const timestamp = asString(record.timestamp) ?? asString(message.timestamp);
    const baseId = asString(record.uuid)
      ?? asString(message.id)
      ?? stableLineId(line);
    const content = message.content;

    if (typeof content === "string") {
      return content ? [event(role, baseId, timestamp, { content })] : [];
    }
    if (!Array.isArray(content)) return [];

    const events: TranscriptEvent[] = [];
    const visibleText: string[] = [];
    content.forEach((block, index) => {
      if (!isObject(block)) return;
      const blockType = asString(block.type);
      if (blockType === "text" && typeof block.text === "string") {
        visibleText.push(block.text);
      } else if (blockType === "tool_use") {
        events.push(event("tool_call", `${baseId}:${index}`, timestamp, {
          toolName: asString(block.name) ?? "unknown",
          toolCallId: asString(block.id) ?? `${baseId}:${index}`,
          arguments: block.input,
        }));
      } else if (blockType === "tool_result") {
        events.push(event("tool_result", `${baseId}:${index}`, timestamp, {
          toolCallId: asString(block.tool_use_id) ?? `${baseId}:${index}`,
          result: normalizeToolResult(block.content),
          isError: block.is_error === true,
        }));
      }
    });

    if (visibleText.length > 0) {
      events.unshift(event(role, `${baseId}:text`, timestamp, {
        content: visibleText.join("\n"),
      }));
    }
    return events;
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
    harness: "claude-code",
    captureFidelity: "harness_transcript",
    ...fields,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function normalizeToolResult(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const text = value.flatMap((block) =>
    isObject(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [],
  );
  return text.length === value.length ? text.join("\n") : value;
}

function stableLineId(line: string): string {
  let hash = 2166136261;
  for (const character of line) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `claude-${(hash >>> 0).toString(16)}`;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
