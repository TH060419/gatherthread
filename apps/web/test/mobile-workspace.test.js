import test from "node:test";
import assert from "node:assert/strict";
import { isMobileDevice, mobileAgentLabel, mobileControlLabel } from "../src/mobile-workspace.js";

test("local connection availability follows the platform, not a narrow desktop window", () => {
  assert.equal(isMobileDevice({ userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 0 }), false);
  assert.equal(isMobileDevice({ userAgent: "Windows Chrome", platform: "Win32", maxTouchPoints: 10 }), false);
  assert.equal(isMobileDevice({ userAgent: "Mozilla/5.0 (iPhone)" }), true);
  assert.equal(isMobileDevice({ userAgent: "Mozilla/5.0 (Linux; Android 16)" }), true);
  assert.equal(isMobileDevice({ userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 }), true);
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
