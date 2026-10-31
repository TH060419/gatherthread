import test from 'node:test';
import assert from 'node:assert/strict';
import { probeExecutable } from '../src/executable.mjs';

function runner(steps) {
  const calls = [];
  const execFileImpl = (file, args, options, done) => {
    calls.push({ file, args, options });
    assert.equal(options.shell, false); assert.equal(options.timeout, 4000); assert.equal(options.maxBuffer, 4096);
    const step = steps.shift(); assert.ok(step, 'unexpected subprocess');
    done(step.error ?? null, step.stdout ?? '', step.stderr ?? '');
  };
  return { execFileImpl, calls };
}
test('damaged app signature is rejected before starting the binary', async () => {
  const r = runner([{ error: { code: 1 }, stderr: 'invalid signature (code or signature have been modified)' }]);
  await assert.rejects(probeExecutable('/Applications/Example.app/Contents/MacOS/codex', 'codex', {},
    { ...r, platform: 'darwin' }), { code: 'executable_signature_invalid' });
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].file, '/usr/bin/codesign');
  assert.deepEqual(r.calls[0].args, ['--verify', '--strict', '/Applications/Example.app/Contents/MacOS/codex']);
});
test('unsigned app script is not misreported as an invalid signature', async () => {
  const r = runner([{ error: { code: 1 }, stderr: 'code object is not signed at all' }, { stdout: 'codex-cli 0.166.0-alpha.5.1\n' }]);
  assert.equal(await probeExecutable('/Applications/Example.app/Contents/bin/codex', 'codex', {},
    { ...r, platform: 'darwin' }), 'codex-cli 0.166.0-alpha.5.1');
});
for (const [error, expected] of [
  [{ killed: true, signal: 'SIGTERM' }, 'executable_probe_timeout'],
  [{ signal: 'SIGABRT' }, 'executable_terminated'],
  [{ code: 1 }, 'executable_probe_failed'],
  [{ code: 'ENOENT' }, 'invalid_executable'],
  [{ code: 'EACCES' }, 'invalid_executable'],
]) test(`version failure ${JSON.stringify(error)} becomes ${expected}`, async () => {
  const r = runner([{ error, stderr: 'private local configuration must not be surfaced' }]);
  await assert.rejects(probeExecutable('/cli/codex', 'codex', {}, { ...r, platform: 'linux' }), err => {
    assert.equal(err.code, expected); assert.doesNotMatch(err.message, /private local/); return true;
  });
});
for (const invalid of [true, false]) test(`SIGKILL requires signature evidence: ${invalid}`, async () => {
  const r = runner([{ error: { signal: 'SIGKILL' } }, invalid
    ? { error: { code: 1 }, stderr: 'invalid signature (code or signature have been modified)' } : {}]);
  await assert.rejects(probeExecutable('/cli/codex', 'codex', {}, { ...r, platform: 'darwin' }),
    { code: invalid ? 'executable_signature_invalid' : 'executable_terminated' });
});
for (const [harness, version] of [['codex', 'codex-cli 0.166.0'], ['claude-code', '2.1.10 (Claude Code)']]) {
  test(`${harness} accepts only its own version format`, async () => {
    const r = runner([{ stdout: version }, { stdout: version }]);
    assert.equal(await probeExecutable('/cli/agent', harness, {}, { ...r, platform: 'linux' }), version);
    await assert.rejects(probeExecutable('/cli/agent', harness === 'codex' ? 'claude-code' : 'codex', {},
      { ...r, platform: 'linux' }), { code: 'invalid_executable' });
  });
}
test('unrelated numeric version and terminal control sequences are rejected', async () => {
  for (const stdout of ['1.2.3', 'codex-cli 0.166.0\u001b[31m', 'codex-cli-other 0.166.0']) {
    const r = runner([{ stdout }]);
    await assert.rejects(probeExecutable('/cli/agent', 'codex', {}, { ...r, platform: 'linux' }), { code: 'invalid_executable' });
  }
});
