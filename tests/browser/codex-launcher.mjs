// Complete built Web UI, isolated fake accounts, no external requests or native launch.
// Routing only replaces the native-navigation sink, not browser click hit-testing.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const dist = resolve("apps/web/dist"), artifacts = process.env.LAUNCHER_UI_ARTIFACTS ?? "/tmp/gt-launcher-ui";
await mkdir(artifacts, { recursive: true });
const name = process.env.LAUNCHER_UI_BROWSER ?? "chrome";
const browser = name === "webkit" ? await webkit.launch() : await chromium.launch({ channel: name, headless: true });
const errors = [];
const downloadSource = "a".repeat(40), downloadIndex = `/downloads/${downloadSource}/index.html`;
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
async function fixture(origin, locale, platform, width = 1440, touch = 0) {
  const userAgent = platform === "iPhone" ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" : undefined;
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, reducedMotion: "reduce", ...(userAgent ? { userAgent } : {}) });
  context.setDefaultTimeout(15000);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/downloads/launcher.json") return route.fulfill({ status: 200,
      contentType: "application/json", body: JSON.stringify({ source_commit: downloadSource, index_path: downloadIndex }) });
    if (url.pathname === downloadIndex) return route.fulfill({ status: 200,
      contentType: "text/html", body: "<!doctype html><title>Verified Launcher downloads</title><p>Controlled public installer index</p>" });
    if (url.pathname.startsWith("/v1/")) {
      return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"unauthorized"}}' });
    }
    const path = resolve(dist, `.${decodeURIComponent(url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname)}`);
    assert.ok(path.startsWith(`${dist}${sep}`));
    try {
      let data = await readFile(path);
      if (path.endsWith("/codex-launcher.js")) {
        const source = data.toString();
        assert.ok(source.includes("globalThis.location.href = uri;"));
        data = Buffer.from(source.replace("globalThis.location.href = uri;", "window.launcherOpened.push({uri, active: navigator.userActivation?.isActive});"));
      }
      await route.fulfill({ status: 200, contentType: mime[extname(path)] ?? "application/octet-stream", body: data });
    } catch (error) { if (error.code === "ENOENT") await route.fulfill({ status: 404, body: "Not found" }); else throw error; }
  });
  await context.addInitScript(({ locale, platform, touch }) => {
    localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
    Object.defineProperty(navigator, "platform", { get: () => platform });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => touch });
    if (navigator.userAgentData) Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : get.call(this, key);
    };
    window.launcherOpened = [];
  }, { locale, platform, touch });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/app/?mock=1`);
  await page.locator("#auth-view").waitFor({ state: "visible" });
  await page.evaluate(async () => {
    const entryUrl = document.querySelector('script[type="module"]').src;
    const entry = await (await fetch(entryUrl)).text();
    const mainUrl = new URL(entry.match(/import\("([^\"]*main\.js[^\"]*)"\)/)[1], entryUrl).href;
    const source = await (await fetch(mainUrl)).text();
    const specifier = source.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)[1];
    const { MockCollaborationApi } = await import(new URL(specifier, mainUrl).href);
    window.launcherRequests = []; window.launcherRevoked = []; window.launcherDelayed = false;
    MockCollaborationApi.prototype.createCodexLauncherAuthorization = async input => {
      window.launcherRequests.push(input);
      if (window.launcherDelayed) await new Promise(done => { window.finishLauncher = done; });
      return { email: input.email, authorization: { id: crypto.randomUUID(),
        expires_at: new Date(Date.now() + 600000).toISOString() } };
    };
    MockCollaborationApi.prototype.revokeDeviceAuthorization = async id => window.launcherRevoked.push(id);
  });
  await page.locator("#auth-select-email-login").click();
  await page.locator("#email-login-email").fill("demo@example.invalid");
  await page.locator("#email-login-password").fill("isolated demo password");
  await page.locator("#email-login-form button[type=submit]").click();
  await page.locator("#code-notice-dialog[open]").waitFor();
  await page.locator("#code-notice-continue").click();
  await page.locator("#session-view:not([hidden])").waitFor();
  return { context, page };
}
try {
  for (const origin of ["https://gatherthread.cn", "https://test.gatherthread.cn"]) {
    for (const [platform, locale] of [["MacIntel", "zh-CN"], ["Win32", "en"]]) {
      const { context, page } = await fixture(origin, locale, platform);
      await page.locator("#connect-codex-button").click();
      await page.locator("#connect-codex-dialog[open]").waitFor();
      await page.locator("#open-codex-launcher-button:not([disabled])").waitFor();
      assert.equal(await page.locator("#connect-codex-manual").evaluate(node => node.open), false);
      assert.equal(await page.locator("#codex-launcher-account").innerText(), "demo@example.invalid");
      assert.equal(await page.locator("#codex-launcher-email-row").isVisible(), false);
      assert.equal(await page.locator("#connect-codex-posix-command").isVisible(), false);
      assert.equal(await page.locator("#codex-launcher-option input[type=password]").count(), 0);
      const macGuide = page.locator("#codex-launcher-macos-install");
      assert.equal(await macGuide.isVisible(), platform === "MacIntel", "Mac installation instructions do not clutter Windows");
      if (platform === "MacIntel") {
        assert.match(await macGuide.innerText(), /DMG/);
        assert.match(await macGuide.innerText(), /系统设置 → 隐私与安全性 → 仍要打开/);
        assert.ok(await macGuide.locator("strong").evaluate(node => Number(getComputedStyle(node).fontWeight) >= 600), "security path stays bold");
      }
      const hooksGuide = page.locator("#codex-launcher-option strong").filter({ hasText: /Hooks/ }).last();
      assert.ok(await hooksGuide.isVisible());
      assert.ok(await hooksGuide.evaluate(node => Number(getComputedStyle(node).fontWeight) >= 600), "Hook review/trust step stays bold");
      const description = await page.locator("#codex-launcher-title + p").boundingBox();
      const download = await page.locator("#download-codex-launcher-button").boundingBox();
      assert.ok(download.y >= description.y + description.height + 4, "download button does not overlap its instructions");
      await page.waitForFunction(path => new URL(document.getElementById("download-codex-launcher-button").href).pathname === path, downloadIndex);
      const [downloads] = await Promise.all([page.waitForEvent("popup"), page.locator("#download-codex-launcher-button").click()]);
      await downloads.waitForLoadState("domcontentloaded");
      assert.equal(downloads.url(), `${origin}${downloadIndex}`, "ordinary download click uses this server's same-source installer index");
      await downloads.close();
      await page.locator("#open-codex-launcher-button").click();
      const opened = await page.evaluate(() => window.launcherOpened);
      assert.equal(opened.length, 1); assert.equal(opened[0].active, true, "native opening keeps the actual user gesture");
      const link = new URL(opened[0].uri);
      const originalGrant = link.searchParams.get("authorization_id");
      assert.match(originalGrant, /^[0-9a-f-]{36}$/i);
      assert.equal(link.searchParams.get("origin"), origin);
      assert.equal(link.searchParams.get("email"), "demo@example.invalid");
      assert.equal(link.searchParams.get("v"), "2");
      assert.doesNotMatch(link.href, /password|gta_|gtd_|cookie/i);
      await page.locator("#close-connect-codex-button").click();
      assert.deepEqual(await page.evaluate(() => window.launcherRevoked), []);
      await page.locator("#connect-codex-button").click();
      await page.locator("#open-codex-launcher-button:not([disabled])").waitFor();
      assert.ok(!(await page.evaluate(() => window.launcherRevoked)).includes(originalGrant), "reopening preserves native password entry");
      await page.locator("#connect-codex-manual > summary").click();
      await page.locator("#connect-codex-posix-command").waitFor({ state: "visible" });
      assert.match(await page.locator("#connect-codex-posix-command").innerText(), /codex-connect/);
      await page.locator("#close-connect-codex-button").click();
      // A delayed handoff cannot enable Launch after the actual close click.
      await page.evaluate(() => { window.launcherDelayed = true; });
      await page.locator("#connect-codex-button").click();
      await page.waitForFunction(() => typeof window.finishLauncher === "function");
      await page.locator("#close-connect-codex-button").click();
      await page.evaluate(() => window.finishLauncher());
      await page.waitForFunction(() => window.launcherRevoked.length >= 2);
      assert.ok(!(await page.evaluate(() => window.launcherRevoked)).includes(originalGrant), "closing a later pending request does not revoke the launched grant");
      assert.equal(await page.locator("#open-codex-launcher-button").isDisabled(), true);
      assert.equal(await page.locator("#prepare-codex-launcher-button").isDisabled(), false);
      await page.evaluate(() => { window.launcherDelayed = false; });
      await page.locator("#connect-codex-button").click();
      await page.locator("#open-codex-launcher-button:not([disabled])").waitFor();
      await page.screenshot({ path: `${artifacts}/${name}-${platform}-${new URL(origin).hostname}-launcher.png` });
      console.log(`${name}: ${platform} ${new URL(origin).hostname} pointer flow passed`);
      await context.close();
    }
  }
  for (const [origin, platform] of [["https://gatherthread.cn", "Linux x86_64"], ["http://127.0.0.1:4173", "Win32"]]) {
    const { context, page } = await fixture(origin, "en", platform);
    await page.locator("#connect-codex-button").click();
    assert.equal(await page.locator("#codex-launcher-option").isVisible(), false);
    assert.equal(await page.locator("#connect-codex-manual").evaluate(node => node.open), true);
    assert.doesNotMatch(await page.locator("#connect-codex-summary").innerText(), /Use the Launcher/);
    assert.deepEqual(await page.evaluate(() => window.launcherRequests), [], "unsupported sites/platforms issue no Launcher grant");
    console.log(`${name}: ${platform} ${new URL(origin).hostname} terminal fallback passed`);
    await context.close();
  }
  for (const [platform, width, touch] of [["iPhone", 390, 5], ["MacIntel", 1024, 5]]) {
    const { context, page } = await fixture("https://test.gatherthread.cn", "zh-CN", platform, width, touch);
    assert.equal(await page.locator("#connect-codex-button").isVisible(), false, "mobile/tablet never configures a local connector");
    await page.locator("#mobile-agent-button").click();
    await page.locator("#agent-harness-select").waitFor({ state: "visible" });
    assert.ok(await page.locator('#agent-harness-select option[value="codex"]').count(), "existing computer Agent stays selectable");
    await page.screenshot({ path: `${artifacts}/${name}-${width}-existing-agent.png` });
    console.log(`${name}: ${width}px ${platform} existing-Agent regression passed`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`${name}: 4 desktop launcher pointer flows + 2 terminal fallbacks + phone/tablet existing-Agent regression passed`);
} finally { await browser.close(); }
