// Real Docker/OpenCode/npm/test/build execution. All GitHub/model/registry responses are local fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedRepositoryRunner } from '../apps/server/dist/src/hosted-repository-runner.js';
const image = process.env.GATHERTHREAD_TEST_HOSTED_IMAGE;
assert.ok(image, 'Set GATHERTHREAD_TEST_HOSTED_IMAGE');
const inspected = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' });
assert.equal(inspected.status, 0);
const directory = mkdtempSync(join(tmpdir(), 'gt-repository-smoke-'));
let calls = 0, tarballCalls = 0, issued = false, observedChecks = false;
// This smoke uses only fixtures. Production keeps raw container output private.
async function runFixtureDocker(args) {
  const name = args[args.indexOf('--name') + 1];
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('docker', [...args.slice(0, -1), '-e', 'GT_HOSTED_SMOKE_DEBUG=1', args.at(-1)],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', size = 0;
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('repository smoke timeout')); }, 90_000);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) child.kill('SIGKILL'); else stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.once('error', reject);
      child.once('close', (code) => code === 0 && size <= 12 * 1024 * 1024 ? resolve(stdout)
        : reject(new Error(`repository container exited ${code}: ${stderr}`)));
    });
  } finally {
    clearTimeout(timer);
    spawnSync('docker', ['rm', '-f', name], { timeout: 5000, stdio: 'ignore' });
  }
}
try {
  const packageDir = join(directory, 'package'); mkdirSync(packageDir);
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'gt-smoke-dependency', version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(packageDir, 'index.js'), 'module.exports = 7;\n');
  const tarPath = join(directory, 'dependency.tgz');
  assert.equal(spawnSync('tar', ['-czf', tarPath, '-C', directory, 'package']).status, 0);
  const tarball = readFileSync(tarPath), integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const file = (path, content) => ({ path, content_base64: Buffer.from(content).toString('base64'), executable: false });
  const files = [file('package.json', JSON.stringify({ name: 'gt-cloud-smoke', version: '1.0.0', scripts: { test: 'node test.cjs', build: 'node build.cjs' }, dependencies: { 'gt-smoke-dependency': '1.0.0' } })),
    file('package-lock.json', JSON.stringify({ name: 'gt-cloud-smoke', version: '1.0.0', lockfileVersion: 3, packages: {
      '': { name: 'gt-cloud-smoke', version: '1.0.0', dependencies: { 'gt-smoke-dependency': '1.0.0' } },
      'node_modules/gt-smoke-dependency': { version: '1.0.0', resolved: 'https://registry.npmjs.org/gt-smoke-dependency/-/gt-smoke-dependency-1.0.0.tgz', integrity },
    } })), file('value.cjs', 'module.exports = 1;\n'),
    file('test.cjs', "require('node:assert/strict').equal(require('./value.cjs'), 2); require('node:assert/strict').equal(require('gt-smoke-dependency'), 7); console.log('TEST_OK');\n"),
    file('build.cjs', "require('node:fs').mkdirSync('dist', {recursive:true}); require('node:fs').writeFileSync('dist/result.txt', String(require('./value.cjs'))); console.log('BUILD_OK');\n")];
  const endpoint = { id: 'fixture', profileId: 'coding', label: 'Fixture', provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'https://model.example/v1', apiToken: 'test-only-model-credential', quotaGroup: 'fixture', dailyRuns: 4, maxConcurrent: 1 };
  const fetcher = async (url, init) => {
    if (String(url) === 'https://registry.npmjs.org/gt-smoke-dependency/-/gt-smoke-dependency-1.0.0.tgz') { tarballCalls++; return new Response(tarball); }
    assert.equal(String(url), 'https://model.example/v1/chat/completions');
    calls++;
    const body = JSON.parse(String(init.body));
    const useTool = !issued && body.tools?.some((tool) => tool.function?.name === 'bash');
    if (useTool) issued = true;
    if (body.messages.some((message) => message.role === 'tool')) {
      const transcript = JSON.stringify(body.messages);
      assert.match(transcript, /TEST_OK/); assert.match(transcript, /BUILD_OK/); observedChecks = true;
    }
    const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_repository', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: "node -e \"require('fs').writeFileSync('value.cjs', 'module.exports = 2;\\n')\" && npm test && npm run build", description: 'Update source and verify tests and build' }) } }] } : { role: 'assistant', content: 'TEST_OK BUILD_OK' };
    const chunk = (delta, finish_reason = null) => JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: endpoint.model, choices: [{ index: 0, delta, finish_reason }] });
    return new Response(`data: ${chunk(delta)}\n\ndata: ${chunk({}, useTool ? 'tool_calls' : 'stop')}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const runner = new HostedRepositoryRunner({ endpoints: [endpoint], image: inspected.stdout.trim(), userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1, fetch: fetcher, runContainer: runFixtureDocker });
  const result = await runner.run(files, 'Update value.cjs to export two; run npm test and npm run build.', endpoint, () => {});
  assert.ok(issued && calls >= 2 && tarballCalls > 0 && observedChecks);
  assert.equal(Buffer.from(result.files.find((f) => f.path === 'value.cjs').content_base64, 'base64').toString(), 'module.exports = 2;\n');
  assert.ok(result.files.every((f) => !f.path.includes('node_modules') && !f.path.startsWith('dist/') && !f.path.startsWith('.git/')));
  assert.equal(result.files.find((f) => f.path === 'package-lock.json').content_base64, files.find((f) => f.path === 'package-lock.json').content_base64);
  process.stdout.write(`PASS real repository container: npm dependency installed, OpenCode bash edited source, tests/build ran, lockfile restored; ${calls} model fixture calls.\n`);
} finally { rmSync(directory, { recursive: true, force: true }); }
