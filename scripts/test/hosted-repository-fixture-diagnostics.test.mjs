import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reportRepositoryFixtureFailure } from '../hosted-repository-fixture-diagnostics.mjs';

const name = `gt-repository-${'a'.repeat(20)}`;
function fixture(execute) {
  const calls = [], messages = [];
  const environment = { PATH: '/fixture/bin', HOME: '/fixture/home', DOCKER_HOST: 'unix:///fixture.sock', DOCKER_CONFIG: '/fixture/client' };
  let closed = 0;
  reportRepositoryFixtureFailure(name, {
    createClient: () => ({ environment, close: () => { closed++; } }),
    execute: (command, args, options) => { calls.push({ command, args, options }); return execute(args); },
    write: (message) => messages.push(message),
  });
  return { calls, messages, environment, closed };
}

test('repository failure diagnostics use the production client environment and bounded exact-container commands', () => {
  const result = fixture((args) => args[1] === 'inspect'
    ? { status: 0, stdout: '{"status":"exited","exit_code":137,"oom_killed":true,"dead":false}\n', stderr: 'private CLI warning' }
    : { status: 0, stdout: 'fixture stdout\n', stderr: 'fixture startup failure\n' });
  assert.equal(result.calls.length, 2);
  for (const call of result.calls) {
    assert.equal(call.command, 'docker');
    assert.equal(call.args.at(-1), name);
    assert.equal(call.options.env, result.environment);
    assert.equal(call.options.timeout, 5_000);
    assert.equal(call.options.maxBuffer, 16_000);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  }
  assert.deepEqual(result.calls[0].args.slice(0, 4), ['container', 'inspect', '--format',
    '{"status":{{json .State.Status}},"exit_code":{{.State.ExitCode}},"oom_killed":{{.State.OOMKilled}},"dead":{{.State.Dead}}}']);
  assert.deepEqual(result.calls[1].args, ['container', 'logs', '--tail', '40', name]);
  assert.match(result.messages[0], /exit_code.*137.*oom_killed.*true/u);
  assert.ok(!result.messages.join('').includes('private CLI warning'));
  assert.match(result.messages[1], /fixture stdout.*fixture startup failure/u);
  assert.equal(result.closed, 1);
});

test('invalid and non-fixture names never create a client or inspect another container', () => {
  for (const rejected of ['production', `gt-repository-${'a'.repeat(32)}`, name + '\n', name + '\r\n',
    `gt-hosted-${'a'.repeat(16)}`, '--help', undefined, null, { toString: () => name }]) {
    let clients = 0, executions = 0, closed = 0;
    const messages = [];
    reportRepositoryFixtureFailure(rejected, {
      createClient: () => { clients++; return { environment: {}, close: () => { closed++; } }; },
      execute: () => { executions++; return { status: 0, stdout: 'fixed fixture output' }; },
      write: (message) => messages.push(message),
    });
    assert.equal(clients, 0);
    assert.equal(executions, 0);
    assert.equal(closed, 0);
    assert.deepEqual(messages, []);
  }
});

test('fixture logs are bounded and diagnostic failures never expose CLI errors or interrupt cleanup', () => {
  const large = fixture(() => ({ status: 0, stdout: 'x'.repeat(20_000), stderr: 'y'.repeat(20_000) }));
  for (const message of large.messages) assert.ok(message.length <= 4030);
  assert.equal(large.closed, 1);
  for (const failure of [{ status: 1, stderr: 'fixture-private-value' },
    { status: null, error: new Error('fixture-private-value') }, { status: 0, signal: 'SIGTERM' }]) {
    const result = fixture(() => failure);
    assert.deepEqual(result.messages, ['Repository fixture state: unavailable.\n', 'Repository fixture logs: unavailable.\n']);
    assert.equal(result.closed, 1);
    assert.ok(!result.messages.join('').includes('fixture-private-value'));
  }
  const thrown = fixture(() => { throw new Error('fixture-private-value'); });
  assert.equal(thrown.calls.length, 2);
  assert.equal(thrown.closed, 1);
  assert.ok(!thrown.messages.join('').includes('fixture-private-value'));
});

test('fixture client setup and cleanup failures report only fixed diagnostics', () => {
  for (const phase of ['setup', 'cleanup']) {
    const messages = [];
    assert.doesNotThrow(() => reportRepositoryFixtureFailure(name, {
      createClient: () => {
        if (phase === 'setup') throw new Error('fixture-private-value');
        return { environment: {}, close: () => { throw new Error('fixture-private-value'); } };
      },
      execute: () => ({ status: 0, stdout: '' }), write: (message) => messages.push(message),
    }));
    assert.ok(messages.some((message) => message.includes(phase === 'setup' ? 'diagnostics: unavailable' : 'client cleanup: failed')));
    assert.ok(!messages.join('').includes('fixture-private-value'));
  }
});

test('a failed diagnostic stream cannot mask the fixture error or prevent client cleanup', () => {
  let calls = 0, closed = 0;
  assert.doesNotThrow(() => reportRepositoryFixtureFailure(name, {
    createClient: () => ({ environment: {}, close: () => { closed++; } }),
    execute: () => { calls++; return { status: 0, stdout: 'fixed fixture output' }; },
    write: () => { throw new Error('fixture stream closed'); },
  }));
  assert.equal(calls, 2);
  assert.equal(closed, 1);
});

test('repository smoke retains production run bounds, failure propagation and exact owned-container cleanup', () => {
  const source = readFileSync(new URL('../test-hosted-repository-container.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ hostedContainerMemoryMiB, runDocker \} from '\.\.\/apps\/server\/dist\/src\/hosted-agent\.js'/u);
  assert.match(source, /import \{ createHostedDockerClient, runHostedDockerCommand, stopHostedContainer \}/u);
  assert.match(source, /const fixtureArgs = args\.filter\(\(argument\) => argument !== '--rm'\)/u);
  assert.match(source, /await runDocker\(\[\.\.\.fixtureArgs\.slice\(0, -1\), '-e', 'GT_HOSTED_SMOKE_DEBUG=1', fixtureArgs\.at\(-1\)\],\s*90_000, 12 \* 1024 \* 1024\)/u);
  assert.match(source, /catch \(error\) \{[\s\S]*reportRepositoryFixtureFailure\(name, \{ createClient: createHostedDockerClient \}\);\s*throw error;\s*\} finally \{\s*stopHostedContainer\(name\)/u);
});
