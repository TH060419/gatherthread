import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { childEnvironment } from './policy.mjs';
import { homedir } from 'node:os';

// Demo runs the real server and Web build with fresh in-memory identities. Its
// credentials travel only over the parent's private Node IPC channel.
export async function startDemo({ directory, staticDirectory, node, serverScript, connector }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = childEnvironment(process.env, { token: '', runtimeDirectory: path.dirname(node), home: homedir() });
  delete env.GATHERTHREAD_TOKEN; delete env.GATHERTHREAD_LAUNCHER_CONTROL;
  const child = spawn(node, [serverScript, directory, staticDirectory], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false });
  const fixture = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Demo startup timeout')); }, 15_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Demo unavailable')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Demo exited before ready')); });
    child.once('message', message => {
      clearTimeout(timer);
      if (!message || message.kind !== 'ready' || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(message.origin)
        || typeof message.cookie !== 'string' || typeof message.token !== 'string') { child.kill('SIGTERM'); reject(new Error('Demo invalid')); return; }
      resolve(message);
    });
  });
  return { ...fixture, connector, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(resolve => child.once('exit', resolve));
    child.send({ action: 'stop' }); await done;
  } };
}
