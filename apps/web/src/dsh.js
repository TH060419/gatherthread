export const DSH_HARNESS = "deepseek-harness";
export const DSH_NPM_VERSION = "0.1.2-rc.1";
export const GATHERTHREAD_DSH_PLUGIN_VERSION = "0.1.0-beta.1";
export const DSH_START_COMMAND = "npx @deepseek-ai/dsh web";
export const DSH_VERSION_COMMAND = "npx @deepseek-ai/dsh --version";
export const DSH_PINNED_START_COMMAND = `npx @deepseek-ai/dsh@${DSH_NPM_VERSION} web`;
export const DSH_INSTALL_COMMAND = `npx @deepseek-ai/dsh@${DSH_NPM_VERSION} plugin --profile web add @gatherthread/dsh-host@${GATHERTHREAD_DSH_PLUGIN_VERSION}`;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const USER_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/u;

export function normalizeDshRuntime(value) {
  if (!isObject(value)) return null;
  const id = safeId(value.id);
  const deviceId = safeId(value.deviceId ?? value.device_id);
  const harness = safeText(value.harness, 80)?.toLowerCase();
  const provider = safeText(value.provider, 80);
  const model = safeText(value.model, 160);
  const status = ["online", "offline", "revoked"].includes(value.status) ? value.status : null;
  const lastSeenAt = safeDate(value.lastSeenAt ?? value.last_seen_at);
  if (!id || !deviceId || harness !== DSH_HARNESS || !provider || !model || !status || !lastSeenAt) return null;
  return { id, deviceId, harness: DSH_HARNESS, provider, model, status, lastSeenAt };
}

export function normalizeDshDevice(value) {
  if (!isObject(value)) return null;
  const id = safeId(value.id);
  const name = safeText(value.name, 120);
  if (!id || !name) return null;
  return { id, name };
}

export function dshRuntimeChoices(runtimes, devices = []) {
  const deviceNames = new Map(devices.map(normalizeDshDevice).filter(Boolean).map((device) => [device.id, device.name]));
  return runtimes
    .map(normalizeDshRuntime)
    .filter(Boolean)
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "online" ? -1 : 1;
      return `${deviceNames.get(left.deviceId) ?? left.deviceId}\u0000${left.provider}\u0000${left.model}`
        .localeCompare(`${deviceNames.get(right.deviceId) ?? right.deviceId}\u0000${right.provider}\u0000${right.model}`);
    })
    .map((runtime) => ({
      ...runtime,
      deviceName: deviceNames.get(runtime.deviceId) ?? "DeepSeek Harness device",
      label: `${deviceNames.get(runtime.deviceId) ?? "DeepSeek Harness device"} · ${runtime.provider} · ${runtime.model}${runtime.status === "online" ? "" : " · offline"}`,
    }));
}

export function resolveDshRuntime(runtimes, devices, profile) {
  const choices = dshRuntimeChoices(runtimes, devices);
  const online = choices.filter((runtime) => runtime.status === "online");
  if (profile) {
    const selected = choices.find((runtime) => runtime.deviceId === profile.deviceId
      && runtime.provider === profile.provider
      && runtime.model === profile.model);
    if (selected?.status === "online") return { runtime: selected, choices, reason: "" };
    if (selected) return { runtime: null, choices, reason: "The selected DeepSeek Harness runtime is offline." };
  }
  if (online.length === 1) return { runtime: online[0], choices, reason: "" };
  if (online.length === 0) {
    return { runtime: null, choices, reason: "Connect DeepSeek Harness before requesting this Agent." };
  }
  return { runtime: null, choices, reason: "Choose which online DeepSeek Harness runtime should handle this request." };
}

export function dshExecutionProfile(runtime) {
  const normalized = normalizeDshRuntime(runtime);
  if (!normalized || normalized.status !== "online") {
    throw new Error("A matching online DeepSeek Harness runtime is required.");
  }
  return {
    harness: DSH_HARNESS,
    provider: normalized.provider,
    model: normalized.model,
    runtimeId: normalized.id,
  };
}

export function dshPairingCodeFromHash(hash) {
  const parameters = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const code = parameters.get("dsh-pair")?.trim().toUpperCase() ?? "";
  return USER_CODE_PATTERN.test(code) ? code : "";
}

export function withoutDshPairingHash(hash) {
  const parameters = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  parameters.delete("dsh-pair");
  return parameters.toString();
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
