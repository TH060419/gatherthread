import test from "node:test";
import assert from "node:assert/strict";
import { isMobileDevice, usesMobileWorkspace, MOBILE_WORKSPACE_MAX_WIDTH, mobileAgentLabel, mobileControlLabel } from "../src/mobile-workspace.js";

test("local connection availability follows the platform, not a narrow desktop window", () => {
  assert.equal(isMobileDevice({ userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 0 }), false);
  assert.equal(isMobileDevice({ userAgent: "Windows Chrome", platform: "Win32", maxTouchPoints: 10 }), false);
  assert.equal(isMobileDevice({ userAgent: "Mozilla/5.0 (iPhone)" }), true);
  assert.equal(isMobileDevice({ userAgent: "Mozilla/5.0 (Linux; Android 16)" }), true);
  assert.equal(isMobileDevice({ userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 }), true);
});

test("mobile presentation includes tablet portrait/landscape without replacing a narrow desktop", () => {
  const ipad = { userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 };
  const android = { userAgent: "Mozilla/5.0 (Linux; Android 16)", maxTouchPoints: 5 };
  const desktop = { userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 0 };
  const touchLaptop = { userAgent: "Windows Chrome", platform: "Win32", maxTouchPoints: 10 };
  for (const width of [320, 390, 768, 820, 844, 1024, 1180, 1366]) {
    assert.equal(usesMobileWorkspace(ipad, width), true);
    assert.equal(usesMobileWorkspace(android, width), true);
    assert.equal(usesMobileWorkspace(desktop, width), false);
    assert.equal(usesMobileWorkspace(touchLaptop, width), false);
  }
  assert.equal(usesMobileWorkspace(ipad, MOBILE_WORKSPACE_MAX_WIDTH + 1), false);
});

test("small mobile labels preserve harness identity and request/pause/resume distinctions", () => {
  const translate = text => ({ low: "低", Cloud: "云端" })[text] ?? text;
  assert.equal(mobileAgentLabel("codex", "low", translate), "Codex · 低");
  assert.equal(mobileAgentLabel("deepseek-harness", "high"), "DSH · high");
  assert.equal(mobileAgentLabel("cloud", "", translate), "云端");
  assert.equal(mobileControlLabel("Request my agent"), "Ask AI");
  assert.equal(mobileControlLabel("Pause Agent"), "Pause");
  assert.equal(mobileControlLabel("Resume Agent"), "Resume");
  assert.equal(mobileControlLabel("Pausing…"), "Pausing…");
  assert.equal(mobileControlLabel("Pauses your current request; your draft stays here."), "Pauses your current request; your draft stays here.");
});
