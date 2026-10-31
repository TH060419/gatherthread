import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorSupervisor } from '../src/supervisor.mjs';
const link = { origin: 'https://test.gatherthread.cn', project: 'fixture', harness: 'codex', model: 'fixture' };
function setup() { const child = new EventEmitter(); Object.assign(child, { pid: 123456, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let alive = false; const supervisor = new ConnectorSupervisor({ spawnImpl: () => child, groupAlive: () => alive, stopDeadline: 15 });
  return { child, supervisor, setAlive: value => { alive = value; } }; }
test('late ready output cannot cancel a requested Stop; EOF is not exit proof', async () => {
  const { child, supervisor } = setup(), r = supervisor.reserve(link, randomUUID());
  supervisor.launch(r, '/runtime/node', ['/connector'], { env: {}, cwd: '/' });
  supervisor.stop(r.id); child.stdout.write('GatherThread connector ready.\n'); child.stdout.end();
  assert.equal(r.state, 'stopping'); await delay(20); assert.equal(r.error, 'cleanup_pending');
  assert.throws(() => supervisor.reserve(link, randomUUID()), { code: 'duplicate_connection' });
  child.emit('exit', 0); assert.equal(r.state, 'stopped'); assert.equal(supervisor.active().length, 0);
});
test('parent exit with a live descendant retains the runtime slot until group exit', async () => {
  const { child, supervisor, setAlive } = setup(), r = supervisor.reserve(link, randomUUID());
  supervisor.launch(r, '/runtime/node', ['/connector'], { env: {}, cwd: '/' }); supervisor.stop(r.id);
  setAlive(true); child.emit('exit', 0); assert.equal(r.state, 'cleanup_pending');
  assert.throws(() => supervisor.reserve(link, randomUUID()), { code: 'duplicate_connection' });
  setAlive(false); await delay(550); assert.equal(r.state, 'stopped');
});
test('raw child output stays private and line limits cannot synthesize readiness', () => {
  const { child, supervisor } = setup(), r = supervisor.reserve(link, randomUUID());
  supervisor.launch(r, '/runtime/node', [], { env: {}, cwd: '/' });
  child.stdout.write('SECRET' + 'x'.repeat(5000) + 'GatherThread connector ready.\n'); assert.equal(r.state, 'starting');
  child.stderr.write('private-provider-body\n'); assert.doesNotMatch(JSON.stringify(supervisor.publicRecords()), /SECRET|private-provider/);
  child.stdout.write('GatherThread connector '); child.stdout.write('ready.\n'); assert.equal(r.state, 'connected');
  supervisor.stop(r.id); child.emit('exit', 0);
});
test('cancellation before spawn prevents a late authorization from launching', () => {
  let spawned = 0; const supervisor = new ConnectorSupervisor({ spawnImpl: () => { spawned++; } });
  const r = supervisor.reserve(link, randomUUID()); supervisor.stop(r.id);
  assert.throws(() => supervisor.launch(r, '/runtime/node', [], { env: {}, cwd: '/' }), { code: 'cancelled' });
  assert.equal(spawned, 0);
});
test('connections are distinct by server/project/harness, bounded, and never silently replaced', () => {
  const supervisor = new ConnectorSupervisor();
  for (let i = 0; i < 8; i++) supervisor.reserve({ ...link, project: `fixture-${i}` }, randomUUID());
  assert.throws(() => supervisor.reserve({ ...link, project: 'extra' }, randomUUID()), { code: 'connection_limit' });
  supervisor.stopAll(); assert.equal(supervisor.active().length, 0);
  supervisor.reserve(link, randomUUID()); assert.equal(supervisor.publicRecords().length, 8);
});
test('startup timeout preserves ownership and allows a later exact ready marker', async () => {
  const { child } = setup(), supervisor = new ConnectorSupervisor({ spawnImpl: () => child, groupAlive: () => false, startDeadline: 10 });
  const r = supervisor.reserve(link, randomUUID()); supervisor.launch(r, '/node', [], { env: {}, cwd: '/' });
  await delay(20); assert.equal(r.error, 'startup_timeout'); assert.equal(r.state, 'starting');
  assert.equal(supervisor.active().length, 1);
  child.stdout.write('GatherThread connector ready.\n'); assert.equal(r.state, 'connected'); assert.equal(r.error, null);
  supervisor.stop(r.id); child.emit('exit', 0);
});
test('broken output and control pipes do not crash or pretend the process exited', () => {
  const { child, supervisor } = setup(), r = supervisor.reserve(link, randomUUID());
  supervisor.launch(r, '/node', [], { env: {}, cwd: '/' });
  child.stdout.emit('error', new Error('private failure')); assert.equal(r.error, 'connector_failed');
  child.stdin.write = () => { throw new Error('closed pipe'); };
  assert.doesNotThrow(() => supervisor.stop(r.id)); assert.equal(supervisor.active().length, 1);
  assert.equal(r.error, 'cleanup_pending'); child.emit('exit', 0); assert.equal(r.state, 'stopped');
});
