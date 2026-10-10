import { closeSync, openSync, readSync } from "node:fs";

const failure = () => new Error("hosted_resource_controls_unavailable");
const canonicalCpu = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]{0,3})$/u.test(value)
  && Number(value) <= 4095 && String(Number(value)) === value;
const positiveInteger = (value) => typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value)
  && Number.isSafeInteger(Number(value)) && String(Number(value)) === value;

export function expectedHostedResources(environment) {
  const cpu = environment.GT_HOSTED_CPUSET;
  const memory = environment.GT_HOSTED_MEMORY_BYTES;
  const pids = environment.GT_HOSTED_PIDS;
  if (!canonicalCpu(cpu) || !["128", "256"].includes(pids)) throw failure();
  const policy = environment.GT_HOSTED_MEMORY_POLICY;
  if (policy === "shared-host") {
    if (memory !== undefined) throw failure();
    return { cpu, memoryPolicy: policy, pids: Number(pids) };
  }
  if ((policy !== undefined && policy !== "limited") || !positiveInteger(memory)) throw failure();
  const memoryBytes = Number(memory);
  const maximum = pids === "128" ? 768 : 2048;
  if (memoryBytes < 256 * 1024 * 1024 || memoryBytes > maximum * 1024 * 1024
    || memoryBytes % (1024 * 1024) !== 0) throw failure();
  return { cpu, memoryBytes, pids: Number(pids) };
}

function canonicalPath(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4096
    && !/[\\\u0000-\u0020\u007f]/u.test(value)
    && (value === "/" || !value.endsWith("/") && value.slice(1).split("/").every((part) => part && part !== "." && part !== ".."));
}

/** Resolve this process's unified membership, never a convenient unrelated root. */
export function hostedCgroupDirectory(cgroup, mountinfo) {
  if (typeof cgroup !== "string" || cgroup.length > 16_384 || typeof mountinfo !== "string"
    || mountinfo.length > 262_144) throw failure();
  const rows = (cgroup.endsWith("\n") ? cgroup.slice(0, -1) : cgroup).split("\n");
  if (rows.some((row) => !/^[0-9]+:[^:]*:/u.test(row))) throw failure();
  const memberships = rows.filter((row) => row.startsWith("0::"));
  if (memberships.length !== 1) throw failure();
  const membership = memberships[0].slice(3);
  if (!canonicalPath(membership)) throw failure();
  const mounts = mountinfo.trimEnd().split("\n").map((row) => row.split(" "))
    .filter((fields) => fields[4] === "/sys/fs/cgroup");
  if (mounts.length !== 1) throw failure();
  const fields = mounts[0], separator = fields.indexOf("-");
  const root = fields[3];
  if (separator < 6 || fields[separator + 1] !== "cgroup2" || !canonicalPath(root)
    || !fields[5]?.split(",").includes("ro")) throw failure();
  if (root !== "/" && membership !== root && !membership.startsWith(`${root}/`)) throw failure();
  const relative = root === "/" ? membership : membership.slice(root.length);
  return `/sys/fs/cgroup${relative === "/" ? "" : relative}`;
}

export function verifyHostedResources(actual, expected) {
  const memory = actual.memory?.trim(), swap = actual.swap?.trim(), pids = actual.pids?.trim();
  if (actual.cpus?.trim() !== expected.cpu || !positiveInteger(pids) || Number(pids) > expected.pids) throw failure();
  // Only an explicit host-owned policy accepts unbounded RAM/swap, not missing controllers.
  if (expected.memoryPolicy === "shared-host") {
    if (memory !== "max" || actual.high?.trim() !== "max" || swap !== "max") throw failure();
    return;
  }
  if (!positiveInteger(memory) || Number(memory) > expected.memoryBytes || swap !== "0") throw failure();
}

function boundedRead(path, maximum) {
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maximum) throw failure();
    return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(descriptor); }
}

/** Only fixed proc paths and derived cgroup files are read; no path comes from the environment. */
export function checkHostedResources(environment = process.env, read = boundedRead) {
  try {
    const expected = expectedHostedResources(environment);
    const membership = read("/proc/self/cgroup", 16_384);
    const directory = hostedCgroupDirectory(membership, read("/proc/self/mountinfo", 262_144));
    verifyHostedResources({ cpus: read(`${directory}/cpuset.cpus.effective`, 4096),
      memory: read(`${directory}/memory.max`, 4096), swap: read(`${directory}/memory.swap.max`, 4096),
      ...(expected.memoryPolicy === "shared-host" ? { high: read(`${directory}/memory.high`, 4096) } : {}),
      pids: read(`${directory}/pids.max`, 4096) }, expected);
    if (read("/proc/self/cgroup", 16_384) !== membership) throw failure();
  } catch { throw failure(); }
}
