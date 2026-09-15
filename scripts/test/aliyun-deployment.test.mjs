import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const deploymentRoot = new URL("../../deploy/aliyun-ecs/", import.meta.url);

async function deploymentFile(name) {
  return readFile(new URL(name, deploymentRoot), "utf8");
}

test("Alibaba Cloud ECS deployment shell entrypoints parse as Bash", () => {
  for (const path of [
    "deploy/aliyun-ecs/install.sh",
    "deploy/aliyun-ecs/preflight.sh",
    "deploy/aliyun-ecs/create-owner.sh",
  ]) {
    const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});

test("Alibaba installer requires private Alpha and mainland ICP acknowledgements", async () => {
  const installer = await deploymentFile("install.sh");
  assert.match(installer, /--acknowledge-private-alpha/);
  assert.match(installer, /--acknowledge-mainland-icp-ready/);
  assert.match(installer, /Refusing public ingress/);
  assert.match(installer, /Refusing mainland-China public deployment/);
});

test("Alibaba reverse proxy and service retain the loopback security boundary", async () => {
  const installer = await deploymentFile("install.sh");
  const caddyfile = await deploymentFile("Caddyfile.in");
  const service = await deploymentFile("gatherthread.service.in");
  assert.match(installer, /GATHERTHREAD_SERVER_HOST=127\.0\.0\.1/);
  assert.match(installer, /GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true/);
  assert.match(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=false/);
  assert.doesNotMatch(installer, /GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=true/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:8787/);
  assert.match(caddyfile, /health_uri \/health\/ready/);
  assert.doesNotMatch(caddyfile, /reverse_proxy 0\.0\.0\.0/);
  assert.match(service, /^User=gatherthread$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/gatherthread$/m);
});

test("Alibaba preflight checks the active candidate and storage readiness", async () => {
  const preflight = await deploymentFile("preflight.sh");
  assert.match(preflight, /0\.1\.0-alpha\.5/);
  assert.match(preflight, /\/health\/live/);
  assert.match(preflight, /\/health\/ready/);
  assert.match(preflight, /foreign_keys/);
  assert.match(preflight, /writable/);
  assert.match(preflight, /PRAGMA integrity_check/);
});
