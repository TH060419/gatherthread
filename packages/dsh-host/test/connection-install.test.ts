import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDshConnectionPlan,
  DSH_CONNECTION_MANIFEST,
  DSH_CONNECTION_OWNER,
  DSH_CONNECTION_PATCH,
  dshLaunchSpec,
  inspectDshConnection,
  installDshConnection,
  removeDshConnection,
  resolveDshConnectionId,
  restoreDshConnection,
} from "../src/connection-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

async function fixture(profile: "web" | "headless" = "web") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-install-")));
  const dshHome = path.join(root, "dsh-home");
  const workspacePath = path.join(root, "workspace");
  const profileDirectory = path.join(dshHome, "profiles", profile);
  const dshSource = path.join(root, "pinned-dsh-source");
  const fakeTsx = path.join(dshSource, "node_modules", "tsx");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(fakeTsx, { recursive: true, mode: 0o700 });
  await chmod(dshHome, 0o700);
  await chmod(path.join(dshHome, "profiles"), 0o700);
  await chmod(profileDirectory, 0o700);
  const profileManifest = "{\"name\":\"private-profile-fixture\"}\n";
  const profilePatch = "# existing user plugin\n- insert: []\n";
  await writeFile(path.join(profileDirectory, "package.json"), profileManifest, { mode: 0o600 });
  await writeFile(path.join(profileDirectory, "cordis.patch.yml"), profilePatch, { mode: 0o600 });
  await writeFile(path.join(dshSource, "package.json"), "{\"private\":true}\n", { mode: 0o600 });
  await writeFile(path.join(fakeTsx, "package.json"), JSON.stringify({
    name: "tsx",
    type: "module",
    exports: { "./esm": "./esm.mjs" },
  }), { mode: 0o600 });
  await writeFile(path.join(fakeTsx, "esm.mjs"), "export {};\n", { mode: 0o600 });
  const plan = createDshConnectionPlan({
    dshSource,
    dshHome,
    packageRoot,
    profile,
    apiUrl: "https://gatherthread.example/v1",
    projectId: "project-1",
    projectName: "Project One",
    deviceId: "device-1",
    workspacePath,
    provider: "deepseek-official",
    model: "DeepSeek-CustomCase",
    shareToolEvents: true,
  });
  return { root, dshHome, workspacePath, profileDirectory, profileManifest, profilePatch, plan };
}

test("connection plan is deterministic, credential-free, and preserves model spelling", async () => {
  const { plan } = await fixture();
  const again = createDshConnectionPlan({
    dshSource: plan.dshSource,
    dshHome: plan.dshHome,
    packageRoot: plan.packageRoot,
    profile: "web",
    apiUrl: plan.manifest.binding.apiUrl,
    projectId: plan.manifest.binding.projectId,
    projectName: plan.manifest.binding.projectName,
    deviceId: plan.manifest.binding.deviceId,
    workspacePath: plan.manifest.binding.workspacePath,
    provider: plan.manifest.binding.provider,
    model: plan.manifest.binding.model,
    shareToolEvents: true,
  });
  assert.equal(again.connectionId, plan.connectionId);
  assert.equal(again.patch, plan.patch);
  assert.equal(plan.manifest.owner, DSH_CONNECTION_OWNER);
  assert.equal(plan.manifest.binding.model, "DeepSeek-CustomCase");
  assert.match(plan.patch, /bindingMode: project/);
  assert.match(plan.patch, /inject: \[agents, sessions, sessionPersistence, llm, connection\]/);
  assert.match(plan.patch, /variable: GATHERTHREAD_DSH_TOKEN/);
  assert.doesNotMatch(plan.patch, /Bearer |authorization|gta_/i);
  assert.doesNotMatch(JSON.stringify(plan.manifest), /Bearer |authorization|gta_/i);
  assert.throws(
    () => createDshConnectionPlan({
      ...again.manifest.binding,
      dshSource: plan.dshSource,
      dshHome: plan.dshHome,
      packageRoot: plan.packageRoot,
      profile: "custom" as "web",
    }),
    /profile must be web or headless/,
  );
});

