/** Presentation helpers. Runtimes must come from the authenticated own-runtime endpoint. */
export const TEAM_NODE_WIDTH = 236;
export const TEAM_NODE_HEIGHT = 142;
export const TEAM_GRAPH_WIDTH = 1800;
export const TEAM_GRAPH_HEIGHT = 1200;

export function teamTargetKey(target) {
  if (!target) return "";
  return JSON.stringify(target.kind === "cloud"
    ? ["cloud", target.profile_id, target.provider, target.model, target.api_config_revision ?? ""]
    : ["local", target.runtime_id, target.harness, target.provider, target.model, target.reasoning_effort ?? ""]);
}

export function teamTargetChoices({ runtimes = [], devices = [], userId, cloudStatus } = {}) {
  const names = new Map(devices.map(device => [device.id, device.name]));
  const choices = [];
  for (const runtime of runtimes) {
    // The current endpoint omits user_id because it is already requester-scoped.
    // An explicitly different actor or non-execution runtime is never a choice.
    if (runtime.userId && runtime.userId !== userId || runtime.user_id && runtime.user_id !== userId
      || runtime.purpose && runtime.purpose !== "execution"
      || !["codex", "deepseek-harness"].includes(runtime.harness) || runtime.status === "revoked") continue;
    const profiles = runtime.executionProfiles?.length ? runtime.executionProfiles
      : [{ provider: runtime.provider, model: runtime.model, reasoningEfforts: [] }];
    for (const profile of profiles) {
      if (!profile.provider || !profile.model) continue;
      const efforts = profile.reasoningEfforts?.length ? profile.reasoningEfforts : [undefined];
      for (const effort of efforts) {
        const target = { kind: "local", runtime_id: runtime.id, harness: runtime.harness,
          provider: profile.provider, model: profile.model, ...(effort ? { reasoning_effort: effort } : {}) };
        choices.push({ key: teamTargetKey(target), target, available: runtime.status === "online",
          label: `${runtime.harness === "codex" ? "Codex" : "DSH"} · ${names.get(runtime.deviceId) ?? runtime.deviceId ?? runtime.id} · ${profile.provider} · ${profile.model}${effort ? ` · ${effort}` : ""}` });
      }
    }
  }
  if (cloudStatus?.enabled) {
    for (const profile of cloudStatus.profiles ?? []) {
      const target = { kind: "cloud", profile_id: profile.id, provider: profile.provider, model: profile.model, include_code: false,
        ...(profile.api_config_revision ? { api_config_revision: profile.api_config_revision } : {}) };
      choices.push({ key: teamTargetKey(target), target, available: profile.available === true,
        label: `Cloud Agent · ${profile.label ?? profile.model} · ${profile.provider} · ${profile.model}` });
    }
  }
  return choices;
}

export function teamEdgePath(source, target) {
  const x1 = source.x + TEAM_NODE_WIDTH, y1 = source.y + TEAM_NODE_HEIGHT / 2;
  const x2 = target.x, y2 = target.y + TEAM_NODE_HEIGHT / 2;
  const bend = Math.max(64, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function clampTeamPosition(x, y) {
  return { x: Math.round(Math.max(0, Math.min(TEAM_GRAPH_WIDTH - TEAM_NODE_WIDTH, Number.isFinite(x) ? x : 0))),
    y: Math.round(Math.max(0, Math.min(TEAM_GRAPH_HEIGHT - TEAM_NODE_HEIGHT, Number.isFinite(y) ? y : 0))) };
}

export function canLinkTeamNodes(plan, source, target, direction = "one_way") {
  if (!source || source === target || !plan.nodes.some(node => node.id === source) || !plan.nodes.some(node => node.id === target)) return false;
  const includes = (from, to) => plan.edges.some(edge => edge.source === from && edge.target === to
    || edge.direction === "bidirectional" && edge.source === to && edge.target === from);
  return !includes(source, target) && (direction !== "bidirectional" || !includes(target, source));
}

export function removeTeamNode(plan, nodeId) {
  const result = { ...plan, nodes: plan.nodes.filter(node => node.id !== nodeId),
    edges: plan.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId) };
  if (result.entry_node_id === nodeId) {
    if (result.nodes.length) result.entry_node_id = result.nodes[0].id;
    else delete result.entry_node_id;
  }
  return result;
}

export function teamRunLabel(run) {
  if (run?.status === "paused" && run.error_code === "agent_timeout") return "Agent timed out · continue available";
  return { running: "Team running", paused: "Team paused", completed: "Team completed", failed: "Team failed",
    stopped: "Team stopped", timed_out: "Team time limit reached", call_limit: "Team call limit reached" }[run?.status] ?? "No team task yet";
}

export function teamRunControls(run) {
  return { pause: run?.status === "running", stop: ["running", "paused"].includes(run?.status),
    resume: run?.status === "paused" && run.error_code !== "agent_timeout",
    continue: run?.status === "paused" && run.error_code === "agent_timeout" };
}

/** Only reviewed explanations reach the UI; private exception text stays private. */
export function teamFailureMessage(code) {
  return {
    agent_team_target_unavailable: "An exact Agent or model is unavailable. Reconnect it before starting a new task.",
    cloud_api_changed: "The personal API configuration changed. Select its current configuration for a new team task.",
    context_changed: "Shared history changed. Start a new team task with current history.",
    team_directive_invalid: "The Agent did not return a valid team decision. Review its answer before starting another task.",
    team_directive_mismatch: "The Agent returned a decision for another call. The team stopped without delegating.",
    team_delegation_forbidden: "The Agent requested a delegation outside the configured connections. The team stopped.",
    team_response_route_mismatch: "The result did not match the selected Agent. The team stopped.",
    agent_team_agent_failed: "An Agent failed before completing its assignment. Review the call's message.",
    agent_team_sensitive_input: "Remove credentials from team instructions, roles and tasks before saving or starting.",
    agent_team_prompt_too_large: "Team instructions and tasks are too long together. Shorten them before starting.",
    agent_team_storage_full: "Private team storage is full. Clear ended team records before starting another task.",
    server_restart: "The server restarted. Review the task before resuming; resuming may create another counted call.",
    connector_update_required: "Update and reconnect your Agent connector before continuing.",
  }[code] ?? null;
}
