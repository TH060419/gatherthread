import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOnboardingProgress, GUIDE_COPY, GUIDE_LABELS, guideSteps, guideText, onboardingKey } from "../src/onboarding-content.js";
import { translateUiText } from "../src/i18n.js";
import { prepareMobileGuidePage, prepareMemberGuideTab, prepareSessionGuideMenus, setGuideMenuExpanded, visibleGuideTarget } from "../src/onboarding.js";

test("guide visibility tolerates subpixel viewport rounding but rejects actual clipping", () => {
  let rect = { top: 520.25, bottom: 568.25, left: 12, right: 308, width: 296, height: 48 };
  const node = { closest: () => null, getClientRects: () => [rect], getBoundingClientRect: () => rect };
  const doc = { defaultView: { innerWidth: 320, innerHeight: 568,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }) },
    querySelectorAll: selector => selector === "dialog[open]" ? [] : [node] };
  assert.equal(visibleGuideTarget(doc, "#control"), node);
  for (const boundary of [{ bottom: 569.01 }, { right: 321.01 }, { top: -1.01 }, { left: -1.01 }]) {
    const before = rect; rect = { ...rect, ...boundary }; assert.equal(visibleGuideTarget(doc, "#control"), undefined); rect = before;
  }
  rect = { ...rect, bottom: 569, right: 321, top: -1, left: -1 };
  assert.equal(visibleGuideTarget(doc, "#control"), node);
});

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
    assert.equal(guideSteps("basics", context).length, 16);
  }
  assert.equal(guideSteps("history").length, 5);
  assert.equal(guideSteps("files").length, 21);
  assert.equal(guideSteps("members").length, 7);
  assert.equal(guideSteps("summaries").length, 5);
  assert.equal(guideSteps("account").length, 4);
  assert.equal(guideSteps("basics")[0].target, "");
  assert.equal(guideSteps("history")[0].target, "");
  assert.deepEqual(Object.keys(GUIDE_LABELS), ["basics", "members", "history", "files", "summaries", "account"]);
  assert.equal(guideSteps("basics").find((item) => item.id === "create-conversation").target, "#new-session-button");
  assert.equal(guideSteps("members").find((item) => item.id === "invite").target, "#create-invitation-form button[type=submit]");
});

test("the beginner workflow reaches summaries, file review and a working coded result", () => {
  for (const layout of ['desktop', 'mobile']) {
    const items = guideSteps('basics', { layout });
    const positions = ['chat', 'summary', 'request', 'answer', 'files', 'review', 'result'].map(id => items.findIndex(item => item.id === id));
    assert.ok(positions.every((value, index) => value >= 0 && (!index || value > positions[index - 1])));
    assert.equal(items.find(item => item.id === 'result').view, 'example-result');
    assert.match(items.find(item => item.id === 'review').text[1], /文件|改动/);
  }
});

test("desktop and phone guides teach the real file workspace, Markdown tabs and read-only review", () => {
  for (const layout of ["desktop", "mobile"]) {
    const basics = guideSteps("basics", { layout });
    assert.deepEqual(basics.find(item => item.id === "file-code").fileSelection, { branchId: "own", path: "src/signup.js", mode: "code" });
    assert.deepEqual(basics.find(item => item.id === "file-readme").fileSelection, { branchId: "own", path: "README.md", mode: "preview" });
    const review = basics.find(item => item.id === "review");
    assert.equal(review.fileSelection.branchId, "branch-maya"); assert.equal(review.fileSelection.compareWithParent, true);
    assert.match(review.text[1], /只读.*红色.*绿色/u);
    const files = guideSteps("files", { layout });
    assert.deepEqual(files.slice(0, 5).map(item => item.id), ["browse-files", "browse-code", "browse-markdown", "browse-review", "edit-own"]);
    assert.match(files.find(item => item.id === "edit-own").text[1], /自行.*保存.*不会替你保存/u);
    assert.ok(files.filter(item => item.fileSelection).every(item => item.view.startsWith("workspace-")));
  }
});

