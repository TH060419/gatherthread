import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, realpath, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const desktop = path.join(root, 'apps/desktop'), dist = path.join(desktop, 'dist'), resources = path.join(dist, 'resources');
if (!/^v24\./u.test(process.version)) throw new Error('Build with Node 24; its runtime is bundled with the prototype.');
await mkdir(path.join(resources, 'runtime'), { recursive: true }); await mkdir(path.join(dist, 'ui'), { recursive: true });
const alias = { '@gatherthread/protocol': path.join(root, 'packages/protocol/src/index.ts'),
  '@gatherthread/bridge': path.join(root, 'packages/bridge/src/index.ts'),
  '@gatherthread/adapters': path.join(root, 'packages/adapters/src/index.ts') };
const common = { bundle: true, platform: 'node', target: 'node24', format: 'esm', alias, legalComments: 'linked',
  banner: { js: 'import { createRequire as desktopCreateRequire } from "node:module"; const require = desktopCreateRequire(import.meta.url);' } };
await build({ ...common, entryPoints: [path.join(desktop, 'src/main.mjs')], outfile: path.join(dist, 'main.mjs'), external: ['electron'] });
for (const name of ['demo-server', 'demo-connector']) await build({ ...common,
  entryPoints: [path.join(desktop, `test/fixtures/${name}.mjs`)], outfile: path.join(resources, `${name}.mjs`) });
await cp(path.join(desktop, 'src/preload.cjs'), path.join(dist, 'preload.cjs'));
await cp(path.join(desktop, 'src/ui'), path.join(dist, 'ui'), { recursive: true });
await cp(path.join(root, 'apps/web/dist/app/src/styles.css'), path.join(dist, 'ui/web-styles.css'));
await cp(path.join(root, 'apps/web/dist/app/src/fonts'), path.join(dist, 'ui/fonts'), { recursive: true });
await cp(path.join(root, 'apps/web/dist'), path.join(resources, 'web'), { recursive: true });
for (const [from, to] of [['logo/svg/lockup-color-transparent-light.svg', 'ui/brand-light.svg'],
  ['logo/svg/lockup-color-transparent-dark.svg', 'ui/brand-dark.svg'],
  ['logo/png/app-icon-color-on-white-512px.png', 'resources/app-icon.png'],
  ['prototypes/codex-launcher/assets/GatherThread.icns', 'resources/GatherThread.icns']]) await cp(path.join(root, from), path.join(dist, to));
await cp(path.join(root, 'packages/codex-connect/dist'), path.join(resources, 'connector'), { recursive: true });
await cp(path.join(root, 'packages/claude-connect/dist/claude-connect.js'), path.join(resources, 'connector/claude-connect.js'));
await writeFile(path.join(resources, 'connector/package.json'), JSON.stringify({ type: 'module' }));
const node = await realpath(process.execPath);
await cp(node, path.join(resources, 'runtime/node')); await chmod(path.join(resources, 'runtime/node'), 0o755);
const license = await readFile(path.join(root, '.local/desktop-build/Node-LICENSE.txt'), 'utf8');
const licenseRecord = JSON.parse(await readFile(path.join(root, '.local/desktop-build/runtime-license.json'), 'utf8'));
if (licenseRecord.version !== process.version || licenseRecord.source !== `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`
  || licenseRecord.sha256 !== createHash('sha256').update(license).digest('hex')
  || !license.startsWith('Node.js is licensed for use as follows:') || license.length < 10_000)
  throw new Error('Matching official Node license is required. Run npm run desktop:prepare-license.');
await writeFile(path.join(resources, 'runtime/Node-LICENSE.txt'), license);
await cp(path.join(root, '.local/desktop-build/runtime-license.json'), path.join(resources, 'runtime/license-source.json'));
for (const name of ['LICENSE', 'NOTICE']) await cp(path.join(root, name), path.join(resources, name));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(path.join(resources, 'build-info.json'), JSON.stringify({ format: 1, source_revision: revision,
  local_changes: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  node: process.version, architecture: process.arch, web_source: revision,
  runtime_sha256: createHash('sha256').update(await readFile(node)).digest('hex'),
  status: 'local-prototype-not-notarized' }, null, 2));
console.log('Desktop build ready; the demo includes the current Web build.');
