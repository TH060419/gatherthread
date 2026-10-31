import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DesktopActionSchema, DesktopStatusSchema, DesktopErrorCodeSchema } from '@gatherthread/protocol';
import { parseHandoff, connectorArguments, childEnvironment, fail } from './policy.mjs';
import { claimAuthorization } from './authorization.mjs';
import { ConnectorSupervisor } from './supervisor.mjs';
import { probeExecutable } from './executable.mjs';
import { programCandidates, selectedProgramCandidates } from './program-discovery.mjs';

export async function inspectFile(file, executable = false) {
  if (!path.isAbsolute(file) || /[\u0000-\u001f]/u.test(file)) fail(executable ? 'invalid_executable' : 'invalid_workspace');
  try {
    const resolved = await realpath(file), s = await stat(resolved);
    if (executable ? !s.isFile() : !s.isDirectory()) fail(executable ? 'invalid_executable' : 'invalid_workspace');
    await access(resolved, executable ? constants.X_OK : constants.R_OK | constants.X_OK);
    return { path: resolved, dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
  } catch { fail(executable ? 'invalid_executable' : 'invalid_workspace'); }
}
async function recheck(pick, executable = false) {
  const current = await inspectFile(pick.path, executable);
  if (current.path !== pick.path || current.dev !== pick.dev || current.ino !== pick.ino
    || executable && (current.size !== pick.size || current.mtimeMs !== pick.mtimeMs)) fail(executable ? 'invalid_executable' : 'invalid_workspace');
  return current.path;
}
export class DesktopHost {
  constructor({ environment, origin, resources, ui, demo = null, supervisor = new ConnectorSupervisor(), claim = claimAuthorization,
    programStore = null, candidates = programCandidates, probe = probeExecutable }) {
    Object.assign(this, { environment, origin, resources, ui, demo, supervisor, claim, programStore, candidates, probe });
    this.handoff = null; this.executables = new Map(); this.workspaces = new Map(); this.workspace = null;
    this.consumed = new Set(); this.discoveries = new Map(); this.selectionEpoch = new Map();
    this.detection = new Map(['codex', 'claude-code'].map(harness => [harness,
      { harness, state: 'idle', error: null, remembered: false }]));
    supervisor.on('change', () => this.changed());
  }
  changed() { this.ui.changed?.(this.status()); }
  status() {
    const h = this.handoff?.expiresAt > Date.now() ? this.handoff : null;
    return DesktopStatusSchema.parse({ version: 1, environment: this.environment, demo: Boolean(this.demo),
      detection: [...this.detection.values()],
      handoff: h ? { id: h.id, origin: h.link.origin, project: h.link.project, harness: h.link.harness,
        model: h.link.model, email: h.link.email, expires_at: h.expiresAt } : null,
      executables: [...this.executables.values()].map(({ id, harness, path: label, version }) => ({ id, harness, label, version })),
      workspace: this.workspace ? { id: this.workspace.id, label: this.workspace.path } : null,
      connections: this.supervisor.publicRecords() });
  }
  acceptHandoff(raw) {
    if (this.demo) fail('wrong_environment');
    const link = parseHandoff(raw);
    // The legacy bearer-paste flow stays in the existing Launcher, never in this UI.
    if (link.version === '1') fail('invalid_handoff');
    if (link.origin !== this.origin) fail('wrong_environment');
    if (this.consumed.has(link.authorizationId)) fail('handoff_used');
    this.handoff = { id: randomUUID(), link, expiresAt: Date.now() + 10 * 60_000 }; this.changed();
  }
  probeEnvironment() {
    const env = childEnvironment(process.env, { token: '', runtimeDirectory: path.dirname(this.resources.node), home: homedir() });
    delete env.GATHERTHREAD_TOKEN; delete env.GATHERTHREAD_LAUNCHER_CONTROL; return env;
  }
  cancelDiscovery() { for (const harness of this.detection.keys()) this.selectionEpoch.set(harness, (this.selectionEpoch.get(harness) ?? 0) + 1); }
  async installChoice(harness, file, version, selected, epoch) {
    if (this.selectionEpoch.get(harness) !== epoch) return;
    const remembered = await this.programStore?.set(harness, selected) ?? false;
    if (this.selectionEpoch.get(harness) !== epoch) return;
    for (const [id, e] of this.executables) if (e.harness === harness) this.executables.delete(id);
    const id = randomUUID(); this.executables.set(id, { ...file, id, harness, version });
    this.detection.set(harness, { harness, state: 'ready', error: null, remembered }); this.changed();
  }
  async discover(harness, force = false) {
    if (this.demo) return;
    await Promise.all((harness ? [harness] : ['codex', 'claude-code']).map(h => this.discoverOne(h, force)));
  }
  async discoverOne(harness, force) {
    if (this.discoveries.has(harness)) return this.discoveries.get(harness);
    const previous = this.detection.get(harness);
    if (previous.state === 'searching') fail('executable_detection_busy');
    if (!force && previous.state === 'ready') return;
    const epoch = (this.selectionEpoch.get(harness) ?? 0) + 1; this.selectionEpoch.set(harness, epoch);
    this.detection.set(harness, { ...previous, state: 'searching', error: null }); this.changed();
    const work = (async () => {
      let error = null, probed = 0; const seen = new Set(), deadline = Date.now() + 15_000;
      const saved = await this.programStore?.get(harness);
      const candidates = [...new Set([saved, ...await this.candidates(harness)].filter(Boolean))];
      for (const selected of candidates) {
        if (this.selectionEpoch.get(harness) !== epoch) return;
        if (probed >= 4 || Date.now() > deadline) { error ??= 'executable_probe_timeout'; break; }
        let file; try { file = await inspectFile(selected, true); } catch { continue; }
        if (selected !== saved && file.path.includes('.app/Contents/')) continue;
        if (seen.has(file.path)) continue; seen.add(file.path); probed++;
        try {
          const version = await this.probe(file.path, harness, this.probeEnvironment()); await recheck(file, true);
          await this.installChoice(harness, file, version, selected, epoch); return;
        } catch (e) { error = DesktopErrorCodeSchema.safeParse(e.code).success ? e.code : 'executable_probe_failed'; }
      }
      if (this.selectionEpoch.get(harness) !== epoch) return;
      for (const [id, e] of this.executables) if (e.harness === harness) this.executables.delete(id);
      this.detection.set(harness, { harness, state: error ? 'failed' : 'missing', error, remembered: false }); this.changed();
    })().catch(error => {
      if (this.selectionEpoch.get(harness) === epoch) {
        for (const [id, e] of this.executables) if (e.harness === harness) this.executables.delete(id);
        this.detection.set(harness, { harness, state: 'failed', error: 'executable_probe_failed', remembered: false }); this.changed();
      }
      throw error;
    }).finally(() => { this.discoveries.delete(harness); });
    this.discoveries.set(harness, work); return work;
  }
  async pickExecutable(harness) {
    const previous = this.detection.get(harness);
    if (previous.state === 'searching') fail('executable_detection_busy');
    const epoch = (this.selectionEpoch.get(harness) ?? 0) + 1; this.selectionEpoch.set(harness, epoch);
    this.detection.set(harness, { ...previous, state: 'searching', error: null }); this.changed();
    try {
      const selected = await this.ui.pickFile(harness);
      if (this.selectionEpoch.get(harness) !== epoch) return;
      if (!selected) { this.detection.set(harness, previous); this.changed(); return; }
      let error = 'invalid_executable';
      for (const candidate of await selectedProgramCandidates(selected, harness)) {
        if (this.selectionEpoch.get(harness) !== epoch) return;
        let file; try { file = await inspectFile(candidate, true); } catch { continue; }
        try {
          const version = await this.probe(file.path, harness, this.probeEnvironment()); await recheck(file, true);
          await this.installChoice(harness, file, version, candidate, epoch); return;
        } catch (e) { error = DesktopErrorCodeSchema.safeParse(e.code).success ? e.code : 'executable_probe_failed'; }
      }
      fail(error);
    } catch (error) {
      if (this.selectionEpoch.get(harness) === epoch) { this.detection.set(harness, previous); this.changed(); }
      throw error;
    }
  }
  async pickWorkspace() {
    const selected = await this.ui.pickDirectory(); if (!selected) return;
    const pick = { ...await inspectFile(selected), id: randomUUID() };
    this.workspaces.set(pick.id, pick); this.workspace = pick; this.changed();
  }
  async prepareDemo() {
    if (!this.demo) fail('not_available');
    const pick = { ...await inspectFile(this.demo.workspace), id: randomUUID() };
    this.workspace = pick; this.workspaces.set(pick.id, pick);
    const id = randomUUID(); this.executables.clear();
    this.executables.set(id, { id, harness: 'codex', path: '本机模拟 Agent（不会调用真实模型）', version: 'fixture 1' });
    this.handoff = { id: randomUUID(), expiresAt: Date.now() + 600_000, link: {
      version: '2', origin: this.origin, project: this.demo.project, model: 'desktop-fixture', harness: 'codex',
      email: 'desktop@example.invalid', authorizationId: randomUUID(), contextTokens: 65536, historySync: 'never' } };
    this.changed();
  }
  async start(input) {
    const h = this.handoff;
    if (!h || h.id !== input.handoff_id || h.expiresAt <= Date.now()) fail('invalid_handoff');
    if (this.consumed.has(h.link.authorizationId)) fail('handoff_used');
    if (this.consumed.size >= 1024) fail('connection_limit');
    const exe = this.executables.get(input.executable_id), workspace = this.workspaces.get(input.workspace_id);
    if (this.detection.get(h.link.harness)?.state === 'searching') fail('executable_detection_busy');
    if (!exe || exe.harness !== h.link.harness) fail('invalid_executable');
    if (!workspace) fail('invalid_workspace');
    if (!this.demo) await recheck(exe, true);
    await recheck(workspace);
    // Check private runtime/bundle before consuming a one-use server authorization.
    await inspectFile(this.resources.node, true);
    const connector = this.resources[h.link.harness];
    if (!this.demo && !(await stat(connector)).isFile()) fail('not_available');
    // Recheck after file IO: another click/deep link may have replaced the form.
    if (this.handoff !== h || this.consumed.has(h.link.authorizationId)) fail('handoff_used');
    const r = this.supervisor.reserve(h.link, workspace.id);
    this.consumed.add(h.link.authorizationId); this.handoff = null; this.changed();
    try {
      let token = this.demo ? this.demo.token : await this.claim(h.link, input.password, { signal: r.controller.signal });
      input.password = ''; if (r.controller.signal.aborted) fail('cancelled');
      if (!this.demo) await recheck(exe, true);
      await recheck(workspace);
      const env = childEnvironment(process.env, { token, runtimeDirectory: path.dirname(this.resources.node), home: homedir() });
      token = '';
      const args = this.demo ? [this.demo.connector, '--url', this.origin, '--session', this.demo.session]
        : connectorArguments(h.link, { connector, executable: exe.path, workspace: workspace.path, codeSync: input.code_sync });
      try { this.supervisor.launch(r, this.resources.node, args, { env, cwd: workspace.path }); }
      finally { delete env.GATHERTHREAD_TOKEN; }
    } catch (error) {
      input.password = ''; const code = DesktopErrorCodeSchema.safeParse(error.code);
      this.supervisor.reject(r, code.success ? code.data : 'unknown_error'); throw error;
    }
  }
  async action(raw) {
    const input = DesktopActionSchema.parse(raw);
    switch (input.action) {
      case 'status': break;
      case 'discover': await this.discover(input.harness, input.force); break;
      case 'select_cli': if (this.demo) fail('not_available'); await this.pickExecutable(input.harness); break;
      case 'select_workspace': await this.pickWorkspace(); break;
      case 'start': await this.start(input); break;
      case 'stop': this.supervisor.stop(input.connection_id); break;
      case 'show_workspace': this.ui.showWorkspace(); break;
      case 'open_dsh': if (this.demo) fail('not_available'); await this.ui.openDsh(); break;
      case 'open_workspace': {
        const workspace = this.workspaces.get(input.workspace_id); if (!workspace) fail('invalid_workspace');
        await recheck(workspace); await this.ui.openDirectory(workspace.path); break;
      }
      case 'demo_handoff': await this.prepareDemo(); break;
    }
    return this.status();
  }
}
