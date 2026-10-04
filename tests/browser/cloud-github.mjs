// Actual HTTP/UI integration with fake GitHub and container responses. No real account, model or PR.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCollaborationServer } from '../../apps/server/dist/src/server.js';
import { TestGateStore } from '../../apps/server/dist/src/test-gate.js';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gt-github-browser-')));
const mails = new Map();
const file = (path, content) => ({ path, content_base64: Buffer.from(content).toString('base64'), executable: false });
const files = [file('package.json', '{"name":"fixture","version":"1.0.0"}'), file('package-lock.json', '{"lockfileVersion":3,"packages":{"":{}}}'), file('index.ts', 'export const value = 1;\n')];
let runs = 0, prCount = 0, oauthCompletions = 0, remoteRef = '', pull = null;
const fixtureFetch = async (url, init) => {
 const path = new URL(String(url)).pathname + new URL(String(url)).search, method = init?.method ?? 'GET';
 const body = init?.body ? JSON.parse(init.body) : null;
 const json = (data) => Response.json(data);
 if (path === '/login/oauth/access_token') { oauthCompletions++; return json({ access_token: 'ghu_test', refresh_token: 'ghr_test', expires_in: 28800, refresh_token_expires_in: 15897600, scope: '' }); }
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
const admissionEnabled = process.env.GATHERTHREAD_TEST_GITHUB_ADMISSION === '1';
const gate = { databasePath: join(directory, 'admission.sqlite'), origin, pepper: randomBytes(32).toString('hex') };
const gateAdmin = admissionEnabled ? new TestGateStore(gate) : null;
async function waitForWorkspace(page, sessionId) {
 await page.locator('#workspace').waitFor({ state: 'visible' });
 await page.waitForFunction((id) => new URLSearchParams(location.hash.slice(1)).get('session') === id
   && document.getElementById('global-connection')?.dataset.state === 'live', sessionId);
}
const server = await startCollaborationServer({ databasePath: join(directory, 'db'), staticDirectory: resolve('apps/web/dist'), publicBaseUrl: origin,
 ...(admissionEnabled ? { testGate: gate } : {}),
 allowedOrigins: [origin], authTokenPepper: 'github-browser-private-test-pepper',
 registration: { enabled: true, origin, siteKey: 'synthetic-browser',
  mailer: { async send(mail) { mails.set(mail.email, mail.code); } }, challenge: { async verify() { return true; } } },
 hostedAgent: { endpoints: [endpoint], image: `sha256:${'a'.repeat(64)}`, userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 2,
 runContainer: async (args) => { runs++; const input = args.find((arg) => arg.endsWith('dst=/input,readonly')).split('src=')[1].split(',dst=')[0];
  const result = files.map((f) => file(f.path, readFileSync(join(input, f.path), 'utf8'))); result.find((f) => f.path === 'index.ts').content_base64 = Buffer.from('export const value = 2;\n').toString('base64');
  return JSON.stringify({ answer: 'Fixture: source changed; test and build checked.', files: result, save_error: null }); } },
 hostedGithub: { clientId: 'browser-fixture', clientSecret: 'test-app', encryptionKey: Buffer.alloc(32, 9).toString('base64'), callbackUrl: 'https://gt.example/v1/hosted-github/callback', appSlug: 'fixture', fetch: fixtureFetch } }, port);
try {
 for (const engine of ['chrome', 'webkit']) {
  const browser = await (engine === 'chrome' ? chromium.launch({ channel: 'chrome' }) : webkit.launch());
  try {
   for (const locale of ['en', 'zh-CN']) {
    // Each browser/language variant gets its own user; production cooldown remains enabled.
    remoteRef = ''; pull = null;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
    // Use the current verified-email/password HTTP flow with synthetic providers.
    const email = `${engine}-${locale.toLowerCase()}@example.invalid`, password = 'synthetic browser password 42';
    const post = (path, data) => page.request.post(`${origin}${path}`, { headers: { origin }, data });
    const grant = gateAdmin?.issue(1, 1)[0];
    if (admissionEnabled) assert.equal((await post('/v1/test-gate', { admission_code: grant.admission_code })).status(), 200);
    assert.equal((await page.request.get(`${origin}/v1/registration`)).status(), 200);
    const callbackStatuses = [];
    page.on('response', response => { if (new URL(response.url()).pathname === '/v1/hosted-github/callback') callbackStatuses.push(response.status()); });
    const sent = await post('/v1/registration/send', { email, locale, challenge_token: randomUUID(), idempotency_key: randomUUID() });
    assert.equal(sent.status(), 202);
    const pending = (await sent.json()).data;
    const verified = await post('/v1/registration/verify', { registration_id: pending.registration_id, code: mails.get(email),
     display_name: `Cloud owner ${engine} ${locale}`, device_name: 'Browser', password, privacy_acknowledged: true, remember_device: false });
    assert.equal(verified.status(), 201);
    const login = await post('/v1/email-login', { email, password, device_name: 'Browser', remember_device: false });
    assert.equal(login.status(), 201);
    const identity = (await login.json()).data;
    assert.equal('token' in identity, false);
    const sessionId = `browser-github-${engine}-${locale}`;
    server.service.createSession(identity.actor, { session_id: sessionId, mode: 'solo', title: 'GitHub browser fixture', idempotency_key: sessionId });
    await page.addInitScript(({ locale, actor, origin }) => {
     localStorage.setItem('gt-lang', locale === 'en' ? 'en' : 'zh');
     localStorage.setItem(`gatherthread.onboarding.v1:${JSON.stringify([origin, actor.user_id, actor.device_id])}`, 'skipped');
    }, { locale, actor: identity.actor, origin });
    await page.route('https://github.com/login/oauth/authorize**', async (route) => {
      const state = new URL(route.request().url()).searchParams.get('state');
      await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(`${origin}/v1/hosted-github/callback?code=browser-fixture&state=${state}`)})</script>` });
    });
    await page.goto(`${origin}/app/`); await waitForWorkspace(page, sessionId);
    // Synchronize the initial notice explicitly instead of enumerating dialogs while startup is rendering.
    await page.locator('#code-notice-continue').waitFor({ state: 'visible' });
    await page.locator('#code-notice-continue').press('Enter');
    await page.locator('#code-notice-dialog').waitFor({ state: 'hidden' });
    await page.locator('#project-code-button').click();
    await page.locator('#code-enable-section').waitFor({ state: 'visible' });
    const gtCloudStatus = await page.locator('#code-repository-status').textContent();
    await page.locator('#code-provider-github').click();
    assert.equal(await page.locator('#code-provider-github').getAttribute('aria-pressed'), 'true');
    await page.locator('#github-code-repository').fill('owner/device-fixture');
    await page.locator('#github-code-save').click();
    await page.locator('#code-confirm-accept').click();
    await page.locator('#github-code-files').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#github-code-files').getAttribute('href'), 'https://github.com/owner/device-fixture/tree/main');
    await page.locator('#code-provider-gt-cloud').click();
    assert.equal(await page.locator('#code-repository-status').textContent(), gtCloudStatus);
    await page.locator('#code-provider-github').click();
    await page.locator('#cloud-github-authorize').click();
    await page.waitForURL(`${origin}/app/`);
    if (admissionEnabled) assert.deepEqual(callbackStatuses, [403, 303], 'cross-site Strict-cookie callback is denied, then retried under live same-site admission');
    await waitForWorkspace(page, sessionId);
    await page.locator('#code-notice-dialog').waitFor({ state: 'hidden' });
    await page.locator('#project-code-button').click();
    await page.locator('#code-provider-github').click(); await page.locator('#cloud-github-repository-form').waitFor({ state: 'visible' });
    await page.locator('#cloud-github-repository').fill('owner/fixture');
    await page.locator('#cloud-github-repository-form button[type=submit]').click();
    await page.locator('#cloud-github-status').filter({ hasText: 'owner/fixture' }).waitFor();
    assert.equal(await page.locator('#cloud-github-new').isDisabled(), true);
    assert.equal(await page.locator('#cloud-github-continue').isDisabled(), true);
    assert.equal(await page.locator('#cloud-github-dialog').count(), 0);
    assert.equal(await page.locator('#cloud-github-open').count(), 0);
    const beforeRuns = runs;
    await page.locator('#close-project-code-button').click();
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#settings-enabled-cloud').isDisabled(), true);
    assert.equal(await page.locator('#settings-enabled-cloud').isChecked(), false);
    assert.equal(await page.locator('#settings-enabled-codex').isDisabled(), true);
    await page.locator('#settings-enabled-codex').evaluate((control) => { control.checked = false; control.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.locator('#settings-enabled-codex').isChecked(), true);
    assert.equal(await page.locator('#settings-agent-harness').inputValue(), 'codex');
    assert.equal(await page.locator('#settings-cloud-agent-fields').isVisible(), false);
    assert.equal(await page.locator('#settings-agent-harness option[value=cloud]').evaluate((option) => option.disabled), true);
    await page.locator('#cancel-settings-button').click();
    // An earlier cloud selection is retained without a silent fallback or a model call.
    await page.evaluate((locale) => {
      localStorage.setItem('gatherthread.settings.v1', JSON.stringify({ version: 13,
        general: { locale }, agents: { activeHarness: 'cloud', enabledHarnesses: ['cloud'] } }));
    }, locale);
    await page.reload(); await waitForWorkspace(page, sessionId);
    await page.waitForFunction(() => document.getElementById('agent-harness-select').value === 'cloud');
    assert.equal(await page.locator('#agent-harness-select').inputValue(), 'cloud');
    assert.equal(await page.locator('#agent-harness-select option[value=cloud]').evaluate((option) => option.disabled), true);
    assert.equal(await page.locator('#send-agent-button').isDisabled(), true);
    assert.equal(await page.locator('#send-cloud-agent-help').isVisible(), false);
    // Reload exposes a temporary history-sync status before locale and final availability settle.
    await page.locator('#agent-target-label').filter({ hasText: locale === 'en' ? /coming later/ : /后续开放/ }).waitFor({ state: 'visible' });
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#settings-agent-harness').inputValue(), 'codex');
    assert.equal(await page.locator('#settings-enabled-codex').isDisabled(), true);
    assert.equal(await page.locator('#settings-cloud-agent-fields').isVisible(), false);
    await page.locator('#cancel-settings-button').click();
    assert.equal(await page.locator('#agent-harness-select').inputValue(), 'cloud');
    await page.locator('#message-input').fill('Must not start a cloud run');
    await page.locator('#send-agent-button').evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(runs, beforeRuns);
    await page.locator('#agent-harness-select').selectOption('codex');
    // Seed an existing completed task through the fixture API; the held UI cannot start it.
    const seeded = await page.request.post(`${origin}/v1/sessions/${sessionId}/hosted-github-tasks`, {
      headers: { origin }, data: { content: 'Fixture task to review', profile_id: 'coding', idempotency_key: `fixture-${engine}-${locale}` }
    });
    assert.equal(seeded.status(), 202);
    await page.locator('#project-code-button').click();
    await page.locator('#code-provider-github').click();
    await page.getByText('Fixture: source changed; test and build checked.', { exact: false }).last().waitFor();
    const beforeLimited = runs;
    const limited = await page.request.post(`${origin}/v1/sessions/${sessionId}/hosted-github-tasks`, {
      headers: { origin }, data: { content: 'Must wait for cooldown', profile_id: 'coding', idempotency_key: `rate-${engine}-${locale}` }
    });
    assert.equal(limited.status(), 429);
    const { error } = await limited.json();
    assert.equal(error.code, 'hosted_user_rate_limit');
    assert.ok(error.details.retry_after_seconds > 0 && error.details.retry_after_seconds <= 30);
    assert.equal(runs, beforeLimited);
    await page.locator('#cloud-github-task-list button').first().click();
    await page.locator('#cloud-github-changes summary').filter({ hasText: 'index.ts' }).waitFor();
    await page.locator('#cloud-github-changes summary').first().click();
    assert.equal(await page.locator('#cloud-github-continue').isDisabled(), true);
    await page.locator('#cloud-github-pr-title').fill('Reviewed fixture changes');
    await page.locator('#cloud-github-pr-body').fill('Fixture review');
    const previousPrs = prCount;
    await page.locator('#cloud-github-pr-form button[type=submit]').click(); await page.locator('#cloud-github-pr-link').waitFor({ state: 'visible' });
    assert.equal(prCount, previousPrs + 1);
    assert.equal(await page.locator('#cloud-github-pr-link').getAttribute('href'), 'https://github.com/owner/fixture/pull/1');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#close-project-code-button').isVisible());
    await page.screenshot({ path: join(tmpdir(), `gt-cloud-github-${engine}-${locale}.png`) });
    assert.ok(await page.locator('#project-code-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 2));
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#project-code-dialog').isVisible(), false);
    assert.equal(await page.locator('#project-code-button').evaluate((button) => document.activeElement === button), true);
    if (admissionEnabled) {
      const authorization = await post('/v1/hosted-github/authorize', {});
      assert.equal(authorization.status(), 200);
      const next = (await authorization.json()).data.authorization_url;
      const previousCompletions = oauthCompletions;
      const credentials = server.database.sqlite.prepare('SELECT credentials FROM hosted_github_accounts WHERE user_id=?').get(identity.actor.user_id).credentials;
      gateAdmin.revoke(grant.grant_id); callbackStatuses.length = 0;
      const admissionResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/test-gate');
      await page.goto(next); await page.locator('#gate-form').waitFor({ state: 'visible' });
      assert.equal((await (await admissionResponse).json()).data.admitted, false);
      assert.deepEqual(callbackStatuses, [403]);
      assert.equal(new URL(page.url()).pathname, '/v1/hosted-github/callback');
      assert.equal(oauthCompletions, previousCompletions);
      assert.equal(server.database.sqlite.prepare('SELECT credentials FROM hosted_github_accounts WHERE user_id=?').get(identity.actor.user_id).credentials, credentials);
    }
    assert.deepEqual(errors, []); await page.close();
    process.stdout.write(`PASS ${engine} ${locale}: single Cloud Git panel, held Agent entry, OAuth callback, repository bind, saved diff and explicit draft PR; user cooldown refusal, mobile and Escape.\n`);
   }
  } finally { await browser.close(); }
 }
 assert.equal(runs, 4);
} finally { await server.close(); gateAdmin?.close(); rmSync(directory, { recursive: true, force: true }); }
