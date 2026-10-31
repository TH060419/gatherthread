import path from 'node:path';
import { homedir } from 'node:os';
import { opendir, stat } from 'node:fs/promises';

const nameFor = harness => harness === 'codex' ? 'codex' : 'claude';
export const safeProgramPath = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
async function versions(root, suffix) {
  const entries = []; let directory;
  try {
    directory = await opendir(root);
    for await (const entry of directory) {
      if (entry.isDirectory() && /^v?\d+\.\d+\.\d+$/u.test(entry.name)) entries.push(entry.name);
      if (entries.length >= 32) break;
    }
  } catch { return []; }
  return entries.sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 4)
    .map(version => path.join(root, version, suffix));
}
export async function programCandidates(harness, { home = homedir(), searchPath = process.env.PATH ?? '' } = {}) {
  const name = nameFor(harness);
  const dirs = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.npm-global/bin'), path.join(home, '.volta/bin'), path.join(home, '.asdf/shims'),
    ...searchPath.split(path.delimiter).filter(p => safeProgramPath(p) && !p.includes('.app/Contents/')).slice(0, 16),
    ...await versions(path.join(home, '.nvm/versions/node'), 'bin'),
    ...await versions(path.join(home, '.local/share/fnm/node-versions'), 'installation/bin')];
  const result = dirs.map(dir => path.join(dir, name));
  // Do not probe private app-bundled programs automatically: some builds cannot
  // run outside their owning app. Users may select an app explicitly below.
  return [...new Set(result)].filter(safeProgramPath).slice(0, 32);
}
export async function selectedProgramCandidates(selected, harness) {
  if (!safeProgramPath(selected)) return [];
  let info; try { info = await stat(selected); } catch { return []; }
  if (info.isFile()) return [selected];
  if (!info.isDirectory()) return [];
  const name = nameFor(harness);
  const relative = [name, `bin/${name}`, `node_modules/.bin/${name}`];
  if (selected.endsWith('.app')) relative.unshift(`Contents/MacOS/${name}`, `Contents/Resources/${name}`,
    ...(harness === 'codex' ? ['Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'] : []));
  return relative.map(p => path.join(selected, p));
}
