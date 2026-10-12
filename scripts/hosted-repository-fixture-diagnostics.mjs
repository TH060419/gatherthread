import { spawnSync } from 'node:child_process';

// The fixed trial smoke retains only its own failed fixture for this read-only
// check. Report typed engine state, not model requests, container logs or errors.
export function reportTrialFixtureFailure(name, { createClient, execute = spawnSync,
  write = message => process.stderr.write(message) }) {
  if (typeof name !== 'string' || /^gt-hosted-[a-f0-9]{16}$/u.exec(name)?.[0] !== name) return;
  const report = message => { try { write(message); } catch {} };
  let client;
  try {
    client = createClient();
    const result = execute('docker', ['container', 'inspect', '--format',
      '{"status":{{json .State.Status}},"exit_code":{{.State.ExitCode}},"oom_killed":{{.State.OOMKilled}},"dead":{{.State.Dead}}}', name],
    { env: client.environment, timeout: 5_000, maxBuffer: 16_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0 || result.error || result.signal || typeof result.stdout !== 'string'
      || result.stdout.length > 1000) throw new Error('fixture_state_unavailable');
    const state = JSON.parse(result.stdout);
    if (!['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(state.status)
      || !Number.isSafeInteger(state.exit_code) || state.exit_code < 0 || state.exit_code > 255
      || typeof state.oom_killed !== 'boolean' || typeof state.dead !== 'boolean') throw new Error('fixture_state_invalid');
    report(`Trial fixture state: ${JSON.stringify({ status: state.status, exit_code: state.exit_code,
      oom_killed: state.oom_killed, dead: state.dead })}\n`);
  } catch { report('Trial fixture state: unavailable.\n'); }
  finally { try { client?.close(); } catch { report('Trial fixture diagnostic client cleanup: failed.\n'); } }
}

// Only the fixed local repository smoke calls this; never use for production output.
export function reportRepositoryFixtureFailure(name, { createClient, execute = spawnSync,
  write = (message) => process.stderr.write(message) }) {
  if (typeof name !== 'string' || /^gt-repository-[a-f0-9]{20}$/u.exec(name)?.[0] !== name) return;
  // A broken diagnostic stream must not replace the original fixture failure.
  const report = (message) => { try { write(message); } catch {} };
  let client;
  try {
    client = createClient();
    const commands = [
      ['state', ['container', 'inspect', '--format',
        '{"status":{{json .State.Status}},"exit_code":{{.State.ExitCode}},"oom_killed":{{.State.OOMKilled}},"dead":{{.State.Dead}}}', name]],
      ['logs', ['container', 'logs', '--tail', '40', name]],
    ];
    for (const [label, args] of commands) {
      try {
        const result = execute('docker', args, { env: client.environment, timeout: 5_000, maxBuffer: 16_000,
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (result.status !== 0 || result.error || result.signal) throw new Error('fixture_diagnostics_unavailable');
        const output = label === 'state' ? result.stdout : `${result.stdout ?? ''}${result.stderr ?? ''}`;
        report(`Repository fixture ${label}: ${JSON.stringify(String(output ?? '')).slice(0, 4000)}\n`);
      } catch { report(`Repository fixture ${label}: unavailable.\n`); }
    }
  } catch { report('Repository fixture diagnostics: unavailable.\n'); }
  finally {
    try { client?.close(); } catch { report('Repository fixture diagnostic client cleanup: failed.\n'); }
  }
}
