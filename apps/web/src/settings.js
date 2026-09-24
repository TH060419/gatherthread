import { DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS } from "./history-summary-policy.js";

export const SETTINGS_VERSION = 12;
export const SETTINGS_STORAGE_KEY = "gatherthread.settings.v1";
export const SHARED_LANGUAGE_STORAGE_KEY = "gt-lang";

export const CODEX_REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);

export const CODEX_MODELS = Object.freeze([
  Object.freeze({ id: "gpt-5.6-sol", defaultEffort: "low", efforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]) }),
  Object.freeze({ id: "gpt-5.6-terra", defaultEffort: "medium", efforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]) }),
  Object.freeze({ id: "gpt-5.6-luna", defaultEffort: "medium", efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]) }),
  Object.freeze({ id: "gpt-5.5", defaultEffort: "medium", efforts: Object.freeze(["low", "medium", "high", "xhigh"]) }),
  Object.freeze({ id: "gpt-5.4", defaultEffort: "medium", efforts: Object.freeze(["low", "medium", "high", "xhigh"]) }),
  Object.freeze({ id: "gpt-5.4-mini", defaultEffort: "medium", efforts: Object.freeze(["low", "medium", "high", "xhigh"]) }),
  Object.freeze({ id: "gpt-5.3-codex-spark", defaultEffort: "high", efforts: Object.freeze(["low", "medium", "high", "xhigh"]) }),
]);

export const CONTEXT_BUDGET_PRESETS = Object.freeze([
  Object.freeze({ bytes: 8 * 1024, label: "8 KiB" }),
  Object.freeze({ bytes: 32 * 1024, label: "32 KiB" }),
  Object.freeze({ bytes: 128 * 1024, label: "128 KiB" }),
  Object.freeze({ bytes: 512 * 1024, label: "512 KiB" }),
  Object.freeze({ bytes: 2 * 1024 * 1024, label: "2 MiB" }),
  Object.freeze({ bytes: 5 * 1024 * 1024, label: "5 MiB" }),
]);

export const CONTEXT_BUDGET_MIN_BYTES = 8 * 1024;
export const CONTEXT_BUDGET_MAX_BYTES = 5 * 1024 * 1024;
export const CURRENT_CODEX_DESKTOP_RELAY_CAP_BYTES = 7 * 1024;

const MODEL_ID_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]{1,120}$/u;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEVICE_ID_PATTERN = PROJECT_ID_PATTERN;
const DSH_PROVIDER_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]{1,80}$/u;
const DSH_MODEL_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]{1,160}$/u;
export const AGENT_HARNESSES = Object.freeze(["codex", "deepseek-harness"]);

export const DEFAULT_SETTINGS = deepFreeze({
  version: SETTINGS_VERSION,
  general: {
    locale: "en",
  },
  appearance: {
    theme: "system",
    textScalePercent: 90,
    density: "comfortable",
    motion: "system",
    ambientCanvas: "pronounced",
    highContrast: true,
  },
  layout: {
    leftRailPixels: 340,
    rightPanelPixels: 320,
    composerPixels: 280,
  },
  sync: {
    mode: "adaptive",
    contextBudgetBytes: 256 * 1024,
    visibleHistorySync: "first-connect",
  },
  composer: {
    enterBehavior: "newline",
    confirmAgentRequest: false,
    autoScroll: true,
  },
  historySummaries: { instructions: DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS },
  notifications: {
    agentCompleted: false,
    connectionLost: true,
  },
  agents: {
    activeHarness: "codex",
    enabledHarnesses: ["codex"],
    customCodexModels: [],
    projectProfiles: {},
  },
});

