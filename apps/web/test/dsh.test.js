import test from "node:test";
import assert from "node:assert/strict";

import {
  DSH_INSTALL_COMMAND,
  DSH_PINNED_START_COMMAND,
  DSH_START_COMMAND,
  DSH_VERSION_COMMAND,
  dshExecutionProfile,
  dshPairingCodeFromHash,
  dshRuntimeChoices,
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

test("DSH fallback commands use the official npm workflow without credentials or a source checkout", () => {
  assert.equal(DSH_START_COMMAND, "npx @deepseek-ai/dsh web");
  assert.equal(DSH_VERSION_COMMAND, "npx @deepseek-ai/dsh --version");
  assert.equal(DSH_PINNED_START_COMMAND, "npx @deepseek-ai/dsh@0.1.2-rc.1 web");
  assert.match(DSH_INSTALL_COMMAND, /^npx @deepseek-ai\/dsh@0\.1\.2-rc\.1 plugin --profile web add @gatherthread\/dsh-host@0\.1\.0-beta\.1$/u);
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

test("pairing hash accepts only the short one-time code and can be removed without losing project navigation", () => {
  assert.equal(dshPairingCodeFromHash("#project=p1&dsh-pair=ABCD-2345"), "ABCD-2345");
  assert.equal(dshPairingCodeFromHash("#dsh-pair=bad-token-value"), "");
  assert.equal(withoutDshPairingHash("#project=p1&session=s1&dsh-pair=ABCD-2345"), "project=p1&session=s1");
});
