/** Presentation-only disclosures. Existing action IDs, handlers and ACL state stay authoritative. */
export function mountSessionToolbar({ document: doc }) {
  const el = id => doc.getElementById(id);
  const groups = [
    { root: el("history-summary-menu"), trigger: el("history-summary-menu-button"), panel: el("history-summary-menu-panel") },
    { root: el("session-options-menu"), trigger: el("session-options-button"), panel: el("session-options-panel") },
  ].filter(group => group.root && group.trigger && group.panel);
  const details = el("session-context-details");
  const listeners = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler));
  };
  const contextOwns = target => Boolean(details?.open && (details.contains(target) || el("session-context-panel")?.contains(target)));
  const guideOwns = target => Boolean(doc.body.classList?.contains("driver-active")
    && target.closest?.(".onboarding-popover, .example-toolbar"));
  const actionable = group => [...group.panel.querySelectorAll("button, summary")]
    .filter(node => !node.disabled && !node.closest("[hidden]") && node.getClientRects().length);
  function close(group, restoreFocus = false) {
    if (group.panel.hidden) return;
    const ownedFocus = group.panel.contains(doc.activeElement) || contextOwns(doc.activeElement);
    group.panel.hidden = true;
    group.trigger.setAttribute("aria-expanded", "false");
    if (group.root.id === "session-options-menu" && details) details.open = false;
    if (restoreFocus && ownedFocus && !group.root.hidden) group.trigger.focus({ preventScroll: true });
  }
  function closeAll({ restoreFocus = false } = {}) { groups.forEach(group => close(group, restoreFocus)); }
  function open(id, { focus = false } = {}) {
    const group = groups.find(value => value.root.id === id || value.trigger.id === id);
    if (!group || group.root.hidden || group.trigger.disabled) return false;
    groups.filter(value => value !== group).forEach(value => close(value));
    group.panel.hidden = false;
    group.trigger.setAttribute("aria-expanded", "true");
    if (focus) actionable(group)[0]?.focus({ preventScroll: true });
    return true;
  }
  function refresh() {
    const summaries = groups.find(group => group.root.id === "history-summary-menu");
    if (summaries) {
      const hidden = [...summaries.panel.querySelectorAll("button")].every(node => node.hidden);
      if (hidden !== summaries.root.hidden) summaries.root.hidden = hidden;
      if (hidden) close(summaries);
    }
  }
  for (const group of groups) {
    listen(group.trigger, "click", () => {
      if (group.panel.hidden) open(group.root.id); else close(group);
    });
    listen(group.trigger, "keydown", event => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault(); open(group.root.id, { focus: true });
    });
    listen(group.panel, "click", event => {
      const button = event.target.closest?.("button");
      // Status contains persistent checkboxes, selectors and explicit sync actions.
      if (!button || button.disabled || contextOwns(button)) return;
      close(group, true);
    });
  }
  listen(doc, "pointerdown", event => {
    if (contextOwns(event.target) || guideOwns(event.target)) return;
    groups.forEach(group => { if (!group.root.contains(event.target)) close(group); });
  });
  listen(doc, "focusin", event => {
    if (contextOwns(event.target) || guideOwns(event.target)) return;
    groups.forEach(group => { if (!group.root.contains(event.target)) close(group); });
  });
  listen(doc, "keydown", event => {
    if (event.key !== "Escape" || contextOwns(event.target)) return;
    const group = groups.find(value => !value.panel.hidden && value.root.contains(event.target));
    if (!group) return;
    event.preventDefault(); event.stopPropagation(); close(group, true);
    if (doc.activeElement === group.trigger) return;
    group.trigger.focus({ preventScroll: true });
  });
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(refresh) : null;
  groups.forEach(group => observer?.observe(group.panel, { subtree: true, attributes: true, attributeFilter: ["hidden", "disabled"] }));
  refresh();
  return { open, closeAll, reset: closeAll, refresh, destroy() { closeAll(); observer?.disconnect(); listeners.forEach(remove => remove()); } };
}
