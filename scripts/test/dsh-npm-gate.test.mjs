import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configureStartupFixture, dshExitDiagnosis, startDsh } from "../test-dsh-npm-plugin-real.mjs";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gatherthread-dsh-gate-test-")));
  const dshHome = path.join(root, "dsh-home");
  const directory = path.join(dshHome, "profiles/web");
  const manifest = path.join(directory, "package.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const original = { name: "isolated-test-profile", dsh: { profile: { bundles: ["@gatherthread/dsh-host"], patchReload: "live" } } };
  await writeFile(manifest, JSON.stringify(original), { mode: 0o600 });
  return { root, dshHome, manifest, original, close: () => rm(root, { recursive: true, force: true }) };
}

test("DSH startup fixture is opt-in and preserves the installed profile layer", async () => {
  const f = await fixture();
  try {
    await configureStartupFixture(f.root, f.dshHome, false);
    assert.deepEqual(JSON.parse(await readFile(f.manifest, "utf8")), f.original);
    await configureStartupFixture(f.root, f.dshHome, true);
    assert.deepEqual(JSON.parse(await readFile(f.manifest, "utf8")), {
      ...f.original, dsh: { profile: { ...f.original.dsh.profile, patchReload: "startup" } },
    });
    await assert.rejects(configureStartupFixture(path.dirname(f.root), f.dshHome, true), /temporary home/u);
  } finally { await f.close(); }
});

test("DSH startup fixture refuses a redirected profile manifest", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, "unrelated.json");
    await writeFile(outside, JSON.stringify(f.original), { mode: 0o600 });
    await rm(f.manifest);
    await symlink(outside, f.manifest);
    await assert.rejects(configureStartupFixture(f.root, f.dshHome, true), /redirect/u);
    assert.deepEqual(JSON.parse(await readFile(outside, "utf8")), f.original);
  } finally { await f.close(); }
});

test("DSH exit diagnosis exposes no launch token, credential or raw private path", () => {
  const privateValue = "private-test-value-do-not-print";
  const error = dshExitDiagnosis({ stderr: `user patch-layer watching requires the Cordis HMR service\nhttp://127.0.0.1:12345/?token=${privateValue}\nAuthorization: ${privateValue}\n/private/${privateValue}` }, { code: 1, signal: null });
  assert.match(error.message, /upstream profile hot-reload service/u);
  assert.ok(!error.message.includes(privateValue));
  assert.ok(!error.message.includes("/private/"));
});

test("DSH launch URL alone cannot pass readiness when the child subsequently exits", async () => {
  const f = await fixture();
  let host;
  try {
    const bin = path.join(f.root, "fake-dsh.mjs");
    await writeFile(bin, `process.stdout.write("http://127.0.0.1:1/?token=private-fixture-token\\n");\nsetTimeout(() => { process.stderr.write("user patch-layer watching requires the Cordis HMR service\\n"); process.exit(1); }, 25);\n`, { mode: 0o600 });
    host = startDsh(bin, 1, { PATH: process.env.PATH }, f.root);
    await assert.rejects(host.ready, /upstream profile hot-reload service/u);
    assert.equal((await host.exit).code, 1);
  } finally {
    if (host?.child.exitCode === null) host.child.kill("SIGTERM");
    await host?.exit;
    await f.close();
  }
});
