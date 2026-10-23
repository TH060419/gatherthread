// Local mock-only checks. The example always uses its own fresh opaque-origin
// iframe, memory storage and Mock API; no real credential/runtime is used.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExampleCollaborationApi } from '../../apps/web/src/example-api.js';
import { examplePreviewDocument, EXAMPLE_REVIEWED_COMMIT } from '../../apps/web/src/example-project.js';
import { guideSteps } from '../../apps/web/src/onboarding-content.js';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const origin = process.env.ONBOARDING_ORIGIN ?? 'http://127.0.0.1:4173';
const artifacts = process.env.ONBOARDING_ARTIFACTS ?? '/tmp/gatherthread-onboarding';
await mkdir(artifacts, { recursive: true });
const browserName = process.env.ONBOARDING_BROWSER ?? 'chrome';
const launchOptions = { headless: process.env.ONBOARDING_HEADLESS !== '0' };
const browser = browserName === 'webkit' ? await webkit.launch(launchOptions) : await chromium.launch({ ...launchOptions, channel: browserName });
const errors = [];
const checkedCases = [];
const popup = '.onboarding-popover';
async function example(page) {
  await page.locator('.onboarding-example-dialog iframe').waitFor();
  const frame = await (await page.locator('.onboarding-example-dialog iframe').elementHandle()).contentFrame();
  await frame.locator('#session-view:not([hidden])').waitFor();
  return frame;
}
async function launchPage({ locale = 'en', width = 1440, height = 900, empty = false, viewer = false, deniedStorage = false, mobile = width <= 760 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce',
    ...(mobile ? { isMobile: true, hasTouch: true,
      userAgent: width >= 768
        ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } : {}) });
  const page = await context.newPage();
  await context.addInitScript(() => {
    window.exampleLoginFlashed = false;
    new MutationObserver(() => {
      const auth = document.getElementById('auth-view');
      if (document.documentElement?.dataset.example === 'true' && auth?.getClientRects().length
        && getComputedStyle(auth).display !== 'none') window.exampleLoginFlashed = true;
    }).observe(document, { subtree: true, attributes: true, childList: true });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/app/?mock=1`);
  await page.locator('#auth-view').waitFor({ state: 'visible' });
  if (mobile) await page.locator('#interface-mode-use-mobile').click();
  await page.evaluate(async ({ locale, empty, viewer, deniedStorage }) => {
    if (locale === 'zh-CN') document.querySelector('#auth-language-button').click();
    window.realWrites = [];
    const entryUrl = document.querySelector('script[type="module"]').src;
    const entry = await (await fetch(entryUrl)).text();
    const mainUrl = new URL(entry.match(/import\("([^\"]*main\.js[^\"]*)"\)/)[1], entryUrl).href;
    const source = await (await fetch(mainUrl)).text();
    const specifier = source.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)?.[1];
    if (!specifier) throw new Error("Fixture could not resolve the application's API module");
    const { MockCollaborationApi } = await import(new URL(specifier, mainUrl).href);
    const proto = MockCollaborationApi.prototype;
    for (const name of ['appendHumanChat', 'appendAgentRequest', 'createHistorySummary', 'createSnapshotRequest', 'createProject', 'createSession', 'mutateProjectCode', 'clearOwnCodeBranch', 'clearProjectCode', 'putProjectGithub', 'setProjectMemberRole', 'createInvitation', 'acceptInvitation', 'setProjectContextPolicy', 'transferProjectOwnership', 'deleteAccount', 'revokeDevice']) {
      const original = proto[name];
      proto[name] = function (...args) { window.realWrites.push(name); return original.apply(this, args); };
    }
    if (empty) {
      proto.listProjects = async () => [];
      const auth = proto.authenticate;
      proto.authenticate = async function (...args) { return { ...await auth.apply(this, args), can_create_projects: false }; };
    }
    if (viewer) {
      const getProject = proto.getProject;
      proto.getProject = async function (...args) { return { ...await getProject.apply(this, args), role: 'viewer' }; };
    }
    if (deniedStorage) {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) { if (key.startsWith('gatherthread.onboarding.')) throw Error('Denied'); return get.call(this, key); };
      Storage.prototype.setItem = function (key, value) { if (key.startsWith('gatherthread.onboarding.')) throw Error('Denied'); return set.call(this, key, value); };
    }
  }, { locale, empty, viewer, deniedStorage });
  await page.locator('#auth-select-email-login').click(); await page.locator('#email-login-email').fill('demo@example.invalid'); await page.locator('#email-login-password').fill('isolated demo password');
  await page.locator('#email-login-form button[type=submit]').click();
  await page.locator('#code-notice-dialog[open]').waitFor();
  assert.equal(await page.locator('iframe').count(), 0, 'required notice precedes guide');
  await page.locator('#code-notice-continue').click();
  const frame = await example(page); await frame.locator(popup).waitFor();
  assert.equal(await frame.evaluate(() => window.exampleLoginFlashed), false, 'entering the example never flashes login');
  assert.equal(await frame.evaluate(() => document.documentElement.dataset.mobileWorkspace === 'true'), mobile,
    `${width}px ${mobile ? 'mobile/tablet' : 'desktop'} example uses the matching controls`);
  await page.waitForTimeout(500); await page.evaluate(() => { window.realWrites = []; });
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  const isolation = await frame.evaluate(() => {
    let parentReadable = true;
    try { void parent.document.body; } catch { parentReadable = false; }
    return { parentReadable, storageLength: localStorage.length, forbidden: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("connect-src 'none'") };
  });
  assert.equal(isolation.parentReadable, false); assert.equal(isolation.forbidden, true);
  return { page, context, frame };
}
async function start(page, topic) {
  await openSettings(page);
  const entry = page.locator(`[data-onboarding-topic="${topic}"]`);
  if (!await entry.isVisible()) await page.locator('.settings-navigation a[href="#settings-general"]').click();
  await entry.click();
  const frame = await example(page); if (topic !== 'browse') await frame.locator(popup).waitFor(); return frame;
}
async function openSettings(page) {
  if (!await page.locator('#settings-button').isVisible()) await page.locator('#mobile-tools-button').click();
  await page.locator('#settings-button').click();
}
async function checkSummarySettingsNavigation(page, locale) {
  await openSettings(page);
  await page.locator('#settings-dialog[open]').waitFor();
  const syncLink = page.locator('.settings-navigation a[href="#settings-sync"]');
  const link = page.locator('.settings-navigation a[href="#settings-summaries"]');
  assert.equal(await link.innerText(), locale === 'zh-CN' ? '摘要' : 'Summaries');
  assert.equal(await page.locator('#settings-summaries').getAttribute('aria-labelledby'), 'settings-summary-title');
  assert.equal(await page.locator('#settings-summary-title').evaluate(node => node.tagName), 'H3');
  assert.equal(await page.locator('#settings-sync').evaluate(node => node.nextElementSibling?.id), 'settings-summaries');
  assert.equal(await page.locator('#settings-sync #settings-history-context-mode').count(), 0, 'summary controls are in their own section');
  const originalUrl = page.url();
  if (await page.locator('#settings-dialog').getAttribute('data-mobile-settings') === 'true') {
    await link.click();
    await page.waitForFunction(() => document.activeElement?.id === 'settings-summaries');
    assert.equal(await page.locator('#settings-history-context-mode').isVisible(), true, 'mobile opens the dedicated Summaries page');
    assert.equal(page.url(), originalUrl, 'mobile Settings navigation keeps the project/session URL');
    await page.locator('.mobile-settings-back').click();
    await page.locator('.settings-navigation a[href="#settings-general"]').click();
    assert.equal(await page.locator('[data-onboarding-topic="files"]').isVisible(), true, 'mobile General exposes the file guide');
    await page.locator('#close-settings-button').click();
    return;
  }
  await page.waitForFunction(() => document.activeElement?.id === 'close-settings-button');
  let reachedSummaryLink = false;
  for (let index = 0; index < 12; index++) {
    // Safari's default Tab behavior skips links; Option+Tab traverses them.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const focus = await page.evaluate(() => ({
      insideDialog: document.querySelector('#settings-dialog').contains(document.activeElement),
      href: document.activeElement?.getAttribute('href'),
    }));
    assert.equal(focus.insideDialog, true, 'Tab stays inside the Settings dialog');
    if (focus.href === '#settings-summaries') { reachedSummaryLink = true; break; }
  }
  assert.equal(reachedSummaryLink, true, 'Tab reaches the Summaries navigation link');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'settings-summaries');
  assert.equal(page.url(), originalUrl, 'keyboard navigation keeps the project/session URL');
  await syncLink.click();
  await page.waitForFunction(() => document.activeElement?.id === 'settings-sync');
  const syncPosition = await page.evaluate(() => {
    const scroller = document.querySelector('.settings-sections');
    const section = document.querySelector('#settings-sync');
    const bounds = scroller.getBoundingClientRect();
    return { top: section.getBoundingClientRect().top, viewportTop: bounds.top, viewportBottom: bounds.bottom };
  });
  assert.ok(syncPosition.top >= syncPosition.viewportTop && syncPosition.top < syncPosition.viewportBottom, `sync section is visible: ${JSON.stringify(syncPosition)}`);
  await link.click();
  await page.waitForFunction(() => document.activeElement?.id === 'settings-summaries');
  const position = await page.evaluate(() => {
    const scroller = document.querySelector('.settings-sections');
    const heading = document.querySelector('#settings-summary-title');
    const bounds = scroller.getBoundingClientRect();
    return { scrollTop: scroller.scrollTop, top: heading.getBoundingClientRect().top, viewportTop: bounds.top, viewportBottom: bounds.bottom };
  });
  assert.ok(position.scrollTop > 0, 'summary navigation scrolls the Settings content');
  assert.ok(position.top >= position.viewportTop && position.top < position.viewportBottom, `summary heading is visible: ${JSON.stringify(position)}`);
  assert.equal(page.url(), originalUrl, 'Settings navigation keeps the project/session URL');
  await page.locator('#close-settings-button').click();
}
async function assertStep(frame, item, size) {
  await frame.locator(popup).waitFor();
  await frame.waitForFunction(({ target }) => !target || document.querySelector('.driver-active-element:not(#driver-dummy-element)'), item);
  await frame.waitForFunction((stepId) => document.querySelector('.onboarding-popover')?.getAttribute('data-onboarding-focus-ready') === stepId, item.id);
  // Focus readiness precedes the connector's next animation frame. Wait for
  // actual geometry, not an arbitrary delay that varies with browser load.
  await frame.waitForFunction(({ id, targeted }) => {
    if (document.querySelector('.onboarding-popover')?.getAttribute('data-onboarding-focus-ready') !== id) return false;
    if (!targeted) return true;
    const target = document.querySelector('.driver-active-element');
    const ring = document.querySelector('.onboarding-ring');
    if (!target || target.id === 'driver-dummy-element' || !ring) return false;
    const box = target.getBoundingClientRect();
    const layer = document.querySelector('.onboarding-connector')?.getBoundingClientRect();
    const expected = [box.x - 7 - (layer?.x ?? 0), box.y - 7 - (layer?.y ?? 0), box.width + 14, box.height + 14];
    return ['x', 'y', 'width', 'height'].every((name, index) => Math.abs(Number(ring.getAttribute(name)) - expected[index]) < 1);
  }, { id: item.id, targeted: Boolean(item.target) }, { timeout: 5000 });
  // Read geometry and verify its ring in one browser tick. Separate protocol
  // reads can straddle an asynchronous scroll and compare different frames.
  const handle = await frame.waitForFunction(({ id, targeted }) => {
    const card = document.querySelector('.onboarding-popover'), target = document.querySelector('.driver-active-element');
    if (!card || card.getAttribute('data-onboarding-focus-ready') !== id) return false;
    const a = card.getBoundingClientRect(), b = target?.getBoundingClientRect();
    const ring = document.querySelector('.onboarding-ring');
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1)?.getBoundingClientRect();
    const connector = document.querySelector('.onboarding-connector')?.getBoundingClientRect();
    const panel = target?.closest('.session-context-panel')?.getBoundingClientRect();
    const state = { card: [a.x, a.y, a.width, a.height], target: target?.id, inviteSubmit: target?.matches('#create-invitation-form button[type=submit]'), hint: card.innerText.includes('正在准备') || card.innerText.includes('Preparing this example'),
      overlap: b && Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
      panelOverlap: panel && Math.max(0, Math.min(a.right, panel.right) - Math.max(a.left, panel.left)) * Math.max(0, Math.min(a.bottom, panel.bottom) - Math.max(a.top, panel.top)),
      targetBox: b && [b.x, b.y, b.width, b.height], ring: ring && ['x', 'y', 'width', 'height'].map((name) => Number(ring.getAttribute(name))), layerOffset: [connector?.x ?? 0, connector?.y ?? 0],
      modalBox: modal && [modal.x, modal.y, modal.width, modal.height],
      focus: card.contains(document.activeElement) || Boolean(document.activeElement.closest('.example-toolbar')),
      closeOutline: getComputedStyle(card.querySelector('.driver-popover-close-btn')).outlineStyle };
    if (targeted && (!state.targetBox || !state.ring || state.target === 'driver-dummy-element')) return false;
    if (targeted && state.ring.some((value, index) => Math.abs(value - (state.targetBox[index] + (index < 2 ? -7 - state.layerOffset[index] : 14))) >= 1)) return false;
    return state;
  }, { id: item.id, targeted: Boolean(item.target) }, { timeout: 5000 });
  const state = await handle.jsonValue();
  await handle.dispose();
  assert.equal(state.hint, false, item.id);
  const [x, y, w, h] = state.card;
  assert.ok(x >= 0 && y >= 0 && x + w <= size.width + 1 && y + h <= size.height + 1, `${item.id}: ${JSON.stringify(state)}`);
  if (state.modalBox) {
    const [mx, my, mw, mh] = state.modalBox;
    assert.ok(x >= mx - 1 && y >= my - 1 && x + w <= mx + mw + 1 && y + h <= my + mh + 1,
      `${item.id} card stays inside its dialog: ${JSON.stringify(state)}`);
  }
  // WebKit can suppress scripted focus in a newly inserted opaque frame before
  // user activation, on desktop as well as touch layouts.
  // Require genuine keyboard entry and a working focus cycle in that case.
  if (!state.focus && browserName === 'webkit') {
    assert.equal(await frame.evaluate(() => document.activeElement === document.body), true);
    await frame.page().keyboard.press('Tab');
    state.focus = await frame.evaluate(() => Boolean(document.activeElement.closest('.onboarding-popover')));
    await frame.page().keyboard.press('Shift+Tab');
    assert.equal(await frame.evaluate(() => Boolean(document.activeElement.closest('.example-toolbar'))), true);
    await frame.page().keyboard.press('Tab');
    assert.equal(await frame.evaluate(() => Boolean(document.activeElement.closest('.onboarding-popover'))), true);
  }
  assert.equal(state.focus, true, `${item.id} focus`);
  assert.equal(state.closeOutline, 'none', 'close has no green outline');
  if (item.target) {
    assert.notEqual(state.target, 'driver-dummy-element', item.id);
    if (/^#history-summary-(?:select|view|versions)-button$/u.test(item.target)) {
      assert.equal(await frame.locator('#history-summary-menu-button').getAttribute('aria-expanded'), 'true', 'guide discloses the shared summary menu');
    }
    if (item.id === 'mention') assert.equal(state.target, 'message-input', 'the mention guide never relies on an unread-only reminder');
    if (item.id === 'create-conversation') assert.equal(state.target, 'new-session-button');
    if (item.id === 'invite') assert.equal(state.inviteSubmit, true);
    assert.ok(state.overlap < 1, `${item.id} card covers control: ${JSON.stringify(state)}`);
    if (size.width >= 1440 && state.panelOverlap !== undefined) assert.ok(state.panelOverlap < 1, `${item.id} card covers disclosure`);
    for (let index = 0; index < 4; index++) assert.ok(Math.abs(state.ring[index] - (state.targetBox[index] + (index < 2 ? -7 - state.layerOffset[index] : 14))) < 1, `${item.id} ring follows target: ${JSON.stringify(state)}`);
  } else assert.equal(state.target, 'driver-dummy-element', 'overview centered');
}
async function walk(page, frame, topic, prefix) {
  const layout = await frame.evaluate(() => document.documentElement.dataset.mobileWorkspace === 'true' ? 'mobile' : 'desktop');
  const steps = guideSteps(topic, { layout }), size = page.viewportSize();
  for (let index = 0; index < steps.length; index++) {
    if (process.env.ONBOARDING_DEBUG) console.log(`  ${topic}/${steps[index].id}`);
    try { await assertStep(frame, steps[index], size); }
    catch (error) { await page.screenshot({ path: `${artifacts}/${prefix}-${topic}-${steps[index].id}-failure.png` });
      if (process.env.ONBOARDING_DEBUG) console.log('Failed target', await frame.evaluate(selector => {
        const node = selector ? document.querySelector(selector) : document.body, ancestors = [];
        for (let parent = node?.parentElement; parent; parent = parent.parentElement) ancestors.push({ id: parent.id, tag: parent.tagName, hidden: parent.hidden, rect: parent.getBoundingClientRect().toJSON(), overflow: getComputedStyle(parent).overflow, scroll: parent.scrollTop });
        return { target: node?.getBoundingClientRect().toJSON(), ancestors };
      }, steps[index].target));
      error.message = `${prefix} ${topic}/${steps[index].id}: ${error.message}`; throw error; }
    if (['welcome', 'create-conversation', 'model', 'answer', 'upload', 'roles', 'invite', 'enable', 'original'].includes(steps[index].id)) await page.screenshot({ path: `${artifacts}/${prefix}-${topic}-${steps[index].id}.png` });
    if (layout === 'mobile' && index === 1) {
      await frame.locator('.driver-popover-prev-btn').click();
      await assertStep(frame, steps[0], size);
      await frame.locator('.driver-popover-next-btn').click();
      await assertStep(frame, steps[index], size);
    }
    if (['create-conversation', 'invite'].includes(steps[index].id)) await page.keyboard.press('ArrowRight');
    else await frame.locator('.driver-popover-next-btn').click();
  }
  await page.locator('.onboarding-example-dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.realWrites), [], 'guides never write to parent API');
}
try {
  // The produced example is an actual, small interactive page, not a report-only fixture.
  for (const locale of ['en', 'zh-CN']) {
    const api = new ExampleCollaborationApi(locale);
    for (const branch of ['main', 'branch-maya']) {
      const { snapshot } = await api.getProjectCodeSnapshot('project-orbit', branch);
      const page = await browser.newPage();
      await page.setContent(examplePreviewDocument(locale, snapshot.commit === EXAMPLE_REVIEWED_COMMIT));
      assert.equal(await page.locator('#confirmation').isVisible(), false);
      await page.getByRole('button', { name: locale === 'zh-CN' ? '我要报名' : 'Sign me up' }).click();
      assert.equal(await page.locator('#confirmation').isVisible(), true);
      assert.match(await page.locator('#confirmation').innerText(), locale === 'zh-CN' ? /报名成功/ : /signed up/);
      if (branch === 'branch-maya') assert.match(await page.locator('#confirmation').innerText(), locale === 'zh-CN' ? /周六见/ : /See you Saturday/);
      await page.close();
    }
  }
  for (const options of [
    { locale: 'en', width: 1440, height: 900 },
    { locale: 'zh-CN', width: 1440, height: 900, empty: true },
    { locale: 'zh-CN', width: 390, height: 844, viewer: true },
    { locale: 'zh-CN', width: 320, height: 568, empty: true, deniedStorage: true },
    { locale: 'en', width: 820, height: 1180, mobile: true },
    { locale: 'zh-CN', width: 1024, height: 768, mobile: true },
  ].filter(options => !process.env.ONBOARDING_WIDTH || options.width === Number(process.env.ONBOARDING_WIDTH))) {
    console.log(`${browserName}: checking ${options.locale} ${options.width}×${options.height}${options.empty ? ' empty' : ''}${options.viewer ? ' viewer' : ''}`);
    checkedCases.push(`${options.locale} ${options.width}×${options.height}`);
    const { page, context, frame } = await launchPage(options);
    const prefix = `${options.locale}-${options.width}`;
    await walk(page, frame, 'basics', prefix);
    for (const topic of ['members', 'history', 'files', 'summaries', 'account']) await walk(page, await start(page, topic), topic, prefix);
    await checkSummarySettingsNavigation(page, options.locale);
    // Free practice may mutate only fresh mock data inside the frame.
    const before = await page.evaluate(() => ({ hash: location.hash, title: document.querySelector('#session-title').textContent,
      timeline: document.querySelector('#event-timeline').innerHTML, draft: document.querySelector('#message-input').value }));
    const practice = await start(page, 'browse');
    await practice.locator('#message-input').fill('Demo practice only'); await practice.locator('#send-chat-button').click();
    await practice.getByText('Demo practice only', { exact: true }).waitFor();
    await practice.evaluate(() => localStorage.setItem('example-only-value', 'temporary'));
    assert.equal(await page.evaluate(() => localStorage.getItem('example-only-value')), null);
    await practice.locator('.example-toolbar button').last().click();
    await page.locator('.onboarding-example-dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => ({ hash: location.hash, title: document.querySelector('#session-title').textContent,
      timeline: document.querySelector('#event-timeline').innerHTML, draft: document.querySelector('#message-input').value })), before);
    assert.deepEqual(await page.evaluate(() => window.realWrites), []);
    await context.close();
  }
  // Toolbar navigation, fresh example after edits, spoofed messages, language,
  // theme, Escape, replay and native-dialog focus all remain usable.
  const { page, context, frame } = await launchPage({ locale: 'en' });
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: { type: 'example-exit', channel: 'forged' } })));
  assert.equal(await page.locator('.onboarding-example-dialog').count(), 1);
  await frame.locator('.example-toolbar button').first().click(); assert.equal(await frame.locator(popup).count(), 0);
  await frame.locator('#message-input').fill('Temporary change'); await frame.locator('#send-chat-button').click();
  await frame.getByText('Temporary change', { exact: true }).waitFor();
  await frame.locator('.example-toolbar button').nth(1).click();
  let fresh = await example(page); assert.equal(await fresh.getByText('Temporary change', { exact: true }).count(), 0);
  await fresh.locator('#example-project-open').evaluate(node => node.addEventListener('click', () => {
    window.exampleResultReturnFocus = document.activeElement;
  }, { capture: true, once: true }));
  await fresh.locator('#example-project-open').click();
  await fresh.locator('#example-project-frame[aria-busy="false"]').waitFor();
  const result = fresh.frameLocator('#example-project-frame');
  await result.locator('#signup').click();
  await result.locator('#signup:disabled').waitFor();
  assert.equal(await result.locator('#confirmation').innerText(), 'You’re signed up.');
  assert.equal(await result.locator('#signup').isDisabled(), true);
  await fresh.locator('#example-project-version').selectOption('branch-maya');
  await fresh.locator('#example-project-frame[aria-busy="false"]').waitFor();
  await result.locator('#signup:not([disabled])').waitFor();
  await result.locator('#signup').click();
  assert.equal(await result.locator('#confirmation').innerText(), 'You’re signed up! See you Saturday.');
  await fresh.locator('#example-project-close').click();
  await fresh.locator('#example-project-dialog[open]').waitFor({ state: 'hidden' });
  // Native close queues its event after removing the open attribute.
  await fresh.waitForFunction(() => document.activeElement === window.exampleResultReturnFocus, null, { timeout: 3000 });
  assert.equal(await fresh.evaluate(() => document.activeElement === window.exampleResultReturnFocus), true, 'closing result restores the actual previous focus in each browser');
  await fresh.locator('#example-files-open').click();
  await fresh.locator('.fw-tree [data-path="src"]').click();
  await fresh.locator('.fw-tree [data-path="src/signup.js"]').click();
  await fresh.locator('.fw-file-pane .cm-content').waitFor();
  assert.match(await fresh.locator('.fw-file-pane .cm-content').innerText(), /addEventListener\('click'/);
  assert.equal(await fresh.locator('#example-file-list, #example-source-code').count(), 0, 'source uses the real file workspace');
  // In-example language preview/cancel/save retains practice and stays local.
  await fresh.locator('#message-input').fill('Keep this practice message');
  await fresh.locator('#send-chat-button').click();
  await fresh.getByText('Keep this practice message', { exact: true }).waitFor();
  assert.equal(await fresh.locator('html').getAttribute('lang'), 'en', 'reset preserves the requested example language');
  await fresh.locator('#settings-button').click();
  await fresh.locator('#settings-locale').selectOption('zh-CN');
  await fresh.getByText('Keep this practice message', { exact: true }).waitFor();
  assert.equal(await fresh.locator('.example-toolbar select option').first().textContent(), '自由浏览');
  assert.match(await fresh.locator('#event-timeline').innerText(), /林悦/);
  assert.equal(await fresh.locator('#current-username').innerText(), '陈晓');
  assert.match(await fresh.locator('#member-list').innerText(), /林悦/);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'sample language does not change real settings');
  await fresh.locator('#cancel-settings-button').click();
  try { await fresh.locator('#settings-dialog[open]').waitFor({ state: 'hidden', timeout: 3000 }); }
  catch (error) { await page.screenshot({ path: `${artifacts}/cancel-failure.png` }); throw error; }
  assert.equal(await fresh.locator('#current-username').innerText(), 'Alex', 'cancel restores authored language');
  await fresh.locator('#settings-button').click();
  await fresh.locator('#settings-locale').selectOption('zh-CN');
  await fresh.locator('#settings-form button[type=submit]').click();
  await fresh.locator('#settings-dialog[open]').waitFor({ state: 'hidden' });
  await fresh.locator('.example-toolbar select').selectOption('summaries');
  fresh = await example(page); await fresh.locator(popup).waitFor();
  assert.equal(await fresh.locator('html').getAttribute('lang'), 'zh-CN', 'guide navigation keeps sample language');
  for (let index = 0; index < 4; index++) await fresh.locator('.driver-popover-next-btn').click();
  await fresh.locator('#settings-dialog[open]').waitFor();
  assert.equal(await fresh.locator('#settings-summary-title').innerText(), '摘要');
  assert.match(await fresh.locator('#settings-history-context-mode option[value=summary]').innerText(), /推荐.*聚焦核心结论/);
  // Exercise preview while the tutorial owns Settings, without restarting it.
  await fresh.locator('#settings-locale').selectOption('en', { force: true });
  assert.equal(await fresh.locator('#settings-dialog[open]').count(), 1);
  assert.match(await fresh.locator('.driver-popover-title').innerText(), /Choose what your AI agent reads/);
  assert.match(await fresh.locator('.driver-popover-description').innerText(), /focus on agreed conclusions/);
  assert.equal(await fresh.locator('#settings-summary-title').innerText(), 'Summaries');
  assert.match(await fresh.locator('#settings-history-context-mode option[value=summary]').innerText(), /focus.*recommended/);
  await fresh.locator('.example-toolbar button').first().click();
  assert.equal(await fresh.locator('#settings-dialog[open]').count(), 0);
  await page.evaluate(() => { localStorage.setItem('gt-lang', 'zh'); dispatchEvent(new StorageEvent('storage', { key: 'gt-lang', newValue: 'zh' })); });
  await page.waitForTimeout(250); fresh = await example(page);
  await fresh.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await fresh.locator('.example-toolbar select').selectOption('files');
  fresh = await example(page); await fresh.locator(popup).waitFor();
  await fresh.locator('.fw-tree').waitFor();
  await fresh.locator('.driver-popover-next-btn').click();
  await fresh.locator('.fw-file-pane .cm-content').waitFor();
  await fresh.locator('.example-toolbar button').first().click(); assert.equal(await fresh.locator(popup).count(), 0);
  assert.equal(await fresh.locator('#project-code-dialog[open]').count(), 0, 'browsing files never opens the old sync dialog');
  await fresh.locator('.example-toolbar select').selectOption('basics'); fresh = await example(page);
  await fresh.locator(popup).waitFor(); await fresh.locator('.driver-popover-next-btn').press('Escape');
  await page.locator('.onboarding-example-dialog').waitFor({ state: 'detached' });
  await start(page, 'basics'); fresh = await example(page); await fresh.locator('.driver-popover-close-btn').click();
  await page.locator('.onboarding-example-dialog').waitFor({ state: 'detached' });
  // The ordinary disclosure stays unclipped and preserves keyboard order.
  const disclosure = page.locator('#session-context-details > summary');
  await page.locator('#session-options-button').click();
  await disclosure.click();
  await page.waitForFunction(() => document.querySelector('.session-context-panel').parentElement === document.body);
  await disclosure.press('Tab');
  assert.equal(await page.evaluate(() => document.querySelector('.session-context-panel').contains(document.activeElement)), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await disclosure.evaluate((node) => node === document.activeElement), true);
  await disclosure.press('Escape');
  assert.equal(await page.locator('#session-context-details').getAttribute('open'), null);
  await disclosure.click();
  // The native toggle event portals the panel asynchronously. Wait before
  // focusing a child, otherwise moving that child can clear its focus.
  await page.waitForFunction(() => document.querySelector('.session-context-panel').parentElement === document.body);
  await page.evaluate(() => {
    const button = document.querySelector('#history-summary-select-button');
    const fixture = { button, disabled: button.disabled, restores: 0 };
    button.disabled = true;
    // Keep this deliberately disabled-control scenario stable while normal
    // member/avatar polling recomputes summary availability in the background.
    fixture.observer = new MutationObserver(() => {
      if (!button.disabled) { fixture.restores += 1; button.disabled = true; }
    });
    fixture.observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
    window.__disabledSummaryFixture = fixture;
  });
  await page.waitForFunction(() => window.__disabledSummaryFixture.restores > 0);
  await disclosure.focus();
  const visitedPanelControls = new Set();
  let reachedLastPanelControl = false;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => ({ id: document.activeElement.id,
      inPanel: document.querySelector('.session-context-panel').contains(document.activeElement) }));
    assert.equal(focus.inPanel, true, 'Tab from the details button must traverse the panel');
    assert.equal(visitedPanelControls.has(focus.id), false, 'Panel controls must not cycle');
    visitedPanelControls.add(focus.id);
    if (focus.id === 'upload-local-turns-button') { reachedLastPanelControl = true; break; }
  }
  assert.equal(reachedLastPanelControl, true, 'Tab must reach the last panel control');
  await page.keyboard.press('Tab');
  const afterPanel = await page.evaluate(() => {
    const node = document.activeElement;
    return { id: node.id, inPanel: document.querySelector('.session-context-panel').contains(node),
      inOptions: document.querySelector('#session-options-panel').contains(node),
      usable: node !== document.body && !node.disabled && !node.closest('[hidden]') && node.getClientRects().length > 0 };
  });
  assert.equal(afterPanel.usable, true, 'disabled or unread-only controls never receive focus');
  assert.equal(afterPanel.inPanel, false, 'Tab leaves status details without a focus trap');
  await page.keyboard.press('Shift+Tab');
  if (browserName === 'webkit' && !afterPanel.inOptions) {
    // macOS WebKit may skip ordinary buttons in native reverse traversal when
    // full keyboard access is off. It must still land on a visible page control.
    assert.equal(await page.evaluate(() => {
      const node = document.activeElement;
      return node !== document.body && !node.closest('[hidden]') && node.getClientRects().length > 0
        && !document.querySelector('.session-context-panel').contains(node);
    }), true, 'native reverse traversal never enters hidden options');
  } else {
    assert.equal(await page.evaluate(() => document.activeElement.id), afterPanel.inOptions ? 'upload-local-turns-button' : 'session-options-button',
      'reverse traversal returns to the open details or the compact options trigger after automatic dismissal');
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#history-summary-select-button').isDisabled(), true, 'disabled-control fixture survives polling');
  if (browserName !== 'webkit' || afterPanel.inOptions) {
    assert.equal(await page.evaluate(() => document.activeElement.id), afterPanel.id, 'forward traversal rejoins the document at the same visible control');
  }
  let reachedDocumentEnd = false;
  for (let i = 0; i < 200; i++) {
    const focus = await page.evaluate(() => {
      window.__focusSeen ??= new WeakSet();
      const element = document.activeElement;
      const repeated = window.__focusSeen.has(element);
      window.__focusSeen.add(element);
      return { repeated, inPanel: document.querySelector('.session-context-panel').contains(element),
        atBody: element === document.body, id: element.id || element.tagName };
    });
    if (focus.atBody) { reachedDocumentEnd = true; break; }
    assert.equal(focus.inPanel, false, 'Tab must not re-enter the portalled details after leaving it');
    assert.equal(focus.repeated, false, `Tab must not cycle through page controls (${focus.id})`);
    await page.keyboard.press('Tab');
  }
  assert.equal(reachedDocumentEnd, true, 'Tab must reach the end of the document');
  await page.evaluate(() => {
    const fixture = window.__disabledSummaryFixture;
    fixture.observer.disconnect();
    fixture.button.disabled = fixture.disabled;
    delete window.__disabledSummaryFixture;
  });
  await page.keyboard.press('Escape');
  if (await page.locator('#session-options-button').getAttribute('aria-expanded') !== 'true') await page.locator('#session-options-button').click();
  await disclosure.click(); await page.locator('#logout-button').click();
  await page.locator('#auth-view:not([hidden])').waitFor();
  assert.equal(await page.locator('.session-context-panel').isVisible(), false, 'logout hides private disclosure');
  assert.equal(await page.locator('#session-context-details .session-context-panel').count(), 1, 'logout restores panel ownership');
  await context.close();
  assert.deepEqual(errors, []);
  console.log(`${browserName}: ${checkedCases.length ? `all guides at ${checkedCases.join('; ')}` : 'result and toolbar checks'}; isolated practice, focus, ring geometry, privacy, reset and language passed.`);
} finally { if (errors.length) console.error('Example page errors:', errors); await browser.close(); }
