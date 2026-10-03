import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('test admission CLI writes private individual distribution files, refuses replacement and lists no secrets', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gt-admission-cli-')));
  const env = { ...process.env, NODE_ENV: 'test', GATHERTHREAD_DEPLOYMENT_ENVIRONMENT: 'test', GATHERTHREAD_TEST_GATE_ENABLED: 'true',
    GATHERTHREAD_TEST_GATE_DATABASE_PATH: join(directory, 'admission.sqlite'), GATHERTHREAD_AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'), GATHERTHREAD_TEST_GATE_PEPPER: randomBytes(32).toString('hex'),
    GATHERTHREAD_DATABASE_PATH: join(directory, 'test.sqlite'), GATHERTHREAD_PUBLIC_BASE_URL: 'https://test.gatherthread.cn', GATHERTHREAD_ALLOWED_ORIGINS: 'https://test.gatherthread.cn', GATHERTHREAD_TLS_TERMINATED_BY_PROXY: 'true' };
  const cli = args => execFileSync(process.execPath, ['apps/server/dist/src/test-gate-cli.js', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const path = join(directory, 'distribution.txt');
    const output = cli(['issue', '--count', '2', '--hours', '1', '--output', path]);
    assert.equal(output.includes('gte_'), false);
    const content = readFileSync(path, 'utf8');
    assert.equal((content.match(/测试人员代码：gte_/g) ?? []).length, 2);
    assert.match(content, /测试账号与正式账号独立/);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = JSON.parse(cli(['list'])); assert.equal(before.length, 2); assert.equal(JSON.stringify(before).includes('gte_'), false);
    assert.throws(() => cli(['issue', '--output', path])); assert.equal(JSON.parse(cli(['list'])).length, 2);
    cli(['revoke', '--grant-id', before[0].grant_id]); assert.equal(JSON.parse(cli(['list']))[0].revoked, 1);
    assert.throws(() => cli(['issue', '--count', '51', '--output', join(directory, 'bad.txt')]));
    assert.throws(() => execFileSync(process.execPath, ['apps/server/dist/src/test-gate-cli.js', 'list'], { env: { ...env, GATHERTHREAD_DEPLOYMENT_ENVIRONMENT: 'production', GATHERTHREAD_TEST_GATE_ENABLED: 'false' }, stdio: 'pipe' }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('public isolation reports compare fingerprints and refuse shared credentials or data directories', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gt-isolation-report-')));
  const auth = randomBytes(32).toString('hex');
  const base = { ...process.env, NODE_ENV: 'test', GATHERTHREAD_TLS_TERMINATED_BY_PROXY: 'true', GATHERTHREAD_AUTH_TOKEN_PEPPER: auth,
    GATHERTHREAD_DEPLOYMENT_ENVIRONMENT: 'production', GATHERTHREAD_TEST_GATE_ENABLED: 'false', GATHERTHREAD_SERVER_PORT: '18787', GATHERTHREAD_ALLOWED_ORIGINS: 'https://gatherthread.cn',
    GATHERTHREAD_PUBLIC_BASE_URL: 'https://gatherthread.cn', GATHERTHREAD_DATABASE_PATH: join(directory, 'production', 'accounts.sqlite'), GATHERTHREAD_BACKUP_DIRECTORY: join(directory, 'production-backup') };
  const report = join(directory, 'public-report.json');
  const run = (env, args) => execFileSync(process.execPath, ['scripts/test-environment/isolation-report.mjs', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run(base, ['write', report]); assert.equal(readFileSync(report, 'utf8').includes(auth), false);
    const preview = { ...base, GATHERTHREAD_DEPLOYMENT_ENVIRONMENT: 'test', GATHERTHREAD_TEST_GATE_ENABLED: 'true', GATHERTHREAD_AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
      GATHERTHREAD_TEST_GATE_PEPPER: randomBytes(32).toString('hex'), GATHERTHREAD_TEST_GATE_DATABASE_PATH: join(directory, 'test', 'admission.sqlite'), GATHERTHREAD_DATABASE_PATH: join(directory, 'test', 'accounts.sqlite'),
      GATHERTHREAD_BACKUP_DIRECTORY: join(directory, 'test-backup'), GATHERTHREAD_PUBLIC_BASE_URL: 'https://test.gatherthread.cn', GATHERTHREAD_ALLOWED_ORIGINS: 'https://test.gatherthread.cn', GATHERTHREAD_SERVER_PORT: '28787' };
    assert.match(run(preview, ['compare', report]), /independent/);
    assert.throws(() => run({ ...preview, GATHERTHREAD_AUTH_TOKEN_PEPPER: auth }, ['compare', report]));
    assert.throws(() => run({ ...preview, GATHERTHREAD_DATABASE_PATH: base.GATHERTHREAD_DATABASE_PATH }, ['compare', report]));
    assert.throws(() => run({ ...preview, GATHERTHREAD_BACKUP_DIRECTORY: base.GATHERTHREAD_BACKUP_DIRECTORY }, ['compare', report]));
    const original = JSON.parse(readFileSync(report, 'utf8'));
    const incomplete = { ...original }; delete incomplete.auth_key_fingerprint;
    writeFileSync(report, JSON.stringify(incomplete)); assert.throws(() => run(preview, ['compare', report]));
    writeFileSync(report, JSON.stringify({ ...original, port: '28787' })); assert.throws(() => run(preview, ['compare', report]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
