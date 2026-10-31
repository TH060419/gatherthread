import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function fixture() {
  const source = (await readFile(new URL('../../client/client.js', import.meta.url), 'utf8')).replace('module.exports = { inject, apply };', 'module.exports = { GatherThreadFiles };');
  const states = new Map<number, any>(); let cursor = 0, effect!: () => () => void, component: any, approve = false, closes = 0;
  const calls: any[] = [], cache: Record<string, any> = {}; let failSave = true;
  const React = { createElement(type: any, props: any, ...children: any[]) { if (typeof type === 'function' && type.name === 'WorkspaceDialog') return type({ ...props, children }); return { type, props: props || {}, children }; },
    useState(initial: any) { const id = cursor++; if (!states.has(id)) states.set(id, initial); return [states.get(id), (value: any) => states.set(id, typeof value === 'function' ? value(states.get(id)) : value)]; },
    useRef(initial: any) { const id = cursor++; if (!states.has(id)) states.set(id, { current: initial }); return states.get(id); },
    useEffect(callback: any) { effect = callback; } };
  const selection = { provider: 'gt-cloud', branch_id: 'branch-a' }, commit = 'a'.repeat(40);
  const seat = { connectionId: 'connection-a', projectId: 'project-a', sessionId: 'session-a', controller: new AbortController() };
  const connection = { rpc: { async call(_channel: string, _endpoint: string, input: any) {
    calls.push(input); const request = input.request; let result;
    if (request.operation === 'localTree') result = { kind: 'localTree', directory: '/project', entries: [{ path: 'local.txt', size: 5 }], truncated: false, busy: false };
    if (request.operation === 'localRead') result = { kind: 'text', path: 'local.txt', text: 'local' };
    if (request.operation === 'branches') result = { kind: 'branches', value: { provider: 'gt-cloud', default_branch_id: 'branch-a', branches: [{ id: 'branch-a', name: '我的分支', can_write: true }] } };
    if (request.operation === 'tree') result = { kind: 'tree', value: { ...selection, commit, head_commit: commit, can_write: true, entries: [{ path: 'a.txt', executable: true }] } };
    if (request.operation === 'content') result = { kind: 'text', path: 'a.txt', text: 'original' };
    if (request.operation === 'save') { if (failSave) return { ok: false, error: { code: 'workspace_file_conflict' } }; result = { kind: 'saved', value: { ...selection, commit: 'b'.repeat(40) } }; }
    return { ok: true, value: { connectionId: seat.connectionId, projectId: seat.projectId, sessionId: seat.sessionId, result } };
  } } };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(handoff: any) { component = handoff.factory(() => React).GatherThreadFiles; } }, confirm: () => approve, addEventListener() {}, removeEventListener() {} },
    navigator: { language: 'zh-CN', clipboard: { async writeText() {} } }, AbortController, setTimeout, clearTimeout, TextEncoder, btoa, crypto: globalThis.crypto });
  const render = () => { cursor = 0; return component({ connection, seat, canWrite: true, fileDrafts: cache, onClose: () => closes++, onReference() {} }); };
  const all = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.children)];
  const text = (node: any): string => typeof node === 'string' ? node : !node ? '' : Array.isArray(node) ? node.map(text).join('') : text(node.children);
  const button = (label: string) => all(render()).find(n => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label));
  const field = () => all(render()).find(n => n.type === 'textarea');
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  render(); const cleanup = effect(); await settle();
  return { render, button, field, settle, calls, cache, text, seat, cleanup, approve: () => { approve = true; }, closes: () => closes, saveWorks: () => { failSave = false; } };
}
test('file browser never writes local previews and requires confirmation before dropping a cloud edit', async () => {
  const f = await fixture();
  try {
    f.button('local.txt').props.onClick(); await f.settle(); assert.equal(f.field().props.readOnly, true);
    f.button('GT 云端').props.onClick(); await f.settle(); f.button('a.txt').props.onClick(); await f.settle();
    f.field().props.onChange({ target: { value: 'edited' } }); f.render();
    f.button('关闭').props.onClick(); assert.equal(f.closes(), 0);
    f.button('本机文件').props.onClick(); await f.settle(); assert.equal(f.field().props.value, 'edited');
    assert.equal(Object.keys(f.cache).length, 1);
    f.approve(); f.button('关闭').props.onClick(); assert.equal(f.closes(), 1); assert.equal(Object.keys(f.cache).length, 0);
  } finally { f.cleanup(); }
});
test('failed save retains text, commit, executable mode and the same retry identity', async () => {
  const f = await fixture();
  try {
    f.button('GT 云端').props.onClick(); await f.settle(); f.button('a.txt').props.onClick(); await f.settle();
    f.field().props.onChange({ target: { value: 'edited' } });
    f.button('保存到云端').props.onClick(); await f.settle();
    assert.match(f.text(f.render()), /云端版本已变化/); assert.equal(f.field().props.value, 'edited'); assert.equal(f.field().props.readOnly, true);
    f.saveWorks(); f.button('重试保存').props.onClick(); await f.settle();
    const saves = f.calls.filter(c => c.request.operation === 'save'); assert.equal(saves.length, 2); assert.deepEqual(saves[0], saves[1]);
    assert.equal(saves[0].request.input.operations[0].executable, true);
    assert.match(f.text(f.render()), /已保存到云端分支/); assert.equal(f.button('保存到云端').props.disabled, true);
    assert.equal(Object.keys(f.cache).length, 0);
  } finally { f.cleanup(); }
});
