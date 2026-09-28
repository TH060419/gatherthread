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

test("all account states get the complete isolated example guides", () => {
  for (const context of [{}, { session: { id: "s" } }, { project: null, session: null }, { writable: false }]) {
    assert.equal(guideSteps("basics", context).length, 10);
  }
  assert.equal(guideSteps("history").length, 5);
  assert.equal(guideSteps("files").length, 7);
  assert.equal(guideSteps("members").length, 7);
  assert.equal(guideSteps("summaries").length, 5);
  assert.equal(guideSteps("basics")[0].target, "");
  assert.equal(guideSteps("history")[0].target, "");
  assert.deepEqual(Object.keys(GUIDE_LABELS), ["basics", "members", "history", "files", "summaries"]);
  assert.ok(guideSteps("basics").find((item) => item.id === "project").note);
  assert.ok(guideSteps("members").find((item) => item.id === "join").note);
  assert.equal(guideSteps("basics").find((item) => item.id === "create-conversation").target, "#new-session-button");
  assert.equal(guideSteps("members").find((item) => item.id === "invite").target, "#create-invitation-form button[type=submit]");
});

test("beginner copy explains shared history and summary limits without technical units", () => {
  for (const topic of ["basics", "history", "summaries"]) {
    for (const item of guideSteps(topic)) {
      for (const copy of item.text) assert.doesNotMatch(copy, /20 KiB|上下文|context\b/iu);
    }
  }
  const chat = guideSteps("basics").find((item) => item.id === "chat");
  const request = guideSteps("basics").find((item) => item.id === "request");
  const selection = guideSteps("summaries").find((item) => item.id === "selection");
  assert.match(chat.text[1], /AI agent.*共享消息/u);
  assert.match(request.text[1], /AI agent.*之前的共享会话消息/u);
  assert.match(selection.text[0], /1–100.*20,000.*6,000/u);
  assert.match(selection.text[1], /1–100.*2 万.*6000/u);
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
      assert.equal(typeof item.target, "string");
      for (const pair of [item.title, item.text]) {
        assert.ok(pair[0]); assert.match(pair[1], /[\u4e00-\u9fff]/u);
        assert.doesNotMatch(pair[1], /助手|助理|只打名字|不要分享自己的登录凭证/u);
      }
    }
  }
});
