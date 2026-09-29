// Disposable mock-only browser checks; never contacts GitHub or a real runtime.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const browserName = process.env.GITHUB_BROWSER ?? 'chrome';
const browser = browserName === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: browserName });
const origin = process.env.GITHUB_WEB_ORIGIN ?? 'http://127.0.0.1:4188';
const errors = [];
try {
  for (const [locale, width] of [['en', 1440], ['zh-CN', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://github.com/**', (route) => route.abort());
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('gatherthread.onboarding.')) return 'skipped';
        if (key.startsWith('gatherthread.code-notice.')) return 'seen';
        return get.call(this, key);
      };
    });
    await page.goto(`${origin}/app/?mock=1`);
    if (locale === 'zh-CN') await page.locator('#auth-language-button').click();
    await page.locator('#auth-select-login').click();
    await page.locator('#token').fill('demo-token');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#session-view:not([hidden])').waitFor();
    await page.locator('#project-code-button').click();
    await page.locator('#github-code-form:not([hidden])').waitFor();
    assert.equal(await page.locator('#github-code-title').innerText(), locale === 'en' ? 'GitHub · larger or long-term projects' : 'GitHub · 推荐较大或长期项目');
    await page.locator('#github-code-repository').fill('example-team/demo');
    await page.locator('#github-code-base').fill('main');
    await page.locator('#github-code-save').click();
    await page.locator('#code-confirm-accept').click();
    await page.locator('#github-code-device:not([hidden])').waitFor();
    assert.equal(await page.locator('#github-code-files').getAttribute('href'), 'https://github.com/example-team/demo/tree/main');
    assert.equal(await page.locator('#github-code-upload').isDisabled(), true);
    await page.locator('#github-code-runtime').selectOption('runtime-codex-session-orbit');
    await page.waitForFunction(() => !document.querySelector('#github-code-upload').disabled);
    await page.locator('#github-code-auth').click();
    await page.locator('#code-confirm-accept').click();
    await page.waitForFunction(() => document.querySelector('#github-code-auth').textContent.includes('signed in') || document.querySelector('#github-code-auth').textContent.includes('已登录'));
    assert.equal(await page.locator('#github-code-auto').isChecked(), true, 'GitHub auto-upload defaults on after local authorization');
    await page.locator('#github-code-auto').click();
    await page.waitForFunction(() => !document.querySelector('#github-code-auto').checked);
    await page.locator('#github-code-auto').click();
    await page.locator('#code-confirm-accept').click();
    await page.waitForFunction(() => document.querySelector('#github-code-auto').checked && !document.querySelector('#github-code-auto').disabled);
    await page.locator('#github-code-pause').click();
    await page.locator('#code-confirm-accept').click();
    await page.waitForFunction(() => document.querySelector('#github-code-pause').textContent.includes('Resume') || document.querySelector('#github-code-pause').textContent.includes('恢复'));
    await page.locator('#github-code-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#github-code-auto').disabled);
    assert.equal(await page.locator('#github-code-upload').isDisabled(), true);
    await page.locator('#github-code-auto').click();
    await page.waitForFunction(() => !document.querySelector('#github-code-auto').checked);
    await page.locator('#github-code-guide summary').click();
    const overflow = await page.locator('#project-code-dialog').evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    assert.equal(overflow, false, `dialog fits viewport ${width}`);
    await page.locator('#github-code-repository').focus();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'github-code-base');
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'github-code-save');
    await page.screenshot({ path: `/tmp/github-sync-${browserName}-${locale}.png` });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#project-code-dialog').evaluate((node) => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'project-code-button');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`${browserName}: EN desktop / ZH mobile GitHub bind, exact runtime, auto-upload, pause, safe links, keyboard and layout passed.`);
} finally { await browser.close(); }
