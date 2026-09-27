import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_HARNESS_IDS,
  agentSettingsSummary,
  syncAgentControlState,
} from "../src/settings-agent-controls.js";

const allEnabled = { codex: true, "deepseek-harness": true, zcode: true };

function input(overrides = {}) {
  return {
    enabled: { ...allEnabled },
    harness: "codex",
    ...overrides,
  };
}

test("all three harness checkboxes including zcode stay manageable while several are enabled", () => {
  const state = syncAgentControlState(input());
  assert.deepEqual(state.enabled, { codex: true, "deepseek-harness": true, zcode: true });
  assert.deepEqual(state.disabled, { codex: false, "deepseek-harness": false, zcode: false });
  assert.equal(state.harness, "codex");
  assert.equal(state.codexFieldsHidden, false);
  assert.equal(state.dshFieldsHidden, true, "codex selection hides DSH fields");
});

test("disabling zcode keeps codex and dsh enabled and the default harness untouched", () => {
  const state = syncAgentControlState(input({
    enabled: { codex: true, "deepseek-harness": true, zcode: false },
    harness: "zcode",
    changed: "zcode",
  }));
  assert.equal(state.enabled.zcode, false);
  assert.equal(state.harness, "codex", "falling back keeps exactly one enabled default");
  assert.equal(state.codexFieldsHidden, false);
  assert.equal(state.dshFieldsHidden, true);
});

test("clearing the last remaining enabled checkbox restores itself instead of leaving zero", () => {
  const state = syncAgentControlState(input({
    enabled: { codex: false, "deepseek-harness": false, zcode: true },
    harness: "zcode",
    changed: "zcode",
  }));
  assert.equal(state.enabled.zcode, true);
  assert.equal(state.disabled.zcode, true, "the single remaining harness locks its checkbox");
  assert.equal(state.harness, "zcode");
  assert.equal(state.codexFieldsHidden, true, "zcode selection hides codex model fields");
  assert.equal(state.dshFieldsHidden, true);
});

test("selecting zcode as default shows only zcode-relevant controls", () => {
  const state = syncAgentControlState(input({ harness: "zcode" }));
  assert.equal(state.harness, "zcode");
  assert.equal(state.codexFieldsHidden, true);
  assert.equal(state.dshFieldsHidden, true);
  assert.equal(agentSettingsSummary("zcode"), "ZCode supplies this project's connection command and handles new Agent requests by default.");
});

test("an unknown or disabled harness falls back to the first enabled harness", () => {
  const unknown = syncAgentControlState(input({ harness: "claude-code" }));
  assert.equal(unknown.harness, "codex");
  const disabled = syncAgentControlState(input({
    enabled: { codex: false, "deepseek-harness": true, zcode: true },
    harness: "codex",
  }));
  assert.equal(disabled.harness, "deepseek-harness");
});

test("the harness id set covers every manageable checkbox", () => {
  assert.deepEqual(AGENT_HARNESS_IDS, ["codex", "deepseek-harness", "zcode"]);
});
