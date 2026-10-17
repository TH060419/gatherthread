import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MOBILE_SETTINGS_SECTIONS } from "../src/mobile-settings-view.js";

test("mobile settings retain core account and interaction choices, not native setup", () => {
  assert.equal(new Set(MOBILE_SETTINGS_SECTIONS).size, MOBILE_SETTINGS_SECTIONS.length);
  for (const id of ["settings-general", "settings-profile", "settings-device", "settings-account",
    "settings-appearance", "settings-composer", "settings-notifications", "settings-summaries"]) {
    assert.ok(MOBILE_SETTINGS_SECTIONS.includes(id));
  }
  for (const id of ["settings-layout", "settings-sync", "settings-agents", "settings-personal-api", "settings-code-storage"]) {
    assert.equal(MOBILE_SETTINGS_SECTIONS.includes(id), false);
  }
});

test("mobile settings preserve original form values and reveal invalid core fields", async () => {
  const source = await readFile(new URL("../src/mobile-settings-view.js", import.meta.url), "utf8");
  assert.match(source, /addEventListener\("invalid",[\s\S]*?closest\("\.settings-section"\)[\s\S]*?true\)/);
  assert.match(source, /querySelector\("\.settings-layout"\)\.scrollTop = 0/);
  assert.doesNotMatch(source, /\.value\s*=|\.disabled\s*=|fetch\(|location\.reload|innerHTML/);
});

test("interface choice is available before login and in General without changing account settings", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["auth-interface-mode", "settings-interface-mode"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>[\\s\\S]*?value="auto"[\\s\\S]*?value="mobile"[\\s\\S]*?value="desktop"`));
  }
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /interfaceMode\.setPreference\(event\.target\.value\)/);
  assert.match(main, /getMode: \(\) => interfaceMode\.getMode\(\)/);
});

test("script validation and save failures reveal their mobile settings page before focus", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  for (const field of ["settings-history-summary-instructions", "settings-history-context-mode"]) {
    assert.match(main, new RegExp(`mobileSettings\\.open\\("settings-summaries"\\);\\s+element\\("${field}"\\)\\.focus\\(\\)`));
  }
  assert.match(main, /mobileSettings\.open\("settings-device"\);\s+deviceInput\.focus\(\)/);
  assert.match(main, /mobileSettings\.open\("settings-device"\);\s+if \(!deviceInput\.disabled\) deviceInput\.focus\(\)/);
  assert.match(main, /if \(mobileWorkspace\.isActive\(\)\) \{\s+mobileSettings\.open\("settings-general"\)/);
  assert.match(main, /message\.hidden = false;\s+element\("settings-interface-mode"\)\.focus\(\)/);
});

test("switching to mobile preserves a focused core section or focuses the settings directory", async () => {
  const source = await readFile(new URL("../src/mobile-settings-view.js", import.meta.url), "utf8");
  assert.match(source, /enteringMobile && dialog\.open && MOBILE_SETTINGS_SECTIONS\.includes\(focusedSection\?\.id\)\) selected = focusedSection\.id/);
  assert.match(source, /!MOBILE_SETTINGS_SECTIONS\.includes\(focusedSection\.id\)[\s\S]*navigation\.focus\(\{ preventScroll: true \}\)/);
});
