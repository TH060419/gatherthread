import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkHostedResources, expectedHostedResources, hostedCgroupDirectory, verifyHostedResources } from "../../ops/hosted-agent/resource-check.mjs";

const environment = { GT_HOSTED_CPUSET: "1", GT_HOSTED_MEMORY_BYTES: "536870912", GT_HOSTED_PIDS: "128" };
const expected = expectedHostedResources(environment);
const actual = { cpus: "1\n", memory: "536870912\n", swap: "0\n", pids: "128\n" };
const mount = (root = "/", point = "/sys/fs/cgroup", mode = "ro") =>
  `29 23 0:26 ${root} ${point} ${mode},nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n`;
const error = { message: "hosted_resource_controls_unavailable" };

test("guard expectations are bounded canonical trusted values with no flexible CPU lists", () => {
  assert.deepEqual(expected, { cpu: "1", memoryBytes: 536870912, pids: 128 });
  for (const cpu of [undefined, "", "01", "0,1", "0-1", "1\n", "1\r\n", "4096"]) {
    assert.throws(() => expectedHostedResources({ ...environment, GT_HOSTED_CPUSET: cpu }), error);
  }
  for (const memory of [undefined, "max", "0", "536870913", "805306369", "9007199254740992", "536870912\n", "536870912\r\n"]) {
    assert.throws(() => expectedHostedResources({ ...environment, GT_HOSTED_MEMORY_BYTES: memory }), error);
  }
  for (const pids of [undefined, "0", "129", "256\n", "max"]) {
    assert.throws(() => expectedHostedResources({ ...environment, GT_HOSTED_PIDS: pids }), error);
  }
  assert.equal(expectedHostedResources({ ...environment, GT_HOSTED_MEMORY_BYTES: "2147483648", GT_HOSTED_PIDS: "256" }).pids, 256);
});

test("shared-host memory requires an explicit policy and retains CPU and PID enforcement", () => {
  const sharedEnvironment = { GT_HOSTED_CPUSET: "1", GT_HOSTED_PIDS: "128",
    GT_HOSTED_MEMORY_POLICY: "shared-host" };
  const shared = expectedHostedResources(sharedEnvironment);
  assert.deepEqual(shared, { cpu: "1", memoryPolicy: "shared-host", pids: 128 });
  const sharedActual = { cpus: "1\n", memory: "max\n", high: "max\n", swap: "max\n", pids: "128\n" };
  assert.doesNotThrow(() => verifyHostedResources(sharedActual, shared));
  assert.throws(() => verifyHostedResources(sharedActual, expected), error);
  for (const policy of ["", "shared", "unlimited", "shared-host\n", "SHARED-HOST"]) {
    assert.throws(() => expectedHostedResources({ ...sharedEnvironment, GT_HOSTED_MEMORY_POLICY: policy }), error);
  }
  assert.throws(() => expectedHostedResources({ ...sharedEnvironment, GT_HOSTED_MEMORY_BYTES: "536870912" }), error);
  for (const change of [{ cpus: "0-1" }, { pids: "max" }, { pids: "129" }, { memory: undefined },
    { swap: undefined }, { high: undefined }, { high: "536870912" }, { memory: "536870912" }, { swap: "0" }]) {
    assert.throws(() => verifyHostedResources({ ...sharedActual, ...change }, shared), error);
  }
  const fixture = fixtureRead({ "/sys/fs/cgroup/container.scope/memory.max": "max\n",
    "/sys/fs/cgroup/container.scope/memory.high": "max\n",
    "/sys/fs/cgroup/container.scope/memory.swap.max": "max\n" });
  assert.doesNotThrow(() => checkHostedResources(sharedEnvironment, fixture.read));
});

