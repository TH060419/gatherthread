import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Trusted entrypoint setup, before any Agent-generated code executes. */
export async function prepareNpm(workspace, run, registry = 'http://127.0.0.1:8788', cache = '/tmp/npm-cache') {
  const lockPath = join(workspace, 'package-lock.json');
  const originalLock = readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(originalLock);
  for (const item of Object.values(lock.packages)) {
    if (item.resolved?.startsWith('https://registry.npmjs.org/')) {
      item.resolved = item.resolved.replace('https://registry.npmjs.org/', `${registry}/`);
    }
  }
  try {
    const globalConfig = `${cache}-global-config`;
    writeFileSync(globalConfig, '', { mode: 0o600 });
    writeFileSync(lockPath, JSON.stringify(lock));
    await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund',
      `--registry=${registry}`, '--userconfig=/dev/null', `--globalconfig=${globalConfig}`, `--cache=${cache}`], 1_000_000);
  } finally { writeFileSync(lockPath, originalLock); }
}
