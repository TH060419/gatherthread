import type { JsonValue } from "@gatherthread/protocol";

const PRIVATE_KEY_NAMES = new Set([
  "authorization",
  "bearer",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "thinking",
  "rawthinking",
  "systemprompt",
  "developerprompt",
  "privatekey",
]);
const STRING_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b(?:ghp|github_pat|glpat|sk|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b(?:gt[aid]|acp(?:i|d)?)_[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]"],
  [/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|refresh[_-]?token|secret|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH_TOKEN_PEPPER)\s*[=:]\s*)[^\s,;]+/g, "$1[REDACTED]"],
];

function isPrivateKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return PRIVATE_KEY_NAMES.has(normalized)
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
      isPrivateKey(key) ? "[REDACTED]" : redactJson(nested),
    ]),
  );
}
