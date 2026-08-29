import test from "node:test";
import assert from "node:assert/strict";

import {
  contextBudgetInputBytes,
  digitsOnly,
  numericPresetAction,
  numericPresetUpdate,
} from "../src/settings-controls.js";

test("numeric preset actions apply during input events without waiting for change", () => {
  assert.deepEqual(numericPresetAction("settings-text-scale-preset", "90"), {
    kind: "apply",
    inputId: "settings-text-scale",
    inputValue: "90",
  });
  assert.deepEqual(numericPresetAction("settings-context-preset", "2097152"), {
    kind: "apply",
    inputId: "settings-context-budget",
    inputValue: "2",
    unit: "MiB",
  });
  assert.deepEqual(numericPresetAction("settings-left-width-preset", "custom"), {
    kind: "focus",
    inputId: "settings-left-width",
  });
  assert.deepEqual(numericPresetAction("settings-theme", "dark"), { kind: "preview" });
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
