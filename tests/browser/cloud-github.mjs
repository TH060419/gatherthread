// Actual HTTP/UI integration with fake GitHub and container responses. No real account, model or PR.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCollaborationServer } from '../../apps/server/dist/src/server.js';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const directory = mkdtempSync(join(tmpdir(), 'gt-github-browser-'));
const file = (path, content) => ({ path, content_base64: Buffer.from(content).toString('base64'), executable: false });
const files = [file('package.json', '{"name":"fixture","version":"1.0.0"}'), file('package-lock.json', '{"lockfileVersion":3,"packages":{"":{}}}'), file('index.ts', 'export const value = 1;\n')];
let runs = 0, prCount = 0, remoteRef = '', pull = null;
const fixtureFetch = async (url, init) => {
 const path = new URL(String(url)).pathname + new URL(String(url)).search, method = init?.method ?? 'GET';
 const body = init?.body ? JSON.parse(init.body) : null;
 const json = (data) => Response.json(data);
 if (path === '/login/oauth/access_token') return json({ access_token: 'ghu_test', refresh_token: 'ghr_test', expires_in: 28800, refresh_token_expires_in: 15897600, scope: '' });
 if (path === '/user') return json({ login: 'browser-fixture' });
 if (path === '/repos/owner/fixture') return json({ id: 1, full_name: 'owner/fixture', permissions: { push: true } });
 if (path.includes('/branches/')) return json({ commit: { sha: 'b'.repeat(40) } });
 if (path.includes('/git/commits/') && method === 'GET') return json({ tree: { sha: 'c'.repeat(40) } });
 if (path.includes('/git/trees/') && method === 'GET') return json({ tree: files.map((f, i) => ({ path: f.path, size: Buffer.byteLength(f.content_base64, 'base64'), type: 'blob', mode: '100644', sha: `blob${i}` })), truncated: false });
 if (path.includes('/git/blobs/blob')) return json({ encoding: 'base64', content: files[Number(path.at(-1))].content_base64 });
 if (path.endsWith('/git/blobs') || path.endsWith('/git/trees') || path.endsWith('/git/commits')) return json({ sha: 'd'.repeat(40) });
 if (path.includes('/git/matching-refs/')) return json(remoteRef ? [{ ref: remoteRef, object: { sha: 'd'.repeat(40) } }] : []);
 if (path.endsWith('/git/refs')) { remoteRef = body.ref; return json({}); }
 if (path.includes('/pulls?')) return json(pull ? [pull] : []);
 if (path.endsWith('/pulls')) { prCount++; pull = { html_url: 'https://github.com/owner/fixture/pull/1', head: { ref: body.head, sha: 'd'.repeat(40) } }; return json(pull); }
 throw new Error(`Unknown fixture path ${path}`);
};
const endpoint = { id: 'fixture', profileId: 'coding', label: 'Coding', provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiToken: 'fake-browser-model', quotaGroup: 'fixture', dailyRuns: 20, maxConcurrent: 2 };
const port = 4199, origin = `http://127.0.0.1:${port}`;
const server = await startCollaborationServer({ databasePath: join(directory, 'db'), staticDirectory: resolve('apps/web/dist'), publicBaseUrl: origin,
 allowedOrigins: [origin], authTokenPepper: 'github-browser-private-test-pepper', hostedAgent: { endpoints: [endpoint], image: `sha256:${'a'.repeat(64)}`, userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 2,
 runContainer: async (args) => { runs++; const input = args.find((arg) => arg.endsWith('dst=/input,readonly')).split('src=')[1].split(',dst=')[0];
  const result = files.map((f) => file(f.path, readFileSync(join(input, f.path), 'utf8'))); result.find((f) => f.path === 'index.ts').content_base64 = Buffer.from('export const value = 2;\n').toString('base64');
  return JSON.stringify({ answer: 'Fixture: source changed; test and build checked.', files: result, save_error: null }); } },
 hostedGithub: { clientId: 'browser-fixture', clientSecret: 'test-app', encryptionKey: Buffer.alloc(32, 9).toString('base64'), callbackUrl: 'https://gt.example/v1/hosted-github/callback', appSlug: 'fixture', fetch: fixtureFetch } }, port);
