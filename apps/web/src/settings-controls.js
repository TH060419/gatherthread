const NUMERIC_PRESETS = Object.freeze({
  "settings-text-scale-preset": Object.freeze({ inputId: "settings-text-scale" }),
  "settings-left-width-preset": Object.freeze({ inputId: "settings-left-width" }),
  "settings-right-width-preset": Object.freeze({ inputId: "settings-right-width" }),
  "settings-composer-height-preset": Object.freeze({ inputId: "settings-composer-height" }),
  "settings-context-preset": Object.freeze({ inputId: "settings-context-budget", context: true }),
});

export function shouldPreviewSettingsInput(controlId) {
  return !Object.hasOwn(NUMERIC_PRESETS, controlId);
}

export function numericPresetInputId(controlId) {
  return NUMERIC_PRESETS[controlId]?.inputId ?? null;
}

export function numericPresetUpdate(controlId, selectedValue) {
  const preset = NUMERIC_PRESETS[controlId];
  if (!preset || selectedValue === "custom") return null;
  if (!preset.context) return { inputId: preset.inputId, inputValue: selectedValue };

  const bytes = Number(selectedValue);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  const useMiB = bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0;
  const divisor = useMiB ? 1024 * 1024 : 1024;
  return {
    inputId: preset.inputId,
    inputValue: String(bytes / divisor),
    unit: useMiB ? "MiB" : "KiB",
  };
}

export function digitsOnly(value) {
  return String(value ?? "").replace(/[^0-9]/gu, "");
}

export function contextBudgetInputBytes(value, unit) {
  const digits = digitsOnly(value);
  if (!digits) return null;
  const numericValue = Number(digits);
  const factor = unit === "MiB" ? 1024 * 1024 : 1024;
  const bytes = numericValue * factor;
  return Number.isSafeInteger(bytes) ? bytes : null;
}
