import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCollaborationServer } from '../../../server/src/server.ts';
import { ProjectCodeSync } from '../../../../packages/bridge/src/code-sync.ts';

if (!process.send) throw new Error('Fixture requires private parent IPC');
const [directory, staticDirectory] = process.argv.slice(2);
if (!path.isAbsolute(directory) || !path.isAbsolute(staticDirectory)) throw new Error('Fixture paths required');
const allowedOrigins = [];
const server = await startCollaborationServer({ databasePath: ':memory:', authTokenPepper: randomUUID() + randomUUID(),
  allowedOrigins, staticDirectory, codeRepositoryDirectory: path.join(directory, `cloud-${randomUUID()}`) }, 0);
allowedOrigins.push(server.origin);
const identity = (id, name) => {
  const result = server.database.createIdentity({ user_id: id, display_name: name, device_id: `${id}-mac`,
    device_name: 'Desktop fictional device', can_create_projects: true });
  server.database.sqlite.prepare('INSERT INTO public_registration_accounts (user_id,email_digest,password_hash,verified_at) VALUES(?,?,?,?)')
    .run(id, randomUUID(), 'fixture-not-a-real-password', Date.now());
  return result;
};
const a = identity('desktop-user-a', '测试用户 A'), b = identity('desktop-user-b', '测试用户 B');
server.database.setAccountAvatar(a.actor, 'cat'); server.database.setAccountAvatar(b.actor, 'fox');
const project = server.service.createProject(a.actor, { project_id: 'desktop-demo-project', title: 'GT 桌面端 · 本机验收', idempotency_key: 'desktop-project' });
server.service.claimInvitationForActor(b.actor, server.service.createProjectInvitation(a.actor, project.id, { role: 'participant', ttl: '1h' }).invite_token);
const { session } = server.service.createSession(a.actor, { project_id: project.id, session_id: 'desktop-demo-multi',
  title: '多人讨论与开发', mode: 'multi', idempotency_key: 'desktop-multi' });
server.service.createSession(a.actor, { project_id: project.id, session_id: 'desktop-demo-solo', title: '我的独立会话', mode: 'solo', idempotency_key: 'desktop-solo' });
server.service.appendEvent(b.actor, session.id, { type: 'human_chat', idempotency_key: 'desktop-context', visibility: 'session', payload: {
  content: '我们在同一个空间讨论并推进开发。\n\n请记住团队约定：**沿用最新版 GT 网页界面，按钮保持绿色。**' } });
server.service.appendEvent(a.actor, session.id, { type: 'human_chat', idempotency_key: 'desktop-help', visibility: 'session', payload: {
  content: '## 欢迎体验 GT 桌面端\n\n这是最新主线的真实网页和服务器，账号、项目与模型全部为本机虚构数据。\n\n1. 在 Mac 菜单中打开 **工作区 → 本机 Agent**。\n2. 点击「准备模拟连接」，再点「授权并连接」。\n3. 回到这里选择 `desktop-fixture` 模型，提交 Agent 请求。\n\n你可以编辑 Team、查看文件与 Git 变更。输入「长任务」可测试停止连接。模拟内容不会访问真实模型或同步到官网。' } });
const workspace = path.join(directory, '项目文件'); await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# GT 桌面端虚构项目\n\n团队约定：沿用网页界面，按钮保持绿色。\n');
await writeFile(path.join(workspace, 'example.js'), 'export const collaboration = "同一空间，讨论与开发";\n');
const enabled = await fetch(`${server.origin}/v1/projects/${project.id}/code/enable`, { method: 'POST', headers: {
  authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ idempotency_key: 'desktop-code' }) });
if (!enabled.ok) throw new Error('Fixture code unavailable');
await new ProjectCodeSync({ apiUrl: server.origin, token: a.token, projectId: project.id, actorId: a.actor.user_id,
  workspacePath: workspace, stateRoot: path.join(directory, `code-sync-${randomUUID()}`) }).upload();
const browser = server.database.createBrowserSession(a.actor);
process.send({ kind: 'ready', origin: server.origin, project: project.id, session: session.id, workspace,
  cookie: browser.token, token: a.token, url: `${server.origin}/app/#project=${project.id}&session=${session.id}` });
let closing = false;
async function close() { if (closing) return; closing = true; await server.close(); process.exit(0); }
process.on('message', message => { if (message?.action === 'stop') close(); });
process.on('disconnect', close); process.on('SIGTERM', close); process.on('SIGINT', close);
