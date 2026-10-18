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
  assert.equal(f.spawns[0][2].env.BUN_OPTIONS, '--smol');
  assert.deepEqual(f.spawns[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(f.requests.map(r => r.path), ['/global/health', '/session', '/session/ses_fixture/message', '/session/status']);
  assert.deepEqual(JSON.parse(f.requests[1].init.body), { title: 'GatherThread cloud task', permission: [
    { permission: 'question', action: 'deny', pattern: '*' },
    { permission: 'plan_enter', action: 'deny', pattern: '*' },
    { permission: 'plan_exit', action: 'deny', pattern: '*' },
  ] });
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

test('a slow read-only idle check retries without submitting the prompt again', async () => {
  let statusCalls = 0;
  const f = fixture({ fetch: async (path, init) => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    if (path.endsWith('/message')) return json(finalReply());
    if (++statusCalls === 1) {
      try { await delay(1500, undefined, { signal: init.signal }); }
      catch (error) { throw init.signal.aborted ? init.signal.reason : error; }
    }
    return json({});
  } });
  assert.equal(await runOpencodeSession(workspace, 'The task', 64_000, f.options), 'Done');
  assert.equal(statusCalls, 2);
  assert.equal(f.requests.filter(r => r.path.endsWith('/message')).length, 1);
  assert.deepEqual(f.child.kills, ['SIGTERM']);
});

test('an idle response arriving past the total window cannot publish success', async t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ fetch: async path => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    if (path.endsWith('/message')) return json(finalReply());
    now += 5001;
    return json({});
  } });
  await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
  assert.equal(f.child.closed, true);
});

test('repeated idle timeouts have a finite total window and never repeat the model request', async t => {
  let now = 100_000, statusCalls = 0;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ fetch: async path => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    if (path.endsWith('/message')) return json(finalReply());
    statusCalls++; now += 1001;
    throw new DOMException('private timeout fixture', 'TimeoutError');
  } });
  await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
  assert.equal(statusCalls, 5);
  assert.equal(f.requests.filter(r => r.path.endsWith('/message')).length, 1);
  assert.equal(f.child.closed, true);
});

test('idle protocol failures and executor exit fail immediately without polling again', async () => {
  for (const variant of ['http', 'type', 'size', 'exit']) {
    let statusCalls = 0;
    const f = fixture({ fetch: async (path, init, child) => {
      if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
      if (path === '/session') return json({ id: 'ses_fixture' });
      if (path.endsWith('/message')) return json(finalReply());
      statusCalls++;
      if (variant === 'http') return json({ error: 'private status fixture' }, 503);
      if (variant === 'type') return new Response('private status fixture', { headers: { 'content-type': 'text/plain' } });
      if (variant === 'size') return json({ private: 'X'.repeat(65_000) });
      child.closed = true; child.emit('exit', 1, null); child.emit('close', 1, null);
      throw init.signal.reason;
    } });
    await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), { message: 'agent_failed' });
    assert.equal(statusCalls, 1);
    assert.equal(f.child.closed, true);
  }
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

test('failure diagnostics contain only the failing phase, not provider or tool details', async () => {
  for (const [phase, route] of [['session', '/session'], ['answer', '/session/ses_fixture/message'], ['idle', '/session/status']]) {
    const f = fixture({ fetch: async path => {
      if (path === route) throw new Error('private-provider-token and tool data');
      if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
      if (path === '/session') return json({ id: 'ses_fixture' });
      if (path.endsWith('/message')) return json(finalReply());
      return json({});
    } });
    await assert.rejects(runOpencodeSession(workspace, 'The task', 64_000, f.options), error => {
      assert.equal(error.message, 'agent_failed');
      assert.equal(error.diagnosticCode, `agent_${phase}_failed`);
      assert.equal(JSON.stringify(error).includes('private'), false);
      return true;
    });
  }
});

// Exercise the actual final-response runner against real HTTP and Undici parser
// timers. Only OpenCode's process and the loopback destination are fictional.
const { createServer } = await import('node:http');
const { createRequire } = await import('node:module');
const { channel } = await import('node:diagnostics_channel');
const { Pool, fetch: runnerFetch } = await import('undici');
const { createOpencodeDispatcher, OPENCODE_ROUND_TIMEOUT_MS } = await import('../../ops/hosted-agent/opencode-session.mjs');
const parserClock = createRequire(import.meta.url)('undici/lib/util/timers.js');
const flushParser = () => new Promise(resolve => setImmediate(resolve));

