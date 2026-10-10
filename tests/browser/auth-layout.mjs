// Loopback fixtures only: no real emails, Turnstile checks, accounts or model calls.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import { TestGateStore } from "../../apps/server/dist/src/test-gate.js";

// Run after build:ts and build:web. Follows the existing standalone browser suites.
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
const reserve = createServer(); await new Promise(done => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port; await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`;
const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-auth-layout-")));
const gate = { databasePath: join(directory, "gate.sqlite"), pepper: randomBytes(32).toString("hex"), origin };
const admin = new TestGateStore(gate), grant = admin.issue(1, 1)[0];
const registration = { enabled: true, recoveryEnabled: true, origin, siteKey: "fixture",
  challenge: { async verify() { return true; } }, mailer: { async send() {}, async notifyPasswordChanged() {} } };
const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: randomBytes(32).toString("hex"),
  registration, testGate: gate, staticDirectory: resolve("apps/web/dist"), publicBaseUrl: origin, allowedOrigins: [origin] }, port);
const output = resolve(process.env.BROWSER_OUTPUT_DIRECTORY ?? "output/playwright/auth-layout");
mkdirSync(output, { recursive: true });
const sizes = [[1440, 900], [1440, 560], [1280, 820], [1024, 768], [820, 1180], [390, 844], [320, 568]];
let passed = 0;

async function scrollAndClick(page, selector) {
  const target = page.locator(selector);
  // Scroll with the ordinary page, then check pointer hit-testing before clicking.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1, `${selector} must fit in the viewport`);
  assert.ok(await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), `${selector} must be a real pointer target`);
  await target.click(); // Never force clicks or substitute Enter for pointer coverage.
}

try {
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch({ headless: true, ...(name === "chromium" && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    try {
      let admissionCookies = null;
      for (const [width, height] of sizes) for (const locale of ["en", "zh-CN"]) {
        const context = await browser.newContext({ viewport: { width, height }, locale, reducedMotion: "reduce" });
        // Reuse only the isolated fixture admission, not an account session. This keeps
        // the layout matrix below the real admission-IP budget without changing it.
        if (admissionCookies) await context.addCookies(admissionCookies);
        const page = await context.newPage(), errors = [], submissions = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(locale => {
          localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
          window.turnstile = {
            render(container, options) {
              // Real compact-widget footprint, including its full 200px height.
              const box = document.createElement("div");
              box.style.cssText = "width:200px;height:200px;border:1px solid #ccc;display:grid;place-items:center";
              box.textContent = "Security check · fixture"; container.replaceChildren(box);
              queueMicrotask(() => options.callback(`fixture-${crypto.randomUUID()}`)); return container;
            }, remove(container) { container?.replaceChildren(); }, reset() {},
          };
        }, locale);
        // Test the actual production form logic with deterministic, provider-free receipts.
        await page.route("**/v1/registration/send", route => route.fulfill({ status: 202, contentType: "application/json",
          body: JSON.stringify({ data: { registration_id: randomUUID(), expires_in_seconds: 600, resend_after_seconds: 60 } }) }));
        await page.route("**/v1/password-reset/send", route => route.fulfill({ status: 202, contentType: "application/json",
          body: JSON.stringify({ data: { reset_id: randomUUID(), expires_in_seconds: 600, resend_after_seconds: 60 } }) }));
        const verify = route => {
          submissions.push(route.request().postDataJSON());
          return route.fulfill({ status: 400, contentType: "application/json",
            body: JSON.stringify({ error: { code: "registration_invalid", message: "Isolated fixture" } }) });
        };
        await page.route("**/v1/registration/verify", verify);
        await page.route("**/v1/password-reset/verify", verify);
        try {
          const initialized = page.waitForResponse(response => response.url() === `${origin}/v1/me` && response.status() === 401);
          await page.goto(`${origin}/app/`);
          if (!admissionCookies) {
            await page.locator("#admission-code").fill(grant.admission_code);
            await page.locator("#enter").click();
          }
          await initialized;
          if (!admissionCookies) {
            admissionCookies = (await context.cookies()).filter(cookie => cookie.name.includes("gatherthread_test_gate"));
            assert.equal(admissionCookies.length, 1);
          }
          await page.locator("#auth-select-register").waitFor();
          await page.waitForFunction(() => document.querySelector("#test-environment-banner").getBoundingClientRect().height
            <= parseFloat(getComputedStyle(document.body).paddingTop));
          for (const prefix of ["registration", "password-reset"]) {
            if (prefix === "registration") {
              await page.locator("#auth-select-register").click();
              await page.locator("#auth-register-panel").waitFor({ state: "visible" });
              await page.locator("#claim-display-name").fill("Fixture tester");
              await page.locator("#claim-device-name").fill("Fixture browser");
            }
            else {
              await page.locator("#auth-register-panel .auth-entry-back").click();
              await page.locator("#auth-select-email-login").click();
              await page.locator("#auth-select-password-reset").click();
            }
            await page.locator(`#${prefix}-email`).fill("fixture@example.invalid");
            await page.locator(`#${prefix}-privacy`).check();
            assert.equal(await page.locator(`#${prefix}-privacy`).evaluate(node => node.getBoundingClientRect().height), 18);
            await scrollAndClick(page, `#${prefix}-send`);
            await page.locator(`#${prefix}-code-step`).waitFor({ state: "visible" });
            for (const suffix of ["password", "password-confirm"]) {
              assert.equal(await page.locator(`#${prefix}-${suffix}`).getAttribute("minlength"), "8");
              await page.locator(`#${prefix}-${suffix}`).fill("short12");
            }
            await page.locator(`#${prefix}-code`).fill("12345678");
            const before = submissions.length;
            await scrollAndClick(page, `#${prefix}-verify`);
            await page.waitForFunction(id => document.getElementById(id).textContent.length > 0, `${prefix}-error`);
            assert.equal(submissions.length, before, "Seven characters must fail before an API call");
            for (const suffix of ["password", "password-confirm"]) await page.locator(`#${prefix}-${suffix}`).fill("fixture8");
            await scrollAndClick(page, `#${prefix}-verify`);
            await page.waitForFunction(id => document.getElementById(id).textContent.includes(document.documentElement.lang === "zh-CN"
              ? "验证码" : "code"), `${prefix}-error`);
            assert.equal(submissions.length, before + 1, "Eight characters must reach the verification API");
            assert.equal(submissions.at(-1).password, "fixture8");
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
            assert.ok(await page.locator(".login-panel").evaluate(element => element.querySelector(".auth-privacy-link").getBoundingClientRect().bottom
              <= element.getBoundingClientRect().bottom), "The card must grow with its content, not clip or shrink it");
            // Screenshot only cleared fixture fields; no real account data or capabilities.
            await page.locator(`#${prefix}-email`).evaluate(element => { element.value = ""; });
            if (prefix === "registration" && width === 1440 && height === 900) {
              await page.evaluate(() => window.scrollTo(0, 0));
              await page.screenshot({ path: join(output, `${name}-${locale}-registration.png`), fullPage: true });
            }
          }
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: join(output, `${name}-${width}x${height}-${locale}.png`), fullPage: true });
          assert.deepEqual(errors, []);
          passed += 1;
          if (locale === "zh-CN") console.log(`${name}: ${width}x${height} pointer/scroll/password checks passed`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  console.log(`PASS: ${passed} bilingual Chromium/WebKit layouts; long registration/recovery forms, real pointer submits, test banner, 7/8-character boundaries.`);
} finally {
  await server.close(); admin.close(); rmSync(directory, { recursive: true, force: true });
}
