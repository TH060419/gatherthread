import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translateUiText } from "../src/i18n.js";
import { mountCodexLauncher } from "../src/codex-launcher.js";

test("Launcher guide emphasizes Mac installation/security and explicit Hook trust", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(/id="codex-launcher-macos-install"[^>]*hidden/.test(html), "Mac installation guide exists");
  assert.ok(/<strong>System Settings → Privacy &amp; Security → Open Anyway<\/strong>/.test(html), "Gatekeeper path is bold");
  assert.ok(/<strong>Review, trust and allow GatherThread Hooks in Codex before using Desktop turn sync\.<\/strong>/.test(html), "Hook review and trust is bold");
  assert.ok(/open the DMG and drag GatherThread Launcher to Applications/.test(html), "DMG explains drag installation");
});

test("Mac-only installation guidance is hidden on Windows without changing the connection", () => {
  for (const [platform, hidden] of [["MacIntel", false], ["macOS", false], ["Win32", true], ["Linux x86_64", true]]) {
    const nodes = new Map();
    const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id,
      { hidden: true, addEventListener() {} }); return nodes.get(id); } };
    mountCodexLauncher({ document, api: {}, localizer: {}, emailHint: {}, context: () => null, platform });
    assert.equal(nodes.get("codex-launcher-macos-install")?.hidden, hidden);
  }
});

test("Installation/security/Hook guide text has matching concise Chinese copy", () => {
  for (const source of [
    "On Mac, open the DMG and drag GatherThread Launcher to Applications. Open it from Applications once.",
    "System Settings → Privacy & Security → Open Anyway",
    "Review, trust and allow GatherThread Hooks in Codex before using Desktop turn sync.",
    "Use Open Anyway only after checking the official download. This Launcher is not Apple-notarized.",
  ]) assert.notEqual(translateUiText(source, "zh-CN"), source);
});
