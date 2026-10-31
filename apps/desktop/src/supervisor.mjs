import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fail } from './policy.mjs';

const ACTIVE = new Set(['authorizing', 'starting', 'connected', 'stopping', 'cleanup_pending']);
export function processGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
/** Owns only children spawned here. Stop waits for process-group cleanup, never
 * infers native exit from EOF, a timeout, or a server's disconnected status. */
export class ConnectorSupervisor extends EventEmitter {
  constructor({ spawnImpl = spawn, groupAlive = processGroupAlive, stopDeadline = 30_000, startDeadline = 60_000 } = {}) {
    super(); this.records = new Map(); this.spawnImpl = spawnImpl; this.groupAlive = groupAlive; this.stopDeadline = stopDeadline; this.startDeadline = startDeadline;
  }
  active() { return [...this.records.values()].filter(r => ACTIVE.has(r.state)); }
  reserve(link, workspaceId) {
    if (this.active().some(r => r.origin === link.origin && r.project === link.project && r.harness === link.harness)) fail('duplicate_connection');
    if (this.active().length >= 8) fail('connection_limit');
    for (const [id, r] of this.records) if (this.records.size >= 8 && !ACTIVE.has(r.state)) this.records.delete(id);
    const r = { id: randomUUID(), origin: link.origin, project: link.project, harness: link.harness, model: link.model,
      state: 'authorizing', error: null, workspace_id: workspaceId, started_at: Date.now(), exit_code: null,
      controller: new AbortController(), child: null, timer: null, parentExited: false };
    this.records.set(r.id, r); this.emit('change'); return r;
  }
  publicRecords() { return [...this.records.values()].map(({ id, origin, project, harness, model, state, error,
    workspace_id, started_at, exit_code }) => ({ id, origin, project, harness, model, state, error, workspace_id, started_at, exit_code })); }
  reject(r, error) {
    if (r.child || r.state !== 'authorizing') return;
    r.state = r.controller.signal.aborted ? 'stopped' : 'failed'; r.error = error; this.emit('change');
  }
  launch(r, command, args, { env, cwd }) {
    if (r.controller.signal.aborted || r.state !== 'authorizing') fail('cancelled');
    let child;
    try { child = this.spawnImpl(command, args, { env, cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { this.reject(r, 'connector_failed'); fail('connector_failed'); }
    r.child = child; r.state = 'starting';
    r.startTimer = setTimeout(() => { if (r.state === 'starting') { r.error = 'startup_timeout'; this.emit('change'); } }, this.startDeadline); r.startTimer.unref?.();
    child.stdin.on('error', () => { if (r.state === 'stopping') { r.error = 'cleanup_pending'; this.emit('change'); } });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', () => { if (ACTIVE.has(r.state)) { r.error = 'connector_failed'; this.emit('change'); } });
      const decoder = new StringDecoder('utf8'); let pending = '', discarding = false;
      stream.on('data', chunk => {
        // Drop content-bearing logs entirely; only exact public lifecycle markers cross IPC.
        const text = decoder.write(chunk);
        for (const part of text.split(/(?<=\n)/u)) {
          if (!discarding) { pending += part; if (pending.length > 4096) { pending = ''; discarding = true; } }
          if (part.endsWith('\n')) {
            if (!discarding && pending.trim() === 'GatherThread connector ready.' && r.state === 'starting') {
              clearTimeout(r.startTimer); r.state = 'connected'; r.error = null; this.emit('change');
            }
            pending = ''; discarding = false;
          }
        }
      });
    }
    child.once('error', () => {
      if (!child.pid) { clearTimeout(r.startTimer); r.child = null; r.state = 'failed'; r.error = 'connector_failed'; this.emit('change'); }
    });
    child.once('exit', (code) => {
      r.parentExited = true; r.exit_code = Number.isInteger(code) ? code : null;
      r.expectedStop = r.state === 'stopping' || r.state === 'cleanup_pending';
      clearTimeout(r.startTimer); clearTimeout(r.timer); this.checkExit(r);
    });
    this.emit('change');
  }
  checkExit(r) {
    if (r.child?.pid && this.groupAlive(r.child.pid)) {
      r.state = 'cleanup_pending'; r.error = 'cleanup_pending';
      r.timer = setTimeout(() => this.checkExit(r), 500); r.timer.unref?.();
    } else {
      r.state = r.expectedStop && r.exit_code === 0 ? 'stopped' : 'failed';
      r.error = r.state === 'failed' ? 'connector_failed' : null; r.child = null;
    }
    this.emit('change');
  }
  stop(id) {
    const r = this.records.get(id); if (!r) fail('not_available');
    if (!ACTIVE.has(r.state)) return;
    r.controller.abort();
    if (!r.child) { r.state = 'stopped'; r.error = null; this.emit('change'); return; }
    if (r.state === 'stopping' || r.state === 'cleanup_pending') return;
    r.state = 'stopping'; this.emit('change');
    clearTimeout(r.startTimer);
    try { if (!r.child.stdin.destroyed) r.child.stdin.write('gatherthread:stop\n'); }
    catch { r.error = 'cleanup_pending'; this.emit('change'); }
    r.timer = setTimeout(() => { if (!r.parentExited && r.state === 'stopping') {
      r.error = 'cleanup_pending'; this.emit('change'); } }, this.stopDeadline); r.timer.unref?.();
  }
  stopAll() { for (const r of this.active()) this.stop(r.id); }
}
