// Portal the disclosure out of clipped/backdrop-filtered conversation ancestors.
// Geometry is read from the current conversation, including collapsed sidebars.
export function positionSessionContextPanel(doc) {
  const details = doc.getElementById('session-context-details');
  const panel = doc.querySelector('.session-context-panel');
  if (!details || !panel) return;
  if (details.open && (doc.getElementById('workspace').hidden || doc.getElementById('session-view').hidden)) details.open = false;
  if (!details.open) {
    if (panel.parentElement !== details) details.append(panel);
    panel.removeAttribute('style');
    return;
  }
  if (panel.parentElement !== doc.body) doc.body.append(panel);
  const win = doc.defaultView;
  const region = doc.getElementById('session-view').getBoundingClientRect();
  const trigger = details.getBoundingClientRect();
  const width = Math.min(480, Math.max(0, region.width - 24), win.innerWidth - 28);
  const left = Math.max(14, Math.min(trigger.right - width, region.right - width - 12));
  const top = Math.min(trigger.bottom + 10, win.innerHeight - 134);
  Object.assign(panel.style, { position: 'fixed', width: `${width}px`, minWidth: '0', left: `${left}px`, right: 'auto', top: `${top}px`,
    maxHeight: `${Math.max(120, win.innerHeight - top - 20)}px`, zIndex: '60' });
}

// Keep the disclosure's original keyboard order when its panel is portalled.
export function bindSessionContextPanel(doc) {
  const details = doc.getElementById('session-context-details');
  const summary = details.querySelector('summary');
  const panel = details.querySelector('.session-context-panel');
  const usable = (node) => node && !node.disabled && !node.closest('[hidden]') && node.getClientRects().length;
  const controls = () => [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]')]
    .filter((node) => !node.closest('[hidden]') && node.getClientRects().length);
  doc.addEventListener('keydown', (event) => {
    if (!details.open || doc.body.classList.contains('driver-active')) return;
    const nodes = controls();
    if (event.key === 'Escape' && (event.target === summary || panel.contains(event.target))) {
      event.preventDefault(); details.open = false; positionSessionContextPanel(doc); summary.focus();
    }
    if (event.key !== 'Tab') return;
    const following = [...summary.closest('.session-header').querySelectorAll('button')]
      .find((node) => !details.contains(node) && usable(node) && Boolean(summary.compareDocumentPosition(node) & 4));
    let destination;
    if (!event.shiftKey && event.target === summary) destination = nodes[0];
    if (event.shiftKey && event.target === nodes[0]) destination = summary;
    if (!event.shiftKey && event.target === nodes.at(-1)) destination = following;
    if (event.shiftKey && event.target === following) destination = nodes.at(-1);
    if (usable(destination)) { event.preventDefault(); destination.focus(); }
  });
}
