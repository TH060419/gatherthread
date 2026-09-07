import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const deploymentRoot = new URL("../../deploy/oracle-free/", import.meta.url);

async function deploymentFile(name) {
  return readFile(new URL(name, deploymentRoot), "utf8");
}

test("Oracle deployment shell entrypoints parse as Bash", () => {
  for (const path of ["deploy/oracle-free/install.sh", "deploy/oracle-free/preflight.sh"]) {
    const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});

test("Oracle installer requires an explicit public-ingress acknowledgement", async () => {
  const installer = await deploymentFile("install.sh");
  assert.match(installer, /--acknowledge-experimental-public-ingress/);
  assert.match(installer, /Refusing public ingress/);
  assert.match(installer, /GATHERTHREAD_SERVER_HOST=127\.0\.0\.1/);
  assert.match(installer, /GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true/);
  assert.match(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=false/);
  assert.doesNotMatch(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=true/);
});

test("Oracle reverse proxy and service retain the loopback security boundary", async () => {
  const caddyfile = await deploymentFile("Caddyfile.in");
  const service = await deploymentFile("gatherthread.service.in");
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:8787/);
  assert.doesNotMatch(caddyfile, /reverse_proxy 0\.0\.0\.0/);
  assert.match(service, /^User=gatherthread$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/gatherthread$/m);
});
