import { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, shell, session, powerMonitor } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { DesktopErrorCodeSchema, DesktopResultSchema } from '@gatherthread/protocol';
import { DesktopHost } from './host.mjs';
import { ProgramStore } from './program-store.mjs';
import { WEB_PREFERENCES, ORIGINS, isWorkspaceURL, isWorkspaceDownload, isWorkspacePermission, externalURL } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resourcesPath = app.isPackaged ? path.join(process.resourcesPath, 'desktop-resources') : path.join(here, 'resources');
const managerURL = pathToFileURL(path.join(here, 'ui/index.html')).href;
const requestedDemo = process.argv.includes('--demo') || process.argv.includes('--desktop-smoke');
const smoke = process.argv.includes('--desktop-smoke');
if (requestedDemo) app.commandLine.appendSwitch('lang', 'zh-CN');
if (smoke) console.log('Desktop smoke: main module loaded');
let environment = requestedDemo ? 'demo' : process.argv.includes('--test-environment') ? 'test' : 'production';
// Separate app storage from browsers, the existing Launcher and the DSH plugin.
app.setName('GatherThread Desktop');
if (!app.isPackaged) app.setPath('userData', path.resolve(here, '../../../.local/desktop-profile'));
// Packaged local acceptance can keep all generated files in the chosen workspace.
const profileArg = process.argv.find(arg => arg.startsWith('--demo-profile='));
if (requestedDemo && profileArg && path.isAbsolute(profileArg.slice(15))) app.setPath('userData', profileArg.slice(15));
if (requestedDemo) app.setPath('userData', path.join(app.getPath('userData'), 'local-demo'));
let webWindow, managerWindow, tray, host, demo, quitting = false, quitRequested = false;
let previousURL = '', navigationFailed = false, unresponsive = false, closeExplained = false;
const programStore = new ProgramStore(path.join(app.getPath('userData'), 'agent-programs.json'));
const icon = path.join(resourcesPath, 'app-icon.png');
const resources = { node: path.join(resourcesPath, 'runtime/node'),
  codex: path.join(resourcesPath, 'connector/codex-connect.js'),
  'claude-code': path.join(resourcesPath, 'connector/claude-connect.js') };

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWorkspace());
  // Do not register/steal the existing Launcher's system URL scheme. In-app
  // navigation is intercepted locally; external browser links keep their handler.
  app.on('open-url', event => event.preventDefault());
  app.whenReady().then(start).catch(async error => {
    if (smoke) {
      console.error('Desktop smoke failed:', String(error.message).slice(0, 300));
      if (webWindow && !webWindow.isDestroyed()) {
        const text = await Promise.race([webWindow.webContents.executeJavaScript('document.body?.innerText.slice(0, 3000)').catch(() => ''), new Promise(r => setTimeout(() => r('renderer-unavailable'), 1000))]);
        console.error('Fixture page:', text);
        await writeFile(path.join(app.getPath('userData'), 'smoke-failure.png'), (await webWindow.webContents.capturePage()).toPNG());
      }
      host?.supervisor.stopAll(); await demo?.close(); app.exit(1); return;
    }
    dialog.showErrorBox('GatherThread Desktop', '桌面端启动失败。请重新打开应用；若仍失败，请重新构建或下载完整安装包。'); app.exit(1);
  });
}

