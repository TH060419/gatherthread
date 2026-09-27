export const ZCODE_HARNESS = "zcode";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]+$/u;

/**
 * ZCode runtime selection follows the same exact, fail-closed rule as Codex:
 * exactly one online ZCode runtime may serve a request, and ambiguity refuses
 * instead of choosing.
 */
export function resolveZcodeRuntime(runtimes) {
  const choices = runtimes
    .map(normalizeZcodeRuntime)
    .filter(Boolean);
  const online = choices.filter((runtime) => runtime.status === "online");
  if (online.length === 1) return { runtime: online[0], choices, reason: "" };
  if (online.length === 0) {
    return { runtime: null, choices, reason: "Connect ZCode before requesting this Agent." };
  }
  return {
    runtime: null,
    choices,
    reason: "More than one ZCode runtime is online for this session. Disconnect the extra runtime before sending.",
  };
}

export function zcodeExecutionProfile(runtime) {
  const normalized = normalizeZcodeRuntime(runtime);
  if (!normalized || normalized.status !== "online") {
    throw new Error("A matching online ZCode runtime is required.");
  }
  return {
    harness: ZCODE_HARNESS,
    provider: normalized.provider,
    model: normalized.model,
    runtimeId: normalized.id,
  };
}

export function normalizeZcodeRuntime(value) {
  if (!isObject(value)) return null;
  const id = safeId(value.id);
  const deviceId = safeId(value.deviceId ?? value.device_id);
  const harness = safeText(value.harness, 80)?.toLowerCase();
  const provider = safeText(value.provider, 80);
  const model = safeText(value.model, 160);
  const status = ["online", "offline", "revoked"].includes(value.status) ? value.status : null;
  const lastSeenAt = safeDate(value.lastSeenAt ?? value.last_seen_at);
  if (!id || !deviceId || !harness || !provider || !model || !status || !lastSeenAt) return null;
  return harness === ZCODE_HARNESS
    ? { id, deviceId, harness, provider, model, status, lastSeenAt }
    : null;
}

function safeId(value) {
  return typeof value === "string" && ID_PATTERN.test(value.trim()) ? value.trim() : "";
}

function safeText(value, maximum) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maximum && SAFE_TEXT.test(text) ? text : "";
}

function safeDate(value) {
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) return "";
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
