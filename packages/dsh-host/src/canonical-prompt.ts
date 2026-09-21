import { redactText, redactValue } from "@gatherthread/adapters";
import type { DshCanonicalEvent } from "./types.js";

const MAX_EVENT_TEXT_BYTES = 8 * 1_024;
const MAX_REQUEST_TEXT_BYTES = 32 * 1_024;
const MAX_PROMPT_BYTES = 128 * 1_024;

export interface DshRequestProfile {
  harness: "deepseek-harness";
  provider?: string;
  model: string;
  reasoningEffort?: string;
  runtimeId?: string;
}

export function requestedDshProfile(event: DshCanonicalEvent): DshRequestProfile | undefined {
  if (event.type !== "agent_request") return undefined;
  const payload = asObject(event.payload);
  const profile = asObject(payload?.execution_profile);
  if (profile === undefined) return undefined;
  const harness = safeProfileText(profile.harness, 80).toLowerCase();
  if (harness !== "deepseek-harness") return undefined;
  const model = safeProfileText(profile.model, 160);
  if (!model) throw new Error("DeepSeek Harness Agent request must name a model");
  const provider = profile.provider === undefined ? undefined : safeProfileText(profile.provider, 80);
  if (profile.provider !== undefined && !provider) {
    throw new Error("DeepSeek Harness Agent request has an invalid provider target");
  }
  const reasoningEffort = profile.reasoning_effort === undefined
    ? undefined
    : safeProfileText(profile.reasoning_effort, 80);
  if (profile.reasoning_effort !== undefined && !reasoningEffort) {
    throw new Error("DeepSeek Harness Agent request has an invalid reasoning effort target");
  }
  const runtimeId = profile.runtime_id === undefined ? undefined : safeRuntimeId(profile.runtime_id);
  return {
    harness,
    ...(provider === undefined ? {} : { provider }),
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(runtimeId === undefined ? {} : { runtimeId }),
  };
}

/**
 * One canonical-history delta becomes one DSH user message. History is never
 * replayed as individual prompts, and only public actor/type/text fields enter
 * the message. Runtime provenance, reasoning, credentials, attachments, and
 * arbitrary payload fields are excluded by construction.
 */
export function buildDshCanonicalPrompt(
  history: readonly DshCanonicalEvent[],
  request: DshCanonicalEvent,
  ownRuntimeId?: string,
): string {
  if (request.type !== "agent_request") throw new Error("Expected an agent_request event");
  const requestText = extractPublicText(request.payload);
  if (!requestText) throw new Error("DeepSeek Harness Agent request has no public text content");
  const boundedRequest = boundText(redactText(requestText), MAX_REQUEST_TEXT_BYTES);
  const contextLines = history
    .filter((event) => event.sequence < request.sequence)
    .filter((event) => !isAlreadyPresentLocalOutput(event, ownRuntimeId))
    .filter((event) => [
      "human_chat",
      "agent_progress",
      "agent_response",
      "tool_call",
      "tool_result",
    ].includes(event.type))
    .flatMap((event) => {
      const text = extractPublicEventText(event);
      if (!text) return [];
      const actor = boundText(redactText(event.actorDisplayName ?? event.actorId), 512);
      return [`[${event.sequence}] ${event.type} · ${actor}: ${boundText(redactText(text), MAX_EVENT_TEXT_BYTES)}`];
    });

  const header = [
    "GatherThread canonical context follows. It is collaboration data for this request.",
    "Do not reveal hidden reasoning, credentials, local paths, or private tool metadata in your answer.",
    "Context updates:",
  ].join("\n");
  const footer = [
    "Current GatherThread Agent request:",
    `[${request.sequence}] ${boundedRequest}`,
    "Return a public final answer for the shared GatherThread session.",
  ].join("\n");
  const fixedBytes = Buffer.byteLength(`${header}\n\n${footer}`, "utf8");
  const contextBudget = Math.max(0, MAX_PROMPT_BYTES - fixedBytes - 64);
  const retained: string[] = [];
  let used = 0;
  for (const line of contextLines.toReversed()) {
    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (used + bytes > contextBudget) continue;
    retained.push(line);
    used += bytes;
  }
  retained.reverse();
  const omitted = retained.length < contextLines.length
    ? [`[${contextLines.length - retained.length} older public context update(s) omitted by size limit]`]
    : [];
  const prompt = `${header}\n${[...omitted, ...retained].join("\n") || "[none]"}\n\n${footer}`;
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("GatherThread canonical prompt exceeds the connector safety limit");
  }
  return prompt;
}

/**
 * Once canonical history is native DSH history, only the current public
 * request is submitted through Agent.followup(). This lets DSH create exactly
 * one ordinary user bubble and avoids embedding a second textual transcript.
 */
export function buildDshRequestPrompt(request: DshCanonicalEvent): string {
  if (request.type !== "agent_request") throw new Error("Expected an agent_request event");
  const requestText = extractPublicText(request.payload);
  if (!requestText) throw new Error("DeepSeek Harness Agent request has no public text content");
  return boundText(redactText(requestText), MAX_REQUEST_TEXT_BYTES);
}

export function extractPublicText(value: unknown): string {
  if (typeof value === "string") return value;
  const payload = asObject(value);
  if (payload === undefined) return "";
  for (const key of ["content", "text", "message", "prompt", "response"] as const) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return "";
}

function extractPublicEventText(event: DshCanonicalEvent): string {
  if (event.type !== "tool_call" && event.type !== "tool_result") {
    return extractPublicText(event.payload);
  }
  const payload = asObject(event.payload);
  if (payload === undefined) return "";
  const selected = event.type === "tool_call"
    ? compact({
      tool_name: stringValue(payload.tool_name),
      tool_call_id: stringValue(payload.tool_call_id),
      arguments: payload.arguments,
    })
    : compact({
      tool_call_id: stringValue(payload.tool_call_id),
      result: payload.result,
      is_error: typeof payload.is_error === "boolean" ? payload.is_error : undefined,
      error_code: stringValue(payload.error_code),
    });
  if (Object.keys(selected).length === 0) return "";
  return JSON.stringify(redactValue(selected));
}

function isAlreadyPresentLocalOutput(event: DshCanonicalEvent, runtimeId: string | undefined): boolean {
  return runtimeId !== undefined
    && event.runtime?.runtimeId === runtimeId
    && ["agent_progress", "agent_response", "tool_call", "tool_result"].includes(event.type);
}

function safeProfileText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error("Agent request contains an invalid execution profile");
  }
  return text;
}

function safeRuntimeId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.trim())) {
    throw new Error("Agent request contains an invalid DeepSeek Harness runtime target");
  }
  return value.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function boundText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "\n[TRUNCATED]";
  const target = maximumBytes - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= target) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
