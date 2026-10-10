import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runOpencodeSession } from '../../ops/hosted-agent/opencode-session.mjs';

const workspace = '/workspace/project';
const finalReply = () => ({
  info: { id: 'msg_final', sessionID: 'ses_fixture', role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop' },
  parts: [{ id: 'part_final', sessionID: 'ses_fixture', messageID: 'msg_final', type: 'text', text: 'Done' },
    { type: 'reasoning', text: 'private thought' }, { type: 'tool', state: { output: 'private tool output' } }],
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fixture(overrides = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.closed = false;
  child.kill = (signal) => {
    child.kills.push(signal);
    if (overrides.shutdownOverflow && !child.overflowInjected) {
      child.overflowInjected = true; child.stderr.write('X'.repeat(65_000));
    }
    if (!overrides.holdClose && !(overrides.holdTermClose && signal === 'SIGTERM') && !child.closed) setImmediate(() => {
      const code = overrides.closeCode ?? null;
      const closeSignal = overrides.closeCode === undefined ? signal : null;
      child.closed = true; child.emit('exit', code, closeSignal); child.emit('close', code, closeSignal);
    });
    return true;
  };
  const requests = [], spawns = [];
  const options = {
    spawnProcess: (...args) => { spawns.push(args); return child; },
    fetchResponse: async (url, init) => {
      const path = new URL(url).pathname;
      requests.push({ path, init });
      assert.equal(new URL(url).origin, 'http://127.0.0.1:8790');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['x-opencode-directory'], workspace);
      if (overrides.fetch) return overrides.fetch(path, init, child);
      if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
      if (path === '/session') return json({ id: 'ses_fixture' });
      if (path === '/session/ses_fixture/message') return json(finalReply());
      if (path === '/session/status') return json({});
      assert.fail('unexpected API route');
    },
  };
  return { child, requests, spawns, options };
}

test('one loopback server waits for completed HTTP reply and idle, then closes before returning', async () => {
  const f = fixture();
  assert.equal(await runOpencodeSession(workspace, 'The task', 64_000, f.options), 'Done');
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0][0], 'opencode');
  assert.deepEqual(f.spawns[0][1], ['serve', '--hostname', '127.0.0.1', '--port', '8790', '--no-mdns']);
  assert.equal(f.spawns[0][2].cwd, workspace);
  assert.equal(f.spawns[0][2].env.PWD, workspace);
  assert.deepEqual(f.spawns[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(f.requests.map(r => r.path), ['/global/health', '/session', '/session/ses_fixture/message', '/session/status']);
  assert.deepEqual(JSON.parse(f.requests[2].init.body), { agent: 'build', parts: [{ type: 'text', text: 'The task' }] });
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal(f.child.closed, true);
});

test('early text never kills the harness or finishes a task before the final HTTP response', async () => {
  let resolveMessage, enteredMessage;
  const entered = new Promise(resolve => { enteredMessage = resolve; });
  const f = fixture({ fetch: async (path) => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    if (path === '/session/status') return json({});
    enteredMessage(); return new Promise(resolve => { resolveMessage = resolve; });
  } });
  let settled = false;
  const pending = runOpencodeSession(workspace, 'The task', 64_000, f.options).finally(() => { settled = true; });
  await entered;
  f.child.stdout.write('{"type":"text","part":{"text":"early partial text"}}\n');
  await delay(10);
  assert.equal(settled, false); assert.deepEqual(f.child.kills, []);
  resolveMessage(json(finalReply()));
  assert.equal(await pending, 'Done');
  assert.equal(f.child.closed, true);
});

test('completed final waits for the same session to become idle before stopping', async () => {
  let statusCalls = 0;
  const f = fixture({ fetch: async (path) => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    if (path.endsWith('/message')) return json(finalReply());
    assert.deepEqual(f.child.kills, []);
    return json(++statusCalls === 1 ? { ses_fixture: { type: 'busy' } } : {});
  } });
  assert.equal(await runOpencodeSession(workspace, 'The task', 64_000, f.options), 'Done');
  assert.equal(statusCalls, 2);
});

test('partial or provider-error prompt results fail without publishing raw error or private data', async () => {
  for (const variant of ['partial', 'error', 'wrongSession']) {
    const f = fixture({ fetch: async (path) => {
      if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
      if (path === '/session') return json({ id: 'ses_fixture' });
      const r = finalReply();
      if (variant === 'partial') delete r.info.time.completed;
      if (variant === 'error') r.info.error = { message: 'private-provider-credential-fixture' };
      if (variant === 'wrongSession') r.info.sessionID = 'ses_other';
      return json(r);
    } });
    await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
    assert.equal(f.child.closed, true);
    assert.equal(f.requests.some(r => r.path === '/session/status'), false);
  }
});

test('version mismatch, malformed session, HTTP error, oversized body and non-JSON each close fail-closed', async () => {
  for (const variant of ['version', 'session', 'http', 'size', 'type']) {
    const f = fixture({ fetch: async (path) => {
      if (path === '/global/health') return json({ healthy: true, version: variant === 'version' ? 'other' : '1.18.32' });
      if (path === '/session') return json({ id: variant === 'session' ? '../different' : 'ses_fixture' });
      if (variant === 'http') return json({ error: 'private error' }, 401);
      if (variant === 'size') return json({ info: 'X'.repeat(65_000) });
      if (variant === 'type') return new Response('private non-JSON data', { headers: { 'content-type': 'text/plain' } });
      assert.fail('unexpected request');
    } });
    await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
    assert.equal(f.child.closed, true);
    assert.equal(f.spawns.length, 1);
  }
});

test('process exit aborts outstanding HTTP; the task does not keep waiting after executor failure', async () => {
  const f = fixture({ fetch: async (path, init, child) => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      setImmediate(() => { child.closed = true; child.emit('exit', 1); child.emit('close', 1); });
    });
  } });
  await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
  assert.deepEqual(f.child.kills, []);
});

test('server diagnostic output is bounded and never interpreted as public answer', async () => {
  const f = fixture({ fetch: async (path, init, child) => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      child.stderr.write('private stderr'.repeat(6000));
    });
  } });
  await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
  assert.equal(f.child.kills[0], 'SIGKILL'); assert.equal(f.child.closed, true);
});

test('a server that never closes is killed and cannot publish a successful answer', async () => {
  const f = fixture({ holdClose: true });
  await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
});

test('nonzero shutdown, shutdown output overflow and forced kill cannot publish success', async () => {
  for (const overrides of [{ closeCode: 1 }, { shutdownOverflow: true }, { holdTermClose: true }]) {
    const f = fixture(overrides);
    await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
    assert.equal(f.child.closed, true);
  }
});

test('the requested graceful shutdown may close with code zero', async () => {
  const f = fixture({ closeCode: 0 });
  assert.equal(await runOpencodeSession(workspace, 'The task', 64_000, f.options), 'Done');
  assert.equal(f.child.closed, true);
});
