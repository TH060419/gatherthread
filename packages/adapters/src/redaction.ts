import type { TranscriptEvent } from "./types.js";

const REDACTED = "[REDACTED]";

const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|github_pat|glpat|sk|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*)[^\s,;]+/gi,
];

const SENSITIVE_KEY = /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|password|passwd|private[_-]?key|refresh[_-]?token|secret|token)$/i;

export interface RedactionOptions {
  extraPatterns?: readonly RegExp[];
  replacement?: string;
}

export function redactText(value: string, options: RedactionOptions = {}): string {
  const replacement = options.replacement ?? REDACTED;
  return [...DEFAULT_SECRET_PATTERNS, ...(options.extraPatterns ?? [])].reduce(
    (redacted, pattern) => redacted.replace(cloneGlobal(pattern), (match, prefix) =>
      typeof prefix === "string" && prefix.length < match.length
        ? `${prefix}${replacement}`
        : replacement,
    ),
    value,
  );
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key)
        ? options.replacement ?? REDACTED
        : redactValue(item, options),
    ]),
  );
}

export function redactTranscriptEvent(
  event: TranscriptEvent,
  options: RedactionOptions = {},
): TranscriptEvent {
  return {
    ...event,
    ...(event.content === undefined ? {} : { content: redactText(event.content, options) }),
    ...(event.arguments === undefined ? {} : { arguments: redactValue(event.arguments, options) }),
    ...(event.result === undefined ? {} : { result: redactValue(event.result, options) }),
  };
}

function cloneGlobal(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}