export function normalizeSettings(input) {
  const source = isObject(input) ? input : {};
  const appearance = isObject(source.appearance) ? source.appearance : {};
  const layout = isObject(source.layout) ? source.layout : {};
  const sync = isObject(source.sync) ? source.sync : {};
  const composer = isObject(source.composer) ? source.composer : {};
  const notifications = isObject(source.notifications) ? source.notifications : {};
  const agents = isObject(source.agents) ? source.agents : {};
  const general = isObject(source.general) ? source.general : {};
  const summaryInstructions = source.historySummaries?.instructions;
  const visibleHistorySync = sync.visibleHistorySync === "every-connect" || sync.visibleHistorySync === "every-update"
    ? "first-connect"
    : sync.visibleHistorySync;
  const customCodexModels = uniqueStrings(agents.customCodexModels)
    .filter((model) => MODEL_ID_PATTERN.test(model))
    .slice(0, 40);
  const availableModels = new Set([...CODEX_MODELS.map((model) => model.id), ...customCodexModels]);
  const activeHarness = oneOf(agents.activeHarness, AGENT_HARNESSES, DEFAULT_SETTINGS.agents.activeHarness);
  const enabledHarnesses = normalizeEnabledHarnesses(agents.enabledHarnesses, activeHarness);
  const projectProfiles = {};
  if (isObject(agents.projectProfiles)) {
    for (const [projectId, profile] of Object.entries(agents.projectProfiles)) {
      if (!PROJECT_ID_PATTERN.test(projectId) || !isObject(profile)) continue;
      const legacyCodex = isObject(profile.codex) ? profile.codex : profile;
      const model = availableModels.has(legacyCodex.model) ? legacyCodex.model : "gpt-5.6-sol";
      const harness = oneOf(profile.harness, AGENT_HARNESSES, activeHarness);
      const enabledHarnesses = normalizeEnabledHarnesses(profile.enabledHarnesses, harness);
      projectProfiles[projectId] = {
        harness,
        enabledHarnesses,
        codex: normalizeCodexProfile({ model, effort: legacyCodex.effort }, customCodexModels),
        dsh: normalizeDshProfile(profile.dsh),
      };
    }
  }
  return {
    version: SETTINGS_VERSION,
    general: {
      locale: general.locale === "zh-CN" ? "zh-CN" : "en",
    },
    appearance: {
      theme: oneOf(appearance.theme, ["system", "light", "dark"], DEFAULT_SETTINGS.appearance.theme),
      textScalePercent: boundedInteger(appearance.textScalePercent, 90, 125, DEFAULT_SETTINGS.appearance.textScalePercent),
      density: oneOf(appearance.density, ["comfortable", "compact"], DEFAULT_SETTINGS.appearance.density),
      motion: oneOf(appearance.motion, ["system", "reduce", "full"], DEFAULT_SETTINGS.appearance.motion),
      ambientCanvas: oneOf(appearance.ambientCanvas, ["off", "subtle", "pronounced"], DEFAULT_SETTINGS.appearance.ambientCanvas),
      highContrast: appearance.highContrast !== false,
    },
    layout: {
      leftRailPixels: boundedInteger(layout.leftRailPixels, 210, 420, DEFAULT_SETTINGS.layout.leftRailPixels),
      rightPanelPixels: boundedInteger(layout.rightPanelPixels, 260, 480, DEFAULT_SETTINGS.layout.rightPanelPixels),
      composerPixels: boundedInteger(layout.composerPixels, 210, 560, DEFAULT_SETTINGS.layout.composerPixels),
    },
    sync: {
      mode: oneOf(sync.mode, ["adaptive", "fixed"], DEFAULT_SETTINGS.sync.mode),
      visibleHistorySync: oneOf(
        visibleHistorySync,
        ["first-connect", "never"],
        DEFAULT_SETTINGS.sync.visibleHistorySync,
      ),
      contextBudgetBytes: boundedInteger(
        sync.contextBudgetBytes,
        CONTEXT_BUDGET_MIN_BYTES,
        CONTEXT_BUDGET_MAX_BYTES,
        DEFAULT_SETTINGS.sync.contextBudgetBytes,
      ),
    },
    composer: {
      enterBehavior: oneOf(composer.enterBehavior, ["newline", "send_chat", "request_agent"], DEFAULT_SETTINGS.composer.enterBehavior),
      confirmAgentRequest: composer.confirmAgentRequest === true,
      autoScroll: composer.autoScroll !== false,
    },
    historySummaries: {
      instructions: typeof summaryInstructions === "string" && summaryInstructions.trim()
        && summaryInstructions.length <= 4000 ? summaryInstructions : DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS,
    },
    notifications: {
      agentCompleted: notifications.agentCompleted === true,
      connectionLost: notifications.connectionLost !== false,
    },
    agents: {
      activeHarness,
      enabledHarnesses,
      customCodexModels,
      projectProfiles,
    },
  };
}

