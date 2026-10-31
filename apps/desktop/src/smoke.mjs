import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeTheme } from 'electron';
async function until(check, timeout = 15_000) { const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); } throw new Error('Smoke timeout'); }
async function capture(win, target) {
  win.show(); win.focus(); await delay(300);
  await writeFile(target, (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
}
export async function runSmoke({ getWeb, showManager, getManager, host, demo, app }) {
  const web = getWeb(); await until(() => !web.webContents.isLoading());
  console.log('Desktop smoke: checking Web session');
  const preferences = web.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
  assert.equal(Boolean(preferences.preload), false);
  const browser = await web.webContents.executeJavaScript('({ title: document.title, native: typeof window.gatherthreadDesktop, node: typeof window.require, body: document.body.innerText })');
  assert.equal(browser.native, 'undefined'); assert.equal(browser.node, 'undefined');
  await until(async () => (await web.webContents.executeJavaScript('document.body.innerText')).includes('多人讨论与开发'));
  await until(async () => await web.webContents.executeJavaScript('document.documentElement.lang === "zh-CN"'));
  await web.webContents.executeJavaScript("document.getElementById('code-notice-continue').click()");
  await until(async () => await web.webContents.executeJavaScript("Boolean(document.querySelector('.onboarding-example-dialog[open]'))"));
  await web.webContents.executeJavaScript("document.querySelector('.onboarding-example-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))");
  console.log('Desktop smoke: Web session ready');
  showManager(); await until(() => !getManager().webContents.isLoading());
  const manager = getManager();
  await until(async () => (await manager.webContents.executeJavaScript('document.body.innerText')).includes('本机模拟'));
  const invalid = await manager.webContents.executeJavaScript("window.gatherthreadDesktop.action({ action: 'status', command: '/bin/sh' })");
  assert.equal(invalid.ok, false); assert.equal(invalid.error, 'invalid_request');
  await manager.webContents.executeJavaScript("document.getElementById('prepare-demo').click()");
  await until(() => Boolean(host.status().handoff));
  // Render detection states with fictional data; these messages grant no native
  // permission and never start discovery or a real Agent.
  const detectionDirectory = path.join(app.getPath('userData'), 'validation'); await mkdir(detectionDirectory, { recursive: true });
  const original = host.status();
  const detectionState = (state, executables = original.executables, error = null) => ({ ...original,
    demo: false, environment: 'test', executables, detection: [{ harness: 'codex', state, error, remembered: state === 'ready' }] });
  await until(async () => await manager.webContents.executeJavaScript("Boolean(document.getElementById('executable').value)"));
  manager.webContents.send('gt-desktop:status', detectionState('searching'));
  await until(async () => await manager.webContents.executeJavaScript("document.getElementById('program-status').textContent.includes('正在查找')"));
  assert.equal(await manager.webContents.executeJavaScript("document.getElementById('connect').disabled && document.getElementById('choose-cli').disabled"), true);
  manager.webContents.send('gt-desktop:status', detectionState('missing', []));
  await until(async () => await manager.webContents.executeJavaScript("document.getElementById('program-status').textContent.includes('还没有找到')"));
  assert.equal(await manager.webContents.executeJavaScript("document.getElementById('connect').disabled && !document.getElementById('find-cli').disabled"), true);
  manager.setSize(460, 780);
  assert.equal(await manager.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
  await capture(manager, path.join(detectionDirectory, 'program-missing.png'));
  manager.webContents.send('gt-desktop:status', detectionState('ready'));
  await until(async () => await manager.webContents.executeJavaScript("document.getElementById('program-hint').textContent.includes('已记住')"));
  await manager.webContents.executeJavaScript("document.getElementById('language').click()");
  assert.equal(await manager.webContents.executeJavaScript("document.getElementById('program-status').textContent.startsWith('Found')"), true);
  await manager.webContents.executeJavaScript("document.getElementById('language').click()");
  await capture(manager, path.join(detectionDirectory, 'program-found.png'));
  manager.webContents.send('gt-desktop:status', original); manager.setSize(760, 830);
  await until(async () => await manager.webContents.executeJavaScript("document.getElementById('program-hint').textContent.includes('模拟程序')"));
  console.log('Desktop smoke: starting mock connector');
  await until(async () => await manager.webContents.executeJavaScript("!document.getElementById('connect').disabled"));
  await manager.webContents.executeJavaScript("document.getElementById('connect-form').requestSubmit()");
  await until(() => host.status().connections[0]?.state === 'connected');
  console.log('Desktop smoke: mock connector ready');
  const id = host.status().connections[0].id;
  const runtimeResponse = await fetch(`${demo.origin}/v1/sessions/${demo.session}/runtimes`, { headers: { authorization: `Bearer ${demo.token}` } });
  const runtime = (await runtimeResponse.json()).data.runtimes[0]; assert.ok(runtime?.id);
  const request = await fetch(`${demo.origin}/v1/sessions/${demo.session}/events`, { method: 'POST', headers: {
    authorization: `Bearer ${demo.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'agent_request', visibility: 'session', idempotency_key: `desktop-smoke-${Date.now()}`,
      payload: { content: '总结共享上下文。', execution_profile: { runtime_id: runtime.id, harness: 'codex', provider: 'openai', model: 'desktop-fixture', reasoning_effort: 'low' } } }) });
  assert.equal(request.status, 201);
  console.log('Desktop smoke: exact runtime request accepted');
  await until(async () => {
    const response = await fetch(`${demo.origin}/v1/sessions/${demo.session}/events?after_sequence=0&limit=100`, { headers: { authorization: `Bearer ${demo.token}` } });
    const body = await response.json(); return JSON.stringify(body).includes('我已读取测试用户 B');
  });
  const browserApi = async (route, method = 'GET', body) => {
    const r = await web.webContents.executeJavaScript(`fetch(${JSON.stringify(route)}, { method: ${JSON.stringify(method)},
      credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-gatherthread-browser-session': '1' },
      ${body === undefined ? '' : `body: JSON.stringify(${JSON.stringify(body)}),`} signal: AbortSignal.timeout(10000)
    }).then(async r => ({ status: r.status, body: await r.json() }))`);
    assert.ok(r.status >= 200 && r.status < 300, `${route}: ${r.status} ${r.body.error?.code}`); return r.body.data;
  };
  const teamId = 'desktop-smoke-team', base = `/v1/sessions/${demo.session}`;
  const saved = await browserApi(`/v1/agent-teams/${teamId}`, 'PUT', { expected_revision: null,
    idempotency_key: 'desktop-save-team', max_calls: 12, max_duration_minutes: 30,
    draft: { name: '桌面端协作验收', team_prompt: '沿用团队的公开上下文', entry_node_id: 'lead',
      nodes: [{ id: 'lead', label: '协调模块', role: '阅读共享上下文并汇报', x: 100, y: 100,
        target: { kind: 'local', runtime_id: runtime.id, harness: 'codex', provider: 'openai', model: 'desktop-fixture', reasoning_effort: 'low' } }], edges: [] } });
  const testRun = await browserApi(`${base}/agent-teams/${teamId}/test`, 'POST', { expected_revision: saved.team.revision,
    content_revision: 0, idempotency_key: 'desktop-test-team' });
  const awaitRun = async runId => { let result; await until(async () => {
    result = (await browserApi(`${base}/agent-team-runs/${runId}`)).run;
    if (['failed', 'stopped', 'timed_out'].includes(result.status)) throw new Error(`Team ${result.status}: ${result.error_code}`);
    return result.status === 'completed';
  }); return result; };
  await awaitRun(testRun.run.id);
  const enabled = await browserApi(`${base}/agent-teams/${teamId}/control`, 'POST', { enabled: true, expected_revision: saved.team.revision, idempotency_key: 'desktop-enable-team' });
  const run = await browserApi(`${base}/agent-teams/${teamId}/start`, 'POST', { content: '总结团队约定', expected_revision: enabled.team.revision,
    content_revision: 0, idempotency_key: 'desktop-start-team' });
  assert.equal((await awaitRun(run.run.id)).calls_used, 1);
  console.log('Desktop smoke: Team save, connectivity test, enable and task passed');
  web.close(); assert.equal(web.isVisible(), false); assert.equal(host.status().connections[0].state, 'connected');
  web.show();
  // Remote UI has no native bridge even after a reload; the exact same server
  // replay returns the completed request without a second model invocation.
  web.webContents.reload(); await until(() => !web.webContents.isLoading());
  assert.equal(await web.webContents.executeJavaScript('typeof window.gatherthreadDesktop'), 'undefined');
  await until(async () => (await web.webContents.executeJavaScript('document.body.innerText')).includes('多人讨论与开发'));
  await manager.webContents.executeJavaScript("document.querySelector('#connections .desktop-stop').click()");
  await until(() => host.status().connections.find(r => r.id === id)?.state === 'stopped');
  const directory = path.join(app.getPath('userData'), 'validation'); await mkdir(directory, { recursive: true });
  await until(async () => await web.webContents.executeJavaScript("document.body.innerText.includes('模块连接成功')"));
  await capture(web, path.join(directory, 'workspace.png'));
  await web.webContents.executeJavaScript("document.getElementById('manage-agents-button').click(); document.getElementById('agent-teams-button').click()");
  await until(async () => await web.webContents.executeJavaScript("document.getElementById('agent-team-dialog').open"));
  await capture(web, path.join(directory, 'teams.png'));
  await capture(manager, path.join(directory, 'management.png'));
  manager.setSize(460, 620);
  nativeTheme.themeSource = 'dark'; await delay(200);
  assert.equal(await manager.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
  await capture(manager, path.join(directory, 'management-dark-compact.png'));
  await writeFile(path.join(directory, 'smoke.json'), JSON.stringify({ result: 'passed',
    checks: ['isolated renderer', 'strict native IPC', 'Chinese latest Web', 'real Web login/replay', 'mock native subprocess',
      'shared context', 'Team save/test/enable/task', 'reload', 'confirmed stop', 'program discovery states and bilingual narrow layout'],
    real_model: false }, null, 2));
  console.log(`Desktop smoke passed. Evidence: ${directory}`);
}
