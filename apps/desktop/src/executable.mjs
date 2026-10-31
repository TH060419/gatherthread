import { execFile } from 'node:child_process';
import { fail } from './policy.mjs';

// Never forward CLI stderr to the renderer: it may contain local configuration.
function run(command, args, env, execFileImpl) {
  return new Promise(resolve => execFileImpl(command, args,
    { env, timeout: 4000, maxBuffer: 4096, shell: false },
    (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })));
}
async function hasInvalidSignature(executable, env, execFileImpl) {
  const result = await run('/usr/bin/codesign', ['--verify', '--strict', executable],
    { ...env, LANG: 'C', LC_ALL: 'C' }, execFileImpl);
  // Unsigned scripts and unsupported formats are not evidence of a damaged signature.
  return Boolean(result.error && !result.error.signal
    && /invalid signature|code or signature have been modified/iu.test(result.stderr));
}
export async function probeExecutable(executable, harness, env, { platform = process.platform, execFileImpl = execFile } = {}) {
  const appBinary = platform === 'darwin' && executable.includes('.app/Contents/');
  // Avoid repeatedly launching a known damaged app-bundled binary (and OS crash dialogs).
  if (appBinary && await hasInvalidSignature(executable, env, execFileImpl)) fail('executable_signature_invalid');
  const { error, stdout } = await run(executable, ['--version'], env, execFileImpl);
  if (error) {
    if (error.killed && error.signal === 'SIGTERM') fail('executable_probe_timeout');
    if (platform === 'darwin' && error.signal === 'SIGKILL'
      && await hasInvalidSignature(executable, env, execFileImpl)) fail('executable_signature_invalid');
    if (error.signal) fail('executable_terminated');
    if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) fail('invalid_executable');
    fail('executable_probe_failed');
  }
  const version = stdout.trim().split(/\r?\n/u)[0];
  // A Claude executable must not be accepted as Codex (or vice versa).
  const valid = harness === 'codex' ? /^codex(?:-cli)? \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/iu
    : /^(?:\d+\.\d+\.\d+(?:[-+][\w.-]+)? \(Claude Code\)|claude(?: code)? \d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/iu;
  if (version.length > 120 || !valid.test(version)) fail('invalid_executable');
  return version;
}
