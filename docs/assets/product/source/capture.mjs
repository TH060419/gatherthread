// Public, authored example only. Full viewports + separate documentation overlay.
// Run after build:web; the loopback preview must already be serving that build.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scenes } from './annotations.mjs';
import { annotationPage } from './annotation-page.mjs';
const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const product = resolve(root, 'docs/assets/product');
const output = process.env.PRODUCT_CAPTURE_OUTPUT ?? '/tmp/gatherthread-product-captures';
const origin = process.env.ONBOARDING_ORIGIN ?? 'http://127.0.0.1:4173';
assert.equal(new URL(origin).hostname, '127.0.0.1', 'capture uses only a loopback example');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const browser = await chromium.launch();
await mkdir(output, { recursive: true });
async function pageFor(locale, viewport = { width: 1440, height: 1000 }, mobile = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce',
    ...(mobile ? { isMobile: true, hasTouch: true, userAgent: viewport.width >= 768
      ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(`${origin}/app/example.html?locale=${locale}&theme=light&topic=browse&layout=${mobile ? 'mobile' : 'desktop'}`);
  await page.locator('#session-view:not([hidden])').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-mobile-workspace'), String(mobile));
  if (mobile) assert.equal(await page.locator('#connect-codex-button').isVisible(), false, 'actual phone/tablet layout does not offer a local connection');
  await page.evaluate(() => document.fonts.ready);
  return { page, context };
}
async function reveal(page, selector) {
  await page.locator(selector).evaluate(node => {
    const scroller = document.getElementById('timeline-region');
    scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 10;
  });
}
async function code(page) {
  await page.locator('#project-code-button').click();
  await page.locator('#code-provider-gt-cloud').click();
  await page.locator('#code-enabled-content:not([hidden])').waitFor();
}
async function capture(locale, name, page) {
  const viewport = page.viewportSize();
  const points = [];
  for (const point of scenes[name]) {
    const locator = page.locator(point.selector).nth(point.nth);
    assert.equal(await locator.isVisible(), true, `${name}: ${point.selector} visible`);
    const box = await locator.boundingBox();
    // Annotate only the visible intersection, preserving all screenshot pixels.
    const x = Math.max(0, box.x), y = Math.max(0, box.y);
    const right = Math.min(viewport.width, box.x + box.width), bottom = Math.min(viewport.height, box.y + box.height);
    assert.ok(right > x && bottom > y, `${name}: ${point.selector} is in the viewport`);
    points.push({ x, y, width: right - x, height: bottom - y, text: locale === 'zh-CN' ? point.zh : point.en });
  }
  const raw = join(output, `${locale}-${name}.png`);
  await page.screenshot({ path: raw });
  const scene = { name, locale, viewport, points };
  const rendered = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height + 180 }, deviceScaleFactor: Math.min(2, 2400 / viewport.width) });
  await rendered.setContent(annotationPage(scene, `data:image/png;base64,${(await readFile(raw)).toString('base64')}`, locale));
  await rendered.waitForFunction(() => window.__ready === true);
  await rendered.locator('main').screenshot({ path: join(product, locale, 'annotated', `${name}.jpg`), type: 'jpeg', quality: 88 });
  await rendered.close();
  return scene;
}
try {
  for (const locale of ['en', 'zh-CN']) {
    const geometry = [];
    const { page, context } = await pageFor(locale);
    await page.locator('#history-summary-view-button').click(); // all originals for discussion
    await reveal(page, '#message-evt-seed-1');
    geometry.push(await capture(locale, '01-workspace', page));
    geometry.push(await capture(locale, '02-discussion', page));
    await page.locator('#history-summary-view-button').click();
    await reveal(page, '#message-example-summary-response-1');
    geometry.push(await capture(locale, '03-summary', page));
    await reveal(page, '#message-evt-seed-4');
    geometry.push(await capture(locale, '04-agent-work', page));
    await page.locator('#message-evt-seed-4 .message-action').nth(1).click();
    await page.locator('#message-input').fill('@');
    await page.locator('#mention-picker [role=option]').nth(1).click();
    geometry.push(await capture(locale, '05-quote-and-mention', page));
    await page.locator('#mentions-button').click();
    await page.locator('#mentions-list button').first().waitFor();
    geometry.push(await capture(locale, '06-mentions', page));
    await page.keyboard.press('Escape');
    await page.locator('#cancel-message-quote').click();
    await page.locator('#message-input').fill('');
    await code(page);
    geometry.push(await capture(locale, '07-file-service', page));
    await page.locator('#code-open-branches-view').click();
    geometry.push(await capture(locale, '07-file-versions', page));
    await page.locator('#code-branch-list > li').nth(1).getByRole('button').click();
    await page.locator('#code-review-files details').first().waitFor();
    await page.locator('#code-review-files summary').first().click();
    await page.locator('#code-merge-button').evaluate(node => node.scrollIntoView({ block: 'end', behavior: 'instant' }));
    geometry.push(await capture(locale, '08-review-changes', page));
    await page.locator('#close-project-code-button').click();
    await page.locator('#project-code-button').click();
    await page.locator('#cloud-github-edit').click();
    await page.locator('#cloud-github-repository-form:not([hidden])').waitFor();
    geometry.push(await capture(locale, '09-github', page));
    await page.locator('#close-project-code-button').click();
    await page.locator('#settings-button').click();
    await page.locator('.settings-navigation a[href="#settings-summaries"]').click();
    geometry.push(await capture(locale, '10-summary-settings', page));
    await page.locator('#cancel-settings-button').click();
    await page.locator('#settings-dialog[open]').waitFor({ state: 'hidden' });
    await page.locator('#toggle-session-rail-button').click();
    await page.locator('#mobile-members-button').click();
    await reveal(page, '#message-evt-seed-4');
    geometry.push(await capture(locale, '11-focused-workspace', page));
    await page.screenshot({ path: join(product, locale, '11-focused-workspace.jpg'), type: 'jpeg', quality: 88 });
    await page.locator('#example-project-open').click();
    await page.locator('#example-project-version').selectOption('branch-maya');
    await page.frameLocator('#example-project-frame').locator('#signup').click();
    geometry.push(await capture(locale, '14-working-result', page));
    await page.locator('#example-files-tab').click();
    geometry.push(await capture(locale, '16-project-code', page));
    await page.locator('#example-project-close').click();
    await page.locator('.agent-worklog[data-request-id="evt-seed-3"] > summary').click();
    await page.locator('.agent-worklog-section').filter({ has: page.locator('.agent-plan') }).evaluate(node => { node.open = true; });
    await page.locator('#message-example-build-check .agent-worklog-section').evaluate(node => { node.open = true; });
    await reveal(page, '#message-example-build-plan .agent-worklog-section');
    geometry.push(await capture(locale, '17-work-plan', page));
    await page.locator('#session-context-details > summary').click();
    await page.waitForFunction(() => document.querySelector('.session-context-panel').parentElement === document.body);
    await page.waitForFunction(() => ['import-visible-history-button', 'upload-local-turns-button'].every(id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && box.width > 0;
    }));
    geometry.push(await capture(locale, '15-history-controls', page));
    await context.close();
    for (const [name, viewport] of [['12-phone', { width: 390, height: 844 }], ['13-tablet', { width: 820, height: 1180 }]]) {
      const { page: device, context: deviceContext } = await pageFor(locale, viewport, true);
      geometry.push(await capture(locale, name, device));
      if (name === '12-phone') await device.screenshot({ path: join(product, locale, '12-phone.jpg'), type: 'jpeg', quality: 88 });
      await device.locator('#mobile-agent-button').click();
      geometry.push(await capture(locale, `${name}-agent`, device));
      await deviceContext.close();
    }
    await writeFile(join(product, 'source', `capture-geometry.${locale}.json`), JSON.stringify(geometry, null, 2) + '\n');
    for (const [destination, source] of Object.entries({ desktop: '11-focused-workspace', phone: '12-phone', summary: '03-summary', github: '09-github', review: '08-review-changes', work: '04-agent-work' })) {
      const from = join(product, locale, ...(['desktop', 'phone'].includes(destination) ? [] : ['annotated']), `${source}.jpg`);
      const to = join(root, 'site/assets/product', locale, `${destination}.jpg`);
      await copyFile(from, to);
      assert.deepEqual(await readFile(to), await readFile(from), 'homepage uses the identical reviewed capture');
    }
    console.log(`Captured ${geometry.length} full-view scenes: ${locale}`);
  }
  // Reuse the already approved composition; only its real app captures change.
  for (const locale of ['en', 'zh-CN']) {
    for (const name of ['cover', 'collaboration']) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
      await page.goto(pathToFileURL(join(product, 'source', `${name}.${locale}.html`)).href);
      await page.waitForFunction(() => window.__ready === true);
      assert.deepEqual(await page.evaluate(() => window.__assetErrors), []);
      await page.screenshot({ path: join(product, `${name}.${locale}.jpg`), type: 'jpeg', quality: 91 });
      await page.close();
    }
  }
} finally { await browser.close(); }
