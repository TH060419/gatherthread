import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHandoff, connectorArguments, childEnvironment, isWorkspaceURL, isWorkspaceDownload, isWorkspacePermission, externalURL, WEB_PREFERENCES } from '../src/policy.mjs';
import { DesktopActionSchema, DesktopResultSchema } from '@gatherthread/protocol';
const vectors = JSON.parse(await readFile(new URL('../../../prototypes/codex-launcher/contract-vectors.json', import.meta.url), 'utf8'));
for (const vector of vectors.accepted) test(`shared Launcher contract accepts: ${vector.name}`, () => {
  const v = parseHandoff(vector.uri);
  const actual = [v.origin, v.project, v.model, v.contextTokens, v.historySync];
  if (v.version !== '1') actual.push(v.email, v.authorizationId);
  if (v.version === '3') actual.push(v.harness);
  assert.deepEqual(actual, vector.parsed);
});
for (const [i, raw] of vectors.rejected_uris.entries()) test(`shared Launcher contract refuses malformed vector ${i}`, () => {
  assert.throws(() => parseHandoff(raw), { code: 'invalid_handoff' });
});
test('remote pages never receive Node, a WebView or permissive web security', () => {
  assert.deepEqual([WEB_PREFERENCES.nodeIntegration, WEB_PREFERENCES.contextIsolation, WEB_PREFERENCES.sandbox,
    WEB_PREFERENCES.webSecurity, WEB_PREFERENCES.webviewTag, WEB_PREFERENCES.allowRunningInsecureContent], [false, true, true, true, false, false]);
  assert.equal('preload' in WEB_PREFERENCES, false);
});
test('navigation accepts exact origins and opens no executable custom protocols', () => {
  assert.equal(isWorkspaceURL('https://gatherthread.cn/app/#project=abc', 'https://gatherthread.cn'), true);
  for (const url of ['https://gatherthread.cn.evil.example/', 'https://gatherthread.cn@evil.example/',
    'https://u:p@gatherthread.cn/', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(isWorkspaceURL(url, 'https://gatherthread.cn'), false);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'shell:run', 'https://u:p@example.com/']) assert.equal(externalURL(url), null);
});
test('connector arguments preserve exact native routing and do not use a shell', () => {
  const link = parseHandoff(vectors.accepted.find(v => v.input.harness === 'claude-code').uri);
  const args = connectorArguments(link, { connector: '/app/connector.mjs', executable: '/app/claude',
    workspace: '/project/a space;$(never execute)', codeSync: false });
  assert.ok(args.includes('/project/a space;$(never execute)')); assert.ok(args.includes('--claude-command'));
  assert.ok(!args.includes('--codex-command')); assert.ok(!args.includes('--code-sync')); assert.ok(!args.includes('--visible-history-sync'));
});
test('unrelated secrets and executable injection variables never enter the child environment', () => {
  const e = childEnvironment({ HOME: '/home/test', PATH: '/evil/bin', NODE_OPTIONS: '--import evil.mjs',
    DYLD_INSERT_LIBRARIES: '/evil.dylib', OPENAI_API_KEY: 'private', GATHERTHREAD_TOKEN: 'old' },
  { token: 'fixture-token', runtimeDirectory: '/runtime', home: '/home/test' });
  assert.equal(e.GATHERTHREAD_TOKEN, 'fixture-token'); assert.equal(e.NODE_OPTIONS, undefined);
  assert.equal(e.DYLD_INSERT_LIBRARIES, undefined); assert.equal(e.OPENAI_API_KEY, undefined);
  assert.ok(!e.PATH.includes('/evil'));
});
test('desktop IPC does not accept paths, endpoints, arbitrary commands or response secrets', () => {
  for (const input of [{ action: 'status', token: 'secret' }, { action: 'exec', command: 'anything' },
    { action: 'select_workspace', path: '/private' }, { action: 'start', password: 'password1', executable: '/bin/sh' }])
    assert.equal(DesktopActionSchema.safeParse(input).success, false);
  assert.equal(DesktopResultSchema.safeParse({ ok: false, error: 'provider-secret' }).success, false);
});
test('permission and download scopes reject subframes, stale windows and foreign blobs', () => {
  const origin = 'https://gatherthread.cn', owner = { native: false, current: true, isMainFrame: true, requestingUrl: `${origin}/app/` };
  assert.equal(isWorkspacePermission(owner, origin), true);
  for (const change of [{ native: true }, { current: false }, { isMainFrame: false }, { requestingUrl: 'https://evil.invalid/' }])
    assert.equal(isWorkspacePermission({ ...owner, ...change }, origin), false);
  assert.equal(isWorkspaceDownload(`blob:${origin}/fixture`, origin), true);
  assert.equal(isWorkspaceDownload(`${origin}/v1/attachment`, origin), true);
  for (const url of ['blob:https://evil.invalid/fixture', 'blob:null/fixture', 'file:///etc/passwd', 'data:text/plain,fixture'])
    assert.equal(isWorkspaceDownload(url, origin), false);
});
test('handoffs reject invalid UTF-8 and URL-normalized control characters', () => {
  const raw = vectors.accepted[0].uri;
  for (const uri of [raw.replace('model=', 'model=%ff'), raw.replace('connect?', 'con\nnect?'), ` ${raw}`])
    assert.throws(() => parseHandoff(uri), { code: 'invalid_handoff' });
});
