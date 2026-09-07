import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeDshEnvironment,
  assertSafeDshPaths,
  assertSafeDshStateRoot,
  deriveDshSessionId,
  deriveNativeDshSessionId,
  parseDshHostConfig,
  resolveCredentialReference,
} from "../src/config.js";

const enabledConfig = {
  enabled: true,
  apiUrl: "https://gatherthread.example/v1",
  credentialReference: { kind: "environment", variable: "GATHERTHREAD_DSH_TOKEN" },
  projectId: "project-1",
  sessionId: "session-1",
  deviceId: "device-1",
  workspacePath: "/work/project",
  statePath: "/state/gatherthread-dsh.json",
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
};

test("DSH host configuration is disabled by default and rejects inline credential keys", () => {
  assert.deepEqual(parseDshHostConfig(undefined), { enabled: false });
  assert.deepEqual(parseDshHostConfig({ enabled: false }), { enabled: false });
  assert.throws(
    () => parseDshHostConfig({ ...enabledConfig, token: "must-not-be-accepted" }),
    /unsupported keys: token/,
  );
  assert.throws(
    () => parseDshHostConfig({ ...enabledConfig, apiUrl: "https://token@example.test/v1" }),
    /cannot contain credentials/,
  );
});

test("enabled configuration derives a stable DSH-native identity without equating it to GatherThread", () => {
  const parsed = parseDshHostConfig(enabledConfig);
  assert.equal(parsed.enabled, true);
  if (!parsed.enabled) throw new Error("unreachable");
  assert.equal(parsed.bindingMode, "single");
  if (parsed.bindingMode !== "single") throw new Error("unreachable");
  assert.match(parsed.dshSessionId, /^gatherthread-[a-f0-9]{32}$/);
  assert.notEqual(parsed.dshSessionId, parsed.sessionId);
  assert.equal(
    parsed.dshSessionId,
    deriveDshSessionId("project-1", "session-1", "/work/project"),
  );
  assert.equal(parsed.pollIntervalMs, 1_000);
  assert.equal(parsed.pollLimit, 200);
  assert.equal(parsed.shareToolEvents, false);
});

test("native Web integration uses a versioned identity distinct from legacy read-only projections", () => {
  const legacy = deriveDshSessionId("project-1", "session-1", "/work/project");
  const native = deriveNativeDshSessionId("project-1", "session-1", "/work/project");
  assert.match(native, /^gatherthread-[a-f0-9]{32}$/u);
  assert.notEqual(native, legacy);
  assert.equal(native, deriveNativeDshSessionId("project-1", "session-1", "/work/project"));
});

test("project binding is explicit while legacy configurations remain single-session compatible", () => {
  const legacy = parseDshHostConfig(enabledConfig);
  assert.equal(legacy.enabled && legacy.bindingMode, "single");
  const project = parseDshHostConfig({
    ...enabledConfig,
    bindingMode: "project",
    sessionId: undefined,
    statePath: undefined,
    stateRoot: "/state/gatherthread-dsh-project",
    refreshIntervalMs: 750,
    maxConcurrentSessions: 3,
    retryBaseMs: 250,
    retryMaxMs: 4_000,
  });
  assert.equal(project.enabled, true);
  if (!project.enabled || project.bindingMode !== "project") throw new Error("unreachable");
  assert.equal(project.stateRoot, "/state/gatherthread-dsh-project");
  assert.equal(project.maxConcurrentSessions, 3);
  assert.equal(project.retryBaseMs, 250);
  assert.equal(project.retryMaxMs, 4_000);
  assert.throws(
    () => parseDshHostConfig({ ...enabledConfig, stateRoot: "/state/ambiguous" }),
    /bindingMode single does not accept: stateRoot/,
  );
  assert.throws(
    () => parseDshHostConfig({
      ...enabledConfig,
      bindingMode: "project",
      stateRoot: "/state/project",
    }),
    /bindingMode project does not accept: sessionId, statePath/,
  );
  assert.throws(
    () => parseDshHostConfig({
      ...enabledConfig,
      bindingMode: "project",
      sessionId: undefined,
      statePath: undefined,
      stateRoot: "/state/project",
      retryBaseMs: 5_000,
      retryMaxMs: 1_000,
    }),
    /retryMaxMs must be greater/,
  );
});

