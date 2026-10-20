import { canAppend, retryAgentRequestInput } from "./domain.js?v=20261018-tabs-2";

export const isCloudTrialRequest = (request) => request?.payload?.execution_profile?.harness === "opencode"
  && !request.payload.github_task_id;

export function retryAgentRequestPermission(request, context) {
  return canAppend({ ...context, kind: isCloudTrialRequest(request) || request?.payload?.github_task_id || request?.payload?.shared_agent ? "human_chat" : "agent_request" });
}

export function cloudRequestInput(request, idempotencyKey, profiles, selection, contentRevision) {
  const recorded = request.payload?.execution_profile;
  const profile = profiles?.find((candidate) => candidate.id === request.payload?.profile_id);
  if (!isCloudTrialRequest(request) || !profile || profile.provider !== recorded?.provider || profile.model !== recorded?.model) {
    throw new Error("The original cloud model is no longer available.");
  }
  const personal = profile.id.startsWith("api-");
  if (personal && (!selection?.api_config_revision || selection.profile_id !== profile.id
    || selection.api_config_revision !== profile.api_config_revision)) {
    throw new Error("The original API connection changed. Start a new request after choosing its current settings.");
  }
  return { content: retryAgentRequestInput(request, idempotencyKey).content, profileId: profile.id,
    includeCode: request.payload.include_code === true, idempotencyKey, replyTo: request.replyTo,
    ...(personal ? { apiConfigRevision: selection.api_config_revision } : {}),
    ...(contentRevision === undefined ? {} : { contentRevision }) };
}

export function continueCloudRequestInput(request, idempotencyKey, profiles, selection, contentRevision) {
  return { ...cloudRequestInput(request, idempotencyKey, profiles, selection, contentRevision), continueFromEventId: request.id };
}

const targetId = (event) => event.replyTo ?? event.reply_to_event_id ?? event.payload?.reply_to_event_id;
const hasRecordedTarget = (request) => {
  const profile = request?.payload?.execution_profile;
  return Boolean(profile?.harness && profile?.model && typeof profile.runtime_id === "string" && profile.runtime_id.length > 0);
};

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
  if (request.deleted || request.contentUnavailable) return { action: "request" };
  const linked = history.filter((event) => targetId(event) === request.id);
  if (linked.some((event) => event.type === "agent_response")) return { action: "request" };
  if (request.payload?.shared_agent) return { action: "stop", request, shared: true };
  if (request.payload?.github_task_id) return { action: "wait", request, cloud: true };
  const cloud = isCloudTrialRequest(request);
  if (linked.some((event) => event.type === "agent_progress" && event.payload?.status === "paused")) {
    // Legacy requests without a recorded target can be asked anew, but cannot
    // honestly promise to resume the original Agent/model.
    if (!cloud && !hasRecordedTarget(request)) return { action: "request" };
    return { action: "resume", request, cloud };
  }
  if (cloud) return { action: "pause", request, cloud: true };
  // The server can pause a claimed request only. A queued/unclaimed request is
  // not advertised as stoppable; generic work markers establish that claim.
  return { action: linked.some((event) => event.type === "agent_progress") ? "pause" : "wait", request };
}

export function resumeAgentRequestInput(request, idempotencyKey) {
  if (!hasRecordedTarget(request)) throw new Error("Original Agent settings are unavailable. Start a new request.");
  return {
    ...retryAgentRequestInput(request, idempotencyKey),
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
    ...(request.payload?.mentions ? { mentions: structuredClone(request.payload.mentions) } : {}),
  };
}