export function normalizeCodexProfile(profile, customModels = []) {
  const available = new Map(CODEX_MODELS.map((entry) => [entry.id, entry]));
  for (const model of uniqueStrings(customModels).filter((value) => MODEL_ID_PATTERN.test(value))) {
    if (!available.has(model)) available.set(model, { id: model, defaultEffort: "medium", efforts: CODEX_REASONING_EFFORTS });
  }
  const selected = available.get(profile?.model) ?? available.get("gpt-5.6-sol");
  const effort = selected.efforts.includes(profile?.effort) ? profile.effort : selected.defaultEffort;
  return { model: selected.id, effort };
}

export function projectCodexProfile(settings, projectId) {
  const normalized = normalizeSettings(settings);
  return normalizeCodexProfile(normalized.agents.projectProfiles[projectId]?.codex, normalized.agents.customCodexModels);
}

export function withProjectCodexProfile(settings, projectId, profile) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("A safe project ID is required for Agent settings.");
  const normalized = normalizeSettings(settings);
  return normalizeSettings({
    ...normalized,
    agents: {
      ...normalized.agents,
      projectProfiles: {
        ...normalized.agents.projectProfiles,
        [projectId]: {
          ...(normalized.agents.projectProfiles[projectId] ?? defaultProjectAgentProfile(normalized)),
          codex: normalizeCodexProfile(profile, normalized.agents.customCodexModels),
        },
      },
    },
  });
}

export function projectAgentHarness(settings, projectId) {
  const normalized = normalizeSettings(settings);
  return normalized.agents.projectProfiles[projectId]?.harness ?? normalized.agents.activeHarness;
}

export function projectEnabledHarnesses(settings, projectId) {
  const normalized = normalizeSettings(settings);
  const profile = normalized.agents.projectProfiles[projectId];
  return [...(profile?.enabledHarnesses ?? normalized.agents.enabledHarnesses)];
}

export function withProjectEnabledHarnesses(settings, projectId, harnesses) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("A safe project ID is required for Agent settings.");
  const normalized = normalizeSettings(settings);
  const selected = uniqueStrings(harnesses).filter((harness) => AGENT_HARNESSES.includes(harness));
  if (selected.length === 0) throw new Error("Keep at least one Agent connection shortcut enabled.");
  const current = normalized.agents.projectProfiles[projectId] ?? defaultProjectAgentProfile(normalized);
  const harness = selected.includes(current.harness) ? current.harness : selected[0];
  return normalizeSettings({
    ...normalized,
    agents: {
      ...normalized.agents,
      activeHarness: harness,
      enabledHarnesses: selected,
      projectProfiles: {
        ...normalized.agents.projectProfiles,
        [projectId]: {
          ...current,
          harness,
          enabledHarnesses: selected,
        },
      },
    },
  });
}

export function withProjectAgentHarness(settings, projectId, harness) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("A safe project ID is required for Agent settings.");
  const normalized = normalizeSettings(settings);
  const selected = oneOf(harness, AGENT_HARNESSES, undefined);
  if (selected === undefined) throw new Error("Choose a supported Agent harness.");
  const current = normalized.agents.projectProfiles[projectId] ?? defaultProjectAgentProfile(normalized);
  const enabledHarnesses = [...new Set([...normalized.agents.enabledHarnesses, selected])];
  return normalizeSettings({
    ...normalized,
    agents: {
      ...normalized.agents,
      activeHarness: selected,
      enabledHarnesses,
      projectProfiles: {
        ...normalized.agents.projectProfiles,
        [projectId]: {
          ...current,
          harness: selected,
          enabledHarnesses: [...new Set([...current.enabledHarnesses, selected])],
        },
      },
    },
  });
}

export function projectDshProfile(settings, projectId) {
  const normalized = normalizeSettings(settings);
  return normalized.agents.projectProfiles[projectId]?.dsh ?? null;
}

