import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { startCollaborationServer } from '../../apps/server/dist/src/server.js';

// Run after npm run build. All mail/security/model interactions are isolated fixtures.
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? 'playwright');
const reserve = createServer();
await new Promise(done => reserve.listen(0, '127.0.0.1', done));
const port = reserve.address().port;
await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`, mails = [];
const registration = { enabled: true, origin, siteKey: 'fixture', challenge: { async verify() { return true; } },
  mailer: { async send(mail) { mails.push(mail); } } };
const server = await startCollaborationServer({ databasePath: ':memory:', authTokenPepper: randomBytes(32).toString('hex'),
  registration, staticDirectory: resolve('apps/web/dist'), publicBaseUrl: origin, allowedOrigins: [origin], heartbeatIntervalMs: 100 }, port);
const output = resolve(process.env.BROWSER_OUTPUT_DIRECTORY ?? 'output/playwright/multi-device');
mkdirSync(output, { recursive: true });
let scenarios = 0;
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, ...(name === 'chromium'
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? engine.executablePath() } : {}) });
    try {
      for (const [width, height] of [[1440, 900], [390, 844]]) for (const locale of ['en', 'zh-CN']) {
        const email = `${randomUUID()}@example.invalid`, password = 'isolated browser multi device password';
        const marker = randomUUID();
        const sent = await server.database.registration.send({ email, locale: 'en', challenge_token: randomUUID(),
          idempotency_key: randomUUID() }, marker, randomUUID(), registration);
        const account = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id,
          code: mails.at(-1).code, display_name: 'Multi-device tester', device_name: 'Initial browser',
          remember_device: false, password, privacy_acknowledged: true }, marker, randomUUID(), registration);
        const project = server.service.createProject(account.actor, { title: 'Shared device project', idempotency_key: randomUUID() });
        const session = server.service.createSession(account.actor, { project_id: project.id, mode: 'multi', title: 'Shared conversation', idempotency_key: randomUUID() });
        const contexts = [], pages = [], actors = [], errors = [];
        try {
          for (const viewport of [{ width, height }, { width: width === 390 ? 1440 : 390, height: width === 390 ? 900 : 844 }]) {
            const context = await browser.newContext({ viewport, locale, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 }); contexts.push(context);
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(value => { if (window.top === window) localStorage.setItem('gt-lang', value === 'zh-CN' ? 'zh' : 'en'); }, locale);
            await page.goto(`${origin}/app/#project=${project.id}&session=${session.id}`);
            await page.locator('#auth-select-email-login').click();
            await page.locator('#email-login-form').getByText(locale === 'zh-CN'
              ? '电脑、手机和平板可登录同一个账号，同时保持在线。' : 'Sign in with the same account on your computer, phone or tablet. Devices can stay signed in together.').waitFor();
            await page.locator('#email-login-email').fill(email);
            await page.locator('#email-login-password').fill(password);
            await page.locator('#email-login-form button[type="submit"]').click();
            await page.locator('#auth-view').waitFor({ state: 'hidden' });
            await page.locator('#code-notice-dialog').waitFor({ state: 'visible' });
            await page.locator('#code-notice-continue').click();
            await page.locator('.onboarding-example-dialog').waitFor({ state: 'visible' });
            await page.frameLocator('.onboarding-example-dialog iframe').getByRole('button', { name: /Exit example|退出示例/ }).click();
            await page.locator('.onboarding-example-dialog').waitFor({ state: 'hidden' });
            const me = await context.request.get(origin + '/v1/me'); assert.equal(me.status(), 200);
            const actor = (await me.json()).data;
            actors.push({ user_id: actor.id, device_id: actor.device_id });
          }
          assert.equal(actors[0].user_id, actors[1].user_id);
          assert.notEqual(actors[0].device_id, actors[1].device_id);
          const message = `Both devices are live ${randomUUID()}`;
          await pages[0].locator('#message-input').fill(message);
          await pages[0].locator('#send-chat-button').click();
          await pages[1].getByText(message, { exact: true }).waitFor();
          const longName = '<Phone> ' + '设备名称'.repeat(24);
          const renamed = await contexts[1].request.patch(`${origin}/v1/devices/${actors[1].device_id}`,
            { headers: { origin }, data: { name: longName } }); assert.equal(renamed.status(), 200);
          if (!await pages[0].locator('#settings-button').isVisible()) await pages[0].locator('#mobile-tools-button').click();
          await pages[0].locator('#settings-button').click();
          await pages[0].locator('.settings-navigation a[href="#settings-device"]').click();
          await pages[0].locator('#settings-devices-list strong').getByText(longName, { exact: true }).waitFor();
          await pages[0].locator('#settings-devices-refresh').focus();
          await pages[0].locator('#settings-devices-refresh').press('Enter');
          await pages[0].locator('#settings-devices-refresh').waitFor({ state: 'visible' });
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
          assert.equal(await pages[0].locator('#settings-devices-refresh').evaluate(element => element === document.activeElement), true);
          assert.equal(await pages[0].locator(`#settings-devices-list button[data-device-id="${actors[0].device_id}"]`).count(), 0);
          assert.ok(await pages[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          assert.ok(await pages[0].locator('#settings-devices-list').evaluate(element => element.scrollWidth <= element.clientWidth));
          await pages[0].screenshot({ path: join(output, `${name}-${width}-${locale}.png`), fullPage: true });
          await pages[0].locator('#settings-devices-list .account-device-row:last-child').scrollIntoViewIfNeeded();
          await pages[0].screenshot({ path: join(output, `${name}-${width}-${locale}-list.png`), fullPage: true });
          // Existing rows must follow a language change without reopening settings.
          const nextLocale = locale === 'en' ? 'zh-CN' : 'en';
          await pages[0].locator('#settings-locale').selectOption(nextLocale);
          await pages[0].waitForFunction(expected => document.querySelector('#settings-devices-title').textContent === expected,
            nextLocale === 'zh-CN' ? '账号下的设备' : 'Your account devices');
          assert.match(await pages[0].locator('#settings-devices-list').textContent(), nextLocale === 'zh-CN' ? /此浏览器/ : /This browser/);
          // Failed HTTP actions must keep an enabled keyboard retry target.
          const refresh = pages[0].locator('#settings-devices-refresh');
          const fail = route => route.fulfill({ status: 503, contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'fixture_failure', message: 'Isolated fixture failure' } }) });
          await pages[0].route(`${origin}/v1/devices`, fail);
          const failedRefresh = pages[0].waitForResponse(response => response.url() === `${origin}/v1/devices` && response.status() === 503);
          await refresh.focus(); await refresh.press('Enter'); await failedRefresh;
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
          assert.equal(await refresh.evaluate(element => element === document.activeElement), true);
          assert.equal(await pages[0].locator('#settings-devices-status').textContent(), nextLocale === 'zh-CN'
            ? '无法加载账号设备，请刷新后重试。' : 'Unable to load account devices. Refresh and try again.');
          await pages[0].unroute(`${origin}/v1/devices`, fail);
          const reloaded = pages[0].waitForResponse(response => response.url() === `${origin}/v1/devices` && response.status() === 200);
          await refresh.press('Enter'); await reloaded;
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
          const revoke = pages[0].locator(`#settings-devices-list button[data-device-id="${actors[1].device_id}"]`);
          const revokeUrl = `${origin}/v1/devices/${actors[1].device_id}`;
          await pages[0].route(revokeUrl, fail);
          const failedRevoke = pages[0].waitForResponse(response => response.url() === revokeUrl && response.status() === 503);
          pages[0].once('dialog', dialog => dialog.accept());
          await revoke.focus(); await revoke.press('Enter'); await failedRevoke;
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
          assert.equal(await revoke.evaluate(element => element === document.activeElement), true);
          assert.equal(await pages[0].locator('#settings-devices-status').textContent(), nextLocale === 'zh-CN'
            ? '未能撤销设备访问权限，请刷新后重试。' : 'Could not revoke device access. Refresh and try again.');
          assert.equal((await contexts[1].request.get(origin + '/v1/me')).status(), 200);
          await pages[0].unroute(revokeUrl, fail);
          pages[0].once('dialog', dialog => dialog.accept());
          await revoke.press('Enter');
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
          assert.equal((await contexts[1].request.get(origin + '/v1/me')).status(), 401);
          assert.equal((await contexts[0].request.get(origin + '/v1/me')).status(), 200);
          assert.equal(await pages[0].locator('#settings-devices-refresh').evaluate(element => element === document.activeElement), true);
          await pages[1].reload(); await pages[1].locator('#auth-view').waitFor({ state: 'visible' });
          // A successful action must not steal focus moved during its request.
          const initialRevokeUrl = `${origin}/v1/devices/${account.actor.device_id}`;
          let releaseRevoke, enteredRevoke;
          const revokeEntered = new Promise(resolve => { enteredRevoke = resolve; });
          await pages[0].route(initialRevokeUrl, async route => {
            await new Promise(resolve => { releaseRevoke = resolve; enteredRevoke(); });
            await route.continue();
          });
          const revokedInitial = pages[0].waitForResponse(response => response.url() === initialRevokeUrl
            && response.request().method() === 'DELETE' && response.status() === 204);
          const initialRevoke = pages[0].locator(`#settings-devices-list button[data-device-id="${account.actor.device_id}"]`);
          pages[0].once('dialog', dialog => dialog.accept());
          await initialRevoke.focus(); await initialRevoke.press('Enter'); await revokeEntered;
          const localeSelect = pages[0].locator('#settings-locale'); await localeSelect.focus();
          releaseRevoke(); await revokedInitial;
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
          assert.equal(await localeSelect.evaluate(element => element === document.activeElement), true);
          assert.equal((await contexts[0].request.get(origin + '/v1/me')).status(), 200);
          assert.deepEqual(errors, []);
          scenarios++;
        } finally { for (const context of contexts) await context.close(); }
      }
    } finally { await browser.close(); }
  }
  console.log(`Chromium/WebKit: ${scenarios} bilingual desktop/mobile concurrent-login, realtime chat, device-revocation, keyboard retry and live-language scenarios passed.`);
} finally { await server.close(); }
