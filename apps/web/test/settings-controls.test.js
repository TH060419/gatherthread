import test from "node:test";
import assert from "node:assert/strict";

import {
  contextBudgetInputBytes,
  digitsOnly,
  numericPresetUpdate,
  shouldPreviewSettingsInput,
} from "../src/settings-controls.js";

test("numeric preset input events wait for the change handler instead of restoring stale values", () => {
  assert.equal(shouldPreviewSettingsInput("settings-text-scale-preset"), false);
  assert.equal(shouldPreviewSettingsInput("settings-left-width-preset"), false);
  assert.equal(shouldPreviewSettingsInput("settings-context-preset"), false);
  assert.equal(shouldPreviewSettingsInput("settings-context-budget"), true);
});

test("numeric presets resolve to their exact input value and context unit", () => {
  assert.deepEqual(numericPresetUpdate("settings-text-scale-preset", "110"), {
    inputId: "settings-text-scale",
    inputValue: "110",
  });
  assert.deepEqual(numericPresetUpdate("settings-left-width-preset", "340"), {
    inputId: "settings-left-width",
    inputValue: "340",
  });
  assert.deepEqual(numericPresetUpdate("settings-context-preset", "131072"), {
    inputId: "settings-context-budget",
    inputValue: "128",
    unit: "KiB",
  });
  assert.deepEqual(numericPresetUpdate("settings-context-preset", "2097152"), {
    inputId: "settings-context-budget",
    inputValue: "2",
    unit: "MiB",
  });
  assert.equal(numericPresetUpdate("settings-context-preset", "custom"), null);
});

test("the custom context ceiling accepts digits only", () => {
  assert.equal(digitsOnly("12e3.4 MiB"), "1234");
  assert.equal(digitsOnly("１２8"), "8");
  assert.equal(digitsOnly("5120"), "5120");
  assert.equal(contextBudgetInputBytes("128", "KiB"), 128 * 1024);
  assert.equal(contextBudgetInputBytes("3", "MiB"), 3 * 1024 * 1024);
  assert.equal(contextBudgetInputBytes("", "KiB"), null);
});