export function withProjectDshProfile(settings, projectId, profile) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("A safe project ID is required for Agent settings.");
  const normalized = normalizeSettings(settings);
  const dsh = normalizeDshProfile(profile);
  if (dsh === null) throw new Error("Choose a connected DeepSeek Harness runtime.");
  const current = normalized.agents.projectProfiles[projectId] ?? defaultProjectAgentProfile(normalized);
  const enabledHarnesses = [...new Set([...normalized.agents.enabledHarnesses, "deepseek-harness"])];
  return normalizeSettings({
    ...normalized,
    agents: {
      ...normalized.agents,
      activeHarness: "deepseek-harness",
      enabledHarnesses,
      projectProfiles: {
        ...normalized.agents.projectProfiles,
        [projectId]: {
          ...current,
          harness: "deepseek-harness",
          enabledHarnesses: [...new Set([...current.enabledHarnesses, "deepseek-harness"])],
          dsh,
        },
      },
    },
  });
}

export function addCustomCodexModel(settings, modelId) {
  const normalized = normalizeSettings(settings);
  const model = typeof modelId === "string" ? modelId.trim() : "";
  if (!MODEL_ID_PATTERN.test(model) || model.startsWith("-")) {
    throw new Error("Custom model IDs must be 1-120 safe, single-line characters and may not start with a dash.");
  }
  if (CODEX_MODELS.some((entry) => entry.id === model)) return normalized;
  return normalizeSettings({
    ...normalized,
    agents: {
      ...normalized.agents,
      customCodexModels: [...normalized.agents.customCodexModels, model],
    },
  });
}

export function effectiveContextBudget(settings, capabilities = {}) {
  const configuredBytes = normalizeSettings(settings).sync.contextBudgetBytes;
  const capabilityBytes = boundedInteger(
    capabilities.maxContextBytes,
    1,
    CONTEXT_BUDGET_MAX_BYTES,
    CURRENT_CODEX_DESKTOP_RELAY_CAP_BYTES,
  );
  return {
    configuredBytes,
    effectiveBytes: Math.min(configuredBytes, capabilityBytes),
    limitedBy: capabilityBytes < configuredBytes ? (capabilities.label ?? "current connector") : null,
  };
}

export function contextBudgetToTokenCeiling(settings) {
  const bytes = normalizeSettings(settings).sync.contextBudgetBytes;
  return Math.min(2_000_000, Math.max(4_096, Math.floor(bytes / 4)));
}

export function createSettingsStore(storage = globalThis.localStorage) {
  let current = DEFAULT_SETTINGS;
  try {
    const raw = storage?.getItem?.(SETTINGS_STORAGE_KEY);
    current = normalizeSettings(raw ? migrateStoredSettings(JSON.parse(raw)) : DEFAULT_SETTINGS);
  } catch {
    current = normalizeSettings(DEFAULT_SETTINGS);
  }
  const sharedLocale = readSharedLocale(storage);
  if (sharedLocale) {
    current = { ...current, general: { ...current.general, locale: sharedLocale } };
  } else {
    writeSharedLocale(storage, current.general.locale);
  }
  return {
    get() {
      const latestSharedLocale = readSharedLocale(storage);
      if (latestSharedLocale && latestSharedLocale !== current.general.locale) {
        current = { ...current, general: { ...current.general, locale: latestSharedLocale } };
      }
      return structuredClone(current);
    },
    set(next) {
      current = normalizeSettings(next);
      try {
        storage?.setItem?.(SETTINGS_STORAGE_KEY, JSON.stringify(current));
      } catch {
        // UI preferences remain usable for this tab when browser storage is unavailable.
      }
      writeSharedLocale(storage, current.general.locale);
      return structuredClone(current);
    },
    reset() {
      current = normalizeSettings(DEFAULT_SETTINGS);
      try {
        storage?.removeItem?.(SETTINGS_STORAGE_KEY);
      } catch {
        // Reset still applies to this tab.
      }
      writeSharedLocale(storage, current.general.locale);
      return structuredClone(current);
    },
  };
}

function readSharedLocale(storage) {
  try {
    const sharedLanguage = storage?.getItem?.(SHARED_LANGUAGE_STORAGE_KEY);
    if (sharedLanguage === "zh") return "zh-CN";
    if (sharedLanguage === "en") return "en";
  } catch {
    // Restricted browser storage keeps the current in-tab setting usable.
  }
  return null;
}

function writeSharedLocale(storage, locale) {
  try {
    storage?.setItem?.(SHARED_LANGUAGE_STORAGE_KEY, locale === "zh-CN" ? "zh" : "en");
  } catch {
    // Restricted browser storage keeps the current in-tab setting usable.
  }
}

