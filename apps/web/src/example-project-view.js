import { examplePreviewDocument, EXAMPLE_REVIEWED_COMMIT } from './example-project.js';

// Mounted only inside the isolated example. It executes only the authored demo,
// never arbitrary uploaded HTML, and reuses the mock repository's real revision.
export function mountExampleProject({ document: doc, api, openFiles = () => {} }) {
  const dialog = doc.createElement('dialog');
  dialog.id = 'example-project-dialog'; dialog.className = 'example-project-dialog';
  dialog.setAttribute('data-i18n-skip', '');
  dialog.innerHTML = `<header><div><p class="eyebrow" id="example-project-note"></p><h2 id="example-project-title"></h2></div>
    <button type="button" id="example-project-close" class="button button-secondary">×</button></header>
    <div class="example-project-controls"><div class="example-project-tabs" role="group">
      <button type="button" id="example-preview-tab" class="button button-secondary" aria-pressed="true"></button>
      <button type="button" id="example-files-tab" class="button button-secondary"></button></div>
      <label><span id="example-version-label"></span><select id="example-project-version"></select></label></div>
    <p id="example-project-status" class="field-help" role="status"></p>
    <iframe id="example-project-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`;
  doc.body.append(dialog);
  const el = id => doc.getElementById(id);
  const locale = () => doc.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en';
  const text = (en, zh) => locale() === 'zh-CN' ? zh : en;
  let version = 'main';
  let generation = 0, returnFocus;
  let frameLoad, framePaint;
  function blockPreview() {
    const frame = el('example-project-frame');
    if (frameLoad) frame.removeEventListener('load', frameLoad);
    frameLoad = null;
    if (framePaint) doc.defaultView.cancelAnimationFrame(framePaint);
    framePaint = null;
    frame.inert = true; frame.style.pointerEvents = 'none'; frame.setAttribute('aria-busy', 'true');
  }
  function translate() {
    dialog.setAttribute('aria-label', text('Example project result', '示例项目成果'));
    el('example-project-note').textContent = text('Authored example · no model calls', '预置示例 · 不调用模型');
    el('example-project-title').textContent = text('From discussion to a working page', '从共同讨论，到可用页面');
    el('example-project-close').setAttribute('aria-label', text('Close example result', '关闭示例成果'));
    el('example-preview-tab').textContent = text('Try the page', '试用页面');
    el('example-files-tab').textContent = text('Open project files', '打开项目文件');
    el('example-version-label').textContent = text('Version', '版本');
    el('example-project-frame').title = text('Working signup page · example', '可操作的报名页 · 示例');
    el('example-project-version').replaceChildren(...[
      ['main', text('Shared version', '共享版本')],
      ['branch-maya', text('Maya’s version', '林悦的版本')],
    ].map(([value, label]) => {
      const option = doc.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
    el('example-project-version').value = version;
  }
  async function load() {
    const current = ++generation;
    blockPreview();
    el('example-project-status').textContent = text('Reading example files…', '正在读取示例文件…');
    try {
      const { snapshot } = await api.getProjectCodeSnapshot('project-orbit', version);
      if (current !== generation || !dialog.open) return;
      const improved = snapshot.commit === EXAMPLE_REVIEWED_COMMIT;
      const frame = el('example-project-frame');
      frame.srcdoc = examplePreviewDocument(locale(), improved);
      frameLoad = () => {
        if (current !== generation || !dialog.open) return;
        frameLoad = null;
        // Apply inert propagation and the status paragraph's layout before the
        // ready marker. Neither may move the iframe at the first allowed click.
        frame.inert = false;
        el('example-project-status').textContent = text(
          'Try the signup button. Open project files to inspect code in the file workspace. This authored demo saves no signup data; edits do not change this preview.',
          '试用报名按钮，也可打开项目文件，在文件工作区查看代码。此预置演示不保存报名数据；编辑文件不会改变此预览。');
        // A srcdoc load can precede Chromium's new-frame hit-test surface.
        // Keep clicks blocked across a render opportunity, not a timed delay.
        framePaint = doc.defaultView.requestAnimationFrame(() => {
          if (current !== generation || !dialog.open) return;
          framePaint = doc.defaultView.requestAnimationFrame(() => {
            framePaint = null;
            if (current !== generation || !dialog.open) return;
            frame.style.pointerEvents = ''; frame.setAttribute('aria-busy', 'false');
          });
        });
      };
      frame.addEventListener('load', frameLoad, { once: true });
    } catch {
      if (current === generation) el('example-project-status').textContent = text('Example files could not be loaded. Close and try again.', '示例文件暂时无法读取，请关闭后重试。');
    }
  }
  el('example-files-tab').addEventListener('click', () => { dialog.close(); void openFiles({ branchId: version }); });
  el('example-project-version').addEventListener('change', event => { version = event.target.value; void load(); });
  el('example-project-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    generation++;
    blockPreview();
    // Discard the executed document and release its memory when leaving.
    el('example-project-frame').removeAttribute('srcdoc');
    returnFocus?.isConnected && returnFocus.focus({ preventScroll: true });
  });
  return {
    open() {
      if (dialog.open) return;
      returnFocus = doc.activeElement;
      translate(); dialog.showModal(); void load();
    },
    close() { if (dialog.open) dialog.close(); },
    refreshLanguage() { if (dialog.open) { translate(); void load(); } },
  };
}
