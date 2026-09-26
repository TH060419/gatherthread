import test from "node:test";
import assert from "node:assert/strict";

import { projectZcodeConnectionCommands, ZCODE_CONNECT_PACKAGE_SPEC } from "../src/domain.js";
import { resolveZcodeRuntime, zcodeExecutionProfile } from "../src/zcode.js";
import { AGENT_HARNESSES, withProjectAgentHarness, projectAgentHarness, projectEnabledHarnesses, normalizeSettings } from "../src/settings.js";

const now = new Date().toISOString();
const runtime = (overrides = {}) => ({
  id: "runtime-zcode-1",
  device_id: "zcode-device-1",
  harness: "zcode",
  provider: "GLM Account",
  model: "GLM-5.3-Flash",
  status: "online",
  last_seen_at: now,
  ...overrides,
});

test("ZCode harness joins the selectable agent harnesses", () => {
  assert.ok(AGENT_HARNESSES.includes("zcode"));
  const settings = withProjectAgentHarness(normalizeSettings(undefined), "project-alpha", "zcode");
  assert.equal(projectAgentHarness(settings, "project-alpha"), "zcode");
  assert.ok(projectEnabledHarnesses(settings, "project-alpha").includes("zcode"));
});

test("ZCode connector commands stay credential-free and pin the package", () => {
  assert.equal(ZCODE_CONNECT_PACKAGE_SPEC, "@gatherthread/zcode-connect@0.1.0-alpha.5");
  const commands = projectZcodeConnectionCommands({
    baseUrl: "https://gather.example.test",
    projectId: "proj_1",
  });
  assert.match(commands.posix, /^npx --yes @gatherthread\/zcode-connect@0\.1\.0-alpha\.5 --url 'https:\/\/gather\.example\.test' --project 'proj_1' --create-workspace$/u);
  assert.match(commands.powershell, /^npx\.cmd --yes @gatherthread\/zcode-connect@0\.1\.0-alpha\.5 /u);
  assert.doesNotMatch(`${commands.posix}\n${commands.powershell}`, /token|credential|localhost/iu);
});

test("ZCode connector commands refuse unsafe server URLs and project IDs", () => {
  assert.throws(() => projectZcodeConnectionCommands({ baseUrl: "https://gather.example.test/x?y=1", projectId: "proj_1" }), /not safe/);
  assert.throws(() => projectZcodeConnectionCommands({ baseUrl: "https://gather.example.test", projectId: "bad id" }), /not safe/);
});

test("ZCode runtime selection resolves the unique online runtime into an exact execution profile", () => {
  const resolved = resolveZcodeRuntime([runtime()]);
  assert.equal(resolved.runtime.id, "runtime-zcode-1");
  assert.equal(resolved.reason, "");
  assert.deepEqual(zcodeExecutionProfile(resolved.runtime), {
    harness: "zcode",
    provider: "GLM Account",
    model: "GLM-5.3-Flash",
    runtimeId: "runtime-zcode-1",
  });
});

test("ZCode runtime selection fails closed for ambiguity, offline, and malformed data", () => {
  const second = runtime({ id: "runtime-zcode-2", device_id: "zcode-device-2" });
  assert.match(resolveZcodeRuntime([runtime(), second]).reason, /More than one ZCode runtime/);
  assert.match(resolveZcodeRuntime([runtime({ status: "offline" })]).reason, /Connect ZCode/);
  assert.deepEqual(resolveZcodeRuntime([{ ...runtime(), harness: "codex" }]).choices, []);
  assert.throws(() => zcodeExecutionProfile(runtime({ status: "offline" })), /online ZCode runtime/);
});
