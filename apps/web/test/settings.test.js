import test from "node:test";
import assert from "node:assert/strict";

import {
  addCustomCodexModel,
  CODEX_MODELS,
  CONTEXT_BUDGET_MAX_BYTES,
  CONTEXT_BUDGET_MIN_BYTES,
  contextBudgetToTokenCeiling,
  createSettingsStore,
  DEFAULT_SETTINGS,
  effectiveContextBudget,
  normalizeCodexProfile,
  normalizeSettings,
  projectAgentHarness,
  projectCodexProfile,
  projectDshProfile,
  projectEnabledHarnesses,
  SETTINGS_STORAGE_KEY,
  withProjectAgentHarness,
  withProjectCodexProfile,
  withProjectDshProfile,
  withProjectEnabledHarnesses,
} from "../src/settings.js";

test("settings normalize invalid or stale browser data without retaining unknown fields", () => {
  const normalized = normalizeSettings({
    version: 0,
    token: "must-not-survive",
    general: { locale: "fr" },
    appearance: { theme: "neon", textScalePercent: 999, density: "tiny", motion: "reduce", ambientCanvas: "loud", highContrast: true },
    layout: { leftRailPixels: 1, rightPanelPixels: 9999 },
    sync: { mode: "fixed", contextBudgetBytes: 99_999_999 },
    composer: { enterBehavior: "execute_shell", autoScroll: false },
  });
  assert.equal(normalized.version, 7);
  assert.equal(normalized.general.locale, "en");
  assert.equal(normalized.appearance.theme, "system");
  assert.equal(normalized.appearance.textScalePercent, 125);
  assert.equal(normalized.appearance.motion, "reduce");
  assert.equal(normalized.appearance.ambientCanvas, "pronounced");
  assert.equal(normalized.appearance.highContrast, true);
  assert.equal(normalized.layout.leftRailPixels, 210);
  assert.equal(normalized.layout.rightPanelPixels, 480);
  assert.equal(normalized.layout.composerPixels, 280);
  assert.equal(normalized.sync.contextBudgetBytes, CONTEXT_BUDGET_MAX_BYTES);
  assert.equal(normalized.composer.enterBehavior, "newline");
  assert.equal(normalized.composer.autoScroll, false);
  assert.equal("token" in normalized, false);
});

test("Codex catalog matches the installed model families and model-specific efforts", () => {
  assert.deepEqual(CODEX_MODELS.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ]);
  assert.deepEqual(normalizeCodexProfile({ model: "gpt-5.6-sol", effort: "ultra" }), { model: "gpt-5.6-sol", effort: "ultra" });
  assert.deepEqual(normalizeCodexProfile({ model: "gpt-5.4", effort: "ultra" }), { model: "gpt-5.4", effort: "medium" });
});

test("project Agent profiles are isolated and custom models remain safe data", () => {
  let settings = addCustomCodexModel(DEFAULT_SETTINGS, "deepseek-chat");
  settings = withProjectCodexProfile(settings, "project-alpha", { model: "deepseek-chat", effort: "high" });
  assert.deepEqual(projectCodexProfile(settings, "project-alpha"), { model: "deepseek-chat", effort: "high" });
  assert.deepEqual(projectCodexProfile(settings, "project-beta"), { model: "gpt-5.6-sol", effort: "low" });
  assert.throws(() => addCustomCodexModel(settings, "--danger"), /may not start/);
  assert.throws(() => addCustomCodexModel(settings, "bad\nmodel"), /single-line/);
  assert.throws(() => withProjectCodexProfile(settings, "bad project", { model: "deepseek-chat", effort: "high" }), /safe project ID/);
});

test("project harness and DSH runtime selections are exact, isolated, and credential-free", () => {
  let settings = withProjectAgentHarness(DEFAULT_SETTINGS, "project-alpha", "deepseek-harness");
  settings = withProjectDshProfile(settings, "project-alpha", {
    deviceId: "dsh-device-1",
    provider: "My Provider",
    model: "CaseSensitive/Model-X",
    token: "must-not-survive",
  });
  assert.equal(projectAgentHarness(settings, "project-alpha"), "deepseek-harness");
  assert.deepEqual(projectEnabledHarnesses(settings, "project-alpha"), ["codex", "deepseek-harness"]);
  assert.equal(projectAgentHarness(settings, "project-beta"), "deepseek-harness");
  assert.deepEqual(projectDshProfile(settings, "project-alpha"), {
    deviceId: "dsh-device-1",
    provider: "My Provider",
    model: "CaseSensitive/Model-X",
  });
  assert.equal(projectDshProfile(settings, "project-beta"), null);
  assert.doesNotMatch(JSON.stringify(settings), /must-not-survive|token/i);
  assert.throws(() => withProjectAgentHarness(settings, "project-alpha", "unknown"), /supported Agent harness/);
  assert.throws(() => withProjectDshProfile(settings, "project-alpha", {
    deviceId: "dsh-device-1",
    provider: "provider",
    model: "bad\nmodel",
  }), /connected DeepSeek Harness runtime/);
});

test("project connection shortcuts are ordered, multi-select, and always keep one default Agent", () => {
  assert.deepEqual(projectEnabledHarnesses(DEFAULT_SETTINGS, "project-alpha"), ["codex"]);
  let settings = withProjectEnabledHarnesses(DEFAULT_SETTINGS, "project-alpha", ["codex", "deepseek-harness", "codex"]);
  assert.deepEqual(projectEnabledHarnesses(settings, "project-alpha"), ["codex", "deepseek-harness"]);
  assert.deepEqual(
    projectEnabledHarnesses(settings, "project-new"),
    ["codex", "deepseek-harness"],
    "a newly opened project inherits the user's enabled connection shortcuts",
  );
  assert.equal(projectAgentHarness(settings, "project-alpha"), "codex");

  settings = withProjectEnabledHarnesses(settings, "project-alpha", ["deepseek-harness"]);
  assert.deepEqual(projectEnabledHarnesses(settings, "project-alpha"), ["deepseek-harness"]);
  assert.equal(projectAgentHarness(settings, "project-alpha"), "deepseek-harness");
  assert.throws(() => withProjectEnabledHarnesses(settings, "project-alpha", []), /at least one Agent connection shortcut/);
});

