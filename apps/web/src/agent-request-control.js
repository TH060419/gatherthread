import { retryAgentRequestInput } from "./domain.js";

const targetId = (event) => event.replyTo ?? event.reply_to_event_id ?? event.payload?.reply_to_event_id;

// Only the latest ordinary request authored by this user controls the composer.
// Summary regeneration uses its own source-selection/confirmation workflow.
export function composerAgentAction(events, userId) {
  if (!userId) return { action: "request" };
  const history = events ?? [];
  let request;
  // Keep the unbundled browser path compatible with Safari 15/Chrome 100.
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].type === "agent_request" && history[index].actor?.id === userId && !history[index].payload?.history_summary) {
      request = history[index];
      break;
    }
  }
  if (!request) return { action: "request" };
  const linked = history.filter((event) => targetId(event) === request.id);
  if (linked.some((event) => event.type === "agent_response")) return { action: "request" };
  if (linked.some((event) => event.type === "agent_progress" && event.payload?.status === "paused")) {
    const profile = request.payload?.execution_profile;
    // Legacy requests without a recorded target can be asked anew, but cannot
    // honestly promise to resume the original Agent/model.
    if (!profile?.harness || !profile?.model) return { action: "request" };
    return { action: "resume", request };
  }
  // The server can pause a claimed request only. A queued/unclaimed request is
  // not advertised as stoppable; generic work markers establish that claim.
  return { action: linked.some((event) => event.type === "agent_progress") ? "pause" : "wait", request };
}

export function resumeAgentRequestInput(request, idempotencyKey) {
  const profile = request?.payload?.execution_profile;
  if (!profile?.harness || !profile?.model) throw new Error("Original Agent settings are unavailable. Start a new request.");
  return {
    ...retryAgentRequestInput(request, idempotencyKey),
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
    ...(request.payload?.mentions ? { mentions: structuredClone(request.payload.mentions) } : {}),
  };
}

export function mountAgentRequestControl({ button, targetLabel, errorNode, api, getContext, onChange, makeKey, t = (text) => text }) {
  let operation = null;
  let resumeIntent = null;

  function view() {
    const context = getContext();
    return { ...context, ...composerAgentAction(context.events, context.userId) };
  }

  function update() {
    const current = view();
    if (resumeIntent?.scope !== current.scope) resumeIntent = null;
    const busy = operation?.scope === current.scope;
    const labels = { request: "Request my agent", wait: "Waiting for Agent…", pause: "Pause Agent", resume: "Resume Agent" };
    const label = busy ? operation.action === "pause" ? "Pausing…" : "Resuming…" : labels[current.action];
    // Reuse the same stable button and keep its accessible name meaningful.
    // Sending owns the button until its HTTP write settles.
    if (!current.sending) {
      const icon = button.ownerDocument.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = current.action === "pause" ? "Ⅱ" : current.action === "resume" ? "▶" : "✦";
      button.replaceChildren(icon, ` ${t(label)}`);
      button.setAttribute("aria-label", t(label));
    }
    button.dataset.agentAction = current.action;
    button.setAttribute("aria-busy", String(busy));
    if (current.action !== "request") {
      button.disabled = busy || current.sending || !current.writable || current.action === "wait";
      targetLabel.textContent = t(current.action === "resume"
        ? "Starts a new request with latest history, using the original Agent and model."
        : current.action === "wait" ? "Waiting for your Agent to start this request."
          : "Pauses your current request; your draft stays here.");
    } else if (busy) button.disabled = true;
  }

  function handleClick() {
    const current = view();
    if (current.action === "request") return false;
    if (button.disabled || operation?.scope === current.scope || !current.writable) return true;
    const pending = { scope: current.scope, action: current.action };
    operation = pending;
    errorNode.textContent = "";
    onChange();
    // Reuse one key after an uncertain resume acknowledgement; another click
    // must not append another identical execution while realtime is catching up.
    if (current.action === "resume" && (resumeIntent?.requestId !== current.request.id || resumeIntent?.scope !== current.scope)) {
      resumeIntent = { scope: current.scope, requestId: current.request.id, key: makeKey("agent-resume") };
    }
    const key = resumeIntent?.key;
    void (async () => {
      try {
        if (current.action === "pause") await api.pauseAgentRequest(current.sessionId, current.request.id);
        else await api.appendAgentRequest(current.sessionId, resumeAgentRequestInput(current.request, key));
      } catch (error) {
        if (getContext().scope === current.scope) errorNode.textContent = t(error.message ?? "Unable to control this Agent request. Try again.");
      } finally {
        if (operation === pending) operation = null;
        if (getContext().scope === current.scope) onChange();
      }
    })();
    return true;
  }

  return { update, handleClick, action: () => view().action };
}