test("guard reads exactly the process's unified cgroup, including a namespaced container root", () => {
  assert.equal(hostedCgroupDirectory("0::/\n", mount()), "/sys/fs/cgroup");
  assert.equal(hostedCgroupDirectory("0::/user.slice/user-108.slice/container.scope\n", mount()),
    "/sys/fs/cgroup/user.slice/user-108.slice/container.scope");
  assert.equal(hostedCgroupDirectory("0::/docker/job/child\n", mount("/docker/job")), "/sys/fs/cgroup/child");
  assert.equal(hostedCgroupDirectory("0::/docker/job\n", mount("/docker/job")), "/sys/fs/cgroup");
  for (const cgroup of ["", "1:cpu:/\n", "0::/\n0::/other\n", "0::relative\n", "0::/../private\n",
    "0::/job//child\n", "0::/job/\n", "0::/job\\040x\n", "0::/ \n", "0::/\n\n"]) {
    assert.throws(() => hostedCgroupDirectory(cgroup, mount()), error);
  }
  for (const mountinfo of ["", mount("/other"), mount("/", "/somewhere-else"), mount("/", "/sys/fs/cgroup", "rw"),
    mount() + mount(), mount().replace("cgroup2", "cgroup"), mount("/../escape")]) {
    assert.throws(() => hostedCgroupDirectory("0::/docker/job\n", mountinfo), error);
  }
  assert.throws(() => hostedCgroupDirectory("0::/\n", mount("/docker/job")), error);
});

test("missing, malformed, wider or unbounded controls fail before harness execution", () => {
  assert.doesNotThrow(() => verifyHostedResources(actual, expected));
  assert.doesNotThrow(() => verifyHostedResources({ ...actual, memory: "268435456", pids: "64" }, expected));
  for (const cpus of [undefined, "", "0", "0-1", "1,2", "01", "1\n2"]) {
    assert.throws(() => verifyHostedResources({ ...actual, cpus }, expected), error);
  }
  for (const memory of [undefined, "max", "0", "536870913", "1e8", "-1", "1\n2", "9007199254740992"]) {
    assert.throws(() => verifyHostedResources({ ...actual, memory }, expected), error);
  }
  for (const swap of [undefined, "max", "1", "00", "-1"]) {
    assert.throws(() => verifyHostedResources({ ...actual, swap }, expected), error);
  }
  for (const pids of [undefined, "max", "0", "129", "1e2", "-1"]) {
    assert.throws(() => verifyHostedResources({ ...actual, pids }, expected), error);
  }
});

function fixtureRead(overrides = {}) {
  const fixtures = { "/proc/self/cgroup": "0::/container.scope\n", "/proc/self/mountinfo": mount(),
    "/sys/fs/cgroup/container.scope/cpuset.cpus.effective": actual.cpus,
    "/sys/fs/cgroup/container.scope/memory.max": actual.memory,
    "/sys/fs/cgroup/container.scope/memory.swap.max": actual.swap,
    "/sys/fs/cgroup/container.scope/pids.max": actual.pids, ...overrides };
  const paths = [];
  return { paths, read: (path) => { paths.push(path); if (!(path in fixtures)) throw new Error("fixture private content"); return fixtures[path]; } };
}

test("runtime guard cannot accept unrelated root controls or a moving membership; failures disclose nothing", () => {
  const fixture = fixtureRead();
  checkHostedResources(environment, fixture.read);
  assert.deepEqual(fixture.paths, ["/proc/self/cgroup", "/proc/self/mountinfo",
    ...["cpuset.cpus.effective", "memory.max", "memory.swap.max", "pids.max"].map((name) => `/sys/fs/cgroup/container.scope/${name}`),
    "/proc/self/cgroup"]);
  const missing = fixtureRead({ "/sys/fs/cgroup/container.scope/memory.max": undefined });
  assert.throws(() => checkHostedResources(environment, missing.read), error);
  assert.throws(() => checkHostedResources(environment, () => { throw new Error("secret file and host path"); }), error);
  let memberships = 0;
  assert.throws(() => checkHostedResources(environment, (path, bound) => path === "/proc/self/cgroup" && ++memberships === 2
    ? "0::/another.scope\n" : fixture.read(path, bound)), error);
  // The executable guard exits before importing the real entrypoint when its required expectations are absent.
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../../ops/hosted-agent/cpuset-entrypoint.mjs", import.meta.url))],
    { env: {}, encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "hosted_resource_controls_unavailable\n");
});