test("legacy flat Codex project profiles migrate without changing their model or effort", () => {
  const migrated = normalizeSettings({
    version: 4,
    agents: {
      activeHarness: "codex",
      customCodexModels: ["Legacy/Model"],
      projectProfiles: {
        "project-alpha": { model: "Legacy/Model", effort: "high" },
      },
    },
  });
  assert.equal(migrated.version, 7);
  assert.equal(projectAgentHarness(migrated, "project-alpha"), "codex");
  assert.deepEqual(projectEnabledHarnesses(migrated, "project-alpha"), ["codex"]);
  assert.deepEqual(projectCodexProfile(migrated, "project-alpha"), { model: "Legacy/Model", effort: "high" });
});

test("version 6 connection shortcuts become the default for newly opened projects", () => {
  const stored = JSON.stringify({
    version: 6,
    agents: {
      activeHarness: "codex",
      projectProfiles: {
        "project-alpha": {
          harness: "codex",
          enabledHarnesses: ["codex", "deepseek-harness"],
          codex: { model: "gpt-5.6-sol", effort: "low" },
          dsh: null,
        },
      },
    },
  });
  const migrated = createSettingsStore({
    getItem: () => stored,
    setItem: () => {},
    removeItem: () => {},
  }).get();
  assert.equal(migrated.version, 7);
  assert.deepEqual(projectEnabledHarnesses(migrated, "project-alpha"), ["codex", "deepseek-harness"]);
  assert.deepEqual(projectEnabledHarnesses(migrated, "project-new"), ["codex", "deepseek-harness"]);
});

test("context budget keeps a precise configured value while reporting connector limits", () => {
  const settings = normalizeSettings({ sync: { mode: "fixed", contextBudgetBytes: 777_777 } });
  assert.deepEqual(effectiveContextBudget(settings, { maxContextBytes: 7 * 1024, label: "Codex Hook" }), {
    configuredBytes: 777_777,
    effectiveBytes: 7 * 1024,
    limitedBy: "Codex Hook",
  });
  assert.equal(normalizeSettings({ sync: { contextBudgetBytes: 1 } }).sync.contextBudgetBytes, CONTEXT_BUDGET_MIN_BYTES);
  assert.equal(contextBudgetToTokenCeiling(settings), 194_444);
  assert.equal(contextBudgetToTokenCeiling({ sync: { contextBudgetBytes: CONTEXT_BUDGET_MIN_BYTES } }), 4_096);
});

test("settings storage is versioned, credential-free, and fails closed to defaults", () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const store = createSettingsStore(storage);
  const updated = store.set({ ...store.get(), general: { locale: "zh-CN" } });
  assert.equal(updated.general.locale, "zh-CN");
  assert.equal(JSON.parse(data.get(SETTINGS_STORAGE_KEY)).general.locale, "zh-CN");
  assert.doesNotMatch(data.get(SETTINGS_STORAGE_KEY), /token|cookie|password|secret/i);
  assert.equal(store.reset().general.locale, "en");

  const broken = createSettingsStore({ getItem: () => "{broken", setItem: () => { throw new Error("blocked"); } });
  assert.deepEqual(broken.get(), structuredClone(DEFAULT_SETTINGS));

  const legacyData = new Map([[SETTINGS_STORAGE_KEY, JSON.stringify({
    version: 2,
    general: { locale: "zh-CN" },
    appearance: { theme: "dark", ambientCanvas: "off" },
  })]]);
  const migrated = createSettingsStore({
    getItem: (key) => legacyData.get(key) ?? null,
    setItem: (key, value) => legacyData.set(key, value),
    removeItem: (key) => legacyData.delete(key),
  }).get();
  assert.equal(migrated.version, 7);
  assert.equal(migrated.general.locale, "zh-CN");
  assert.equal(migrated.appearance.theme, "dark");
  assert.equal(migrated.appearance.ambientCanvas, "pronounced");
  assert.equal(migrated.appearance.highContrast, true);
  assert.equal(migrated.appearance.textScalePercent, 90);
  assert.equal(migrated.layout.leftRailPixels, 340);
  assert.equal(migrated.layout.rightPanelPixels, 320);

  const customizedLayout = createSettingsStore({
    getItem: () => JSON.stringify({
      version: 3,
      appearance: { ambientCanvas: "off", highContrast: false },
      layout: { leftRailPixels: 312, rightPanelPixels: 356, composerPixels: 330 },
    }),
    setItem: () => {},
  }).get();
  assert.equal(customizedLayout.appearance.ambientCanvas, "off");
  assert.equal(customizedLayout.appearance.highContrast, false);
  assert.equal(customizedLayout.layout.leftRailPixels, 312);
  assert.equal(customizedLayout.layout.rightPanelPixels, 356);
  assert.equal(customizedLayout.layout.composerPixels, 330);

  const customizedTextScale = createSettingsStore({
    getItem: () => JSON.stringify({ version: 5, appearance: { textScalePercent: 110 } }),
    setItem: () => {},
  }).get();
  assert.equal(customizedTextScale.appearance.textScalePercent, 110);
});
