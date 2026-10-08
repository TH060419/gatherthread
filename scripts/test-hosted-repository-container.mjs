// Real Docker/OpenCode/npm/test/build execution. All GitHub/model/registry responses are local fixtures.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedRepositoryRunner } from '../apps/server/dist/src/hosted-repository-runner.js';
import { hostedContainerMemoryMiB, runDocker } from '../apps/server/dist/src/hosted-agent.js';
import { runHostedDockerCommand, stopHostedContainer } from '../apps/server/dist/src/hosted-agent-recovery.js';
// Exercise production mount preparation with the hardened Linux service umask.
if (process.platform === 'linux') process.umask(0o077);
const image = process.env.GATHERTHREAD_TEST_HOSTED_IMAGE;
assert.ok(image, 'Set GATHERTHREAD_TEST_HOSTED_IMAGE');
const inspected = runHostedDockerCommand(['image', 'inspect', '--format', '{{.Id}}', image]);
assert.equal(inspected.status, 0);
const memoryMiB = hostedContainerMemoryMiB('repository', process.env.GATHERTHREAD_HOSTED_GITHUB_MEMORY_MIB === undefined
  ? undefined : Number(process.env.GATHERTHREAD_HOSTED_GITHUB_MEMORY_MIB));
const directory = mkdtempSync(join(tmpdir(), 'gt-repository-smoke-'));
let calls = 0, tarballCalls = 0, issued = false, observedChecks = false;

