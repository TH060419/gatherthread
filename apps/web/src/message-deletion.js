/** UI eligibility is explanatory only; the server rechecks author/device/ACL. */
export function canDeleteMessage(event, context) {
  return Boolean(context.writable && context.userId && event?.actor?.id === context.userId
    && event.sessionId === context.sessionId && !event.deleted && !event.contentUnavailable
    && ["human_chat", "agent_request", "agent_response"].includes(event.type));
}

export function mountMessageDeletion({ document, api, localizer, getContext, onDeleted, announce, makeKey,
  confirm = text => globalThis.confirm(text) }) {
  const t = text => localizer.t(text);
  const intents = new Map();
  let generation = 0;
  const sameScope = (scope, stamp) => generation === stamp && getContext().scope === scope;
  async function remove(event, button) {
    const context = getContext(), stamp = generation;
    if (!canDeleteMessage(event, context)) return;
    const identity = `${context.scope}:${event.id}`;
    if (intents.get(identity)?.sending) return;
    const warning = event.type === "agent_request"
      ? "Delete this request, its linked replies and work? It will be excluded from future GatherThread Agent context. Existing independent local or provider copies are not erased."
      : "Delete this message? It will be excluded from future GatherThread Agent context. Existing independent local or provider copies are not erased.";
    if (!confirm(t(warning)) || !sameScope(context.scope, stamp)) return;
    const current = getContext().events.find(item => item.id === event.id);
    if (!canDeleteMessage(current, getContext())) return;
    const intent = intents.get(identity) ?? { idempotencyKey: makeKey("message-delete"), sending: false };
    intents.set(identity, intent);
    intent.sending = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const receipt = await api.deleteMessage(context.sessionId, event.id, { idempotencyKey: intent.idempotencyKey });
      if (!sameScope(context.scope, stamp)) return;
      intents.delete(identity);
      const restoreFocus = document.activeElement === button || document.activeElement === document.body;
      await onDeleted(receipt);
      if (restoreFocus && sameScope(context.scope, stamp)
        && (document.activeElement === button || document.activeElement === document.body)) {
        document.getElementById?.(`message-${event.id}`)?.focus({ preventScroll: true });
      }
      if (sameScope(context.scope, stamp)) announce(t("Message deleted. Future Agent context will exclude it."));
    } catch (error) {
      if (!sameScope(context.scope, stamp)) return;
      const uncertain = !error.status || error.status >= 500;
      if (!uncertain) intents.delete(identity);
      announce(t(uncertain ? "Deletion is not confirmed. Try again safely; the same deletion will not be duplicated."
        : [401, 403, 404].includes(error.status) ? "Your access changed. Reopen this session to check deletion permission."
          : "Unable to delete this message. Refresh the history and try again."));
    } finally {
      intent.sending = false;
      if (sameScope(context.scope, stamp) && button.isConnected) {
        button.disabled = !canDeleteMessage(getContext().events.find(item => item.id === event.id), getContext());
        button.setAttribute("aria-busy", "false");
      }
    }
  }
  function action(event) {
    if (!canDeleteMessage(event, getContext())) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button message-action message-delete-action";
    button.dataset.messageDeleteId = event.id;
    button.title = t("Delete my message");
    button.setAttribute("aria-label", t("Delete my message"));
    button.disabled = intents.get(`${getContext().scope}:${event.id}`)?.sending === true;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7");
    svg.append(path); button.append(svg);
    button.addEventListener("click", () => void remove(event, button));
    return button;
  }
  return { action, reset: () => { generation++; intents.clear(); } };
}
