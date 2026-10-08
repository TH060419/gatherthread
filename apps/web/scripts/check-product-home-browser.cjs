// Run with playwright-cli run-code --filename apps/web/scripts/check-product-home-browser.cjs
// Serve the Web build on loopback: GATHERTHREAD_WEB_PORT=18842 node apps/web/scripts/serve.mjs
async (page) => {
  const origin = 'http://127.0.0.1:18842';
  const results = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (name, pass, data) => {
    results.push({ name, pass: Boolean(pass), data });
    if (!pass) throw new Error(JSON.stringify(results));
  };
  const delay = ms => page.waitForTimeout(ms);
  async function checkFirstChapterClick(label) {
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin + '/?theme=light');
    if (await page.evaluate(() => document.documentElement.lang) !== 'zh-CN') await page.locator('#language').click();
    await delay(2100);
    await page.evaluate(() => {
      window.homeScrollAudit = [];
      window.homePointerAudit = [];
      const original = window.scrollTo.bind(window);
      window.scrollTo = (...args) => { homeScrollAudit.push(args); return original(...args); };
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event =>
        homePointerAudit.push({ type, target: event.target.closest('a')?.getAttribute('href') ?? event.target.tagName, trusted: event.isTrusted }));
    });
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 450);
    await delay(900);
    const middle = await page.evaluate(() => scrollY);
    await delay(1000);
    check('no delayed or scripted snap ' + label, await page.evaluate(y => Math.abs(scrollY - y) < 2 && homeScrollAudit.length === 0, middle));
    await page.mouse.wheel(0, 370);
    await delay(1100);
    await page.mouse.wheel(0, -100);
    await delay(1000);
    const target = page.locator('[data-chapter-link][href="#workflow"]');
    const box = await target.boundingBox();
    if (!box) throw new Error('Chapter target has no visible box: ' + label);
    const before = await page.evaluate(rect => {
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      return { y: scrollY, visible: rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= innerWidth
        && rect.y + rect.height <= innerHeight, hit: document.elementFromPoint(point.x, point.y)?.closest('a')?.getAttribute('href') };
    }, box);
    await delay(100);
    const stableBox = await target.boundingBox();
    const stable = stableBox && ['x', 'y', 'width', 'height'].every(key => Math.abs(stableBox[key] - box[key]) < 0.5)
      && await page.evaluate(y => Math.abs(scrollY - y) < 2, before.y);
    check('chapter target is visible and hit-tested ' + label,
      await target.isVisible() && stable && before.visible && before.hit === '#workflow', before);
    // Exactly one ordinary pointer click after wheel/reverse; never force or retry.
    await target.click();
    await delay(1400);
    const navigation = await page.evaluate(() => ({
      hash: location.hash,
      top: document.querySelector('#workflow').getBoundingClientRect().top,
      calls: homeScrollAudit.length,
      pointers: homePointerAudit,
    }));
    check('wheel then first chapter click ' + label,
      navigation.hash === '#workflow' && Math.abs(navigation.top) < 3 && navigation.calls === 1
        && navigation.pointers.length === 3
        && navigation.pointers.every(event => event.target === '#workflow' && event.trusted), navigation);
  }
  await checkFirstChapterClick('initial');
  // Warm navigation has its own rendering/input lifecycle; cold loads alone miss it.
  await page.goto(origin + '/privacy/');
  await checkFirstChapterClick('from privacy');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin + '/');
  await checkFirstChapterClick('after reduced motion');
  if (await page.evaluate(() => document.documentElement.lang) !== 'en') await page.locator('#language').click();
  await page.goto(origin + '/privacy/');
  await checkFirstChapterClick('from English privacy');
  for (let index = 0; index < 4; index++) {
    await page.locator('#step-tab-' + index).click();
    check('workflow pointer tab ' + index, await page.locator('#step-panel-' + index).isVisible());
  }
  await page.locator('#step-tab-3').press('Home');
  check('workflow keyboard Home', await page.locator('#step-tab-0').getAttribute('aria-selected') === 'true');
  await page.locator('#step-tab-0').press('End');
  check('workflow keyboard End', await page.locator('#step-tab-3').getAttribute('aria-selected') === 'true');
  await page.locator('[data-chapter-link][href="#faq"]').click();
  await delay(1400);
  for (const summary of await page.locator('#faq summary').all()) await summary.click();
  check('all FAQ answers readable', await page.locator('#faq details[open]').count() === 10);
  for (const [width, height] of [[1440, 900], [1280, 720], [820, 1180], [1024, 768], [390, 844], [320, 667], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin + '/?theme=light');
    await delay(2000);
    for (const language of ['zh-CN', 'en']) {
      if (await page.evaluate(() => document.documentElement.lang) !== language) await page.locator('#language').click();
      await delay(300);
      const layout = await page.evaluate(() => {
        const title = document.querySelector('#hero-title');
        const range = document.createRange();
        range.setStart(title.firstChild, 0); range.setEnd(title.firstChild, 12);
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          brandRects: range.getClientRects().length,
          snap: getComputedStyle(document.documentElement).scrollSnapType,
          stageBottom: document.querySelector('.product-stage').getBoundingClientRect().bottom,
          locale: document.documentElement.lang,
        };
      });
      check('layout ' + width + 'x' + height + ' ' + language, !layout.overflow && layout.brandRects === 1 && layout.locale === language, layout);
      if (width > 900 && height >= 620) {
        check('native proximity scrolling ' + width + ' ' + language, ['y', 'y proximity'].includes(layout.snap), layout.snap);
        check('first-screen screenshot fit ' + width + ' ' + language, layout.stageBottom <= height + 1, layout.stageBottom);
      }
      if (width <= 900 || height < 620) check('compact natural scrolling ' + width + ' ' + language, layout.snap === 'none', layout.snap);
    }
    if (width <= 850) {
      await page.locator('#menu').click();
      check('compact menu pointer ' + width, await page.locator('#menu').getAttribute('aria-expanded') === 'true');
      await page.locator('#menu').press('Escape');
      check('compact menu Escape ' + width, await page.locator('#menu').getAttribute('aria-expanded') === 'false');
      await page.locator('#menu').press('Enter');
      check('compact menu keyboard focus ' + width, await page.evaluate(() => document.activeElement === document.querySelector('#navigation a')));
      await page.locator('#navigation a').first().press('Escape');
      check('compact menu keyboard return ' + width, await page.evaluate(() => document.activeElement === document.querySelector('#menu')));
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/?theme=light');
  const other = await page.context().newPage();
  if (await page.evaluate(() => document.documentElement.lang) !== 'zh-CN') await page.locator('#language').click();
  await other.goto(origin + '/?theme=light');
  await other.locator('#language').click();
  await delay(300);
  check('cross-tab language sync', await page.evaluate(() => document.documentElement.lang === 'en' && localStorage.getItem('gt-lang') === 'en'));
  await other.close();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await delay(300);
  check('reduced-motion no running animation', await page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType === 'none' && !document.getAnimations().some(animation => animation.playState === 'running')));
  await page.goto(origin + '/?theme=dark');
  await delay(300);
  check('dark theme retains readable title', await page.evaluate(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.querySelector('#hero-title')).color === 'rgb(245, 245, 247)'));
  await page.locator('#themeToggle').click();
  check('theme toggle', await page.evaluate(() => document.documentElement.dataset.theme === 'light' && localStorage.getItem('gt-theme') === 'light'));
  const noScript = await page.context().browser().newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const fallback = await noScript.newPage();
  await fallback.goto(origin + '/');
  check('no-JS shows every workflow panel', await fallback.locator('.story-panel:visible').count() === 4);
  check('no-JS keeps nav and entry usable', await fallback.locator('#navigation').isVisible() && await fallback.locator('.hero a[href="./app/"]').isVisible());
  await noScript.close();
  await page.route('**/v1/**', route => route.fulfill({ status: route.request().url().endsWith('/me') ? 401 : 200, contentType: 'application/json', body: JSON.stringify({ data: { enabled: false, site_key: null, challenge_binding: null } }) }));
  await page.goto(origin + '/?theme=light');
  await page.locator('.hero a[href="./app/"]').click();
  check('same-origin login entry', page.url().startsWith(origin + '/app/'));
  check('login shares selected language', await page.evaluate(() => localStorage.getItem('gt-lang') === 'en'));
  await page.goto(origin + '/?theme=light');
  await page.locator('.hero [data-example]').click();
  check('same-origin isolated example', page.url().startsWith(origin + '/app/example.html?locale=en&topic=browse'));
  await page.goto(origin + '/?theme=light');
  await page.locator('.footer-links a[href="./privacy/"]').click();
  check('same-origin privacy entry', page.url() === origin + '/privacy/');
  check('no runtime errors', errors.length === 0, errors);
  return { browser: page.context().browser().browserType().name(), passed: results.length, results };
}
