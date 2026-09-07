import assert from "node:assert/strict";
import test from "node:test";
import { automaticDeviceName } from "../src/device-name.js";

test("automaticDeviceName identifies Safari on macOS", () => {
  assert.equal(automaticDeviceName({
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
  }), "Safari · macOS");
});

test("automaticDeviceName identifies Chromium browsers without detailed fingerprinting", () => {
  assert.equal(automaticDeviceName({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
    userAgentData: { platform: "Windows", brands: [{ brand: "Microsoft Edge" }] },
  }), "Edge · Windows");
});

test("automaticDeviceName identifies mobile Edge variants", () => {
  assert.equal(automaticDeviceName({
    userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 EdgA/140.0",
  }), "Edge · Android");
  assert.equal(automaticDeviceName({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1 EdgiOS/140.0",
  }), "Edge · iPhone");
});

test("automaticDeviceName identifies mobile Safari and has a neutral fallback", () => {
  assert.equal(automaticDeviceName({
    platform: "iPhone",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  }), "Safari · iPhone");
  assert.equal(automaticDeviceName({}), "This browser");
});
