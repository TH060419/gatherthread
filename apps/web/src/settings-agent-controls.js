import { ZCODE_HARNESS } from "./zcode.js";

export const DSH_HARNESS = "deepseek-harness";
export const AGENT_HARNESS_IDS = ["codex", DSH_HARNESS, ZCODE_HARNESS];

/**
 * Pure state machine behind the settings dialog Agent controls.
 *
 * Given the current checkbox map, the selected default harness, and the id of
 * the checkbox the user just changed (if any), returns the next consistent
 * state: at least one harness stays enabled, a checkbox is disabled exactly
 * when it is the single remaining enabled harness, the default harness falls
 * back to the first enabled harness when its own checkbox is cleared, and
 * only the selected harness's field group is visible. The DOM layer applies
 * this result verbatim.
 */
export function syncAgentControlState(input) {
  const enabled = {};
  for (const id of AGENT_HARNESS_IDS) {
    enabled[id] = input.enabled[id] === true;
  }
  const changed = input.changed !== undefined && enabled[input.changed] === false
    ? input.changed
    : undefined;
  if (changed && !AGENT_HARNESS_IDS.some((id) => enabled[id])) {
    // Never leave zero harnesses enabled: restore the checkbox the user just
    // cleared so the project always keeps one default Agent.
    enabled[changed] = true;
  }
  const enabledIds = AGENT_HARNESS_IDS.filter((id) => enabled[id]);
  const singleEnabled = enabledIds.length === 1;
  const disabled = {};
  for (const id of AGENT_HARNESS_IDS) {
    disabled[id] = enabled[id] && singleEnabled;
  }
  let harness = AGENT_HARNESS_IDS.includes(input.harness) ? input.harness : enabledIds[0];
  if (!enabled[harness]) harness = enabledIds[0];
  return {
    enabled,
    disabled,
    harness,
    codexFieldsHidden: harness !== "codex",
    dshFieldsHidden: harness !== DSH_HARNESS,
  };
}

export function agentSettingsSummary(harness) {
  if (harness === DSH_HARNESS) {
    return "DeepSeek Harness supplies this project's runtime and handles new Agent requests by default.";
  }
  if (harness === ZCODE_HARNESS) {
    return "ZCode supplies this project's connection command and handles new Agent requests by default.";
  }
  return "Codex supplies this project's connection command and handles new Agent requests by default.";
}
