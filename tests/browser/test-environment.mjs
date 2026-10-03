import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { startCollaborationServer } from '../../apps/server/dist/src/server.js';
import { TestGateStore } from '../../apps/server/dist/src/test-gate.js';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? 'playwright');
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gt-admission-browser-')));
const gate = { databasePath: join(directory, 'admission.sqlite'), pepper: randomBytes(32).toString('hex'), origin };
const admin = new TestGateStore(gate), grant = admin.issue(1, 1)[0];
const emailAccounts = existsSync(new URL('../../apps/server/dist/src/registration.js', import.meta.url));
const mails = [];
const registration = { enabled: true, recoveryEnabled: true, origin, siteKey: 'fixture', challenge: { async verify() { return true; } },
  mailer: { async send(mail) { mails.push(mail); }, async notifyPasswordChanged() {} } };
const server = await startCollaborationServer({ databasePath: ':memory:', authTokenPepper: randomBytes(32).toString('hex'),
  staticDirectory: resolve('apps/web/dist'), publicBaseUrl: origin, allowedOrigins: [origin], testGate: gate, ...(emailAccounts ? { registration } : {}) }, port);
const output = resolve(process.env.BROWSER_OUTPUT_DIRECTORY ?? '.local/test-environment-browser'); mkdirSync(output, { recursive: true });
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, ...(name === "chromium" ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? engine.executablePath() } : {}) });
    try {
      for (const [width, height] of [[1440, 900], [390, 844]]) for (const locale of ['en', 'zh-CN']) {
        const context = await browser.newContext({ viewport: { width, height }, locale });
        const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => { window.turnstile = { render(_container, options) { queueMicrotask(() => options.callback(`fixture-challenge-${crypto.randomUUID()}`)); return 'fixture-widget'; }, remove() {}, reset() {} }; });
        await page.goto(origin + '/app/#settings-account'); await page.locator('#admission-code').waitFor();
        assert.equal(await page.locator('#auth-view').count(), 0);
        try { await page.locator('#test-environment-banner').waitFor({ state: "visible", timeout: 8000 }); } catch (error) { console.error(JSON.stringify({errors, scripts: await page.locator('script').evaluateAll(elements => elements.map(element => element.src))})); throw error; }
        assert.equal(await page.locator('#test-environment-banner').isVisible(), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const selectedLocale = locale === 'en' ? 'zh-CN' : 'en';
        await page.locator('#language').click();
        await page.waitForFunction(selected => document.documentElement.lang === selected, selectedLocale);
        assert.equal(await page.evaluate(() => localStorage.getItem('gt-lang')), selectedLocale === 'zh-CN' ? 'zh' : 'en');
        await page.screenshot({ path: join(output, `${name}-gate-${width}-${locale}.png`), fullPage: true });
        await page.locator('#admission-code').focus(); await page.keyboard.press(name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
        assert.equal(await page.locator('#enter').evaluate(element => element === document.activeElement), true);
        if (width === 1440 && locale === 'en') {
          await page.locator('#admission-code').fill('unavailable-fixture'); await page.locator('#enter').click();
          await page.waitForFunction(() => document.querySelector('#feedback').textContent.length > 0);
          assert.equal(await page.locator('#admission-code').inputValue(), '');
        }
        await page.locator('#admission-code').fill(grant.admission_code); await page.locator('#enter').click();
        await page.waitForURL('**/app/#settings-account');
        if (emailAccounts) {
          await page.locator('#auth-select-register').waitFor();
          // One gate switch must carry into sign-in without a compensating app switch.
          await page.waitForFunction(selected => document.documentElement.lang === selected, selectedLocale);
          const gateTab = await context.newPage(); gateTab.on('pageerror', error => errors.push(error.message));
          await gateTab.goto(origin + '/test-gate/index.html');
          await gateTab.waitForFunction(selected => document.documentElement.lang === selected, selectedLocale);
          // Changing the shared preference in the app updates an already open gate tab.
          await page.locator('#auth-language-button').click();
          await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
          await gateTab.waitForFunction(locale => document.documentElement.lang === locale, locale);
          await gateTab.reload(); await gateTab.waitForFunction(locale => document.documentElement.lang === locale, locale);
          await gateTab.close();
          assert.match(await page.locator('#test-environment-banner').textContent(), locale === 'zh-CN' ? /测试环境/ : /Test environment/);
          if (width === 1440 && locale === 'en') {
            await page.locator('#auth-select-register').click();
            await page.locator('#claim-display-name').fill('Fixture tester'); await page.locator('#claim-device-name').fill('Fixture browser');
            const email = `${randomUUID()}@example.invalid`, password = 'browser fixture account password';
            await page.locator('#registration-email').fill(email); await page.locator('#registration-privacy').check();
            const sendResponse = page.waitForResponse(response => response.url().endsWith('/v1/registration/send') && response.request().method() === 'POST');
            await page.locator('#registration-send').click();
            const sent = await sendResponse;
            assert.equal(sent.status(), 202, `${name} registration send failed (${await page.locator('#registration-error').textContent()})`);
            await page.locator('#registration-code-step').waitFor({ state: 'visible' });
            await page.locator('#registration-password').fill(password); await page.locator('#registration-password-confirm').fill(password); await page.locator('#registration-code').fill(mails.at(-1).code);
            await page.locator('#registration-form button[type="submit"]').click();
            await page.locator('#auth-view').waitFor({ state: 'hidden' });
            await page.locator('#code-notice-dialog').waitFor({ state: 'visible' });
            await page.locator('#code-notice-continue').click();
            await page.locator('.onboarding-example-dialog').waitFor({ state: 'visible' });
            await page.frameLocator('.onboarding-example-dialog iframe').getByRole('button', { name: /Exit example|退出示例/ }).click();
            await page.locator('.onboarding-example-dialog').waitFor({ state: 'hidden' });
            await page.reload(); await page.locator('#auth-view').waitFor({ state: 'hidden' });
          }
        } else { await page.getByText('账号系统准备中').waitFor(); }
        const cookies = await context.cookies(); const admission = cookies.find(cookie => cookie.name === 'gatherthread_test_gate');
        assert.ok(admission?.httpOnly); assert.equal(admission.sameSite, 'Strict');
        assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => /gteg?_/.test(value))), false);
        assert.equal(await page.evaluate(() => document.cookie.includes('gatherthread_test_gate')), false);
        assert.deepEqual(errors, []);
        await page.waitForFunction(() => parseFloat(getComputedStyle(document.body).paddingTop) >= document.querySelector('#test-environment-banner').getBoundingClientRect().height);
        // Screenshots are taken only after inputs have been cleared and contain no credentials.
        await page.screenshot({ path: join(output, `${name}-${width}-${locale}.png`), fullPage: true });
        await page.locator('#test-environment-banner button').click(); await page.locator('#admission-code').waitFor();
        await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
        await page.reload(); await page.locator('#admission-code').waitFor();
        await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
        const api = await context.request.get(origin + '/v1/me'); assert.equal(api.status(), 403);
        await context.close();
      }
      for (const [locale, stored] of [['en', 'zh'], ['zh-CN', 'en']]) {
        const context = await browser.newContext({ locale }), page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/app/');
        await page.evaluate(value => localStorage.setItem('gt-lang', value), stored);
        await page.reload(); await page.locator('#admission-code').waitFor();
        const expected = stored === 'zh' ? 'zh-CN' : 'en';
        await page.waitForFunction(locale => document.documentElement.lang === locale, expected);
        await page.locator('#admission-code').fill(grant.admission_code); await page.locator('#enter').click();
        await page.locator('#auth-select-register').waitFor();
        await page.waitForFunction(locale => document.documentElement.lang === locale, expected);
        await page.locator('#test-environment-banner button').click(); await page.locator('#admission-code').waitFor();
        await page.waitForFunction(locale => document.documentElement.lang === locale, expected);
        assert.deepEqual(errors, []); await context.close();
      }
      const restricted = await browser.newContext({ locale: 'en' }), restrictedPage = await restricted.newPage(), errors = [];
      restrictedPage.on('pageerror', error => errors.push(error.message));
      await restrictedPage.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true,
        get() { throw new DOMException('Fixture storage restriction', 'SecurityError'); } }));
      await restrictedPage.goto(origin + '/app/'); await restrictedPage.locator('#admission-code').waitFor();
      await restrictedPage.locator('#language').click();
      await restrictedPage.waitForFunction(() => document.documentElement.lang === 'zh-CN');
      await restrictedPage.locator('#admission-code').fill('unavailable-fixture'); await restrictedPage.locator('#enter').click();
      await restrictedPage.waitForFunction(() => document.querySelector('#feedback').textContent.includes('代码不可用'));
      assert.deepEqual(errors, []); await restricted.close();
    } finally { await browser.close(); }
  }
  console.log(`Chromium/WebKit: 8 bilingual desktop/mobile admission and single-switch cross-entry/tab/refresh flows, 4 existing language preference flows and 2 restricted-storage flows passed; ${emailAccounts ? 'mock email registration/session restoration' : 'dependency pending-page'} checks passed.`);
} finally { await server.close(); admin.close(); rmSync(directory, { recursive: true, force: true }); }