for (const phase of ['headers', 'body']) for (const timesOut of [false, true]) {
  test(`actual final JSON runner ${timesOut ? 'classifies a real 12-minute timeout' : 'survives the old five-minute deadline'} in ${phase}`, { timeout: 5000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const firstBody = Promise.withResolvers(), bodyChannel = channel('undici:request:bodyChunkReceived');
    const receivedBody = ({ request }) => { if (request.path === '/session/ses_fixture/message') firstBody.resolve(); };
    const final = JSON.stringify(finalReply());
    let prompts = 0, sse = false;
    const server = createServer(async (request, response) => {
      request.resume();
      if (request.url === '/event') {
        sse = true; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': started\n\n'); return;
      }
      if (request.url === '/session/ses_fixture/message') {
        prompts++;
        if (phase === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write(final.slice(0, 20)); }
        entered.resolve(); await release.promise;
        if (!response.destroyed) {
          if (phase === 'headers') response.writeHead(200, { 'content-type': 'application/json' });
          response.end(phase === 'body' ? final.slice(20) : final);
        }
        return;
      }
      const body = request.url === '/global/health' ? { healthy: true, version: '1.18.32' }
        : request.url === '/session' ? { id: 'ses_fixture' } : {};
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const dispatcher = createOpencodeDispatcher((_, options) => new Pool(origin, options));
    const unrelated = createOpencodeDispatcher();
    const f = fixture(); let settled = false;
    const result = runOpencodeSession(workspace, 'Observed task', 64_000, { spawnProcess: f.options.spawnProcess,
      fetchResponse: runnerFetch, createDispatcher: () => dispatcher, onProgress: () => {} }).finally(() => { settled = true; });
    // Register expected failure before the real transport rejects.
    const checked = timesOut ? assert.rejects(result, error => {
      assert.equal(error.message, 'agent_failed'); assert.equal(error.diagnosticCode, 'agent_timeout');
      assert.deepEqual(Object.keys(error), ['diagnosticCode']); return true;
    }) : result;
    bodyChannel.subscribe(receivedBody);
    let cleanupPromise;
    const cleanup = () => cleanupPromise ??= (async () => {
      bodyChannel.unsubscribe(receivedBody); release.resolve();
      // Node's test timeout does not unwind an outstanding awaited promise.
      // Force transport cleanup from the after hook as well as normal finally.
      await dispatcher.destroy(); await unrelated.destroy(); server.closeAllConnections();
      await Promise.allSettled([result, checked]);
      await new Promise(resolve => server.close(resolve)); parserClock.reset();
    })();
    t.after(cleanup);
    try {
      await entered.promise;
      // Server write completion does not prove the client parser has consumed
      // its first chunk. A late first chunk refreshes the body timer after the
      // synthetic five-minute tick, making the second jump miss its deadline.
      if (phase === 'body') await firstBody.promise;
      await flushParser(); await flushParser();
      assert.equal(sse, true, 'the SSE connection must not block the final-response connection');
      assert.equal(OPENCODE_ROUND_TIMEOUT_MS, 720_000);
      parserClock.tick(0); parserClock.tick(301_000); await flushParser();
      assert.equal(settled, false, 'a real final response cannot fail at the old five-minute parser limit');
      if (timesOut) { parserClock.tick(421_000); await checked; }
      else { release.resolve(); assert.equal(await checked, 'Done'); }
      assert.equal(prompts, 1, 'waiting/timeout must never silently submit a second model request');
      assert.equal(dispatcher.destroyed, true); assert.equal(unrelated.destroyed, false); assert.equal(f.child.closed, true);
    } finally {
      await cleanup();
    }
  });
}

test('final timeout classification is allowlisted and every owned dispatcher closes on malformed answers', async () => {
  for (const error of [new DOMException('private deadline', 'TimeoutError'),
    new TypeError('fetch failed', { cause: Object.assign(new Error('private detail'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }),
    Object.assign(new Error('unrelated connection failure'), { code: 'ECONNRESET' })]) {
    const dispatcher = createOpencodeDispatcher();
    const f = fixture({ fetch: async path => {
      if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
      if (path === '/session') return json({ id: 'ses_fixture' }); throw error;
    } });
    await assert.rejects(runOpencodeSession(workspace, 'Task', 64_000, { ...f.options, createDispatcher: () => dispatcher }),
      { message: 'agent_failed', diagnosticCode: error.code === 'ECONNRESET' ? 'agent_answer_failed' : 'agent_timeout' });
    assert.equal(dispatcher.destroyed, true); assert.equal(f.child.closed, true);
  }
});

test('the absolute round signal ends an outstanding answer even without an idle transport deadline', async t => {
  const wholeRound = new AbortController(), originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => milliseconds === OPENCODE_ROUND_TIMEOUT_MS
    ? wholeRound.signal : originalTimeout.call(AbortSignal, milliseconds));
  const entered = Promise.withResolvers();
  const dispatcher = createOpencodeDispatcher();
  const f = fixture({ fetch: async (path, init) => {
    if (path === '/global/health') return json({ healthy: true, version: '1.18.32' });
    if (path === '/session') return json({ id: 'ses_fixture' });
    entered.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const result = runOpencodeSession(workspace, 'Task', 64_000, { ...f.options, createDispatcher: () => dispatcher });
  const checked = assert.rejects(result, { message: 'agent_failed', diagnosticCode: 'agent_timeout' });
  await entered.promise; wholeRound.abort(new DOMException('private deadline detail', 'TimeoutError')); await checked;
  assert.equal(dispatcher.destroyed, true); assert.equal(f.child.closed, true);
});
