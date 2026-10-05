// Loopback + MockCollaborationApi only. No native Agent/provider is invoked.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const origin = process.env.AGENT_UI_ORIGIN ?? "http://127.0.0.1:4318";
assert.ok(new Set(["127.0.0.1", "localhost", "[::1]"]).has(new URL(origin).hostname), "local mock checks only");
const artifacts = process.env.AGENT_UI_ARTIFACTS ?? "/tmp/gatherthread-agent-ui";
await mkdir(artifacts, { recursive: true });
const browserName = process.env.AGENT_UI_BROWSER ?? "chrome";
const browser = browserName === "webkit" ? await webkit.launch()
  : await chromium.launch({ headless: true, channel: browserName });
const errors = [];

async function contextFor(locale, width) {
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, reducedMotion: "reduce" });
  await context.addInitScript(({ locale }) => {
    localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith("gatherthread.onboarding.v1:")) return "skipped";
      return getItem.call(this, key);
    };
    // Hold only the mock Agent's work callbacks. UI/network timers run normally.
    const schedule = window.setTimeout.bind(window);
    window.agentWork = [];
    window.setTimeout = (callback, delay, ...args) => {
      if ([220, 430, 650].includes(delay) && /mock-progress|mock-response/.test(String(callback))) {
        window.agentWork.push({ callback, delay });
        return 900000 + window.agentWork.length;
      }
      return schedule(callback, delay, ...args);
    };
  }, { locale });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  return { context, page };
}

async function login(page, empty = false) {
  await page.goto(`${origin}/app/?mock=1`);
  await page.evaluate(async empty => {
    const mainUrl = document.querySelector('script[type="module"][src*="/main.js"]').src;
    const source = await (await fetch(mainUrl)).text();
    const specifier = source.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)?.[1];
    if (!specifier) throw new Error("Fixture could not resolve the application's API module");
    const { MockCollaborationApi } = await import(new URL(specifier, mainUrl).href);
    const proto = MockCollaborationApi.prototype;
    window.agentWrites = [];
    for (const method of ["appendAgentRequest", "pauseAgentRequest"]) {
      const original = proto[method];
      proto[method] = async function (...args) {
        window.fixtureApi = this;
        window.agentWrites.push({ method, args: structuredClone(args) });
        return original.apply(this, args);
      };
    }
    if (empty) proto.listProjects = async () => [];
  }, empty);
  await page.locator("#auth-select-email-login").click();
  await page.locator("#email-login-email").fill("demo@example.invalid");
  await page.locator("#email-login-password").fill("isolated demo password");
  await page.locator("#email-login-form button[type=submit]").click();
  await page.locator("#code-notice-dialog[open]").waitFor();
  await page.locator("#code-notice-continue").click();
  await page.locator(empty ? "#empty-state:not([hidden])" : "#session-view:not([hidden])").waitFor();
}

async function openAgentSettings(page, width) {
  if (width < 760 && await page.locator("#toggle-session-rail-button").getAttribute("aria-expanded") === "false") {
    await page.locator("#toggle-session-rail-button").click();
  }
  const url = page.url();
  await page.locator("#add-agent-button").waitFor({ state: "visible" });
  await page.locator("#add-agent-button").focus();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "add-agent-button");
  await page.keyboard.press("Enter");
  try { await page.locator("#settings-dialog[open]").waitFor({ timeout: 8000 }); }
  catch (error) {
    await page.screenshot({ path: `${artifacts}/${browserName}-shortcut-failure.png` });
    throw error;
  }
  await page.waitForFunction(() => document.activeElement?.id === "settings-agents");
  assert.equal(page.url(), url, "shortcut preserves project/session navigation");
  const visible = await page.locator("#settings-agents-title").evaluate(node => {
    const box = node.getBoundingClientRect();
    const container = node.closest(".settings-sections").getBoundingClientRect();
    return box.top >= container.top && box.bottom <= container.bottom;
  });
  assert.equal(visible, true, "Agent settings heading is in view");
}

async function runWork(page, delay) {
  await page.evaluate(delay => {
    const work = window.agentWork.filter(item => item.delay === delay);
    window.agentWork = window.agentWork.filter(item => item.delay !== delay);
    for (const item of work) item.callback();
  }, delay);
}