test("state must remain outside the read-only workspace", () => {
  assert.throws(
    () => parseDshHostConfig({ ...enabledConfig, statePath: "/work/project/.dsh-state.json" }),
    /outside the read-only workspace/,
  );
});

test("activation resolves real ancestors before accepting workspace/state separation", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-realpath-")));
  const workspace = path.join(root, "workspace");
  const stateInsideWorkspace = path.join(workspace, "redirected-state");
  const lexicalOutside = path.join(root, "apparently-outside");
  await mkdir(stateInsideWorkspace, { recursive: true, mode: 0o700 });
  await symlink(stateInsideWorkspace, lexicalOutside, "dir");
  const parsed = parseDshHostConfig({
    ...enabledConfig,
    workspacePath: workspace,
    statePath: path.join(lexicalOutside, "nested", "connector.json"),
  });
  assert.equal(parsed.enabled, true);
  if (!parsed.enabled || parsed.bindingMode !== "single") throw new Error("unreachable");
  await assert.rejects(assertSafeDshPaths(parsed), /real path must be outside/);
});

test("activation rejects a symbolic link in any existing state ancestor", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-ancestor-")));
  const workspace = path.join(root, "workspace");
  const realStateRoot = path.join(root, "real-state-root");
  const linkedAncestor = path.join(root, "linked-state-root");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(path.join(realStateRoot, "level-one"), { recursive: true, mode: 0o700 });
  await symlink(realStateRoot, linkedAncestor, "dir");
  const parsed = parseDshHostConfig({
    ...enabledConfig,
    workspacePath: workspace,
    statePath: path.join(linkedAncestor, "level-one", "level-two", "connector.json"),
  });
  assert.equal(parsed.enabled, true);
  if (!parsed.enabled || parsed.bindingMode !== "single") throw new Error("unreachable");
  await assert.rejects(assertSafeDshPaths(parsed), /symbolic-link ancestor/);
});

test("project state root rejects ancestor symlinks and non-0700 owner permissions", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-project-root-")));
  const workspace = path.join(root, "workspace");
  const realStateParent = path.join(root, "real-state-parent");
  const linkedParent = path.join(root, "linked-state-parent");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(realStateParent, { mode: 0o700 });
  await symlink(realStateParent, linkedParent, "dir");
  const linked = parseDshHostConfig({
    ...enabledConfig,
    bindingMode: "project",
    sessionId: undefined,
    statePath: undefined,
    stateRoot: path.join(linkedParent, "nested"),
    workspacePath: workspace,
  });
  if (!linked.enabled || linked.bindingMode !== "project") throw new Error("unreachable");
  await assert.rejects(assertSafeDshStateRoot(linked), /symbolic-link ancestor/);

  const insecureRoot = path.join(root, "insecure-state-root");
  await mkdir(insecureRoot, { mode: 0o700 });
  await chmod(insecureRoot, 0o750);
  const insecure = parseDshHostConfig({
    ...enabledConfig,
    bindingMode: "project",
    sessionId: undefined,
    statePath: undefined,
    stateRoot: insecureRoot,
    workspacePath: workspace,
  });
  if (!insecure.enabled || insecure.bindingMode !== "project") throw new Error("unreachable");
  if (process.platform !== "win32") {
    await assert.rejects(assertSafeDshStateRoot(insecure), /permissions must be 0700/);
  }
});

test("credential references and required safety environment fail closed without revealing values", () => {
  const reference = { kind: "environment" as const, variable: "GATHERTHREAD_DSH_TOKEN" };
  const secret = "gta_01234567890123456789012345678901";
  assert.equal(resolveCredentialReference(reference, { GATHERTHREAD_DSH_TOKEN: secret }), secret);
  assert.throws(
    () => resolveCredentialReference(reference, { GATHERTHREAD_DSH_TOKEN: `${secret}\nleak` }),
    (error: unknown) => error instanceof Error && !error.message.includes(secret),
  );
  assert.doesNotThrow(() => assertSafeDshEnvironment({
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PERMISSION_MODE: "read-only",
  }));
  assert.throws(
    () => assertSafeDshEnvironment({ DSH_PERMISSION_MODE: "read-only" }),
    /telemetry must be disabled/,
  );
  assert.throws(
    () => assertSafeDshEnvironment({ DSH_TELEMETRY_MODE: "DISABLED" }),
    /must be read-only/,
  );
});