test("owned overlay installs idempotently without changing profile files, then removes and restores", async () => {
  const { plan, profileDirectory, profileManifest, profilePatch } = await fixture();
  assert.equal((await installDshConnection(plan)).status, "installed");
  assert.equal((await installDshConnection(plan)).status, "already_installed");
  assert.equal(await readFile(path.join(profileDirectory, "package.json"), "utf8"), profileManifest);
  assert.equal(await readFile(path.join(profileDirectory, "cordis.patch.yml"), "utf8"), profilePatch);
  assert.equal(await resolveDshConnectionId(plan.dshHome), plan.connectionId);
  const installed = await inspectDshConnection(plan.dshHome, plan.connectionId);
  assert.equal(installed.status, "installed");
  assert.deepEqual(installed.manifest, plan.manifest);
  assert.equal(await readFile(
    path.join(plan.connectionDirectory, DSH_CONNECTION_PATCH),
    "utf8",
  ), plan.patch);
  if (process.platform !== "win32") {
    assert.equal((await stat(plan.connectionDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(plan.stateRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(plan.connectionDirectory, DSH_CONNECTION_MANIFEST))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(plan.connectionDirectory, DSH_CONNECTION_PATCH))).mode & 0o777, 0o600);
  }

  assert.equal(await removeDshConnection(plan.dshHome, plan.connectionId), "removed");
  assert.equal(await removeDshConnection(plan.dshHome, plan.connectionId), "already_removed");
  assert.equal((await inspectDshConnection(plan.dshHome, plan.connectionId)).status, "removed");
  assert.equal(await restoreDshConnection(plan.dshHome, plan.connectionId), "restored");
  assert.equal(await restoreDshConnection(plan.dshHome, plan.connectionId), "already_installed");
  assert.equal((await inspectDshConnection(plan.dshHome, plan.connectionId)).status, "installed");
});

test("headless overlay disables only the stock one-shot rows", async () => {
  const { plan } = await fixture("headless");
  assert.match(plan.patch, /id: headless-startup\n  disabled: true/);
  assert.match(plan.patch, /id: headless-runner\n  disabled: true/);
  assert.doesNotMatch(plan.patch, /, connection\]/);
});

test("launch spec contains no credential and targets only the owned overlay", async () => {
  const { plan } = await fixture();
  const secret = "gta_fixture_must_never_be_argv";
  const spec = dshLaunchSpec(plan, 0);
  const encoded = JSON.stringify(spec);
  assert.doesNotMatch(encoded, new RegExp(secret));
  assert.ok(spec.args.includes("--profile"));
  assert.ok(spec.args.includes("web"));
  assert.ok(spec.args.includes("--patch"));
  assert.ok(spec.args.includes(path.join(plan.connectionDirectory, DSH_CONNECTION_PATCH)));
  assert.deepEqual(spec.args.slice(-5), ["--host", "127.0.0.1", "--no-open", "--port", "0"]);
});

test("foreign, tampered, and symlink-replaced artifacts fail closed", async () => {
  const first = await fixture();
  await mkdir(first.plan.managedRoot, { mode: 0o700 });
  await mkdir(path.dirname(first.plan.connectionDirectory), { mode: 0o700 });
  await mkdir(path.dirname(first.plan.removedDirectory), { mode: 0o700 });
  await mkdir(first.plan.connectionDirectory, { recursive: true, mode: 0o700 });
  await assert.rejects(
    removeDshConnection(first.dshHome, first.plan.connectionId),
    /manifest|owned/,
  );

  const second = await fixture();
  await installDshConnection(second.plan);
  await writeFile(
    path.join(second.plan.connectionDirectory, DSH_CONNECTION_PATCH),
    `${second.plan.patch}# tampered\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    inspectDshConnection(second.dshHome, second.plan.connectionId),
    /digest does not match/,
  );

  const third = await fixture();
  const redirected = path.join(third.root, "redirected-managed-root");
  await mkdir(redirected, { mode: 0o700 });
  await symlink(redirected, path.join(third.dshHome, "gatherthread"), "dir");
  await assert.rejects(
    installDshConnection(third.plan),
    /symbolic-link ancestor|must be a real directory/,
  );
});

test("installation refuses a missing profile and exact owner permission drift", async () => {
  const missing = await fixture();
  const absentPlan = createDshConnectionPlan({
    ...missing.plan.manifest.binding,
    dshSource: missing.plan.dshSource,
    dshHome: missing.plan.dshHome,
    packageRoot: missing.plan.packageRoot,
    profile: "headless",
  });
  await assert.rejects(installDshConnection(absentPlan), /profile is not initialized/);

  if (process.platform === "win32") return;
  const insecure = await fixture();
  await mkdir(insecure.plan.managedRoot, { mode: 0o700 });
  await chmod(insecure.plan.managedRoot, 0o750);
  await assert.rejects(installDshConnection(insecure.plan), /permissions must be 0700/);
});
