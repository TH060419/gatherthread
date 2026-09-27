import { GUIDE_LABELS, createOnboardingProgress, guideText, onboardingKey } from './onboarding-content.js';

// A sandboxed, opaque-origin document runs its own in-memory application.
// Only presentation and an authored topic cross this boundary, never user data.
export function mountExampleGateway({ document: doc, getContext, openSettings, storage }) {
  const win = doc.defaultView;
  const progress = createOnboardingProgress(storage);
  let dialog, frame, channel, focus, activeKey, activeTopic, pendingKey, autoFrame, presentation;
  function cancel() {
    pendingKey = null;
    win.cancelAnimationFrame(autoFrame);
    if (!dialog) return;
    const previous = focus;
    dialog.close(); dialog.remove(); dialog = frame = null;
    if (previous?.isConnected && !previous.closest('dialog:not([open]), [hidden]')) previous.focus({ preventScroll: true });
    else doc.getElementById('settings-button').focus({ preventScroll: true });
  }
  function start(topic = 'basics') {
    if (doc.getElementById('workspace').hidden || !getContext().userId || doc.querySelector('dialog[open]')) return;
    cancel();
    activeTopic = Object.hasOwn(GUIDE_LABELS, topic) ? topic : 'browse';
    activeKey = onboardingKey(getContext());
    focus = doc.activeElement;
    channel = win.crypto.randomUUID();
    dialog = doc.createElement('dialog');
    dialog.className = 'onboarding-example-dialog';
    dialog.setAttribute('aria-label', getContext().locale === 'zh-CN' ? '独立示例项目' : 'Isolated example project');
    frame = doc.createElement('iframe');
    frame.title = dialog.getAttribute('aria-label');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    presentation = JSON.stringify([getContext().locale, doc.documentElement.dataset.theme]);
    frame.name = JSON.stringify({ topic: activeTopic, channel, locale: getContext().locale,
      theme: doc.documentElement.dataset.theme ?? 'system' });
    // This public, self-contained example alone permits same-site embedding.
    // It has no API access, credentials or external script/style requests.
    frame.src = new URL('./example.html', win.location.href).href;
    dialog.append(frame); doc.body.append(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (activeTopic === 'basics') progress.mark(activeKey, 'skipped'); cancel(); });
    dialog.showModal(); frame.focus({ preventScroll: true });
  }
  win.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow || event.data?.channel !== channel) return;
    if (event.data.type === 'example-topic' && (event.data.topic === 'browse' || Object.hasOwn(GUIDE_LABELS, event.data.topic))) { const topic = event.data.topic; cancel(); start(topic); return; }
    if (event.data.type === 'example-exit') {
      if (activeTopic === 'basics') progress.mark(activeKey, event.data.status === 'completed' ? 'completed' : 'skipped');
      cancel();
      if (event.data.settings === true) openSettings();
    }
  });
  function autoStart() {
    win.cancelAnimationFrame(autoFrame);
    if (!pendingKey || pendingKey !== onboardingKey(getContext()) || progress.has(pendingKey)
      || doc.getElementById('workspace').hidden || doc.querySelector('dialog[open]')) return;
    autoFrame = win.requestAnimationFrame(() => start('basics'));
  }
  new win.MutationObserver(autoStart).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  return { start, cancel, offer() { pendingKey = onboardingKey(getContext()); autoStart(); },
    refreshLanguage() {
      if (frame && presentation !== JSON.stringify([getContext().locale, doc.documentElement.dataset.theme])) {
        const topic = activeTopic; cancel(); start(topic);
      }
    } };
}

export function exampleToolbar(doc, { cancel, onExit }) {
  const channel = doc.defaultView.__examplePresentation?.channel;
  const zh = doc.documentElement.lang === 'zh-CN';
  const bar = doc.createElement('nav'); bar.className = 'example-toolbar'; bar.setAttribute('aria-label', zh ? '示例导航' : 'Example navigation');
  const label = doc.createElement('span'); label.textContent = zh ? '示例项目 · 操作仅保留在本次演示' : 'Example project · changes stay in this demo';
  const choices = doc.createElement('select'); choices.setAttribute('aria-label', zh ? '选择教程' : 'Choose a guide');
  const browse = doc.createElement('option'); browse.value = ''; browse.textContent = zh ? '自由浏览' : 'Browse freely'; choices.append(browse);
  for (const [topic, pair] of Object.entries(GUIDE_LABELS)) { const option = doc.createElement('option'); option.value = topic; option.textContent = guideText(pair, doc.documentElement.lang); choices.append(option); }
  choices.addEventListener('change', () => { cancel(); if (choices.value) { doc.defaultView.parent.postMessage({ type: 'example-topic', topic: choices.value, channel }, '*'); } });
  const free = doc.createElement('button'); free.type = 'button'; free.textContent = zh ? '自由浏览' : 'Browse freely'; free.addEventListener('click', () => { cancel(); choices.value = ''; });
  const close = doc.createElement('button'); close.type = 'button'; close.textContent = zh ? '退出示例 ×' : 'Exit example ×'; close.addEventListener('click', () => onExit('skipped'));
  const reset = doc.createElement('button'); reset.type = 'button'; reset.textContent = zh ? '重置示例' : 'Reset example'; reset.addEventListener('click', () => { doc.defaultView.parent.postMessage({ type: 'example-topic', topic: 'browse', channel }, '*'); });
  bar.append(label, choices, free, reset, close); doc.body.append(bar);
}
