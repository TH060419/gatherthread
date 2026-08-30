export const SETTINGS_VERSION = 4;
export const SETTINGS_STORAGE_KEY = "gatherthread.settings.v1";

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

export const DEFAULT_SETTINGS = deepFreeze({
  version: SETTINGS_VERSION,
  general: {
    locale: "en",
  },
  appearance: {
    theme: "system",
    textScalePercent: 100,
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
  },
  composer: {
    enterBehavior: "newline",
    confirmAgentRequest: false,
    autoScroll: true,
  },
  notifications: {
    agentCompleted: false,
    connectionLost: true,
  },
  agents: {
    activeHarness: "codex",
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
  const customCodexModels = uniqueStrings(agents.customCodexModels)
    .filter((model) => MODEL_ID_PATTERN.test(model))
    .slice(0, 40);
  const availableModels = new Set([...CODEX_MODELS.map((model) => model.id), ...customCodexModels]);
  const projectProfiles = {};
  if (isObject(agents.projectProfiles)) {
    for (const [projectId, profile] of Object.entries(agents.projectProfiles)) {
      if (!PROJECT_ID_PATTERN.test(projectId) || !isObject(profile)) continue;
      const model = availableModels.has(profile.model) ? profile.model : DEFAULT_SETTINGS.agents.projectProfiles.model;
      projectProfiles[projectId] = normalizeCodexProfile({
        model: model ?? "gpt-5.6-sol",
        effort: profile.effort,
      }, customCodexModels);
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
    notifications: {
      agentCompleted: notifications.agentCompleted === true,
      connectionLost: notifications.connectionLost !== false,
    },
    agents: {
      activeHarness: "codex",
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
  return normalizeCodexProfile(normalized.agents.projectProfiles[projectId], normalized.agents.customCodexModels);
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
        [projectId]: normalizeCodexProfile(profile, normalized.agents.customCodexModels),
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
  return {
    get() {
      return structuredClone(current);
    },
    set(next) {
      current = normalizeSettings(next);
      try {
        storage?.setItem?.(SETTINGS_STORAGE_KEY, JSON.stringify(current));
      } catch {
        // UI preferences remain usable for this tab when browser storage is unavailable.
      }
      return structuredClone(current);
    },
    reset() {
      current = normalizeSettings(DEFAULT_SETTINGS);
      try {
        storage?.removeItem?.(SETTINGS_STORAGE_KEY);
      } catch {
        // Reset still applies to this tab.
      }
      return structuredClone(current);
    },
  };
}

function migrateStoredSettings(input) {
  if (!isObject(input) || Number(input.version) >= SETTINGS_VERSION) return input;
  const previousVersion = Number(input.version);
  const appearance = isObject(input.appearance) ? input.appearance : {};
  const layout = isObject(input.layout) ? input.layout : {};
  return {
    ...input,
    appearance: {
      ...appearance,
      ambientCanvas: previousVersion < 3 ? "pronounced" : appearance.ambientCanvas,
      highContrast: previousVersion < 3 ? true : appearance.highContrast,
    },
    layout: {
      ...layout,
      leftRailPixels: layout.leftRailPixels == null || layout.leftRailPixels === 260 ? DEFAULT_SETTINGS.layout.leftRailPixels : layout.leftRailPixels,
      rightPanelPixels: layout.rightPanelPixels == null || layout.rightPanelPixels === 290 ? DEFAULT_SETTINGS.layout.rightPanelPixels : layout.rightPanelPixels,
    },
  };
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
