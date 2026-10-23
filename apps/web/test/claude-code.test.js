import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { normalizeSettings, withProjectAgentHarness, projectAgentHarness, projectClaudeProfile, withProjectClaudeProfile,
  withProjectCodexProfile, withProjectCloudProfile, withProjectEnabledHarnesses } from "../src/settings.js";
import { projectClaudeLauncherUrl } from "../src/domain.js";
import { dshRuntimeChoices, resolveDshRuntime, dshExecutionSelection, dshExecutionProfile } from "../src/dsh.js";

const runtime = { id: "runtime-claude", device_id: "device-claude", harness: "claude-code", provider: "anthropic",
  model: "claude-sonnet-test", status: "online", last_seen_at: "2026-10-21T01:00:00.000Z" };
const codex = { ...runtime, id: "runtime-codex", harness: "codex" };
const dsh = { ...runtime, id: "runtime-dsh", harness: "deepseek-harness" };
test("Claude selection survives settings normalization without rewriting Codex or DSH", () => {
  let settings = withProjectAgentHarness(normalizeSettings({}), "project-a", "claude-code");
  settings = withProjectClaudeProfile(settings, "project-a", { runtimeId: runtime.id, deviceId: "device-claude", provider: "anthropic", model: runtime.model });
  assert.equal(projectAgentHarness(settings, "project-a"), "claude-code");
  assert.equal(projectClaudeProfile(settings, "project-a").runtimeId, runtime.id);
  assert.equal(settings.agents.projectProfiles["project-a"].dsh, null);
  assert.equal(settings.agents.projectProfiles["project-a"].codex.model, "gpt-5.6-sol");
});
test("Claude native selector never falls back to another harness or device", () => {
  assert.deepEqual(dshRuntimeChoices([runtime, codex, dsh], [], "claude-code").map(r => r.id), [runtime.id]);
  assert.equal(resolveDshRuntime([runtime, codex, dsh], [], null, "claude-code").runtime.id, runtime.id);
  assert.equal(resolveDshRuntime([codex, dsh], [], null, "claude-code").runtime, null);
  assert.equal(resolveDshRuntime([runtime], [], { runtimeId: "other" }, "claude-code").runtime, null);
  const selected = dshExecutionSelection(runtime, null, "claude-code");
  assert.deepEqual(dshExecutionProfile(runtime, selected, "claude-code"), { harness: "claude-code", provider: "anthropic", model: runtime.model, runtimeId: runtime.id });
  assert.throws(() => dshExecutionProfile(codex, selected, "claude-code"));
});
test("a re-registered Claude runtime never silently replaces a saved model or effort", () => {
  const saved = { runtimeId: runtime.id, deviceId: "device-claude", provider: "anthropic", model: "claude-old-test", effort: "high" };
  const changed = { ...runtime, execution_profiles: [{ provider: "anthropic", model: runtime.model, reasoning_efforts: ["low"], default_reasoning_effort: "low" }] };
  assert.equal(resolveDshRuntime([changed], [], saved, "claude-code").runtime, null);
  assert.throws(() => dshExecutionSelection(changed, saved, "claude-code"), /selected|profile|model/i);
  assert.throws(() => dshExecutionProfile(runtime, saved, "claude-code"), /selected|profile|model/i);
  const unsupportedEffort = { ...saved, model: runtime.model };
  assert.equal(resolveDshRuntime([changed], [], unsupportedEffort, "claude-code").runtime, null);
  assert.throws(() => dshExecutionSelection(changed, unsupportedEffort, "claude-code"), /effort/i);
  assert.equal(dshExecutionSelection(changed, null, "claude-code").model, runtime.model);
});
test("Claude handoff is v3 with exact native harness and no credential", () => {
  const link = projectClaudeLauncherUrl({ baseUrl: "https://test.gatherthread.cn", projectId: "project-a", model: runtime.model,
    email: "user@example.com", authorizationId: "b9c8f2e1-457b-4c22-b19a-c0184d9a1123" });
  const url = new URL(link);
  assert.equal(url.searchParams.get("v"), "3");
  assert.equal(url.searchParams.get("harness"), "claude-code");
  assert.equal(url.searchParams.get("model"), runtime.model);
  assert.equal(url.searchParams.has("token"), false);
  assert.throws(() => projectClaudeLauncherUrl({ baseUrl: "https://gatherthread.cn", projectId: "project-a", model: "sonnet" }));
});
test("Claude offers an accessible launcher and independently enabled native runtime choice", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["connect-claude-button", "connect-claude-dialog", "claude-launcher-model", "settings-enabled-claude", "open-claude-launcher-button"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<option value="claude-code">Claude Code<\/option>/);
  assert.doesNotMatch(html, /Claude Code · coming later/);
});