test("mobile guide uses visible drawer and Agent controls without mobile installation instructions", () => {
  const basics = guideSteps("basics", { layout: "mobile" });
  assert.equal(basics.find((item) => item.id === "project").target, "#toggle-session-rail-button");
  assert.equal(basics.find((item) => item.id === "model").target, "#mobile-agent-button");
  assert.match(basics.find((item) => item.id === "connect").text[1], /电脑.*同一账号.*在线/u);
  assert.match(basics.find((item) => item.id === "connect").text[1], /公网访问.*其他网络/u);
  assert.equal(guideSteps("files", { layout: "mobile" }).find((item) => item.id === "browse-files").target, ".fw-location");
  const mention = guideSteps("members", { layout: "mobile" }).find((item) => item.id === "mention");
  assert.equal(mention.view, "conversation");
  assert.equal(mention.target, "#message-input");
  assert.match(mention.text[1], /未读.*角落.*定位.*读过.*消失/u);
});

test("guide menus disclose only the required compact toolbar without invoking child actions", () => {
  const clicks = [], nodes = new Map();
  for (const id of ["history-summary-menu-button", "session-options-button"]) {
    const node = { expanded: false,
      getAttribute: name => name === "aria-expanded" ? String(node.expanded) : null,
      click: () => { node.expanded = !node.expanded; clicks.push(id); } };
    nodes.set(id, node);
  }
  const doc = { getElementById: id => nodes.get(id) };
  for (const target of ["#history-summary-select-button", "#history-summary-view-button", "#history-summary-versions-button"]) {
    prepareSessionGuideMenus(doc, { target, view: "conversation" });
  }
  assert.deepEqual(clicks.splice(0), ["history-summary-menu-button"], "successive summary steps keep one disclosure open");
  prepareSessionGuideMenus(doc, { target: "#history-summary-toolbar", view: "summary-selection" });
  assert.deepEqual(clicks.splice(0), ["history-summary-menu-button"], "source selection needs no open menu");
  for (const view of ["details", "mobile-details"]) prepareSessionGuideMenus(doc, { target: "#upload-local-turns-button", view });
  assert.deepEqual(clicks.splice(0), ["session-options-button"]);
  prepareSessionGuideMenus(doc, { target: "#message-input", view: "conversation" });
  assert.deepEqual(clicks.splice(0), ["session-options-button"]);
  prepareSessionGuideMenus(doc, { target: "#download-codex-button", view: "snapshot" });
  assert.deepEqual(clicks.splice(0), ["session-options-button"], "read-only download remains reachable inside Session options");
  prepareSessionGuideMenus(doc, { target: "#settings-button" });
  assert.deepEqual(clicks.splice(0), ["session-options-button"]);
  setGuideMenuExpanded(doc, "history-summary-menu-button", true);
  setGuideMenuExpanded(doc, "history-summary-menu-button", true);
  setGuideMenuExpanded(doc, "history-summary-menu-button", false);
  setGuideMenuExpanded(doc, "missing-optional-menu", false);
  assert.deepEqual(clicks, ["history-summary-menu-button", "history-summary-menu-button"]);
});

test("mention guides target the composer rather than a transient unread reminder", () => {
  for (const layout of ["desktop", "mobile"]) {
    const mention = guideSteps("members", { layout }).find(item => item.id === "mention");
    assert.equal(mention.target, "#message-input");
    assert.equal(mention.view, "conversation");
    assert.match(mention.text[0], /unread.*corner|corner.*unread/iu);
    assert.doesNotMatch(mention.text.join(" "), /inbox|右上角 @|再点 @/iu);
  }
});

test("member guide activates its workspace tab only when hidden", () => {
  const pane = { hidden: true }; let opened = 0;
  const doc = { getElementById: id => id === 'fw-pane-members' ? pane : null,
    querySelector: selector => selector === '#file-workspace-host [data-open-tab="members"]'
      ? { click: () => { pane.hidden = false; opened += 1; } } : null };
  prepareMemberGuideTab(doc, "conversation"); assert.equal(opened, 0);
  prepareMemberGuideTab(doc, "members"); prepareMemberGuideTab(doc, "members");
  assert.equal(opened, 1);
});

