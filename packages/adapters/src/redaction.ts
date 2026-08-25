import type { TranscriptEvent } from "./types.js";

const REDACTED = "[REDACTED]";

const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|github_pat|glpat|sk|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bacp(?:i|d)?_[A-Za-z0-9_-]{20,}\b/g,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*)[^\s,;]+/gi,
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH_TOKEN_PEPPER)\s*[=:]\s*)[^\s,;]+/g,
];

const SENSITIVE_KEY_NAMES = new Set([
  "apikey",
  "accesstoken",
  "authtoken",
  "authorization",
  "bearer",
  "clientsecret",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "token",
  "thinking",
  "rawthinking",
  "systemprompt",
  "developerprompt",
]);

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
      isSensitiveKey(key)
        ? options.replacement ?? REDACTED
        : redactValue(item, options),
    ]),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEY_NAMES.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("passwd")
    || normalized.endsWith("apikey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("tokenpepper")
    || normalized.endsWith("systemprompt")
    || normalized.endsWith("developerprompt")
    || normalized.endsWith("rawthinking");
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
