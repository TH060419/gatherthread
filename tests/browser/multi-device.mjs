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
            actors.push((await me.json()).data);
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
          await pages[0].locator('#settings-button').click();
          await pages[0].locator('.settings-navigation a[href="#settings-device"]').click();
          await pages[0].locator('#settings-devices-list strong').getByText(longName, { exact: true }).waitFor();
          await pages[0].locator('#settings-devices-refresh').click();
          await pages[0].locator('#settings-devices-refresh').waitFor({ state: 'visible' });
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
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
          pages[0].once('dialog', dialog => dialog.accept());
          await pages[0].locator(`#settings-devices-list button[data-device-id="${actors[1].device_id}"]`).click();
          await pages[0].waitForFunction(() => !document.querySelector('#settings-devices-refresh').disabled);
          assert.equal((await contexts[1].request.get(origin + '/v1/me')).status(), 401);
          assert.equal((await contexts[0].request.get(origin + '/v1/me')).status(), 200);
          assert.equal(await pages[0].locator('#settings-devices-refresh').evaluate(element => element === document.activeElement), true);
          await pages[1].reload(); await pages[1].locator('#auth-view').waitFor({ state: 'visible' });
          assert.deepEqual(errors, []);
          scenarios++;
        } finally { for (const context of contexts) await context.close(); }
      }
    } finally { await browser.close(); }
  }
  console.log(`Chromium/WebKit: ${scenarios} bilingual desktop/mobile concurrent-login, realtime chat, device-revocation and live-language scenarios passed.`);
} finally { await server.close(); }
