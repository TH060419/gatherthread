import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { DesktopHost } from '../src/host.mjs';
import { ProgramStore } from '../src/program-store.mjs';
import { programCandidates } from '../src/program-discovery.mjs';
const root = new URL('../../../.local/desktop-build/discovery-tests/', import.meta.url);
async function fixture(t) {
  await mkdir(root, { recursive: true }); const dir = await mkdtemp(new URL('case-', root));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProgramStore(path.join(dir, 'preferences.json'));
  const executable = async (relative, version = 'codex-cli 0.166.0') => {
    const file = path.join(dir, relative); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 }); return file;
  };
  const host = options => new DesktopHost({ environment: 'test', origin: 'https://test.gatherthread.cn',
    resources: { node: process.execPath }, ui: {}, programStore: store, candidates: async () => [], ...options });
  return { dir, store, executable, host };
}
test('auto-detection prefers the saved location and verifies it again on restart', async t => {
  const f = await fixture(t), file = await f.executable('custom/codex');
  await f.store.set('codex', file);
  const first = f.host(); await first.discover('codex');
  assert.equal(first.status().executables[0].label, file);
  assert.equal(first.status().detection[0].remembered, true);
  await writeFile(file, "#!/bin/sh\nprintf 'codex-cli 0.167.0\\n'\n");
  const second = f.host(); await second.discover('codex');
  assert.equal(second.status().executables[0].version, 'codex-cli 0.167.0');
});
test('missing saved path recovers to a verified common install', async t => {
  const f = await fixture(t), file = await f.executable('bin/codex'); await f.store.set('codex', path.join(f.dir, 'gone'));
  const host = f.host({ candidates: async () => [file] }); await host.discover('codex');
  assert.equal(host.status().executables[0].label, file); assert.equal(await f.store.get('codex'), file);
});
test('corrupt or oversized preferences do not break discovery', async t => {
  const f = await fixture(t), file = await f.executable('bin/codex');
  for (const data of ['invalid JSON', 'x'.repeat(17000), JSON.stringify({ version: 1, programs: { codex: 'relative/path' } }),
    JSON.stringify({ version: 1, programs: {}, token: 'never accepted' })]) {
    await writeFile(f.store.file, data); assert.deepEqual(await f.store.read(), {});
    const host = f.host({ candidates: async () => [file] }); await host.discover('codex');
    assert.equal(host.status().executables[0].label, file);
  }
});
test('concurrent preferences writes keep both harnesses and private file permissions', async t => {
  const f = await fixture(t);
  await Promise.all([f.store.set('codex', '/test/codex'), f.store.set('claude-code', '/test/claude')]);
  assert.deepEqual(await f.store.read(), { codex: '/test/codex', 'claude-code': '/test/claude' });
  assert.equal((await stat(f.store.file)).mode & 0o777, 0o600);
});
for (const relative of ['Application.app/Contents/Resources/codex', 'npm-install/node_modules/.bin/codex'])
  test(`selecting the container resolves ${relative}`, async t => {
    const f = await fixture(t), file = await f.executable(relative);
    const selected = path.join(f.dir, relative.split('/')[0]);
    const host = f.host({ ui: { pickFile: async () => selected } }); await host.pickExecutable('codex');
    assert.equal(host.status().executables[0].label, file);
  });
