// Run against the built, local mock preview. No real account or assistant is used.
// PLAYWRIGHT_MODULE may point at an existing Playwright installation.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const origin = process.env.ONBOARDING_ORIGIN ?? 'http://127.0.0.1:4173';
const artifacts = process.env.ONBOARDING_ARTIFACTS ?? '/tmp/gatherthread-onboarding';
await mkdir(artifacts, { recursive: true });
const errors = [];
const browserName = process.env.ONBOARDING_BROWSER ?? 'chrome';
const browser = browserName === 'webkit' ? await webkit.launch() : await chromium.launch({ headless: true, channel: browserName });
const popup = '.onboarding-popover';
const next = '.driver-popover-next-btn';
async function settle(page) { await page.waitForTimeout(90); }
async function assertCard(page) {
  await page.locator(popup).waitFor(); await settle(page);
  const box = await page.locator(popup).boundingBox(); const size = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, JSON.stringify(box));
  assert.equal(await page.evaluate(() => document.querySelector('.onboarding-popover')?.contains(document.activeElement)), true, 'focus stays in guide');
}
async function launchPage({ locale = 'en', width = 1440, height = 900, fixture = 'normal', user = 'user-avery', device = 'device-demo', deniedStorage = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale, reducedMotion: 'reduce' });
  const page = await context.newPage();
  if (deniedStorage) await page.addInitScript(() => {
    for (const name of ['getItem', 'setItem']) {
      const original = Storage.prototype[name];
      Storage.prototype[name] = function (key, ...args) {
        if (key.startsWith('gatherthread.onboarding.')) throw new DOMException('Storage denied', 'SecurityError');
        return original.call(this, key, ...args);
      };
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/app/?mock=1`);
  await page.evaluate(async ({ locale, fixture, user, device }) => {
    if (locale === 'zh-CN') document.querySelector('#auth-language-button').click();
    window.guideWrites = [];
    const { MockCollaborationApi } = await import('./src/api.js?v=20260927-1');
    const proto = MockCollaborationApi.prototype;
    const auth = proto.authenticate;
    proto.authenticate = async function (...args) { const actor = await auth.apply(this, args); return { ...actor, id: user, device_id: device }; };
    for (const name of ['appendHumanChat','appendAgentRequest','createHistorySummary','createSnapshotRequest','createProject','createSession','mutateProjectCode','clearOwnCodeBranch','clearProjectCode','setProjectMemberRole','createInvitation','acceptInvitation','setProjectContextPolicy']) {
      const fn = proto[name];
      proto[name] = function (...args) { window.guideWrites.push(name === 'createSnapshotRequest' ? `${name}:${args[1]}` : name); return fn.apply(this, args); };
    }
    const getCode = proto.getProjectCode;
    proto.getProjectCode = async function (...args) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return fixture === 'files' ? { repository: { enabled: true, main_commit: 'mock-main' }, branches: [], own_branch_id: null } : getCode.apply(this, args);
    };
    if (fixture === 'empty') proto.listProjects = async () => [];
    if (fixture === 'viewer') {
      const getProject = proto.getProject;
      proto.getProject = async function (...args) { return { ...await getProject.apply(this, args), role: 'viewer' }; };
      const getSession = proto.getSession;
      proto.getSession = async function (...args) { const session = await getSession.apply(this, args); session.members = session.members.map((m) => m.userId === user ? { ...m, role: 'viewer' } : m); return session; };
      const members = proto.listMembers;
      proto.listMembers = async function (...args) { return (await members.apply(this, args)).map((m) => m.userId === user ? { ...m, role: 'viewer' } : m); };
    }
  }, { locale, fixture, user, device });
  await page.locator('#auth-select-login').click(); await page.locator('#token').fill('demo-token');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#code-notice-dialog[open]').waitFor();
  assert.equal(await page.locator(popup).count(), 0, 'privacy notice comes first');
  await page.locator('#code-notice-continue').click(); await assertCard(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.guideWrites = []; });
  return { page, context };
}
async function guide(page, topic) {
  await page.locator('#settings-button').click();
  await page.locator(`[data-onboarding-topic=${topic}]`).click(); await assertCard(page);
}
async function walk(page, count, prefix, { finish = true } = {}) {
  const before = await page.locator('#timeline-region').evaluate((node) => node.scrollTop);
  for (let i = 0; i < count; i++) {
    await assertCard(page);
    if (prefix === 'mobile-320' && i >= 4 && i <= 6) {
      const target = ['send-chat-button', 'agent-request-profile', 'send-agent-button'][i - 4];
      assert.equal(await page.locator(`#${target}.driver-active-element`).count(), 1, 'short populated screen highlights core action');
    }
    if (i === 1 || i === count - 2) await page.screenshot({ path: `${artifacts}/${prefix}-${i + 1}.png` });
    if (i < count - 1 || finish) await page.locator(next).click();
  }
  if (finish) { await page.locator(popup).waitFor({ state: 'detached' }); await settle(page); }
  assert.equal(await page.locator('#timeline-region').evaluate((node) => node.scrollTop), before, 'history scroll is preserved');
}
try {
  const { page, context } = await launchPage();
  await page.locator(next).click(); await assertCard(page);
  assert.ok(await page.locator('.onboarding-line').count(), 'arrow points at actual project control');
  await page.locator('#project-select').evaluate((node) => { node.hidden = true; });
  await page.waitForFunction(() => !document.querySelector('#project-select.driver-active-element'));
  await page.locator('#project-select').evaluate((node) => { node.hidden = false; });
  await page.waitForFunction(() => document.querySelector('#project-select.driver-active-element'));
  await page.keyboard.press('ArrowLeft'); await settle(page);
  assert.match(await page.locator('.driver-popover-title').innerText(), /A place/);
  await page.keyboard.press('Tab'); await assertCard(page);
  if (browserName === 'chrome') {
    await page.emulateMedia({ colorScheme: 'dark', contrast: 'more' }); await assertCard(page);
    await page.screenshot({ path: `${artifacts}/dark-contrast.png` });
    await page.emulateMedia({ forcedColors: 'active' }); await assertCard(page);
    await page.screenshot({ path: `${artifacts}/forced-colors.png` });
    await page.emulateMedia({ colorScheme: 'light', contrast: 'no-preference', forcedColors: 'none' });
  }
  await walk(page, 9, 'desktop');
  const seen = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('gatherthread.onboarding.')));
  assert.equal(seen.length, 1); assert.equal(seen[0][1], 'completed');
  assert.equal(await page.locator('#settings-button').getAttribute('aria-controls'), 'settings-dialog');
  await page.locator('#toggle-session-rail-button').click();
  await guide(page, 'basics'); await walk(page, 9, 'collapsed');
  assert.equal(await page.locator('#workspace').getAttribute('data-left-rail-collapsed'), 'true', 'sidebar state restored');
  await guide(page, 'history');
  await page.locator(next).click(); await settle(page);
  const idleMutations = await page.evaluate(async () => {
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    observer.observe(document.querySelector('#session-context-details'), { attributes: true, attributeFilter: ['open'] });
    await new Promise((resolve) => setTimeout(resolve, 300)); observer.disconnect(); return count;
  });
  assert.equal(idleMutations, 0, 'idle presentation does not mutate itself continuously');
  await page.locator('.driver-popover-prev-btn').click();
  await walk(page, 7, 'history');
  assert.equal(await page.locator('#session-context-details').evaluate((node) => node.open), false, 'details restored');
  await guide(page, 'files');
  await page.locator(next).click();
  await page.waitForFunction(() => document.querySelector('#code-enable-section.driver-active-element'));
  assert.ok(await page.locator('.onboarding-line').count(), 'delayed file status resolves a real target');
  await page.locator('.driver-popover-prev-btn').click(); await assertCard(page);
  assert.equal(await page.locator('#project-code-dialog').evaluate((node) => node.open), false, 'back closes owned file dialog');
  assert.equal(await page.locator('#project-code-button.driver-active-element').count(), 1);
  await walk(page, 6, 'files');
  assert.equal(await page.locator('#project-code-dialog').evaluate((node) => node.open), false);
  await guide(page, 'members'); await walk(page, 5, 'members');
  await guide(page, 'basics');
  await page.evaluate(() => document.querySelector('#auth-language-button').click());
  await assertCard(page); assert.match(await page.locator('.driver-popover-title').innerText(), /一起/);
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => window.guideWrites), [], 'tour performs no protected mutation');
  await page.locator('#logout-button').click();
  await page.locator('#auth-select-login').click(); await page.locator('#token').fill('demo-token');
  await page.locator('#login-form button[type=submit]').click(); await page.locator('#session-view:not([hidden])').waitFor();
  await page.waitForFunction(() => !document.querySelector('#login-form button[type=submit]').disabled); await settle(page);
  assert.equal(await page.locator(popup).count(), 0, 'same identity is not prompted again');
  await page.locator('#logout-button').click();
  await page.evaluate(async () => { const { MockCollaborationApi } = await import('./src/api.js?v=20260927-1'); const auth = MockCollaborationApi.prototype.authenticate; MockCollaborationApi.prototype.authenticate = async function (...args) { return { ...await auth.apply(this, args), id: 'another-user' }; }; });
  await page.locator('#auth-select-login').click(); await page.locator('#token').fill('demo-token'); await page.locator('#login-form button[type=submit]').click();
  await assertCard(page); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('gatherthread.onboarding.')).length), 2, 'another account gets its own tour');
  await page.locator('#logout-button').click();
  await page.evaluate(async () => { const { MockCollaborationApi } = await import('./src/api.js?v=20260927-1'); const auth = MockCollaborationApi.prototype.authenticate; MockCollaborationApi.prototype.authenticate = async function (...args) { return { ...await auth.apply(this, args), device_id: 'another-device' }; }; });
  await page.locator('#auth-select-login').click(); await page.locator('#token').fill('demo-token'); await page.locator('#login-form button[type=submit]').click();
  await page.locator('#code-notice-continue').click(); await assertCard(page); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('gatherthread.onboarding.')).length), 3, 'another device gets its own tour');
  await context.close();
  for (const options of [{ locale: 'zh-CN', width: 390, height: 844 }, { locale: 'en', width: 320, height: 568 }, { locale: 'en', width: 320, height: 568, fixture: 'empty' }, { locale: 'zh-CN', fixture: 'viewer' }, { fixture: 'files' }]) {
    const current = await launchPage(options);
    await walk(current.page, options.fixture === 'empty' ? 5 : 9, `${options.fixture ?? 'mobile'}-${options.width ?? 1440}`);
    if (options.fixture === 'files') { await guide(current.page, 'files'); await walk(current.page, 6, 'enabled-files'); }
    await guide(current.page, 'members'); await current.page.keyboard.press('Escape');
    await current.page.locator(popup).waitFor({ state: 'detached' });
    assert.deepEqual(await current.page.evaluate(() => window.guideWrites), []);
    await current.context.close();
  }
  const denied = await launchPage({ deniedStorage: true });
  await denied.page.keyboard.press('Escape');
  await denied.page.locator('#logout-button').click();
  await denied.page.locator('#auth-select-login').click(); await denied.page.locator('#token').fill('demo-token'); await denied.page.locator('#login-form button[type=submit]').click();
  await denied.page.locator('#session-view:not([hidden])').waitFor();
  await denied.page.waitForFunction(() => !document.querySelector('#login-form button[type=submit]').disabled); await settle(denied.page);
  assert.equal(await denied.page.locator(popup).count(), 0, 'storage denial retains same-page progress');
  await guide(denied.page, 'basics'); await denied.page.keyboard.press('Escape');
  await denied.context.close();
  assert.deepEqual(errors, []);
  console.log(`PASS ${browserName}: bilingual desktop/mobile/empty/viewer, all guides, modal layers, arrows, keyboard, progress isolation, no mutations, focus and scroll restoration. Screenshots: ${artifacts}`);
} finally { await browser.close(); }