function toolOutputLines(messages) {
  return messages.filter((message) => message.role === 'tool').flatMap((message) =>
    typeof message.content === 'string' ? [message.content]
      : Array.isArray(message.content) ? message.content.filter((block) =>
        block.type === 'text' && typeof block.text === 'string').map((block) => block.text) : [])
    .flatMap((content) => content.split(/\r?\n/u));
}
// This smoke uses only fixtures. Production keeps raw container output private.
async function runFixtureDocker(args) {
  const name = args[args.indexOf('--name') + 1];
  assert.equal(args[args.indexOf('--user') + 1], '10001:10001');
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '256');
  assert.equal(args[args.indexOf('--cpus') + 1], '2');
  assert.equal(args[args.indexOf('--memory') + 1], `${memoryMiB}m`);
  assert.equal(args[args.indexOf('--memory-swap') + 1], `${memoryMiB}m`);
  assert.ok(args.includes('--read-only') && args.includes('no-new-privileges'));
  assert.equal(args.at(-1), inspected.stdout.trim());
  assert.ok(args.some((argument) => argument.endsWith('dst=/input,readonly')));
  const controlMount = args.find((argument) => argument.endsWith('dst=/run/gatherthread,readonly'));
  assert.ok(controlMount);
  const control = controlMount.split('src=')[1].split(',dst=')[0];
  assert.equal(readFileSync(join(control, 'opencode.json'), 'utf8').includes('test-only-model-credential'), false);
  assert.equal(args.includes('test-only-model-credential'), false);
  try {
    return await runDocker([...args.slice(0, -1), '-e', 'GT_HOSTED_SMOKE_DEBUG=1', args.at(-1)],
      90_000, 12 * 1024 * 1024);
  } finally {
    stopHostedContainer(name);
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
  const sourcePath = 'src/deep/nested/value.cjs';
  const files = [file('package.json', JSON.stringify({ name: 'gt-cloud-smoke', version: '1.0.0', workspaces: ['packages/*'], scripts: { test: 'node tests/deep/nested/test.cjs', build: 'node build.cjs' }, dependencies: { 'gt-smoke-dependency': '1.0.0' } })),
    file('package-lock.json', JSON.stringify({ name: 'gt-cloud-smoke', version: '1.0.0', lockfileVersion: 3, packages: {
      '': { name: 'gt-cloud-smoke', version: '1.0.0', workspaces: ['packages/*'], dependencies: { 'gt-smoke-dependency': '1.0.0' } },
      'packages/lib': { version: '1.0.0' },
      'node_modules/gt-smoke-workspace': { resolved: 'packages/lib', link: true },
      'node_modules/gt-smoke-dependency': { version: '1.0.0', resolved: 'https://registry.npmjs.org/gt-smoke-dependency/-/gt-smoke-dependency-1.0.0.tgz', integrity },
    } })), file('packages/lib/package.json', JSON.stringify({ name: 'gt-smoke-workspace', version: '1.0.0', main: 'src/deep/nested/index.cjs' })),
    file('packages/lib/src/deep/nested/index.cjs', 'module.exports = 9;\n'), file(sourcePath, 'module.exports = 1;\n'),
    file('tests/deep/nested/test.cjs', "require('node:assert/strict').equal(require('../../../src/deep/nested/value.cjs'), 2); require('node:assert/strict').equal(require('gt-smoke-dependency'), 7); require('node:assert/strict').equal(require('gt-smoke-workspace'), 9); console.log('TEST_OK');\n"),
    file('build.cjs', "require('node:fs').mkdirSync('dist', {recursive:true}); require('node:fs').writeFileSync('dist/result.txt', String(require('./src/deep/nested/value.cjs'))); console.log('BUILD_OK');\n")];
  const endpoint = { id: 'fixture', profileId: 'coding', label: 'Fixture', provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'https://model.example/v1', apiToken: 'test-only-model-credential', quotaGroup: 'fixture', dailyRuns: 4, maxConcurrent: 1 };
  const checks = "const assert=require('node:assert/strict'),fs=require('node:fs');"
    + "assert.equal(process.getuid(),10001);"
    + "assert.equal(fs.readFileSync('/input/src/deep/nested/value.cjs','utf8'),'module.exports = 1;\\n');"
    + "assert.equal(fs.readFileSync('/input/packages/lib/src/deep/nested/index.cjs','utf8'),'module.exports = 9;\\n');"
    + "assert.throws(()=>fs.writeFileSync('/input/src/deep/nested/value.cjs','tampered'),e=>e.code==='EROFS');"
    + "assert.throws(()=>fs.writeFileSync('/run/gatherthread/prompt.txt','tampered'),e=>e.code==='EROFS');"
    + "assert.equal(fs.readFileSync('/run/gatherthread/opencode.json','utf8').includes('test-only-model-credential'),false);"
    + "assert.equal(Object.keys(process.env).some(k=>/^(GATHERTHREAD_|GITHUB_TOKEN$|GH_TOKEN$|AWS_|SILICONFLOW_API_KEY$|OPENAI_API_KEY$)/.test(k)),false);"
    + "fs.writeFileSync('src/deep/nested/value.cjs','module.exports = 2;\\n');console.log('READONLY_OK');console.log('SECRETS_ABSENT');";
  const commandMarker = `GT_SMOKE_COMMAND_OK_${randomBytes(12).toString('hex')}`;
  const command = `node -e ${JSON.stringify(checks)} && npm test && npm run build && printf '\\n%s\\n' ${commandMarker}`;
  const fetcher = async (url, init) => {
    if (String(url) === 'https://registry.npmjs.org/gt-smoke-dependency/-/gt-smoke-dependency-1.0.0.tgz') { tarballCalls++; return new Response(tarball); }
    assert.equal(String(url), 'https://model.example/v1/chat/completions');
    calls++;
    const body = JSON.parse(String(init.body));
    const useTool = !issued && body.tools?.some((tool) => tool.function?.name === 'bash');
    if (useTool) issued = true;
    if (body.messages.some((message) => message.role === 'tool')) {
      const lines = toolOutputLines(body.messages);
      for (const marker of ['TEST_OK', 'BUILD_OK', 'READONLY_OK', 'SECRETS_ABSENT', commandMarker]) assert.ok(lines.includes(marker));
      observedChecks = true;
    }
    const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_repository', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Verify read-only input and edit and test nested source' }) } }] } : { role: 'assistant', content: 'TEST_OK BUILD_OK' };
    const chunk = (delta, finish_reason = null) => JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: endpoint.model, choices: [{ index: 0, delta, finish_reason }] });
    return new Response(`data: ${chunk(delta)}\n\ndata: ${chunk({}, useTool ? 'tool_calls' : 'stop')}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const runner = new HostedRepositoryRunner({ endpoints: [endpoint], image: inspected.stdout.trim(), userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1, repositoryMemoryMiB: memoryMiB, fetch: fetcher, runContainer: runFixtureDocker });
  const result = await runner.run(files, 'Update src/deep/nested/value.cjs to export two; run npm test and npm run build.', endpoint, () => {});
  assert.ok(issued && calls >= 2 && tarballCalls > 0 && observedChecks);
  assert.equal(Buffer.from(result.files.find((f) => f.path === sourcePath).content_base64, 'base64').toString(), 'module.exports = 2;\n');
  assert.ok(result.files.every((f) => !f.path.includes('node_modules') && !f.path.startsWith('dist/') && !f.path.startsWith('.git/')));
  assert.equal(result.files.find((f) => f.path === 'package-lock.json').content_base64, files.find((f) => f.path === 'package-lock.json').content_base64);
  process.stdout.write(`PASS real repository container at ${memoryMiB}m under strict Linux umask: npm dependency installed, nested source edited, tests/build ran, read-only input and credential isolation verified, lockfile restored; ${calls} model fixture calls.\n`);
} finally { rmSync(directory, { recursive: true, force: true }); }
