import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DSH_INSTALL_COMMAND,
  DSH_NPM_VERSION,
  DSH_PINNED_START_COMMAND,
  DSH_START_COMMAND,
  DSH_VERSION_COMMAND,
} from "../../apps/web/src/dsh.js";

// This is a cross-layer install contract, not a simulation of DSH's loader.
// Actual upstream preflight/startup still needs the fixed-version native gate.
const verifiedDefaultRuntime = "0.2.1-rc.2";
const supportedDefaultRange = `>=${verifiedDefaultRuntime} <0.3.0`;
const dshPackage = "@deepseek-ai/dsh";
const packageRoot = new URL("../../packages/dsh-host/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));

test("DSH Web installation and repair use the default plugin layer's verified runtime", () => {
  assert.equal(manifest.engines.dsh, supportedDefaultRange);
  assert.equal(DSH_NPM_VERSION, verifiedDefaultRuntime,
    "Web must not install a 0.2.x plugin using the frozen 0.1.x runtime");
  assert.equal(DSH_START_COMMAND, `npx ${dshPackage}@${verifiedDefaultRuntime} web`);
  assert.equal(DSH_PINNED_START_COMMAND, DSH_START_COMMAND);
  assert.equal(DSH_INSTALL_COMMAND,
    `npx ${dshPackage}@${verifiedDefaultRuntime} plugin --profile web add "/absolute/path/to/LOCAL_DSH_PLUGIN.tgz"`);
});

test("DSH bundle metadata agrees with the Web's default runtime and profile", async () => {
  const bundle = JSON.parse(await readFile(new URL("bundle/manifest.json", packageRoot), "utf8"));
  assert.equal(bundle.deepseekHarness.primary.version, DSH_NPM_VERSION);
  assert.equal(bundle.deepseekHarness.primary.profile, "web");
  assert.equal(bundle.defaultEnabled, false);
  assert.deepEqual(bundle.runtimeDependencies, []);
});

test("DSH console version check inspects the same pinned runtime as installation", () => {
  assert.equal(DSH_VERSION_COMMAND, `npx ${dshPackage}@${verifiedDefaultRuntime} --version`,
    "An unpinned npx version check can report a different runtime than the install command");
});

test("DSH has an optional peer preflight guard as well as its newer engines guard", () => {
  assert.equal(manifest.peerDependencies?.[dshPackage], supportedDefaultRange,
    "Older DSH ignores engines.dsh; the optional peer range must reject the incompatible current layer");
  assert.equal(manifest.peerDependencies?.[dshPackage], manifest.engines.dsh);
  assert.deepEqual(manifest.peerDependenciesMeta?.[dshPackage], { optional: true },
    "The guard must not install a DSH runtime into the user's profile");
});

test("installing the opt-in plugin does not auto-install a DSH runtime", () => {
  for (const field of ["dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
    const dependencies = manifest[field] ?? {};
    assert.equal(Array.isArray(dependencies) ? dependencies.includes(dshPackage) : Object.hasOwn(dependencies, dshPackage),
      false, `${field} must not make DSH an automatic install side effect`);
  }
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
});

test("default and frozen legacy layers retain distinct explicit trust-service wiring", async () => {
  const current = await readFile(new URL("cordis.patch.yml", packageRoot), "utf8");
  const legacy = await readFile(new URL("cordis.patch.dsh-0.1.yml", packageRoot), "utf8");
  const connectionInjection = (patch) => {
    const match = /^- id: connection\r?\n\s+inject: \[([^\]]+)\]/mu.exec(patch);
    assert.ok(match, "The Connection row must retain an explicit dependency list");
    return match[1].split(",").map((name) => name.trim());
  };
  assert.deepEqual(connectionInjection(current), ["webStartup", "credentials", "webServer"]);
  assert.deepEqual(connectionInjection(legacy), ["webRuntime", "credentials", "webServer"]);
  assert.equal(manifest.exports["./cordis.patch.yml"].default, "./cordis.patch.yml");
  assert.equal(manifest.exports["./cordis.patch.dsh-0.1.yml"].default, "./cordis.patch.dsh-0.1.yml");
  assert.ok(manifest.files.includes("cordis.patch.yml"));
  assert.ok(manifest.files.includes("cordis.patch.dsh-0.1.yml"));
});