test('wrong Agent type and empty directory are rejected without replacing a working choice', async t => {
  const f = await fixture(t), good = await f.executable('codex'), wrong = await f.executable('claude', '2.1.10 (Claude Code)');
  let selected = good; const host = f.host({ ui: { pickFile: async () => selected } }); await host.pickExecutable('codex');
  const original = host.status().executables[0];
  for (selected of [wrong, path.join(f.dir, 'no-such-app')]) {
    await assert.rejects(host.pickExecutable('codex'), { code: 'invalid_executable' });
    assert.deepEqual(host.status().executables[0], original); assert.equal(host.status().detection[0].state, 'ready');
  }
});
test('cancelled file picker restores state and allows another lookup', async t => {
  const f = await fixture(t), host = f.host({ ui: { pickFile: async () => null } });
  await host.pickExecutable('codex'); assert.equal(host.status().detection[0].state, 'idle');
  await host.discover('codex'); assert.equal(host.status().detection[0].state, 'missing');
});
test('refresh revalidates a removed executable and removes the stale choice', async t => {
  const f = await fixture(t), file = await f.executable('codex'), host = f.host({ candidates: async () => [file] });
  await host.discover('codex'); await rm(file); await host.discover('codex', true);
  assert.equal(host.status().executables.length, 0); assert.equal(host.status().detection[0].state, 'missing');
});
test('duplicate scan is coalesced and competing manual selection is refused', async t => {
  const f = await fixture(t), file = await f.executable('codex'); let release, entered, probes = 0;
  const ready = new Promise(r => { entered = r; });
  const host = f.host({ candidates: async () => [file], probe: async () => { probes++; entered(); await new Promise(r => { release = r; }); return 'codex-cli 0.166.0'; } });
  const first = host.discover('codex'); await ready;
  const second = host.discover('codex', true);
  await assert.rejects(host.pickExecutable('codex'), { code: 'executable_detection_busy' });
  release(); await Promise.all([first, second]); assert.equal(probes, 1);
});
test('disposed environment does not apply or remember an old probe result', async t => {
  const f = await fixture(t), file = await f.executable('codex'); let release, entered;
  const ready = new Promise(r => { entered = r; });
  const host = f.host({ candidates: async () => [file], probe: async () => { entered(); await new Promise(r => { release = r; }); return 'codex-cli 0.166.0'; } });
  const work = host.discover('codex'); await ready; host.cancelDiscovery(); release(); await work;
  assert.equal(host.status().executables.length, 0); assert.equal(await f.store.get('codex'), undefined);
});
test('unwritable preferences do not prevent a valid current-session choice', async t => {
  const f = await fixture(t), file = await f.executable('codex');
  const host = f.host({ programStore: new ProgramStore(path.join(file, 'impossible.json')), candidates: async () => [file] });
  await host.discover('codex'); assert.equal(host.status().detection[0].state, 'ready');
  assert.equal(host.status().detection[0].remembered, false);
});
test('aliases are probed once and failures are bounded without exposing raw diagnostics', async t => {
  const f = await fixture(t), files = []; let probes = 0;
  for (let i = 0; i < 6; i++) files.push(await f.executable(`candidate${i}`));
  const alias = path.join(f.dir, 'alias'); await symlink(files[0], alias);
  const host = f.host({ candidates: async () => [files[0], alias, ...files.slice(1)], probe: async () => {
    probes++; throw Object.assign(new Error('private native output'), { code: 'executable_terminated' });
  } });
  await host.discover('codex'); assert.equal(probes, 4); assert.equal(host.status().detection[0].error, 'executable_terminated');
  assert.doesNotMatch(JSON.stringify(host.status()), /private native output/);
});
test('version-manager search is bounded, prefers recent Node, and ignores relative and app-private PATH entries', async t => {
  const f = await fixture(t);
  for (const version of ['v20.1.0', 'v24.0.0', 'v22.1.0']) await mkdir(path.join(f.dir, '.nvm/versions/node', version), { recursive: true });
  const candidates = await programCandidates('codex', { home: f.dir,
    searchPath: '.:relative:/Applications/ChatGPT.app/Contents/bin:/custom/bin' });
  assert.ok(candidates.includes('/custom/bin/codex'));
  assert.ok(!candidates.some(p => p.includes('.app/Contents/') || !path.isAbsolute(p)));
  assert.ok(candidates.indexOf(path.join(f.dir, '.nvm/versions/node/v24.0.0/bin/codex')) < candidates.indexOf(path.join(f.dir, '.nvm/versions/node/v20.1.0/bin/codex')));
});

test('automatic discovery does not execute PATH aliases into app-private programs', async t => {
  const f = await fixture(t), internal = await f.executable('ChatGPT.app/Contents/MacOS/codex');
  const alias = path.join(f.dir, 'codex'); await symlink(internal, alias);
  let probes = 0;
  const host = f.host({ candidates: async () => [alias], probe: async () => { probes++; return 'codex-cli 0.166.0'; } });
  await host.discover('codex'); assert.equal(probes, 0); assert.equal(host.status().detection[0].state, 'missing');
});
