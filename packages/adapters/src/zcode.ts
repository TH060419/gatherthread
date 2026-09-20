import type { TranscriptAdapter, TranscriptEvent } from "./types.js";

interface JsonObject {
  [key: string]: unknown;
}

/**
 * One parsed ZCode headless stream-json record.
 *
 * `events` carries the shareable transcript projection. `sessionId`, `model`,
 * and `finalResultText` are connector metadata: the session id binds the
 * native conversation, the model names provenance, and the final text is the
 * last assistant answer of a completed run. Hidden reasoning never reaches
 * `events`.
 */
export interface ZcodeStreamRecord {
  events: TranscriptEvent[];
  sessionId?: string;
  model?: string;
  finalResultText?: string;
  isError?: boolean;
}

/**
 * Parses one ZCode headless `--output-format stream-json` line.
 *
 * The stream shape mirrors the harness's event architecture: `system` init
 * records carry the native session identity, `assistant` records carry visible
 * text and tool_use blocks, `user` records carry tool_result blocks, and a
 * `result` record closes the run. Unknown record types and unknown content
 * block types are skipped rather than guessed, so a newer harness cannot leak
 * unreviewed shapes into canonical history.
 */
export function parseZcodeStreamLine(line: string): ZcodeStreamRecord {
  const record = JSON.parse(line) as JsonObject;
  if (!isObject(record)) return { events: [] };
  const sessionId = asString(record.session_id);
  const model = asString(record.model);
  const type = asString(record.type);

  if (type === "assistant" || type === "user") {
    return {
      events: parseMessageRecord(record, type, line),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(model === undefined ? {} : { model }),
    };
  }
  if (type === "result") {
    const finalResultText = asString(record.result);
    return {
      events: [],
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(model === undefined ? {} : { model }),
      ...(finalResultText === undefined ? {} : { finalResultText }),
      isError: asString(record.subtype) !== "success",
    };
  }
  return {
    events: [],
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(model === undefined ? {} : { model }),
  };
}

export class ZcodeStreamAdapter implements TranscriptAdapter {
  readonly harness = "zcode" as const;

  parseLine(line: string): TranscriptEvent[] {
    return parseZcodeStreamLine(line).events;
  }
}

function parseMessageRecord(
  record: JsonObject,
  role: "assistant" | "user",
  line: string,
): TranscriptEvent[] {
  const message = record.message;
  if (!isObject(message)) return [];
  const timestamp = asString(record.timestamp) ?? asString(message.timestamp);
  const baseId = asString(record.uuid)
    ?? asString(message.id)
    ?? stableLineId(line);
  const content = message.content;

  if (typeof content === "string") {
    return role === "assistant" && content
      ? [event("assistant", baseId, timestamp, { content })]
      : [];
  }
  if (!Array.isArray(content)) return [];

  const events: TranscriptEvent[] = [];
  const visibleText: string[] = [];
  content.forEach((block, index) => {
    if (!isObject(block)) return;
    const blockType = asString(block.type);
    if (blockType === "text" && typeof block.text === "string") {
      if (role === "assistant" || block.text) visibleText.push(block.text);
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
    // "thinking" and unknown block types stay local by construction.
  });

  const shareable: TranscriptEvent[] = [];
  if (visibleText.length > 0) {
    shareable.push(event(role, `${baseId}:text`, timestamp, {
      content: visibleText.join("\n"),
    }));
  }
  return [...shareable, ...events];
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
    harness: "zcode",
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
  return `zcode-${(hash >>> 0).toString(16)}`;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
