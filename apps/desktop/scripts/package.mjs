import { packager } from '@electron/packager';
import { mkdir, cp, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const desktop = path.join(root, 'apps/desktop'), dist = path.join(desktop, 'dist');
if (process.platform !== 'darwin') throw new Error('This prototype is packaged and verified on macOS only.');
const output = path.join(root, '.local/desktop-build', `package-${Date.now()}`), stage = path.join(output, 'source');
await mkdir(stage, { recursive: true });
await cp(dist, path.join(stage, 'dist'), { recursive: true, filter: source => source !== path.join(dist, 'resources') });
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'gatherthread-desktop', version: '0.1.0-beta.6',
  private: true, type: 'module', main: 'dist/main.mjs', description: 'GatherThread macOS local prototype' }));
const [appDir] = await packager({ dir: stage, out: output, name: 'GatherThread Desktop', platform: 'darwin', arch: process.arch,
  electronVersion: '45.1.0', appBundleId: 'cn.gatherthread.desktop.prototype', appVersion: '0.1.0-beta.6', buildVersion: '0.1.0',
  icon: path.join(dist, 'resources/GatherThread.icns'), prune: false, asar: true,
  extendInfo: { NSHumanReadableCopyright: 'GatherThread contributors · Apache-2.0',
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true } },
  extraResource: [], overwrite: false });
const appPath = path.join(appDir, 'GatherThread Desktop.app');
await access(appPath);
await cp(path.join(dist, 'resources'), path.join(appPath, 'Contents/Resources/desktop-resources'), { recursive: true });
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
await writeFile(path.join(root, '.local/desktop-build/latest-package.json'), JSON.stringify({ appPath, status: 'local-only-ad-hoc-signed-not-notarized' }, null, 2));
console.log(`Local macOS application: ${appPath}`);
console.log('Ad-hoc signed local prototype; not an Apple-notarized release.');