try {
 const identity = server.database.bootstrapIdentity({ display_name: 'Cloud owner', device_name: 'Browser' });
 server.service.createSession(identity.actor, { session_id: 'browser-github-session', mode: 'solo', title: 'GitHub browser fixture', idempotency_key: 'browser-github-session' });
 for (const engine of ['chrome', 'webkit']) {
  const browser = await (engine === 'chrome' ? chromium.launch({ channel: 'chrome' }) : webkit.launch());
  try {
   for (const locale of ['en', 'zh-CN']) {
    remoteRef = ''; pull = null;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
    await page.addInitScript(({ locale, actor, origin }) => {
     localStorage.setItem('gt-lang', locale === 'en' ? 'en' : 'zh');
     localStorage.setItem(`gatherthread.onboarding.v1:${JSON.stringify([origin, actor.user_id, actor.device_id])}`, 'skipped');
    }, { locale, actor: identity.actor, origin });
    const login = await page.request.post(`${origin}/v1/browser-sessions`, { headers: { authorization: `Bearer ${identity.token}` }, data: { remember_device: false } });
    assert.equal(login.status(), 201);
    await page.route('https://github.com/login/oauth/authorize**', async (route) => {
      const state = new URL(route.request().url()).searchParams.get('state');
      await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(`${origin}/v1/hosted-github/callback?code=browser-fixture&state=${state}`)})</script>` });
    });
    await page.goto(`${origin}/app/`); await page.locator('#workspace').waitFor({ state: 'visible' });
    for (const dialog of await page.locator('dialog[open]').all()) { const button = dialog.locator('button').last(); await button.click(); }
    await page.locator('#agent-harness-select').selectOption('cloud');
    await page.locator('#cloud-github-open').click();
    await page.locator('#cloud-github-authorize').click();
    await page.waitForURL(`${origin}/app/`);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    for (const dialog of await page.locator('dialog[open]').all()) await dialog.locator('button').last().click();
    await page.locator('#agent-harness-select').selectOption('cloud');
    await page.locator('#cloud-github-open').click(); await page.locator('#cloud-github-repository-form').waitFor({ state: 'visible' });
    await page.locator('#cloud-github-repository').fill('owner/fixture');
    await page.locator('#cloud-github-repository-form button[type=submit]').click();
    await page.locator('#cloud-github-status').filter({ hasText: 'owner/fixture' }).waitFor();
    await page.locator('#cloud-github-close').click();
    await page.locator('#cloud-agent-source').selectOption('github');
    assert.equal(await page.locator('#cloud-agent-include-code').isVisible(), false);
    await page.locator('#message-input').fill('Change value to two and run the tests/build'); await page.locator('#send-agent-button').click();
    await page.getByText('Fixture: source changed; test and build checked.', { exact: false }).last().waitFor();
    await page.locator('#cloud-github-open').click();
    await page.locator('#cloud-github-task-list button').first().click();
    await page.locator('#cloud-github-changes summary').filter({ hasText: 'index.ts' }).waitFor();
    await page.locator('#cloud-github-changes summary').first().click();
    await page.locator('#cloud-github-continue').click();
    assert.equal(await page.locator('#agent-harness-select').inputValue(), 'cloud');
    assert.equal(await page.locator('#agent-cloud-model-select').inputValue(), 'coding');
    assert.equal(await page.locator('#cloud-agent-source').inputValue(), 'github');
    await page.locator('#cloud-github-open').click();
    await page.locator('#cloud-github-pr-title').fill('Reviewed fixture changes');
    await page.locator('#cloud-github-pr-body').fill('Fixture review');
    const previousPrs = prCount;
    await page.locator('#cloud-github-pr-form button[type=submit]').click(); await page.locator('#cloud-github-pr-link').waitFor({ state: 'visible' });
    assert.equal(prCount, previousPrs + 1);
    assert.equal(await page.locator('#cloud-github-pr-link').getAttribute('href'), 'https://github.com/owner/fixture/pull/1');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#cloud-github-close').isVisible());
    await page.screenshot({ path: join(tmpdir(), `gt-cloud-github-${engine}-${locale}.png`) });
    assert.ok(await page.locator('#cloud-github-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 2));
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#cloud-github-dialog').isVisible(), false);
    assert.deepEqual(errors, []); await page.close();
    process.stdout.write(`PASS ${engine} ${locale}: OAuth callback, repository bind, composer task, diff and explicit draft PR; mobile and Escape.\n`);
   }
  } finally { await browser.close(); }
 }
 assert.equal(runs, 4);
} finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
