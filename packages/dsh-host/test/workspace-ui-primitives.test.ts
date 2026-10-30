import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function atoms(available: boolean) {
  const source = (await readFile(new URL('../../client/client.js', import.meta.url), 'utf8'))
    .replace('module.exports = { inject, apply };', 'module.exports = { workspaceElement, WorkspaceDialog, workspaceIcon };');
  let result: any;
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }) };
  vm.runInNewContext(source, { navigator: { language: 'zh-CN' }, window: { __ModuleLoader__: { load(value: any) {
    result = value.factory((name: string) => {
      if (name === 'react') return React;
      assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives');
      if (!available) throw new Error('old host');
      return { Button: 'official-button', Modal: 'official-modal', IconCopyOutlineRegular: 'official-copy' };
    });
  } } } });
  return result;
}

test('host buttons retain disabled actions and native form props; icons use the public DSH resource', async () => {
  const api = await atoms(true), onClick = () => {};
  const button = api.workspaceElement('button', { className: 'gtw-primary', disabled: true, onClick, 'aria-label': '发送' }, '发送');
  assert.equal(button.type, 'official-button');
  assert.equal(button.props.variant, 'primary');
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.onClick, onClick);
  assert.equal(button.props['aria-label'], '发送');
  assert.equal(api.workspaceIcon('IconCopyOutlineRegular').type, 'official-copy');
});

test('all official modal dismiss paths preserve the application busy and dirty guards', async () => {
  const api = await atoms(true); let closes = 0;
  const guarded = () => { closes++; };
  const busy = api.WorkspaceDialog({ title: '项目文件', onClose: guarded, busy: true, children: 'content' });
  assert.equal(busy.type, 'official-modal');
  assert.equal(busy.props.closeLabel, '关闭');
  busy.props.onClose(); assert.equal(closes, 0);
  const ready = api.WorkspaceDialog({ title: '项目文件', onClose: guarded, busy: false });
  ready.props.onClose(); assert.equal(closes, 1);
});

test('older hosts retain accessible HTML dialogs and buttons without installing a second UI bundle', async () => {
  const api = await atoms(false); let closes = 0, cancelled = 0;
  assert.equal(api.workspaceElement('button', { disabled: true }, '保存').type, 'button');
  const dialog = api.WorkspaceDialog({ title: '管理我的 Agent', onClose: () => closes++, busy: false });
  assert.equal(dialog.type, 'dialog');
  assert.equal(dialog.props['aria-label'], '管理我的 Agent');
  dialog.props.onCancel({ preventDefault: () => cancelled++ });
  assert.equal(closes, 1); assert.equal(cancelled, 1);
});
