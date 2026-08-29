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
  projectCodexProfile,
  SETTINGS_STORAGE_KEY,
  withProjectCodexProfile,
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
  assert.equal(normalized.version, 3);
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
  assert.equal(migrated.version, 3);
  assert.equal(migrated.general.locale, "zh-CN");
  assert.equal(migrated.appearance.theme, "dark");
  assert.equal(migrated.appearance.ambientCanvas, "pronounced");
  assert.equal(migrated.appearance.highContrast, true);
});
