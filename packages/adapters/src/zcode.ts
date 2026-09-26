import type { TranscriptAdapter, TranscriptEvent } from "./types.js";

interface JsonObject {
  [key: string]: unknown;
}

/**
 * One reviewed ZCode Protocol app-server session event.
 *
 * `session/event` deliveries wrap a typed payload:
 * `{"deliveryKind":"desktop-continuous","eventId":"...","payload":{"type":"turn.completed",...}}`.
 * `parseZcodeProtocolEvent` projects only the reviewed shareable vocabulary —
 * assistant message text, tool calls, and tool results — and reports turn
 * lifecycle so the connector can distinguish a completed answer from a failed
 * or cancelled run. Unknown event types and unknown fields stay local by
 * construction, so a newer harness cannot leak unreviewed shapes into
 * canonical history.
 */
export interface ZcodeProtocolEventRecord {
  events: TranscriptEvent[];
  eventType?: string;
  /** Final answer text of a `turn.completed` event. */
  finalResponse?: string;
  /** Error message of a `turn.failed` event. */
  errorMessage?: string;
  /** Error code of a `turn.failed` event, when the harness supplies one. */
  errorCode?: string;
  /** Observed model label (`providerId/modelId`) when the event carries one. */
  observedModel?: string;
}

export function parseZcodeProtocolEvent(params: unknown): ZcodeProtocolEventRecord {
  if (!isObject(params)) return { events: [] };
  // Delivered session events carry the event type at the envelope level and
  // the schema fields inside `payload`:
  // `{"type":"turn.failed","payload":{"error":{...}},"turnId":"...",...}`.
  const payload = isObject(params.payload) ? params.payload : params;
  const eventType = asString(params.type) ?? asString(payload.type);
  if (!eventType) return { events: [] };

  if (eventType === "turn.completed") {
    const finalResponse = asString(payload.response);
    return {
      events: [],
      eventType,
      ...(finalResponse === undefined ? {} : { finalResponse }),
    };
  }
  if (eventType === "turn.failed") {
    const error = isObject(payload.error) ? payload.error : {};
    const errorMessage = asString(error.message) ?? asString(payload.message) ?? "ZCode turn failed";
    const errorCode = asString(error.code);
    return {
      events: [],
      eventType,
      errorMessage,
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }
  if (eventType === "message.upserted") {
    return {
      events: parseMessageUpserted(payload),
      eventType,
    };
  }
  return { events: [], eventType };
}

/**
 * `message.upserted` carries visible message content plus optional tool call
 * entries. Reasoning, provider traffic, and private metadata are not part of
 * the reviewed surface and never leave this function.
 */
function parseMessageUpserted(payload: JsonObject): TranscriptEvent[] {
  const content = asString(payload.content) ?? "";
  const messageId = asString(payload.messageId) ?? asString(payload.id) ?? "zcode-message";
  const events: TranscriptEvent[] = [];
  if (content.trim()) {
    events.push(protocolEvent("assistant", `${messageId}:text`, { content }));
  }
  const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
  toolCalls.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const toolName = asString(entry.toolName);
    if (!toolName) return; // Unnamed tool entries are not shareable.
    const toolCallId = asString(entry.toolCallId) ?? `${messageId}:tool:${index}`;
    const localEventId = `${messageId}:tool:${index}`;
    events.push(protocolEvent("tool_call", localEventId, {
      toolName,
      toolCallId,
      ...(entry.arguments === undefined ? {} : { arguments: entry.arguments }),
    }));
    if (entry.result !== undefined || entry.content !== undefined || entry.isError === true) {
      events.push(protocolEvent("tool_result", `${localEventId}:result`, {
        toolCallId,
        ...(entry.result !== undefined
          ? { result: entry.result }
          : entry.content !== undefined ? { result: entry.content } : {}),
        ...(entry.isError === true ? { isError: true } : {}),
      }));
    }
  });
  return events;
}

export class ZcodeStreamAdapter implements TranscriptAdapter {
  readonly harness = "zcode" as const;

  parseLine(line: string): TranscriptEvent[] {
    // The headless connector consumes app-server deliveries directly; JSONL
    // transcript import stays unavailable for ZCode in this slice.
    try {
      return parseZcodeProtocolEvent(JSON.parse(line)).events;
    } catch {
      return [];
    }
  }
}

function protocolEvent(
  kind: TranscriptEvent["kind"],
  localEventId: string,
  fields: Partial<TranscriptEvent>,
): TranscriptEvent {
  return {
    ...fields,
    kind,
    localEventId,
    // Fidelity labels stay authoritative over caller-provided fields.
    harness: "zcode",
    captureFidelity: "harness_transcript",
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
