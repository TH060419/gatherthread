import test from "node:test";
import assert from "node:assert/strict";

import {
  codexExecutionProfile,
  DSH_INSTALL_COMMAND,
  DSH_PINNED_START_COMMAND,
  DSH_START_COMMAND,
  DSH_VERSION_COMMAND,
  dshExecutionProfile,
  dshExecutionSelection,
  dshPairingCodeFromHash,
  dshRuntimeChoices,
  resolveCodexRuntime,
  resolveDshRuntime,
  withoutDshPairingHash,
} from "../src/dsh.js";

const now = new Date().toISOString();
const runtime = (overrides = {}) => ({
  id: "runtime-dsh-1",
  device_id: "dsh-device-1",
  harness: "deepseek-harness",
  provider: "Local Provider",
  model: "CaseSensitive/Model-X",
  status: "online",
  last_seen_at: now,
  ...overrides,
});

const dynamicRuntime = (overrides = {}) => runtime({
  execution_profiles: [
    {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoning_efforts: ["low", "high", "max"],
      default_reasoning_effort: "high",
    },
    {
      provider: "deepseek-official",
      model: "deepseek-v4",
      reasoning_efforts: ["low", "max"],
      default_reasoning_effort: "max",
    },
  ],
  ...overrides,
});

test("DSH fallback commands use the official npm workflow without credentials or a source checkout", () => {
  assert.equal(DSH_START_COMMAND, "npx @deepseek-ai/dsh@0.1.2-rc.1 web");
  assert.equal(DSH_VERSION_COMMAND, "npx @deepseek-ai/dsh --version");
  assert.equal(DSH_PINNED_START_COMMAND, "npx @deepseek-ai/dsh@0.1.2-rc.1 web");
  assert.match(DSH_INSTALL_COMMAND, /^npx @deepseek-ai\/dsh@0\.1\.2-rc\.1 plugin --profile web add @gatherthread\/dsh-host@0\.1\.0-alpha\.7$/u);
  assert.doesNotMatch(`${DSH_START_COMMAND}\n${DSH_VERSION_COMMAND}\n${DSH_PINNED_START_COMMAND}\n${DSH_INSTALL_COMMAND}`, /token|credential|--dsh-source|localhost/iu);
});

test("DSH runtime choices preserve configured provider/model spelling and select the unique online runtime", () => {
  const choices = dshRuntimeChoices([runtime()], [{ id: "dsh-device-1", name: "Tony's DSH" }]);
  assert.equal(choices[0].label, "Tony's DSH · Local Provider · CaseSensitive/Model-X");
  const resolved = resolveDshRuntime([runtime()], [{ id: "dsh-device-1", name: "Tony's DSH" }], null);
  assert.equal(resolved.runtime.id, "runtime-dsh-1");
  assert.deepEqual(dshExecutionProfile(resolved.runtime), {
    harness: "deepseek-harness",
    provider: "Local Provider",
    model: "CaseSensitive/Model-X",
    runtimeId: "runtime-dsh-1",
  });
});

test("DSH runtime selection fails closed for ambiguity, offline selection, and malformed server data", () => {
  const second = runtime({ id: "runtime-dsh-2", device_id: "dsh-device-2" });
  assert.match(resolveDshRuntime([runtime(), second], [], null).reason, /Choose which/);
  assert.match(resolveDshRuntime([
    runtime({ status: "offline" }),
  ], [], { deviceId: "dsh-device-1", provider: "Local Provider", model: "CaseSensitive/Model-X" }).reason, /offline/);
  assert.deepEqual(dshRuntimeChoices([{ ...runtime(), model: "bad\nmodel" }]), []);
  assert.throws(() => dshExecutionProfile(runtime({ status: "offline" })), /online DeepSeek Harness runtime/);
});

