export const ORIGINS = Object.freeze({ production: 'https://gatherthread.cn', test: 'https://test.gatherthread.cn' });
export const WEB_PREFERENCES = Object.freeze({ nodeIntegration: false, contextIsolation: true,
  sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  spellcheck: true, navigateOnDragDrop: false });
export class DesktopError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new DesktopError(code); };
export function environmentOrigin(environment, demoOrigin) {
  if (environment === 'demo' && /^http:\/\/127\.0\.0\.1:\d+$/u.test(demoOrigin ?? '')) return demoOrigin;
  return ORIGINS[environment] ?? fail('wrong_environment');
}
export function isWorkspaceURL(raw, origin) {
  try { const u = new URL(raw); return u.origin === origin && !u.username && !u.password
    && ['https:', 'http:'].includes(u.protocol); } catch { return false; }
}
export function externalURL(raw) {
  try { const u = new URL(raw); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
    && raw.length <= 4096 ? u.href : null; } catch { return null; }
}
export function isWorkspaceDownload(raw, origin) {
  try { const u = new URL(raw); return isWorkspaceURL(raw, origin)
    || u.protocol === 'blob:' && u.origin === origin; } catch { return false; }
}
export function isWorkspacePermission({ native, current, requestingUrl, isMainFrame }, origin) {
  return !native && current === true && isMainFrame === true && isWorkspaceURL(requestingUrl, origin);
}
/** Parse the existing launcher contract; use its shared cross-platform vectors. */
export function parseHandoff(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2048 || /[\u0000-\u0020\u007f]/u.test(raw) || /%(?![\da-f]{2})/iu.test(raw)) fail('invalid_handoff');
  try { decodeURIComponent(raw); } catch { fail('invalid_handoff'); }
  let u; try { u = new URL(raw); } catch { fail('invalid_handoff'); }
  if (u.protocol !== 'gatherthread-connect:' || u.hostname !== 'connect' || u.port || u.username || u.password
    || !['', '/'].includes(u.pathname) || u.hash || raw.includes('#')) fail('invalid_handoff');
  const fields = Object.fromEntries(u.searchParams), v = fields.v;
  const base = ['v', 'origin', 'project', 'model', 'context_window_tokens', 'visible_history_sync'];
  const keys = v === '1' ? base : v === '2' ? [...base, 'email', 'authorization_id']
    : v === '3' ? [...base, 'email', 'authorization_id', 'harness'] : [];
  if (!keys.length || [...u.searchParams].length !== keys.length || keys.some(k => !fields[k])
    || Object.keys(fields).some(k => !keys.includes(k))) fail('invalid_handoff');
  if (!(v === '1' ? [ORIGINS.production] : Object.values(ORIGINS)).includes(fields.origin)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(fields.project)
    || !fields.model.trim() || [...fields.model].length > 120 || fields.model.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(fields.model)
    || !/^\d+$/u.test(fields.context_window_tokens)
    || Number(fields.context_window_tokens) < 4096 || Number(fields.context_window_tokens) > 2_000_000
    || !['first-connect', 'never'].includes(fields.visible_history_sync)) fail('invalid_handoff');
  const harness = v === '3' ? fields.harness : 'codex';
  if (!['codex', 'claude-code'].includes(harness) || harness === 'claude-code'
    && !/^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(fields.model)) fail('invalid_handoff');
  let email = null, authorizationId = null;
  if (v !== '1') {
    email = fields.email.trim().toLowerCase(); authorizationId = fields.authorization_id.toLowerCase();
    if (fields.email.length > 254 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(email)
      || email.split('@')[0].length > 64 || email.split('@')[1].split('.').some(p => p.length > 63)
      || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(authorizationId)) fail('invalid_handoff');
  }
  return Object.freeze({ version: v, origin: fields.origin, project: fields.project, model: fields.model,
    contextTokens: Number(fields.context_window_tokens), historySync: fields.visible_history_sync,
    email, authorizationId, harness });
}
export function connectorArguments(link, { connector, executable, workspace, codeSync = false }) {
  const result = [connector, '--url', link.origin, '--project', link.project, '--workspace', workspace,
    '--plugin-hooks', '--model', link.model];
  if (link.harness === 'codex') result.push('--codex-command', executable, '--visible-history-sync', link.historySync,
    '--context-window-tokens', String(link.contextTokens));
  else result.push('--claude-command', executable);
  if (codeSync) result.push('--code-sync');
  return result;
}
// GUI launch PATH is often sparse. Never source a login shell or carry unrelated
// provider credentials / NODE_OPTIONS into the private connector runtime.
export function childEnvironment(parent, { token, runtimeDirectory, home }) {
  const env = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'SSH_AUTH_SOCK'])
    if (typeof parent[k] === 'string') env[k] = parent[k];
  env.PATH = [runtimeDirectory, '/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  env.GATHERTHREAD_TOKEN = token; env.GATHERTHREAD_LAUNCHER_CONTROL = 'stdin-v1';
  return env;
}
