import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { DesktopHost, inspectFile } from '../src/host.mjs';
import { ConnectorSupervisor } from '../src/supervisor.mjs';
const root = new URL('../../../.local/desktop-build/host-tests/', import.meta.url);
async function fixture(t, claim = async () => 'fixture-credential') {
  await mkdir(root, { recursive: true }); const dir = await mkdtemp(new URL('case-', root));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'fixture-agent'); await writeFile(executable, '#!/bin/false\n', { mode: 0o700 });
  const workspace = path.join(dir, 'project'); await mkdir(workspace);
  let starts = 0; const children = [];
  const supervisor = new ConnectorSupervisor({ groupAlive: () => false, spawnImpl(command, args, options) {
    starts++; assert.equal(command, process.execPath); assert.equal(options.shell, false);
    assert.equal(options.env.GATHERTHREAD_TOKEN, 'fixture-credential');
    assert.ok(!args.includes('fixture-credential'));
    const child = new EventEmitter(); Object.assign(child, { pid: 123456, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }); children.push(child); return child;
  } });
  t.after(() => { supervisor.stopAll(); for (const c of children) c.emit('exit', 0); });
  const host = new DesktopHost({ environment: 'test', origin: 'https://test.gatherthread.cn', supervisor, claim,
    resources: { node: process.execPath, codex: executable }, ui: { pickDirectory: async () => workspace } });
  const exeId = randomUUID(); host.executables.set(exeId, { ...await inspectFile(executable, true), id: exeId, harness: 'codex', version: 'fixture' });
  await host.pickWorkspace();
  const query = new URLSearchParams({ v: '2', origin: host.origin, project: 'fixture-project', model: 'fixture',
    context_window_tokens: '65536', visible_history_sync: 'never', email: 'fixture@example.invalid', authorization_id: randomUUID() });
  const link = `gatherthread-connect://connect?${query}`; host.acceptHandoff(link);
  const input = () => ({ action: 'start', handoff_id: host.status().handoff.id, executable_id: exeId,
    workspace_id: host.workspace.id, password: 'fixture1', code_sync: false });
  return { host, input, link, executable, workspace, starts: () => starts };
}
test('double submit reserves only one process and keeps credentials out of IPC state', async t => {
  let release, claimed; const ready = new Promise(r => { claimed = r; });
  const f = await fixture(t, () => { claimed(); return new Promise(r => { release = r; }); });
  const input = f.input(), first = f.host.action(input); await ready;
  await assert.rejects(f.host.action(input)); release('fixture-credential'); await first;
  assert.equal(f.starts(), 1); assert.doesNotMatch(JSON.stringify(f.host.status()), /fixture1|fixture-credential/);
  assert.throws(() => f.host.acceptHandoff(f.link), { code: 'handoff_used' });
});
test('stop during authorization fences a late successful claim', async t => {
  let release, claimed; const ready = new Promise(r => { claimed = r; });
  const f = await fixture(t, () => { claimed(); return new Promise(r => { release = r; }); });
  const operation = f.host.action(f.input()); await ready;
  f.host.supervisor.stop(f.host.status().connections[0].id); release('fixture-credential');
  await assert.rejects(operation, { code: 'cancelled' }); assert.equal(f.starts(), 0);
  assert.equal(f.host.status().connections[0].state, 'stopped');
});
for (const replace of ['executable', 'workspace']) test(`changing ${replace} during authorization prevents launch`, async t => {
  let release, claimed; const ready = new Promise(r => { claimed = r; });
  const f = await fixture(t, () => { claimed(); return new Promise(r => { release = r; }); });
  const operation = f.host.action(f.input()); await ready;
  await rename(f[replace], f[replace] + '-old');
  if (replace === 'workspace') await mkdir(f.workspace); else await writeFile(f.executable, '#!/bin/false\n', { mode: 0o700 });
  release('fixture-credential'); await assert.rejects(operation, { code: replace === 'workspace' ? 'invalid_workspace' : 'invalid_executable' });
  assert.equal(f.starts(), 0); assert.equal(f.host.status().connections[0].state, 'failed');
});
test('wrong environment and renderer-invented paths never reach native launch', async t => {
  const f = await fixture(t); assert.throws(() => f.host.acceptHandoff(f.link.replace('test.gatherthread.cn', 'gatherthread.cn')), { code: 'wrong_environment' });
  await assert.rejects(f.host.action({ ...f.input(), workspace_id: randomUUID() }), { code: 'invalid_workspace' });
  await assert.rejects(f.host.action({ ...f.input(), command: '/bin/sh' })); assert.equal(f.starts(), 0);
});
