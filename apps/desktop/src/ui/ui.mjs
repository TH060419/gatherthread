const api = window.gatherthreadDesktop;
const $ = id => document.getElementById(id);
for (const button of document.querySelectorAll('button')) {
  button.classList.add('button');
  if (!button.classList.contains('button-primary')) button.classList.add('button-secondary');
}
$('prepare-demo').classList.replace('button-secondary', 'button-primary');
let state, language = 'zh-CN', pending = false, currentHandoff = null;
const t = (zh, en) => language === 'zh-CN' ? zh : en;
const errors = {
  invalid_request: ['操作内容无效，请重新打开本机管理窗口。', 'Invalid action. Reopen local Agent management.'],
  not_available: ['所需程序或资源不可用。请检查应用是否完整安装。', 'Required resource unavailable. Check the installation.'],
  invalid_handoff: ['连接链接已失效或不受支持，请在工作区重新打开启动器。', 'Invalid or expired link. Open Launcher again from the workspace.'],
  handoff_used: ['本次授权已经提交，请在工作区生成新链接，不要重复提交。', 'Authorization was already submitted. Generate a new link in the workspace.'],
  wrong_environment: ['链接与当前服务器不一致，请先切换到相应的正式服或测试服。', 'The link belongs to another server. Select the matching environment.'],
  authorization_failed: ['账号验证失败。请检查密码，然后从工作区重新打开启动器。', 'Sign-in failed. Check the password and open a new Launcher link.'],
  authorization_uncertain: ['授权结果未确认。不会自动重试或启动 Agent；请从工作区重新授权，并在设置中检查设备列表。', 'Authorization is unconfirmed. No automatic retry or Agent start. Reauthorize and check your device list in Settings.'],
  rate_limited: ['操作过于频繁，请稍后在工作区重新授权。', 'Too many attempts. Reauthorize later from the workspace.'],
  cancelled: ['操作已取消，未自动重新运行。', 'Cancelled. Nothing was automatically restarted.'],
  invalid_executable: ['Agent 程序不存在、已发生变化或无法识别。请重新选择正确的可执行文件。', 'Agent executable missing, changed or unrecognized. Choose it again.'],
  executable_signature_invalid: ['Agent 程序的代码签名无效，macOS 无法正常启动它。请从官方渠道重新安装对应 CLI，再选择新安装的程序；重复选择当前文件无法解决。', 'The Agent code signature is invalid and macOS cannot launch it. Reinstall the CLI from its official source and select the new executable; selecting this file again will not help.'],
  executable_terminated: ['Agent 在版本检查时被终止。请确认它能在终端运行；若仍然退出，请重新安装官方 CLI，再选择新程序。', 'The Agent was terminated during its version check. Check that it runs in Terminal; if it still exits, reinstall the official CLI and select it again.'],
  executable_probe_timeout: ['Agent 版本检查超时。请在终端确认该程序能正常启动，再返回重新选择。', 'The Agent version check timed out. Confirm that the program starts in Terminal, then select it again.'],
  executable_probe_failed: ['Agent 版本检查失败。请检查 CLI 的安装和所需运行环境，再重新选择正确的程序。', 'The Agent version check failed. Check the CLI installation and its runtime dependencies, then select the correct executable.'],
  executable_detection_busy: ['正在检查 Agent 程序，请稍等检查完成。', 'Checking the Agent program. Please wait for it to finish.'],
  invalid_workspace: ['项目目录不存在或已发生变化，请重新选择。', 'Project folder missing or changed. Choose it again.'],
  duplicate_connection: ['这个项目的同类 Agent 已在连接或清理中，请先处理现有连接。', 'This Agent is already connected or cleaning up for this project.'],
  connection_limit: ['已达到本机连接限制。请先停止已有连接；若仍不可用，请退出后重新打开。', 'Local connection limit reached. Stop existing connections; restart the app if needed.'],
  connector_failed: ['连接器已退出。请检查 Agent 的安装、登录和插件状态，然后从工作区重新连接。不会自动重跑任务。', 'Connector exited. Check installation, sign-in and plugins, then reconnect. Tasks will not automatically rerun.'],
  startup_timeout: ['启动尚未确认。请检查 Agent 登录、插件与权限提示；可以继续等待或停止连接。不会重复启动。', 'Startup is unconfirmed. Check Agent sign-in, plugins and permission prompts; wait or stop. No duplicate start.'],
  cleanup_pending: ['仍在等待本机任务退出。请保持应用运行，暂时不要重复连接或重复提交任务。', 'Still waiting for native tasks to exit. Keep the app running; do not reconnect or resubmit yet.'],
  unknown_error: ['出现未识别的问题。请先检查连接和任务状态，再重新打开本机管理；未确认的请求不要重复提交。', 'An unexpected problem occurred. Check connection and task status, then reopen management. Do not duplicate unconfirmed requests.'],
};
const states = { authorizing: ['授权中', 'Authorizing'], starting: ['启动中', 'Starting'], connected: ['已连接', 'Connected'],
  stopping: ['停止中', 'Stopping'], cleanup_pending: ['等待清理', 'Cleanup pending'], stopped: ['已停止', 'Stopped'], failed: ['已退出', 'Exited'] };
