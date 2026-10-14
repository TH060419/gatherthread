// Only authored, isolated examples. No account, runtime or provider is used.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const origin = process.env.ONBOARDING_ORIGIN ?? 'http://127.0.0.1:4173';
const artifacts = process.env.ONBOARDING_ARTIFACTS ?? '/tmp/gatherthread-example-project';
await mkdir(artifacts, { recursive: true });
const name = process.env.ONBOARDING_BROWSER ?? 'chromium';
const browser = await (name === 'webkit' ? webkit : chromium).launch();
try {
  for (const locale of ['en', 'zh-CN']) for (const [width, height] of [[1440, 900], [390, 844], [320, 568], [820, 1180]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) remote.push(request.url()); });
    await page.goto(`${origin}/app/example.html?locale=${locale}&topic=browse&layout=${width <= 820 ? 'mobile' : 'desktop'}`);
    await page.locator('#session-view:not([hidden])').waitFor();
    await page.locator('#example-project-open').click();
    const dialog = page.locator('#example-project-dialog[open]');
    await dialog.waitFor();
    const preview = page.frameLocator('#example-project-frame');
    await preview.locator('#signup').click();
    assert.equal(await preview.locator('#signup').isDisabled(), true);
    assert.equal(await preview.locator('#confirmation').innerText(), locale === 'zh-CN' ? '报名成功。' : 'You’re signed up.');
    await page.locator('#example-files-tab').click();
    assert.equal(await page.locator('#example-file-list button').count(), 6);
    assert.match(await page.locator('#example-source-code').innerText(), /addEventListener/);
    await page.locator('[data-path="index.html"]').click();
    assert.match(await page.locator('#example-source-code').innerText(), /src\/signup.js/);
    await page.locator('[data-path="src/signup.js"]').click();
    await page.screenshot({ path: `${artifacts}/${name}-${locale}-${width}-code.png` });
    await page.locator('#example-project-version').selectOption('branch-maya');
    await page.waitForFunction(() => document.querySelector('#example-source-code').textContent.includes('周六见') || document.querySelector('#example-source-code').textContent.includes('See you Saturday'));
    await page.locator('#example-preview-tab').click();
    await preview.locator('#signup').click();
    assert.match(await preview.locator('#confirmation').innerText(), locale === 'zh-CN' ? /周六见/ : /See you Saturday/);
    const isolated = await preview.locator('body').evaluate(() => { try { void parent.document.body; return false; } catch { return true; } });
    assert.equal(isolated, true, 'executed demo cannot read the application');
    await page.screenshot({ path: `${artifacts}/${name}-${locale}-${width}-result.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#example-project-close').click();
    await page.locator('#example-project-open').click();
    await preview.locator('#signup').waitFor();
    assert.equal(await preview.locator('#confirmation').isVisible(), false, 'reopening resets the executed page');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(remote, [], 'no external model, image, font or account access');
    console.log(`${name}: ${locale} ${width}x${height} source, result, version and isolation passed`);
    await context.close();
  }
} finally { await browser.close(); }
