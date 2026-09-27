import test from "node:test";
import assert from "node:assert/strict";
import { createOnboardingProgress, GUIDE_COPY, GUIDE_LABELS, guideSteps, guideText, onboardingKey } from "../src/onboarding-content.js";
import { translateUiText } from "../src/i18n.js";

test("tour progress is isolated by user, device and site, including delimiter-like IDs", () => {
  const identity = { userId: "u:a", deviceId: "d", origin: "https://example.test" };
  const key = onboardingKey(identity);
  const storage = new Map();
  const progress = createOnboardingProgress({ getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) });
  assert.equal(progress.has(key), false);
  progress.mark(key, "skipped");
  assert.equal(createOnboardingProgress({ getItem: (k) => storage.get(k) }).has(key), true);
  for (const other of [{ userId: "u" }, { deviceId: "other" }, { origin: "https://another.test" }]) {
    assert.equal(progress.has(onboardingKey({ ...identity, ...other })), false);
  }
  assert.notEqual(onboardingKey({ ...identity, userId: "u", deviceId: "a:d" }), key);
  progress.mark(onboardingKey({ ...identity, userId: "new" }), "opened");
  assert.equal(progress.has(onboardingKey({ ...identity, userId: "new" })), false);
  assert.equal(onboardingKey({ ...identity, deviceId: undefined }), null);
});

test("storage denial retains completion within the page and never breaks sign-in", () => {
  const progress = createOnboardingProgress({ getItem() { throw Error("blocked"); }, setItem() { throw Error("full"); } });
  assert.equal(progress.has("a"), false);
  progress.mark("a", "completed");
  assert.equal(progress.has("a"), true);
  assert.equal(progress.has("b"), false);
  assert.equal(progress.has(null), true);
});

test("empty workspace uses a short setup tour, while every core guide remains available", () => {
  const empty = guideSteps("basics");
  assert.deepEqual(empty.map((step) => step.id), ["welcome", "project", "conversation", "connect", "finish"]);
  const full = guideSteps("basics", { session: { id: "s" } });
  assert.ok(full.find((step) => step.id === "chat"));
  assert.ok(full.find((step) => step.id === "request"));
  assert.equal(full.length, 9);
  assert.equal(guideSteps("history").length, 7);
  assert.equal(guideSteps("files").length, 6);
  assert.equal(guideSteps("members").length, 5);
});

test("every guide and navigation label has authored Chinese and English copy", () => {
  for (const pair of [...Object.values(GUIDE_LABELS), ...Object.values(GUIDE_COPY)]) {
    assert.equal(pair.length, 2); assert.notEqual(pair[0], pair[1]);
    assert.equal(guideText(pair, "en"), pair[0]);
    assert.equal(guideText(pair, "zh-CN"), pair[1]);
  }
  for (const label of Object.values(GUIDE_LABELS)) assert.equal(translateUiText(label[0], "zh-CN"), label[1]);
  for (const topic of Object.keys(GUIDE_LABELS)) {
    const items = guideSteps(topic, { session: { id: "s" } });
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    for (const item of items) {
      assert.ok(item.target);
      for (const pair of [item.title, item.text]) {
        assert.ok(pair[0]); assert.match(pair[1], /[\u4e00-\u9fff]/u);
        assert.doesNotMatch(pair.join(" ").replaceAll("DeepSeek Harness", "DSH"), /\b(?:harness|git|context)\b|上下文|字体|动态背景/iu);
      }
    }
  }
});