async function start() {
  if (smoke) console.log('Desktop smoke: application ready');
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  if (requestedDemo) {
    const { startDemo } = await import('./demo.mjs');
    demo = await startDemo({ directory: path.join(app.getPath('userData'), 'fixture'),
      staticDirectory: path.join(resourcesPath, 'web'), node: resources.node,
      serverScript: path.join(resourcesPath, 'demo-server.mjs'), connector: path.join(resourcesPath, 'demo-connector.mjs') });
  }
  createHost(); createWorkspace();
  if (smoke) console.log('Desktop smoke: fixture and workspace created');
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 18, height: 18 }));
  tray.setToolTip('GatherThread · 共序'); tray.on('click', showWorkspace); rebuildMenu();
  app.on('activate', showWorkspace);
  powerMonitor.on('suspend', () => host.supervisor.stopAll());
  powerMonitor.on('shutdown', () => host.supervisor.stopAll());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); requestQuit();
  });
  ipcMain.handle('gt-desktop:action', async (event, raw) => {
    const owner = host, sender = managerWindow?.webContents;
    if (!sender || event.sender !== sender || event.senderFrame !== sender.mainFrame
      || event.senderFrame.url !== managerURL) return { ok: false, error: 'invalid_request' };
    try {
      const data = await owner.action(raw);
      if (host !== owner || managerWindow?.webContents !== sender) return { ok: false, error: 'cancelled' };
      return DesktopResultSchema.parse({ ok: true, data });
    } catch (error) {
      const parsed = DesktopErrorCodeSchema.safeParse(error.code);
      return { ok: false, error: parsed.success ? parsed.data : error.name === 'ZodError' ? 'invalid_request' : 'unknown_error' };
    }
  });
  if (smoke) {
    const { runSmoke } = await import('./smoke.mjs');
    await runSmoke({ getWeb: () => webWindow, showManager, getManager: () => managerWindow, host, demo, app, resourcesPath });
    quitting = true; await demo?.close(); app.exit(0);
  }
}
function createHost() {
  host?.cancelDiscovery();
  const origin = environment === 'demo' ? demo.origin : ORIGINS[environment];
  host = new DesktopHost({ environment, origin, resources, programStore, demo: environment === 'demo' ? demo : null, ui: {
    changed(status) {
      if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send('gt-desktop:status', status);
      rebuildMenu();
    },
    async pickFile(harness) { const r = await dialog.showOpenDialog(managerWindow, {
      title: harness === 'codex' ? '选择 Codex 应用、程序或安装文件夹' : '选择 Claude Code 程序或安装文件夹',
      message: '可以直接选择应用或安装文件夹，共序会查找里面的命令行程序。',
      defaultPath: '/Applications', properties: ['openFile', 'openDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
    async pickDirectory() { const r = await dialog.showOpenDialog(managerWindow, { title: '选择本机项目目录', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
    async openDirectory(file) { if (await shell.openPath(file)) throw Object.assign(new Error(), { code: 'not_available' }); },
    async openDsh() {
      // No profile patching, plugin installation, shell command or automatic login.
      const r = await dialog.showOpenDialog(managerWindow, { title: '选择已安装的 DSH 应用', defaultPath: '/Applications',
        properties: ['openFile'], filters: [{ name: 'macOS 应用', extensions: ['app'] }] });
      if (!r.canceled && r.filePaths[0]?.endsWith('.app') && await shell.openPath(r.filePaths[0]))
        throw Object.assign(new Error(), { code: 'not_available' });
    }, showWorkspace,
  } });
}
const configuredSessions = new WeakSet();
function configureSession(s, { native = false } = {}) {
  if (configuredSessions.has(s)) return;
  configuredSessions.add(s);
  const origin = host.origin, localDemo = environment === 'demo';
  let notificationsAllowed = false;
  const trusted = (wc, details) => isWorkspacePermission({ native,
    current: Boolean(wc && wc === webWindow?.webContents && !wc.isDestroyed() && isWorkspaceURL(wc.getURL(), origin)), ...details }, origin);
  s.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!trusted(wc, details)) { callback(false); return; }
    if (permission === 'clipboard-sanitized-write') { callback(true); return; }
    if (permission !== 'notifications' || localDemo) { callback(false); return; }
    if (notificationsAllowed) { callback(true); return; }
    dialog.showMessageBox(webWindow, { type: 'question', message: '允许共序显示系统通知？',
      detail: '通知可能包含项目消息。你也可以在系统设置中关闭。', buttons: ['暂不允许', '允许'], defaultId: 0, cancelId: 0 })
      .then(r => { notificationsAllowed = r.response === 1 && trusted(wc, details); callback(notificationsAllowed); }).catch(() => callback(false));
  });
  s.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => trusted(wc, details)
    && isWorkspaceURL(requestingOrigin, origin)
    && (permission === 'clipboard-sanitized-write' || permission === 'notifications' && notificationsAllowed));
  s.on('will-download', (event, item, wc) => {
    if (native || wc !== webWindow?.webContents || !isWorkspaceURL(wc?.getURL(), origin)
      || !isWorkspaceDownload(item.getURL(), origin)) event.preventDefault();
    else item.setSaveDialogOptions({ title: '保存 GatherThread 文件', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
  if (localDemo && !native) s.webRequest.onBeforeRequest((details, callback) => {
    // The fictional acceptance app has no reason to contact any remote service.
    let allowed = isWorkspaceURL(details.url, origin) || isWorkspaceDownload(details.url, origin)
      || /^(?:data:|devtools:)/u.test(details.url);
    try { const u = new URL(details.url); if (u.protocol === 'ws:' && u.host === new URL(origin).host) allowed = true; } catch {}
    callback({ cancel: !allowed });
  });
}
function createWorkspace() {
  const isolatedSession = session.fromPartition(environment === 'demo' ? `gt-desktop-demo-${Date.now()}` : `persist:gt-desktop-${environment}`);
  configureSession(isolatedSession);
  webWindow = new BrowserWindow({ title: environment === 'demo' ? 'GatherThread · 本机模拟验收' : 'GatherThread · 共序',
    width: 1440, height: 940, minWidth: 900, minHeight: 620, backgroundColor: '#f5f5f7', show: false,
    icon, webPreferences: { ...WEB_PREFERENCES, session: isolatedSession } });
  const win = webWindow;
  if (environment === 'demo') win.webContents.once('did-finish-load', async () => {
    // Seed only the isolated, fictional browser's existing language preference.
    try {
      await win.webContents.executeJavaScript("localStorage.setItem('gt-lang', 'zh')");
      if (!win.isDestroyed()) win.reload();
    } catch { if (!win.isDestroyed()) showRecovery('本机演示初始化失败', '请重新打开本机演示。'); }
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault(); win.hide();
    if (!closeExplained && !smoke) { closeExplained = true;
      dialog.showMessageBox({ message: '共序仍在菜单栏运行', detail: '本机 Agent 连接会继续保持。使用「GatherThread Desktop → 退出」可停止连接并退出。', buttons: ['知道了'] }); }
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  const navigate = (event, url) => {
    if (isWorkspaceURL(url, host.origin)) return;
    event.preventDefault(); handleNavigation(url);
  };
  win.webContents.on('will-navigate', navigate);
  win.webContents.on('will-redirect', navigate);
  win.webContents.setWindowOpenHandler(({ url }) => { handleNavigation(url); return { action: 'deny' }; });
  win.webContents.on('did-navigate', (_e, url) => { if (isWorkspaceURL(url, host.origin)) previousURL = url; });
  win.webContents.on('did-navigate-in-page', (_e, url, main) => { if (main && isWorkspaceURL(url, host.origin)) previousURL = url; });
  win.webContents.on('did-finish-load', () => { navigationFailed = false; unresponsive = false; });
  win.webContents.on('did-fail-load', (_e, code, _description, _url, main) => {
    if (main && code !== -3 && !win.isDestroyed()) { navigationFailed = true; showRecovery('页面暂时无法加载', '请检查网络，然后选择重新连接。已在运行的本机任务不会因此自动重试。'); }
  });
  win.webContents.on('render-process-gone', () => { navigationFailed = true; showRecovery('协作页面意外退出', '可以重新打开页面。系统会重新读取任务状态，请不要重复提交尚未确认的请求。'); });
  win.on('unresponsive', () => { unresponsive = true; showRecovery('协作页面暂时没有响应', '可以继续等待，或重新加载。重新加载可能丢失网页中尚未保存的输入。'); });
  win.on('responsive', () => { unresponsive = false; });
  const url = environment === 'demo' ? demo.url : `${host.origin}/app/`;
  previousURL = url;
  if (environment === 'demo') isolatedSession.cookies.set({ url: demo.origin, name: 'gatherthread_session', value: demo.cookie,
    httpOnly: true, sameSite: 'strict', path: '/' }).then(() => win.loadURL(url)).catch(() => showRecovery('本机测试页启动失败', '请重新打开本机演示。'));
  else win.loadURL(url).catch(() => {});
}
let recoveryShowing = false;
async function showRecovery(message, detail) {
  if (recoveryShowing || smoke || quitting) return;
  recoveryShowing = true;
  try {
    const r = await dialog.showMessageBox(webWindow, { type: 'warning', message, detail,
      buttons: ['继续等待', '重新加载', '本机 Agent 管理'], defaultId: 0, cancelId: 0 });
    if (r.response === 1) reloadWorkspace();
    if (r.response === 2) showManager();
  } finally { recoveryShowing = false; }
}
function reloadWorkspace() {
  if (!webWindow || webWindow.isDestroyed()) { createWorkspace(); return; }
  webWindow.loadURL(isWorkspaceURL(previousURL, host.origin) ? previousURL : `${host.origin}/app/`).catch(() => {});
}
function showWorkspace() {
  if (!app.isReady() || !host) return;
  if (!webWindow || webWindow.isDestroyed()) createWorkspace();
  webWindow.show(); webWindow.focus();
}
function showManager() {
  if (!host) return;
  if (managerWindow && !managerWindow.isDestroyed()) { managerWindow.show(); managerWindow.focus(); return; }
  const s = session.fromPartition('gt-desktop-native'); configureSession(s, { native: true });
  managerWindow = new BrowserWindow({ title: 'GatherThread · 本机 Agent', width: 760, height: 830,
    minWidth: 460, minHeight: 540, backgroundColor: '#f5f5f7', show: false, icon,
    webPreferences: { ...WEB_PREFERENCES, session: s, preload: path.join(here, 'preload.cjs') } });
  managerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  managerWindow.webContents.on('will-navigate', event => event.preventDefault());
  managerWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  managerWindow.once('ready-to-show', () => managerWindow?.show());
  managerWindow.on('closed', () => { managerWindow = null; });
  managerWindow.loadURL(managerURL).catch(() => {});
}
async function handleNavigation(url) {
  if (url.startsWith('gatherthread-connect:')) {
    try { host.acceptHandoff(url); showManager(); }
    catch { dialog.showMessageBox(webWindow, { type: 'warning', message: '无法使用这个连接链接',
      detail: '请在当前服务器的项目中重新选择「连接 Agent → 打开启动器」。链接不会自动启动或安装 Agent。', buttons: ['知道了'] }); }
    return;
  }
  if (isWorkspaceURL(url, host.origin)) { webWindow.loadURL(url).catch(() => {}); return; }
  const target = externalURL(url); if (!target || environment === 'demo') return;
  const r = await dialog.showMessageBox(webWindow, { type: 'question', message: '在系统浏览器中打开外部链接？',
    detail: new URL(target).origin, buttons: ['取消', '打开浏览器'], defaultId: 0, cancelId: 0 });
  if (r.response === 1) await shell.openExternal(target).catch(() => {});
}
async function switchEnvironment(next) {
  if (next === environment) return;
  if (host.supervisor.active().length) { showManager(); return; }
  const r = await dialog.showMessageBox(webWindow, { message: '切换服务器环境？',
    detail: '当前页面未保存的输入可能丢失。正式服、测试服和本机演示使用独立登录状态。', buttons: ['取消', '切换'], defaultId: 0, cancelId: 0 });
  if (r.response !== 1) return;
  managerWindow?.destroy(); webWindow?.destroy(); environment = next; createHost(); createWorkspace(); rebuildMenu();
}
function rebuildMenu() {
  if (!host || !app.isReady()) return;
  const count = host.supervisor.active().length;
  const management = { label: `本机 Agent${count ? ` · ${count}` : ''}`, accelerator: 'CmdOrCtrl+Shift+A', click: showManager };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about', label: '关于 GatherThread' }, { type: 'separator' },
      { role: 'hide', label: '隐藏共序' }, { role: 'hideOthers', label: '隐藏其他应用' }, { role: 'unhide', label: '显示全部' },
      { type: 'separator' }, { label: '退出 GatherThread', accelerator: 'CmdOrCtrl+Q', click: requestQuit }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '工作区', submenu: [{ label: '显示协作窗口', accelerator: 'CmdOrCtrl+1', click: showWorkspace }, management,
      { label: '重新加载页面', accelerator: 'CmdOrCtrl+R', click: () => showRecovery('重新加载页面？', '网页中未保存的输入可能丢失。本机连接继续保持，请勿重复提交未确认的任务。') },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '服务器', submenu: [
      ...[['production', '正式服'], ['test', '测试服'], ...(demo ? [['demo', '本机模拟验收']] : [])].map(([env, label]) => ({ label,
        type: 'radio', checked: environment === env, click: () => switchEnvironment(env) }))] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]));
  tray?.setContextMenu(Menu.buildFromTemplate([{ label: `GatherThread · ${count} 个本机连接`, enabled: false },
    { label: '打开协作窗口', click: showWorkspace }, management, { type: 'separator' }, { label: '停止连接并退出', click: requestQuit }]));
}
async function requestQuit() {
  if (quitRequested || quitting) return;
  quitRequested = true;
  try {
    if (host?.supervisor.active().length) {
      const r = await dialog.showMessageBox(webWindow, { type: 'warning', message: '停止本机连接并退出？',
        detail: '正在执行的本机或共享 Agent 任务可能中断。共序会等待连接器确认清理完成；云端任务不受此按钮直接控制。',
        buttons: ['取消', '停止并退出'], defaultId: 0, cancelId: 0 });
      if (r.response !== 1) return;
      host.supervisor.stopAll(); showManager();
      const deadline = Date.now() + 30_000;
      while (host.supervisor.active().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (host.supervisor.active().length) {
        await dialog.showMessageBox(managerWindow, { message: '仍在等待本机任务退出', detail: '应用会保持运行，避免误认为任务已经停止。请在本机 Agent 管理中查看状态。', buttons: ['知道了'] }); return;
      }
    }
    quitting = true; await demo?.close(); app.quit();
  } finally { quitRequested = false; }
}