test("DSH dynamic profiles use only advertised model and reasoning combinations", () => {
  const selected = dshExecutionSelection(dynamicRuntime(), {
    provider: "deepseek-official",
    model: "deepseek-v4",
    effort: "low",
  });
  assert.deepEqual(selected, {
    provider: "deepseek-official",
    model: "deepseek-v4",
    reasoningEfforts: ["low", "max"],
    defaultReasoningEffort: "max",
    reasoningEffort: "low",
  });
  assert.deepEqual(dshExecutionProfile(dynamicRuntime(), selected), {
    harness: "deepseek-harness",
    provider: "deepseek-official",
    model: "deepseek-v4",
    reasoningEffort: "low",
    runtimeId: "runtime-dsh-1",
  });

  const corrected = dshExecutionSelection(dynamicRuntime(), {
    provider: "deepseek-official",
    model: "deepseek-v4",
    effort: "unsupported",
  });
  assert.equal(corrected.reasoningEffort, "max");
  assert.throws(
    () => dshExecutionProfile(dynamicRuntime(), { provider: "other", model: "made-up", reasoningEffort: "low" }),
    /advertised DeepSeek Harness execution profile/u,
  );
});

test("DSH ignores malformed advertised choices instead of exposing unsafe model controls", () => {
  const resolved = resolveDshRuntime([dynamicRuntime({
    execution_profiles: [
      { provider: "deepseek-official", model: "bad\nmodel", reasoning_efforts: ["low"] },
      { provider: "deepseek-official", model: "deepseek-v4", reasoning_efforts: ["low", "bad\neffort"] },
    ],
  })], [], null);
  assert.deepEqual(resolved.runtime.executionProfiles, [{
    provider: "deepseek-official",
    model: "deepseek-v4",
    reasoningEfforts: ["low"],
  }]);
});

test("DSH runtime resolution prefers stable runtime id and uses exact legacy fallback only for migrated profiles", () => {
  const moved = dynamicRuntime({
    id: "runtime-dsh-new",
    device_id: "dsh-device-2",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });
  assert.equal(resolveDshRuntime([dynamicRuntime(), moved], [], {
    runtimeId: "runtime-dsh-new",
    deviceId: "stale-device",
    provider: "stale-provider",
    model: "stale-model",
  }).runtime.id, "runtime-dsh-new");
  assert.equal(resolveDshRuntime([dynamicRuntime()], [], {
    runtimeId: "runtime-missing",
    deviceId: "dsh-device-1",
    provider: "Local Provider",
    model: "CaseSensitive/Model-X",
  }).runtime, null, "a stale stable id must not silently retarget another runtime");
  assert.equal(resolveDshRuntime([runtime()], [], {
    deviceId: "dsh-device-1",
    provider: "Local Provider",
    model: "CaseSensitive/Model-X",
  }).runtime.id, "runtime-dsh-1");
});

test("Codex and DSH resolve independently from the complete runtime list", () => {
  const codex = runtime({
    id: "runtime-codex-1",
    device_id: "codex-device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  const runtimes = [runtime(), codex];
  const codexResolution = resolveCodexRuntime(runtimes);
  const dshResolution = resolveDshRuntime(runtimes, [], null);
  assert.equal(codexResolution.runtime.id, "runtime-codex-1");
  assert.equal(dshResolution.runtime.id, "runtime-dsh-1");
  assert.deepEqual(codexExecutionProfile(codexResolution.runtime, {
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  }), {
    harness: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    runtimeId: "runtime-codex-1",
  });
});

test("Codex runtime selection fails closed when offline or ambiguous", () => {
  const codex = runtime({
    id: "runtime-codex-1",
    device_id: "codex-device-1",
    harness: "codex",
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  assert.match(resolveCodexRuntime([{ ...codex, status: "offline" }]).reason, /offline|Connect Codex/u);
  assert.match(resolveCodexRuntime([
    codex,
    { ...codex, id: "runtime-codex-2", device_id: "codex-device-2" },
  ]).reason, /More than one/u);
  assert.throws(
    () => codexExecutionProfile({ ...codex, status: "offline" }, { model: "gpt-5.6-luna", reasoningEffort: "low" }),
    /online Codex runtime/u,
  );
});

test("pairing hash accepts only the short one-time code and can be removed without losing project navigation", () => {
  assert.equal(dshPairingCodeFromHash("#project=p1&dsh-pair=ABCD-2345"), "ABCD-2345");
  assert.equal(dshPairingCodeFromHash("#dsh-pair=bad-token-value"), "");
  assert.equal(withoutDshPairingHash("#project=p1&session=s1&dsh-pair=ABCD-2345"), "project=p1&session=s1");
});