test("an unconnected native Agent has a visible device placeholder, not an empty disabled picker", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const render = source.match(/function renderDshRuntimeOptions\([^]*?(?=\nfunction dshStoredProjectProfile)/u)?.[0];
  assert.ok(render);
  const options = [];
  const select = { replaceChildren() { options.length = 0; }, append(option) { options.push(option); },
    setAttribute() {}, disabled: false };
  vm.runInNewContext(`${render}\nrenderDshRuntimeOptions(select);`, {
    state: { settings: {} }, select,
    currentDshResolution: () => ({ choices: [], runtime: null }),
    document: { createElement: () => ({}) }, localizer: { t: value => value },
  });
  assert.equal(select.disabled, true);
  assert.equal(options.length, 1);
  assert.equal(options[0].textContent, "No connected Agent runtime");
  assert.equal(options[0].value, "");
});

test("unrelated Settings saves preserve Claude's pin; only the device change handler adopts a new profile", async () => {
  const source = (await readFile(new URL("../src/main.js", import.meta.url), "utf8")).replace(/\r\n?/gu, "\n");
  const functions = ["readSettingsForm", "isAlternativeNative", "nativeProjectProfile", "withNativeProjectProfile", "nativeExecutionSelection", "dshStoredProjectProfile", "selectSettingsNativeRuntime"];
  const bodies = functions.map(name => {
    const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
    assert.notEqual(start, -1, name);
    const tail = source.slice(start), end = tail.indexOf("\n}\n");
    if (tail.split("\n")[0].endsWith("}")) return tail.split("\n")[0];
    return end >= 0 ? tail.slice(0, end + 2) : tail.slice(0, tail.indexOf("\n"));
  });
  const projectId = "project-a";
  let saved = withProjectAgentHarness(normalizeSettings({}), projectId, "claude-code");
  saved = withProjectClaudeProfile(saved, projectId, { runtimeId: runtime.id, deviceId: "device-claude", provider: "anthropic", model: "claude-old-test", effort: "high" });
  const nodes = new Map(), element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", checked: false });
    return nodes.get(id);
  };
  element("settings-agent-harness").value = "claude-code";
  element("settings-dsh-runtime").value = runtime.id;
  const context = vm.createContext({ state: { project: { id: projectId }, executionRuntimes: [{ ...runtime, execution_profiles: [
    { provider: "anthropic", model: runtime.model, reasoning_efforts: ["low"], default_reasoning_effort: "low" },
  ] }], devices: [], settings: saved }, settingsPreview: saved, element,
    DSH_HARNESS: "deepseek-harness", normalizeSettings, projectDshProfile: () => null, projectClaudeProfile,
    withProjectDshProfile: () => { throw new Error("Not a DSH preference"); }, withProjectClaudeProfile,
    withProjectCodexProfile, withProjectCloudProfile, withProjectEnabledHarnesses, withProjectAgentHarness,
    currentProjectHarness: settings => projectAgentHarness(settings, projectId), advertisedCodexModels: () => [],
    settingsEnabledHarnesses: () => ["claude-code"], dshRuntimeChoices, dshExecutionSelection });
  vm.runInContext(bodies.join("\n"), context);
  const passive = context.readSettingsForm(saved);
  assert.equal(projectClaudeProfile(passive, projectId).model, "claude-old-test");
  assert.equal(projectClaudeProfile(passive, projectId).effort, "high");
  context.selectSettingsNativeRuntime();
  const explicit = context.readSettingsForm(context.settingsPreview);
  assert.equal(projectClaudeProfile(explicit, projectId).model, runtime.model);
  assert.equal(projectClaudeProfile(explicit, projectId).effort, "low");
});
