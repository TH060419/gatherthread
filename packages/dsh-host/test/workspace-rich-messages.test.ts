import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function fixture(official = true) {
  const source = (await readFile(new URL('../../client/client.js', import.meta.url), 'utf8')).replace('module.exports = { inject, apply };', 'module.exports = { WorkspaceMessageBody, WorkspaceAvatar, workspaceRelativeFile };');
  const states = new Map<number, any>(); let cursor = 0, api: any, cleanup = () => {};
  const calls: any[] = [];
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children }),
    useState(initial: any) { const id = cursor++; if (!states.has(id)) states.set(id, initial); return [states.get(id), (v: any) => states.set(id, typeof v === 'function' ? v(states.get(id)) : v)]; },
    useRef(initial: any) { const id = cursor++; if (!states.has(id)) states.set(id, { current: initial }); return states.get(id); },
    useMemo: (fn: any) => fn(), useEffect: (fn: any) => { cleanup = fn(); } };
  vm.runInNewContext(source, { navigator: { language: 'zh-CN' }, AbortController, setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(value: any) { api = value.factory((name: string) => {
      if (name === 'react') return React;
      if (!official) throw new Error('old host');
      return { MarkdownText: 'native-markdown', MarkdownDelegateProvider: 'native-delegate' };
    }); } } } });
  const item = { id: 'message-a', sequence: 1, content: '**Hello**\n```js\nconst a=1;\n```', truncated: true, deleted: false };
  const seat = { connectionId: 'connection-a', projectId: 'project-a', sessionId: 'session-a', revision: 0, controller: new AbortController() };
  let resolve: any;
  const connection = { rpc: { call: (...args: any[]) => { calls.push(args[2]); return new Promise(r => { resolve = r; }); } } };
  const fileDrag = { prepare() {}, reportFailure() {} };
  const render = () => { cursor = 0; return api.WorkspaceMessageBody({ item, seat, connection, fileDrag }); };
  const nodes = (tree: any): any[] => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : [];
  const byType = (type: string) => nodes(render()).find(n => n.type === type);
  const button = (label: string) => nodes(render()).find(n => n.type === 'button' && n.children.includes(label));
  return { api, render, nodes, byType, button, seat, item, calls, fileDrag, cleanup: () => cleanup(), complete: (value: any) => resolve({ ok: true, value: { ...seat, controller: undefined, ...value } }) };
}

test('rich messages use official Markdown and image delegates without local media URLs', async () => {
  const f = await fixture();
  assert.equal(f.byType('native-markdown').props.text, f.item.content);
  assert.equal(f.byType('native-markdown').props.labels.code.copyLabel, '复制代码');
  const delegate = f.byType('native-delegate').props;
  assert.equal(delegate.fileImages.fileDrag, f.fileDrag);
  assert.equal(delegate.fileImages.resolve('/etc/passwd'), undefined);
  assert.equal(delegate.fileImages.resolve('file:///private/file.png'), undefined);
  assert.equal(delegate.fileImages.labels.dialog, '图片预览');
  delegate.openFile('../private.txt');
  assert.match(JSON.stringify(f.render()), /有效的项目相对路径/);
  assert.equal(f.calls.length, 0);
  f.button('查看原文').props.onClick();
  assert.equal(f.byType('native-markdown'), undefined);
});

test('local file references reject traversal and protocols before any file action', async () => {
  const f = await fixture();
  for (const path of ['../secret', '/tmp/secret', 'file:///etc/passwd', 'https://example.org/a', 'C:\\secret', 'a/%2e%2e/b', 'a//b']) assert.equal(f.api.workspaceRelativeFile(path), null);
  assert.equal(f.api.workspaceRelativeFile('./docs/测试.md'), 'docs/测试.md');
});

test('long-message expansion rejects a reply from another revision and supports retry', async () => {
  const f = await fixture();
  const action = f.button('展开长消息').props.onClick();
  assert.equal(f.button('正在展开…').props.disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { action: 'message', connectionId: 'connection-a', projectId: 'project-a', sessionId: 'session-a', eventId: 'message-a', sequence: 1, contentRevision: 0 });
  f.complete({ contentRevision: 1, message: { ...f.item, content: 'STALE' } }); await action;
  assert.doesNotMatch(JSON.stringify(f.render()), /STALE/);
  assert.match(JSON.stringify(f.render()), /冲突/);
  const retry = f.button('展开长消息').props.onClick();
  f.complete({ contentRevision: 0, message: { ...f.item, content: 'FULL', truncated: false } }); await retry;
  assert.equal(f.byType('native-markdown').props.text, 'FULL');
});

test('disconnect or unmount suppresses late full-message results', async () => {
  const f = await fixture();
  const action = f.button('展开长消息').props.onClick();
  f.seat.controller.abort();
  f.complete({ contentRevision: 0, message: { ...f.item, content: 'STALE' } }); await action;
  assert.doesNotMatch(JSON.stringify(f.render()), /STALE/);
  f.cleanup();
});

test('older DSH retains source text and avatars only use the bundled catalog', async () => {
  const f = await fixture(false);
  assert.match(JSON.stringify(f.render()), /Hello/);
  assert.equal(f.byType('native-markdown'), undefined);
  const invalid = f.api.WorkspaceAvatar({ name: 'A', avatarId: 'https://tracking.example/image' });
  assert.equal(f.nodes(invalid).some(n => n.type === 'img'), false);
  const valid = f.api.WorkspaceAvatar({ name: 'A', avatarId: 'cat', agent: true });
  assert.equal(f.nodes(valid).filter(n => n.type === 'img').length, 2);
});