async function exerciseControl(page, harness, locale, prefix) {
  const choose = async value => {
    const mobile = await page.locator("#mobile-agent-button").isVisible();
    if (mobile) await page.locator("#mobile-agent-button").click();
    await page.locator("#agent-harness-select").selectOption(value);
    if (mobile) await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
  };
  await choose(harness);
  await page.evaluate(() => { window.primaryAgentButton = document.querySelector("#send-agent-button"); });
  const draft = `UNSENT_${harness}`;
  await page.locator("#message-input").fill(`LOCAL_MOCK_${harness}`);
  const confirmed = page.waitForEvent("dialog").then(dialog => dialog.accept());
  await page.locator("#send-agent-button").click();
  await confirmed;
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "wait");
  assert.equal(await page.locator("#send-agent-button").isDisabled(), true, "unclaimed work cannot be paused");
  await page.locator("#message-input").fill(draft);
  await runWork(page, 220);
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "pause");
  assert.match(await page.locator("#send-agent-button").innerText(), locale === "zh-CN" ? /暂停/ : /Pause/);
  const first = await page.evaluate(() => window.agentWrites.filter(item => item.method === "appendAgentRequest").at(-1));
  await page.screenshot({ path: `${artifacts}/${prefix}-${harness}-pause.png` });
  await page.locator("#send-agent-button").click();
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "resume");
  assert.match(await page.locator("#send-agent-button").innerText(), locale === "zh-CN" ? /恢复 Agent|继续/ : /Resume/);
  assert.equal(await page.locator("#message-input").inputValue(), draft, "pause retains draft");
  assert.ok(await page.locator(".agent-paused-notice").count() >= 1, "paused request remains understandable in history");
  await runWork(page, 430); await runWork(page, 650);
  assert.equal(await page.locator("#send-agent-button").getAttribute("data-agent-action"), "resume", "paused work never produces a late mock reply");
  // Change the composer selection. Resume must still use the original target.
  await choose(harness === "codex" ? "deepseek-harness" : "codex");
  const beforeResume = await page.evaluate(() => window.agentWrites.length);
  const cancelled = page.waitForEvent("dialog").then(async dialog => {
    assert.match(dialog.message(), locale === "zh-CN" ? /原 Agent.*新请求/ : /original Agent.*new request/);
    await dialog.dismiss();
  });
  await page.locator("#send-agent-button").click();
  await cancelled;
  assert.equal(await page.evaluate(() => window.agentWrites.length), beforeResume, "cancelled confirmation never writes");
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  const resumedConfirmation = page.waitForEvent("dialog").then(dialog => dialog.accept());
  await page.locator("#send-agent-button").click();
  await resumedConfirmation;
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "wait");
  const resumed = await page.evaluate(() => window.agentWrites.filter(item => item.method === "appendAgentRequest").at(-1));
  assert.equal(resumed.args[0], first.args[0]);
  assert.equal(resumed.args[1].content, first.args[1].content);
  assert.deepEqual(resumed.args[1].executionProfile, first.args[1].executionProfile, "exact target survives composer changes");
  assert.notEqual(resumed.args[1].idempotencyKey, first.args[1].idempotencyKey);
  assert.equal(await page.locator("#message-input").inputValue(), draft, "resume retains draft");
  await runWork(page, 220); await runWork(page, 430); await runWork(page, 650);
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "request");
  assert.equal(await page.evaluate(() => window.primaryAgentButton === document.querySelector("#send-agent-button")), true, "all actions reuse the original element");
  assert.equal(await page.locator("#message-input").inputValue(), draft, "completion retains draft");
  await page.locator("#send-chat-button").click();
  await page.getByText(draft, { exact: true }).waitFor();
}

try {
  for (const locale of ["en", "zh-CN"]) {
    for (const width of [1440, 390]) {
      const prefix = `${browserName}-${locale}-${width}`;
      const { page, context } = await contextFor(locale, width);
      await page.goto(origin);
      const github = page.locator(".hero-ctas .btn-repository");
      await github.waitFor();
      assert.equal(await github.getAttribute("href"), "https://github.com/TH060419/gatherthread");
      assert.match(await github.innerText(), locale === "zh-CN" ? /GitHub 项目/ : /GitHub repository/);
      assert.match(await github.getAttribute("rel"), /noopener/);
      assert.equal(await github.evaluate(node => node.classList.contains("btn-pill")), true, "repository uses the existing product button style");
      assert.equal(await github.evaluate(node => getComputedStyle(node).backgroundImage),
        await page.locator('.hero-ctas [data-i18n="hero.cta1"]').evaluate(node => getComputedStyle(node).backgroundImage));
      assert.match(await page.locator('[data-i18n="setup.codex.2"]').innerText(), locale === "zh-CN" ? /打开启动器/ : /Open Launcher/);
      assert.equal(await page.locator('[data-i18n="setup.codex.link"]').getAttribute("href"), "https://github.com/TH060419/gatherthread/tree/main/prototypes/codex-launcher");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "home has no horizontal overflow");
      await page.screenshot({ path: `${artifacts}/${prefix}-home.png` });
      await login(page);
      await openAgentSettings(page, width);
      await page.screenshot({ path: `${artifacts}/${prefix}-settings.png` });
      await page.locator("#close-settings-button").click();
      if (width < 760) await page.locator("#toggle-session-rail-button").click();
      else await page.waitForFunction(() => document.activeElement?.id === "add-agent-button");
      await page.locator("#add-agent-button").click();
      await page.locator("#settings-enabled-dsh").check();
      await page.locator("#settings-confirm-agent").check();
      await page.locator("#settings-form button[type=submit]").click();
      if (width < 760 && await page.locator("#toggle-session-rail-button").getAttribute("aria-expanded") === "true") {
        await page.locator("#toggle-session-rail-button").click();
      }
      await exerciseControl(page, "codex", locale, prefix);
      await exerciseControl(page, "deepseek-harness", locale, prefix);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "workspace has no horizontal overflow");
      console.log(`PASS ${prefix}: home, keyboard shortcut, Codex/DSH pause/resume, exact target, draft/chat`);
      await context.close();
    }
  }
  const { page, context } = await contextFor("zh-CN", 1440);
  await login(page, true);
  await openAgentSettings(page, 1440);
  await page.locator("#settings-enabled-dsh").check();
  await page.locator("#settings-form button[type=submit]").click();
  assert.equal(await page.locator("#settings-dialog").getAttribute("open"), null, "settings remain usable before the first project");
  await context.close();
  assert.deepEqual(errors, [], "no page runtime errors");
  console.log(`PASS ${browserName}: no-project Agent settings; no page errors`);
} finally {
  await browser.close();
}
