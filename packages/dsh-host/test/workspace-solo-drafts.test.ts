import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function fixture() {
  const source = (await readFile(new URL('../../client/client.js', import.meta.url), 'utf8'))
    .replace('module.exports = { inject, apply };', 'module.exports = { leaveWorkspaceSolo };');
  let api: any;
  vm.runInNewContext(source, { AbortController, setTimeout, clearTimeout, window: { __ModuleLoader__: {
    load(value: any) { api = value.factory(() => ({})); },
  } } });
  const seat = { connectionId: 'connection-a', projectId: 'project-a', sessionId: 'session-a', controller: new AbortController() };
  const key = JSON.stringify([seat.projectId, seat.sessionId]);
  const memory: any = { drafts: {}, attempts: {}, fileDrafts: {}, soloDrafts: { [key]: seat.connectionId } };
  const calls: any[] = [];
  const state = { fail: false, discarded: true, sessionId: seat.sessionId };
  const connection = { rpc: { async call(_channel: string, _endpoint: string, input: any) {
    calls.push(input);
    if (state.fail) throw new Error('network failed');
    return { ok: true, value: { connectionId: seat.connectionId, projectId: seat.projectId,
      sessionId: state.sessionId, discarded: state.discarded } };
  } } };
  return { seat, key, memory, calls, state, leave: () => api.leaveWorkspaceSolo(connection, memory, seat) };
}

for (const reason of ['existing', 'other-account', 'draft', 'pending-send', 'file-draft'] as const) {
  test(`Solo cleanup preserves ${reason}`, async () => {
    const f = await fixture();
    if (reason === 'existing') delete f.memory.soloDrafts[f.key];
    if (reason === 'other-account') f.memory.soloDrafts[f.key] = 'old-connection';
    if (reason === 'draft') f.memory.drafts[f.key] = '未发送的想法';
    if (reason === 'pending-send') f.memory.attempts[f.key] = { idempotencyKey: 'unknown-receipt' };
    if (reason === 'file-draft') f.memory.fileDrafts[JSON.stringify([f.seat.connectionId, f.seat.projectId, f.seat.sessionId])] = { text: '未保存文件' };
    await f.leave(); assert.equal(f.calls.length, 0);
  });
}
test('cleanup uses only the conditional endpoint and accepts concurrent-content preservation', async () => {
  const f = await fixture(); f.state.discarded = false;
  await f.leave();
  assert.equal(f.calls[0].action, 'discardEmptySolo');
  assert.equal(f.calls.length, 1);
  assert.equal(f.memory.soloDrafts[f.key], undefined);
});
test('failure and wrong-scope receipts retain the candidate; retry never falls back to delete', async () => {
  const f = await fixture(); f.state.fail = true;
  await assert.rejects(f.leave(), /network failed/);
  assert.equal(f.memory.soloDrafts[f.key], f.seat.connectionId);
  f.state.fail = false; f.state.sessionId = 'other-session';
  await assert.rejects(f.leave(), /workspace_invalid_response/);
  assert.equal(f.memory.soloDrafts[f.key], f.seat.connectionId);
  f.state.sessionId = f.seat.sessionId;
  await f.leave();
  assert.equal(f.memory.soloDrafts[f.key], undefined);
  assert.ok(f.calls.every(call => call.action === 'discardEmptySolo'));
});