test("tall mobile file guide sheets are scoped to the active isolated example", async () => {
  const css = await readFile(new URL("../src/onboarding.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-example="true"\]\[data-mobile-workspace="true"\] body\.driver-active #project-code-dialog\[data-mobile-code="true"\]\s*\{\s*height: calc\(100dvh - 46px\); max-height: calc\(100dvh - 46px\); margin: 46px auto 0;/u);
});

test("mobile member guides select their focused invitation, join and project pages", () => {
  const byId = new Map(guideSteps("members", { layout: "mobile" }).map(item => [item.id, item]));
  assert.equal(byId.get("roles").view, "mobile-members");
  assert.equal(byId.get("invite").view, "mobile-invite");
  assert.equal(byId.get("join").view, "mobile-join");
  assert.equal(byId.get("manage").view, "mobile-project");
  assert.equal(byId.get("leave").view, "mobile-project");
});

test("guide preparation discloses only presentation pages and Settings sections", () => {
  const clicks = [], nodes = new Map();
  const add = (id, hidden = true) => { const node = { hidden, dataset: {}, click: () => clicks.push(id) }; nodes.set(id, node); return node; };
  for (const id of ["mobile-invitations-page", "mobile-join-page", "mobile-project-management"]) add(id);
  for (const id of ["mobile-invitations-page-back", "mobile-join-page-back", "mobile-project-management-back", "mobile-open-invitations", "mobile-open-join", "mobile-project-options"]) add(id);
  add("settings-dialog");
  const doc = { getElementById: id => nodes.get(id), querySelector: selector => ({ click: () => clicks.push(selector) }) };
  prepareMobileGuidePage(doc, "mobile-invite"); assert.deepEqual(clicks.splice(0), ["mobile-open-invitations"]);
  nodes.get("mobile-invitations-page").hidden = false;
  prepareMobileGuidePage(doc, "mobile-join"); assert.deepEqual(clicks.splice(0), ["mobile-invitations-page-back", "mobile-open-join"]);
  prepareMobileGuidePage(doc, "mobile-project"); assert.deepEqual(clicks.splice(0), ["mobile-project-options"]);
  nodes.get("mobile-project-management").hidden = false;
  prepareMobileGuidePage(doc, "mobile-rail"); assert.deepEqual(clicks.splice(0), ["mobile-project-management-back"]);
  prepareMobileGuidePage(doc, "account-device"); assert.deepEqual(clicks.splice(0), ['#settings-dialog .settings-navigation a[href="#settings-device"]']);
  prepareMobileGuidePage(doc, "conversation"); assert.deepEqual(clicks, [], "regular conversation steps never click transfer, account or task actions");
});

test("mobile history follows the remote Agent and discussion workflow, not computer import controls", () => {
  const steps = guideSteps("history", { layout: "mobile" });
  assert.deepEqual(steps.map(item => item.id), ["sharing", "mobile-agent", "mobile-chat", "mobile-request", "mobile-summary"]);
  assert.ok(steps.some(item => item.target === "#send-chat-button"));
  assert.ok(steps.some(item => item.target === "#send-agent-button"));
  assert.ok(steps.some(item => item.target === "#history-summary-select-button"));
  for (const item of steps) {
    assert.notEqual(item.view, "mobile-details");
    assert.doesNotMatch(item.target, /upload-local|import-visible|download-codex|auto-upload/);
  }
  assert.deepEqual(guideSteps("history").map(item => item.id), ["sharing", "upload", "manual", "import", "snapshot"]);
});

test("mobile file guides cover connection and status without hidden local file operations", () => {
  const steps = guideSteps("files", { layout: "mobile" });
  assert.deepEqual(steps.map(item => item.id), ["browse-files", "browse-code", "browse-markdown", "browse-review", "edit-own", "files", "github", "github-account", "github-repository", "github-status", "gt-cloud", "enable", "continue"]);
  for (const item of steps) {
    assert.doesNotMatch(item.target, /code-runtime|code-(?:upload|download|recover|branch|merge)|github-code/);
    assert.ok(!["code-device", "code-branches", "code-github"].includes(item.view));
    for (const pair of [item.title, item.text]) { assert.ok(pair[0]); assert.match(pair[1], /[\u4e00-\u9fff]/u); }
  }
  const review = guideSteps("basics", { layout: "mobile" }).find(item => item.id === "review");
  assert.equal(review.target, ".fw-file-heading");
  assert.equal(review.view, "workspace-review");
  assert.equal(guideSteps("files").length, 21, "desktop keeps synchronization and merge controls after file browsing");
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