function migrateStoredSettings(input) {
  if (!isObject(input) || Number(input.version) >= SETTINGS_VERSION) return input;
  const previousVersion = Number(input.version);
  const appearance = isObject(input.appearance) ? input.appearance : {};
  const layout = isObject(input.layout) ? input.layout : {};
  const sync = isObject(input.sync) ? input.sync : {};
  const agents = isObject(input.agents) ? input.agents : {};
  const legacyProjectProfiles = isObject(agents.projectProfiles) ? Object.values(agents.projectProfiles) : [];
  const inheritedEnabledHarnesses = normalizeEnabledHarnesses([
    ...uniqueStrings(agents.enabledHarnesses),
    ...legacyProjectProfiles.flatMap((profile) => isObject(profile) ? uniqueStrings(profile.enabledHarnesses) : []),
  ], oneOf(agents.activeHarness, AGENT_HARNESSES, DEFAULT_SETTINGS.agents.activeHarness));
  return {
    ...input,
    appearance: {
      ...appearance,
      textScalePercent: previousVersion < 6 && (appearance.textScalePercent == null || appearance.textScalePercent === 100)
        ? DEFAULT_SETTINGS.appearance.textScalePercent
        : appearance.textScalePercent,
      ambientCanvas: previousVersion < 3 ? "pronounced" : appearance.ambientCanvas,
      highContrast: previousVersion < 3 ? true : appearance.highContrast,
    },
    layout: {
      ...layout,
      leftRailPixels: layout.leftRailPixels == null || layout.leftRailPixels === 260 ? DEFAULT_SETTINGS.layout.leftRailPixels : layout.leftRailPixels,
      rightPanelPixels: layout.rightPanelPixels == null || layout.rightPanelPixels === 290 ? DEFAULT_SETTINGS.layout.rightPanelPixels : layout.rightPanelPixels,
    },
    sync: {
      ...sync,
      visibleHistorySync: previousVersion < 8
        ? DEFAULT_SETTINGS.sync.visibleHistorySync
        : sync.visibleHistorySync === "every-connect" || sync.visibleHistorySync === "every-update"
          ? "first-connect"
          : sync.visibleHistorySync,
    },
    agents: {
      ...agents,
      enabledHarnesses: previousVersion < 7 ? inheritedEnabledHarnesses : agents.enabledHarnesses,
    },
  };
}

function normalizeDshProfile(profile) {
  if (!isObject(profile)) return null;
  const deviceId = typeof profile.deviceId === "string" ? profile.deviceId.trim() : "";
  const runtimeIdSource = profile.runtimeId ?? profile.id;
  const runtimeId = typeof runtimeIdSource === "string" ? runtimeIdSource.trim() : "";
  const provider = typeof profile.provider === "string" ? profile.provider.trim() : "";
  const model = typeof profile.model === "string" ? profile.model.trim() : "";
  const effort = typeof (profile.effort ?? profile.reasoningEffort) === "string"
    ? (profile.effort ?? profile.reasoningEffort).trim()
    : "";
  if (!DEVICE_ID_PATTERN.test(deviceId) || !DSH_PROVIDER_PATTERN.test(provider) || !DSH_MODEL_PATTERN.test(model)) {
    return null;
  }
  if (runtimeId && !DEVICE_ID_PATTERN.test(runtimeId)) return null;
  if (effort && !DSH_PROVIDER_PATTERN.test(effort)) return null;
  return {
    deviceId,
    ...(runtimeId ? { runtimeId } : {}),
    provider,
    model,
    ...(effort ? { effort } : {}),
  };
}

function defaultProjectAgentProfile(settings) {
  return {
    harness: settings.agents.activeHarness,
    enabledHarnesses: [...settings.agents.enabledHarnesses],
    codex: normalizeCodexProfile(undefined, settings.agents.customCodexModels),
    dsh: null,
  };
}

function normalizeEnabledHarnesses(harnesses, fallbackHarness) {
  const selected = uniqueStrings(harnesses).filter((harness) => AGENT_HARNESSES.includes(harness));
  if (selected.length === 0) return [fallbackHarness];
  return selected.includes(fallbackHarness) ? selected : [...selected, fallbackHarness];
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
