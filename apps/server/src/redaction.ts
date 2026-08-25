import type { JsonValue } from "@agent-cooperation/protocol";

const PRIVATE_KEYS = /^(authorization|cookie|password|passwd|secret|token|api[_-]?key|thinking|raw_thinking|system_prompt|developer_prompt)$/i;
const STRING_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/(\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
];

function redactString(value: string): string {
  return STRING_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value,
  );
}

export function redactJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactJson);

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      PRIVATE_KEYS.test(key) ? "[REDACTED]" : redactJson(nested),
    ]),
  );
}
