import { exampleProjectFiles, examplePreviewDocument, EXAMPLE_REVIEWED_COMMIT } from './example-project.js';

// Mounted only inside the isolated example. It executes only the authored demo,
// never arbitrary uploaded HTML, and reuses the mock repository's real revision.
export function mountExampleProject({ document: doc, api }) {
  const dialog = doc.createElement('dialog');
  dialog.id = 'example-project-dialog'; dialog.className = 'example-project-dialog';
  dialog.setAttribute('data-i18n-skip', '');
  dialog.innerHTML = `<header><div><p class="eyebrow" id="example-project-note"></p><h2 id="example-project-title"></h2></div>
    <button type="button" id="example-project-close" class="button button-secondary">×</button></header>
    <div class="example-project-controls"><div class="example-project-tabs" role="group">
      <button type="button" id="example-preview-tab" class="button button-secondary" aria-pressed="true"></button>
      <button type="button" id="example-files-tab" class="button button-secondary" aria-pressed="false"></button></div>
      <label><span id="example-version-label"></span><select id="example-project-version"></select></label></div>
    <p id="example-project-status" class="field-help" role="status"></p>
    <iframe id="example-project-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    <div id="example-project-files" hidden><nav id="example-file-list"></nav><div class="example-source">
      <p id="example-file-purpose" class="field-help"></p><pre id="example-source-code" tabindex="0"></pre></div></div>`;
  doc.body.append(dialog);
  const el = id => doc.getElementById(id);
  const locale = () => doc.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en';
  const text = (en, zh) => locale() === 'zh-CN' ? zh : en;
  let files = [], selectedPath = 'src/signup.js', version = 'main', tab = 'preview';
  let generation = 0, returnFocus;

  function showFile(path) {
    selectedPath = path;
    const file = files.find(item => item.path === path) ?? files[0];
    if (!file) return;
    el('example-file-purpose').textContent = `${file.path} · ${file.description}`;
    el('example-source-code').textContent = file.content;
    for (const button of el('example-file-list').children) button.setAttribute('aria-current', String(button.dataset.path === file.path));
  }
  function showTab(next) {
    tab = next;
    el('example-project-frame').hidden = tab !== 'preview';
    el('example-project-files').hidden = tab !== 'files';
    el('example-preview-tab').setAttribute('aria-pressed', String(tab === 'preview'));
    el('example-files-tab').setAttribute('aria-pressed', String(tab === 'files'));
  }
  function translate() {
    dialog.setAttribute('aria-label', text('Example project result', '示例项目成果'));
    el('example-project-note').textContent = text('Authored example · no model calls', '预置示例 · 不调用模型');
    el('example-project-title').textContent = text('From discussion to a working page', '从共同讨论，到可用页面');
    el('example-project-close').setAttribute('aria-label', text('Close example result', '关闭示例成果'));
    el('example-preview-tab').textContent = text('Try the page', '试用页面');
    el('example-files-tab').textContent = text('Project files', '项目文件');
    el('example-version-label').textContent = text('Version', '版本');
    el('example-project-frame').title = text('Working signup page · example', '可操作的报名页 · 示例');
    el('example-file-list').setAttribute('aria-label', text('Project files', '项目文件'));
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
    el('example-project-status').textContent = text('Reading example files…', '正在读取示例文件…');
    try {
      const { snapshot } = await api.getProjectCodeSnapshot('project-orbit', version);
      if (current !== generation || !dialog.open) return;
      const improved = snapshot.commit === EXAMPLE_REVIEWED_COMMIT;
      files = exampleProjectFiles(locale(), improved);
      el('example-file-list').replaceChildren(...files.map(file => {
        const button = doc.createElement('button'); button.type = 'button'; button.dataset.path = file.path;
        button.textContent = file.path; button.addEventListener('click', () => showFile(file.path)); return button;
      }));
      showFile(selectedPath);
      el('example-project-frame').srcdoc = examplePreviewDocument(locale(), improved);
      el('example-project-status').textContent = text(
        'Try the button, or inspect the files. Changes stay in this example; no signup data is saved.',
        '点一下报名按钮，或查看文件。操作仅在此示例中进行，不保存实际报名数据。');
    } catch {
      if (current === generation) el('example-project-status').textContent = text('Example files could not be loaded. Close and try again.', '示例文件暂时无法读取，请关闭后重试。');
    }
  }
  el('example-preview-tab').addEventListener('click', () => showTab('preview'));
  el('example-files-tab').addEventListener('click', () => showTab('files'));
  el('example-project-version').addEventListener('change', event => { version = event.target.value; void load(); });
  el('example-project-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    generation++;
    // Discard the executed document and release its memory when leaving.
    el('example-project-frame').removeAttribute('srcdoc');
    returnFocus?.isConnected && returnFocus.focus({ preventScroll: true });
  });
  return {
    open() {
      if (dialog.open) return;
      returnFocus = doc.activeElement;
      translate(); showTab(tab); dialog.showModal(); void load();
    },
    close() { if (dialog.open) dialog.close(); },
    refreshLanguage() { if (dialog.open) { translate(); void load(); } },
  };
}