export function mountAgentRequestControl({ button, targetLabel, errorNode, api, getContext, onChange, makeKey,
  confirmResume = () => true, t = (text) => text }) {
  let operation = null;
  let resumeIntent = null;
  let stopIntent = null;

  function view() {
    const context = getContext();
    return { ...context, ...composerAgentAction(context.events, context.userId) };
  }

  function update() {
    const current = view();
    if (resumeIntent?.scope !== current.scope) resumeIntent = null;
    if (stopIntent?.scope !== current.scope) stopIntent = null;
    if (operation?.scope === current.scope && operation.action === "stop"
      && current.events.some(event => event.type === "agent_response" && targetId(event) === operation.requestId)) {
      operation.confirmed = true;
      operation = null;
    }
    const busy = operation?.scope === current.scope;
    const labels = { request: current.requestLabel ?? "Request my agent", wait: "Waiting for Agent…", pause: "Pause Agent", resume: "Resume Agent", stop: "Stop shared Agent" };
    const label = busy ? operation.action === "stop" ? "Stopping…" : operation.action === "pause" ? "Pausing…" : "Resuming…" : labels[current.action];
    // Reuse the same stable button and keep its accessible name meaningful.
    // A canonical shared request is independently stoppable even while its
    // original send/recovery HTTP response is still incomplete.
    const independentStop = current.action === "stop";
    if (!current.sending || independentStop) {
      const icon = button.ownerDocument.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = current.action === "stop" ? "■" : current.action === "pause" ? "Ⅱ" : current.action === "resume" ? "▶" : "✦";
      button.replaceChildren(icon, ` ${t(label)}`);
      button.setAttribute("aria-label", t(label));
    }
    button.dataset.agentAction = current.action;
    button.setAttribute("aria-busy", String(busy));
    if (current.action !== "request") {
      button.disabled = busy || current.sending && !independentStop || !current.writable || current.action === "wait";
      targetLabel.textContent = t(current.action === "stop" ? "Stops your shared request and cancels queued work; your draft stays here." : current.action === "resume"
        ? "Starts a new request with latest history, using the original Agent and model."
        : current.action === "wait" ? current.cloud ? "Cloud Agent is working…" : "Waiting for your Agent to start this request."
          : "Pauses your current request; your draft stays here.");
    } else if (busy) button.disabled = true;
  }

  function handleClick() {
    const current = view();
    const contentRevision = current.contentRevision ?? 0;
    const sourceNow = () => {
      const latest = getContext();
      if (latest.scope !== current.scope || (latest.contentRevision ?? 0) !== contentRevision || !latest.writable) return undefined;
      return latest.events.find(event => event.id === current.request?.id && event.type === "agent_request"
        && !event.deleted && !event.contentUnavailable && event.actor?.id === latest.userId);
    };
    if (current.action === "request") return false;
    if (button.disabled || operation?.scope === current.scope || !current.writable) return true;
    if (current.action === "resume" && !confirmResume(current.request)) return true;
    const pending = { scope: current.scope, action: current.action, requestId: current.request?.id };
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
        if (current.action === "stop") {
          if (stopIntent?.requestId !== current.request.id || stopIntent.scope !== current.scope) {
            stopIntent = { requestId: current.request.id, scope: current.scope, key: makeKey("shared-cancel") };
          }
          await api.cancelSharedAgentRequest(current.sessionId, current.request.id, { idempotency_key: stopIntent.key });
        } else if (current.action === "pause") {
          if (current.cloud) await api.pauseHostedAgentRequest(current.sessionId, current.request.id);
          else await api.pauseAgentRequest(current.sessionId, current.request.id);
        } else if (current.cloud) {
          const selection = current.request.payload?.profile_id?.startsWith("api-")
            ? await api.getHostedAgentSelection(current.sessionId, current.request.id) : undefined;
          const source = sourceNow();
          if (!source) return;
          await api.appendHostedAgentRequest(current.sessionId, cloudRequestInput(source, key, current.cloudProfiles, selection, contentRevision));
        } else {
          const source = sourceNow();
          if (!source) return;
          await api.appendAgentRequest(current.sessionId, { ...resumeAgentRequestInput(source, key), contentRevision });
        }
      } catch (error) {
        if (getContext().scope === current.scope && !pending.confirmed) errorNode.textContent = t(error.message ?? "Unable to control this Agent request. Try again.");
      } finally {
        if (operation === pending) operation = null;
        if (getContext().scope === current.scope) onChange();
      }
    })();
    return true;
  }

  return { update, handleClick, action: () => view().action };
}