function message(code) { const pair = errors[code] ?? errors.unknown_error; return t(...pair); }
function feedback(text) { $('feedback').textContent = text; $('feedback').hidden = !text; }
function element(tag, text, className) { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; }
function render(value) {
  state = value;
  $('environment').textContent = value.demo ? t('本机模拟 · 不连接真实模型', 'Local simulation · no real model')
    : value.environment === 'test' ? t('测试服', 'Test environment') : t('正式服', 'Production');
  $('demo-panel').hidden = !value.demo; $('dsh-panel').hidden = value.demo;
  $('connect-form').hidden = !value.handoff; $('handoff-empty').hidden = Boolean(value.handoff);
  if (currentHandoff !== value.handoff?.id) { currentHandoff = value.handoff?.id;
    $('password').value = ''; $('code-sync').checked = false;
    if (value.handoff && !value.demo) queueMicrotask(() => act({ action: 'discover', harness: value.handoff.harness })); }
  if (value.handoff) {
    const h = value.handoff; const summary = $('handoff-summary'); summary.replaceChildren();
    for (const [key, text] of [[t('服务器', 'Server'), h.origin], [t('项目', 'Project'), h.project],
      ['Agent', h.harness === 'codex' ? 'Codex' : 'Claude Code'], [t('模型', 'Model'), h.model], [t('账号', 'Account'), h.email]])
      summary.append(element('dt', key), element('dd', text));
    const chosen = $('executable').value; $('executable').replaceChildren();
    const choices = value.executables.filter(e => e.harness === h.harness);
    for (const c of choices) { const o = element('option', c.version); o.value = c.id; $('executable').append(o); }
    if (choices.some(c => c.id === chosen)) $('executable').value = chosen;
    $('executable').hidden = choices.length < 2;
    $('executable').required = choices.length > 1;
    const detection = value.detection.find(d => d.harness === h.harness);
    const searching = detection?.state === 'searching', found = choices[0];
    $('program-status').textContent = searching ? t('正在查找并检查程序…', 'Finding and checking the program…')
      : found ? `${t('已找到', 'Found')} · ${found.version}`
      : detection?.state === 'failed' ? t('找到了程序，但暂时无法使用', 'A program was found but cannot be used yet')
      : t('还没有找到可用程序', 'No usable program found yet');
    $('program-status').dataset.state = searching ? 'searching' : found ? 'ready' : 'missing';
    $('program-details').hidden = !found || searching; $('program-path').textContent = found?.label ?? '';
    $('program-hint').textContent = searching ? t('只检查程序版本，不会启动任务。', 'Only checking the version; no task will run.')
      : found ? value.demo ? t('这是本机模拟程序。', 'This is a local mock program.')
        : detection?.remembered ? t('已记住程序位置，下次打开会自动检查。可继续选择项目目录并连接。', 'Location saved and checked automatically next time. Choose a project folder and connect.')
        : t('本次可以使用，但程序位置未能保存；下次打开可重新查找。', 'Ready for this session, but the location could not be saved. Find it again next time.')
      : detection?.error ? message(detection.error)
      : t('已安装？可直接选择应用或安装文件夹，无需查找内部文件。尚未安装时，请先安装对应 Agent 的官方 CLI，再点击重新查找。', 'Already installed? Choose the app or installation folder without finding internal files. Otherwise, install the official Agent CLI and select Find again.');
    $('choose-cli').disabled = value.demo || pending || searching;
    $('find-cli').disabled = value.demo || pending || searching;
    $('find-cli').textContent = searching ? t('正在查找…', 'Searching…') : t('重新查找', 'Find again');
    $('choose-folder').disabled = value.demo || pending;
    $('workspace-label').textContent = value.workspace?.label ?? t('请选择允许 Agent 使用的项目目录', 'Choose the folder this Agent may use');
    $('connect').disabled = pending || searching || !choices.length || !value.workspace;
    $('password').required = !value.demo; $('password').disabled = value.demo;
    $('password').placeholder = value.demo ? t('模拟验收无需密码', 'No password for simulation') : '';
    $('code-sync').disabled = value.demo || pending;
  }
  const list = $('connections'); list.replaceChildren();
  if (!value.connections.length) list.append(element('p', t('还没有由桌面端启动的连接。已有 DSH 插件或其他设备的在线状态仍在工作区中显示。',
    'No connections started by Desktop yet. Existing DSH plugins and other devices remain visible in the workspace.'), 'desktop-note'));
  for (const r of value.connections) {
    const card = element('article', '', 'desktop-connection'), head = element('header');
    head.append(element('strong', `${r.harness === 'codex' ? 'Codex' : 'Claude Code'} · ${r.project}`));
    const badge = element('span', t(...states[r.state]), 'desktop-state'); badge.dataset.state = r.state; head.append(badge); card.append(head);
    card.append(element('p', `${r.model} · ${r.origin}`, 'desktop-note'));
    if (r.error) card.append(element('p', message(r.error), 'desktop-note'));
    const actions = element('div', '', 'connection-actions');
    if (['authorizing', 'starting', 'connected', 'stopping', 'cleanup_pending'].includes(r.state)) {
      const stop = element('button', t('停止连接', 'Stop connection'), 'button button-danger desktop-stop'); stop.type = 'button';
      stop.disabled = ['stopping', 'cleanup_pending'].includes(r.state);
      stop.addEventListener('click', () => act({ action: 'stop', connection_id: r.id })); actions.append(stop);
    }
    const folder = element('button', t('在访达中打开目录', 'Show folder in Finder'), 'button button-secondary'); folder.type = 'button';
    folder.addEventListener('click', () => act({ action: 'open_workspace', workspace_id: r.workspace_id })); actions.append(folder);
    card.append(actions); list.append(card);
  }
}
async function act(input) {
  try {
    const result = await api.action(input);
    if (result.ok) { render(result.data); return true; }
    feedback(message(result.error)); return false;
  } catch { feedback(message('unknown_error')); return false; }
}
$('language').addEventListener('click', () => {
  language = language === 'zh-CN' ? 'en' : 'zh-CN'; document.documentElement.lang = language;
  for (const e of document.querySelectorAll('[data-zh]')) e.textContent = language === 'zh-CN' ? e.dataset.zh : e.dataset.en;
  $('language').textContent = language === 'zh-CN' ? 'EN' : '中文'; feedback(''); if (state) render(state);
});
$('connect-form').addEventListener('submit', async e => {
  e.preventDefault(); if (pending || !state?.handoff || !state.workspace) return;
  if (!$('executable').value || state.detection.find(d => d.harness === state.handoff.harness)?.state === 'searching') return;
  const input = { action: 'start', handoff_id: state.handoff.id, executable_id: $('executable').value,
    workspace_id: state.workspace.id, password: state.demo ? 'local-fixture-only' : $('password').value, code_sync: $('code-sync').checked };
  pending = true; $('password').value = ''; feedback(''); render(state);
  const timer = setTimeout(() => feedback(t('仍在等待授权结果。可以在连接状态中停止；请勿重复提交。',
    'Still waiting for authorization. You can stop it below; do not submit again.')), 16_000);
  try { await act(input); } finally { input.password = ''; clearTimeout(timer); pending = false; if (state) render(state); }
});
$('choose-cli').addEventListener('click', () => { feedback(''); if (state?.handoff) act({ action: 'select_cli', harness: state.handoff.harness }); });
$('find-cli').addEventListener('click', () => { feedback(''); if (state?.handoff) act({ action: 'discover', harness: state.handoff.harness, force: true }); });
$('choose-folder').addEventListener('click', () => act({ action: 'select_workspace' }));
$('open-dsh').addEventListener('click', () => act({ action: 'open_dsh' }));
$('back').addEventListener('click', () => act({ action: 'show_workspace' }));
$('prepare-demo').addEventListener('click', () => act({ action: 'demo_handoff' }));
if (api) { api.subscribe(render); await act({ action: 'status' }); await act({ action: 'discover' }); }
else feedback(t('本机管理需要从 GatherThread Desktop 的「工作区 → 本机 Agent」打开。', 'Open local management from GatherThread Desktop → Workspace → Local Agents.'));
window.addEventListener('error', () => feedback(message('unknown_error')));
window.addEventListener('unhandledrejection', () => feedback(message('unknown_error')));
