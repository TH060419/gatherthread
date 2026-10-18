export const TEAM_NODE_WIDTH = 228;
export const TEAM_NODE_HEIGHT = 114;
export const teamModelKey = target => JSON.stringify([target.provider, target.model, target.profile_id ?? ""]);
export const teamConnectionKey = target => !target ? "" : target.kind === "local" ? `local:${target.runtime_id}`
  : target.kind === "shared" ? `shared:${target.share_id}:${target.share_revision}` : "cloud";
const normalizedProfile = profile => ({ provider: profile.provider, model: profile.model,
  efforts: profile.reasoningEfforts ?? profile.reasoning_efforts ?? [],
  defaultEffort: profile.defaultReasoningEffort ?? profile.default_reasoning_effort });
const modelLabels = profiles => {
  const multipleProviders = new Set(profiles.map(profile => profile.provider)).size > 1;
  return profile => multipleProviders ? `${profile.provider} · ${profile.model}` : profile.model;
};

/** Agent, model and effort are separate choices. Only advertised exact routes are offered. */
export function teamConnectionChoices(context, t = text => text) {
  const choices = [];
  for (const runtime of context.runtimes ?? []) {
    if (runtime.userId !== context.userId || runtime.purpose !== "execution"
      || ((runtime.sessionId ?? runtime.session_id) && (runtime.sessionId ?? runtime.session_id) !== context.sessionId)
      || !["codex", "deepseek-harness"].includes(runtime.harness)) continue;
    const profiles = (runtime.executionProfiles?.length ? runtime.executionProfiles : [{ provider: runtime.provider, model: runtime.model }]).map(normalizedProfile);
    const device = context.devices?.find(item => item.id === runtime.deviceId);
    const label = modelLabels(profiles);
    choices.push({ key: `local:${runtime.id}`, label: `${runtime.harness === "codex" ? "Codex" : "DSH"} · ${device?.name ?? device?.device_name ?? runtime.deviceId}`,
      available: runtime.status === "online", models: profiles.map(profile => ({ ...profile, key: teamModelKey(profile), label: label(profile),
        target: { kind: "local", runtime_id: runtime.id, harness: runtime.harness, provider: profile.provider, model: profile.model } })) });
  }
  for (const choice of context.sharedAgents ?? []) {
    const share = choice.share;
    const profiles = share.execution_profiles ?? [{ provider: share.execution_profile.provider, model: share.execution_profile.model,
      ...(share.execution_profile.reasoning_effort ? { reasoning_efforts: [share.execution_profile.reasoning_effort] } : {}) }];
    const normalized = profiles.map(normalizedProfile), label = modelLabels(normalized);
    choices.push({ key: `shared:${share.id}:${share.revision}`, label: choice.label, available: choice.available,
      models: normalized.map(profile => ({ ...profile, key: teamModelKey(profile), label: label(profile),
        target: { kind: "shared", share_id: share.id, share_revision: share.revision, harness: share.execution_profile.harness,
          provider: profile.provider, model: profile.model } })) });
  }
  const cloud = (context.cloudProfiles ?? []).map(profile => ({ key: teamModelKey({ ...profile, profile_id: profile.id }),
    label: profile.label ? `${profile.label} · ${profile.model}` : profile.model, efforts: [], available: profile.available !== false,
    target: { kind: "cloud", profile_id: profile.id, provider: profile.provider, model: profile.model, include_code: false,
      ...(profile.api_config_revision === undefined ? {} : { api_config_revision: profile.api_config_revision }) } }));
  if (cloud.length) choices.push({ key: "cloud", label: t("Cloud Agent"), available: cloud.some(item => item.available), models: cloud });
  return choices;
}
export function teamTargetForModel(model, effort) {
  if (!model) return null;
  if (effort !== undefined && !model.efforts.includes(effort)) return null;
  const selected = effort ?? model.defaultEffort ?? model.efforts[0];
  return { ...model.target, ...(selected && model.efforts.includes(selected) ? { reasoning_effort: selected } : {}) };
}
export function moduleSnapshot(node) {
  return { label: node.label, role: node.role, ...(node.prompt === undefined ? {} : { prompt: node.prompt }), target: structuredClone(node.target) };
}
export const sameTeamSnapshot = (a, b) => {
  const key = value => JSON.stringify({ ...value, prompt: value.prompt ?? "" }, (_name, field) =>
    field && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.keys(field).sort().map(name => [name, field[name]])) : field);
  return key(a) === key(b);
};
export function removeTeamNode(draft, id) {
  const next = { ...draft, nodes: draft.nodes.filter(node => node.id !== id), edges: draft.edges.filter(edge => edge.source !== id && edge.target !== id) };
  if (draft.entry_node_id === id) {
    if (next.nodes.length) next.entry_node_id = next.nodes[0].id;
    else delete next.entry_node_id;
  }
  return next;
}
export function teamEdgeAllowed(edges, source, target, direction, exceptId) {
  if (!source || !target || source === target) return false;
  const routes = edges.filter(edge => edge.id !== exceptId).flatMap(edge => [`${edge.source}\0${edge.target}`,
    ...(edge.direction === "bidirectional" ? [`${edge.target}\0${edge.source}`] : [])]);
  return !routes.includes(`${source}\0${target}`) && (direction !== "bidirectional" || !routes.includes(`${target}\0${source}`));
}
export function teamEdgePath(source, target) {
  const x1 = source.x + TEAM_NODE_WIDTH, y1 = source.y + TEAM_NODE_HEIGHT / 2;
  const x2 = target.x, y2 = target.y + TEAM_NODE_HEIGHT / 2;
  const bend = Math.max(70, Math.abs(x2 - x1) * .5);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
