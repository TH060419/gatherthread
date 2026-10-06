// Isolated loopback Mock API only. No real account, provider or Agent runs.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
const origin = process.env.AVATAR_UI_ORIGIN ?? "http://127.0.0.1:4368";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname));
const output = resolve(process.env.BROWSER_OUTPUT_DIRECTORY ?? "output/playwright/account-avatars");
await mkdir(output, { recursive: true });
const phoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const cases = [
  { name: "desktop-en", locale: "en", width: 1440, height: 900 },
  { name: "phone-zh", locale: "zh-CN", width: 390, height: 844, mobile: true },
  { name: "tablet-en", locale: "en", width: 820, height: 1180, mobile: true },
];
let passed = 0;
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch({ headless: true, ...(name === "chromium" ? {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  } : {}) });
  try {
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height },
        reducedMotion: "reduce", ...(item.mobile ? { userAgent: phoneUA, hasTouch: true, isMobile: true } : {}) });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await context.addInitScript(locale => {
        localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : get.call(this, key);
        };
      }, item.locale);
      try {
        await page.goto(`${origin}/app/?mock=1`);
        await page.evaluate(async () => {
          const main = document.querySelector('script[type="module"][src*="/main.js"]').src;
          const source = await (await fetch(main)).text();
          const specifier = source.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)[1];
          const { MockCollaborationApi } = await import(new URL(specifier, main).href);
          const { avatarImage } = await import(new URL("./avatars.js", main).href);
          const qa = window.avatarQa = { holdAccount: true, holdProfiles: true, role: null, writes: 0, failSave: false };
          qa.image = avatarImage;
          const proto = MockCollaborationApi.prototype;
          const account = proto.getAccountAvatar, profiles = proto.listAvatarProfiles, members = proto.listMembers, save = proto.setAccountAvatar;
          proto.getAccountAvatar = function (...args) {
            qa.api = this;
            if (!qa.holdAccount) return account.apply(this, args);
            return new Promise(resolve => { qa.releaseAccount = () => resolve(account.apply(this, args)); });
          };
          proto.listAvatarProfiles = function (...args) {
            qa.api = this;
            if (!qa.holdProfiles) return profiles.apply(this, args);
            return new Promise(resolve => { qa.releaseProfiles = () => resolve(profiles.apply(this, args)); });
          };
          proto.listMembers = async function (...args) {
            qa.api = this;
            const result = await members.apply(this, args);
            return result.map(member => qa.role && member.userId === this.currentUser.id ? { ...member, role: qa.role } : member);
          };
          proto.setAccountAvatar = async function (...args) {
            qa.writes += 1;
            if (qa.failSave) throw new Error("Isolated avatar save failure");
            return save.apply(this, args);
          };
        });
        await page.locator("#auth-select-email-login").click();
        await page.locator("#email-login-email").fill("demo@example.invalid");
        await page.locator("#email-login-password").fill("isolated demo password");
        await page.locator("#email-login-form button[type=submit]").click();
        await page.locator("#code-notice-dialog[open]").waitFor();
        await page.locator("#code-notice-continue").click();
        await page.locator("#session-view:not([hidden])").waitFor({ timeout: 5000 });
        await page.waitForFunction(() => document.querySelector("#global-connection-label").textContent.includes("#5"));
        assert.equal(await page.locator("#workspace").getAttribute("data-mobile-ui"), String(Boolean(item.mobile)));
        await page.evaluate(() => {
          avatarQa.holdAccount = avatarQa.holdProfiles = false;
          avatarQa.releaseAccount(); avatarQa.releaseProfiles();
        });
        await page.waitForFunction(() => document.querySelector("#current-user-avatar img")?.getAttribute("src") === avatarQa.image("cat"));

        if (item.mobile) await page.locator("#mobile-tools-button").click();
        await page.locator("#settings-button").click();
        await page.locator('#settings-dialog a[href="#settings-profile"]').click();
        await page.waitForFunction(() => !document.querySelector('#settings-avatar-grid input[value="fox"]').disabled);
        await page.locator('#settings-avatar-grid input[value="fox"]').check();
        assert.equal(await page.evaluate(() => avatarQa.writes), 0);
        await page.waitForFunction(() => document.querySelector("#settings-avatar-preview img")?.getAttribute("src") === avatarQa.image("fox"));
        await page.locator("#settings-avatar-cancel").click();
        await page.waitForFunction(() => document.querySelector("#settings-avatar-preview img")?.getAttribute("src") === avatarQa.image("cat"));
        await page.locator('#settings-avatar-grid input[value="owl"]').check();
        await page.evaluate(() => { avatarQa.failSave = true; });
        await page.locator("#settings-avatar-save").click();
        await page.waitForFunction(() => document.querySelector("#settings-avatar-status").textContent.includes("重试")
          || document.querySelector("#settings-avatar-status").textContent.includes("Try again"));
        assert.equal(await page.locator("#settings-avatar-save").isEnabled(), true);
        await page.evaluate(() => { avatarQa.failSave = false; });
        await page.locator("#settings-avatar-save").click();
        await page.waitForFunction(() => document.querySelector("#current-user-avatar img")?.getAttribute("src") === avatarQa.image("owl"));
        await page.locator("#close-settings-button").click();
        await page.waitForFunction(() => [...document.querySelectorAll(".event-agent_response .avatar-agent-badge img")].length > 0);
        assert.ok(await page.locator(".event-agent_response .event-identity strong").first().textContent());

        await page.evaluate(() => { avatarQa.holdProfiles = true; avatarQa.role = "viewer"; });
        await page.waitForFunction(() => document.querySelector("#send-chat-button").disabled, { timeout: 8000 });
        // The member endpoint has applied the role while the avatar read is still pending.
        assert.equal(await page.locator("#send-agent-button").isDisabled(), true);
        await page.evaluate(() => { avatarQa.holdProfiles = false; avatarQa.releaseProfiles(); });
        await page.waitForFunction(() => document.querySelector("#current-user-avatar img")?.getAttribute("src") === avatarQa.image("owl"));
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `${output}/${name}-${item.name}.png` });
        passed += 1;
      } catch (error) {
        await page.screenshot({ path: `${output}/${name}-${item.name}-failure.png` }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
console.log(`${passed} isolated bilingual Chromium/WebKit avatar scenarios passed.`);
