import { parseHostedMemoryPolicy, type HostedMemoryPolicy } from "./hosted-container-memory.js";

export const HOSTED_CPUSET_ENTRYPOINT = "/usr/local/lib/gatherthread-hosted-cpuset-entrypoint.mjs";

/** Explicit single-core affinity, not a CFS CPU-time quota or an automatic fallback. */
export function parseHostedCpuSet(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]{0,3})$/u.test(input)
    || Number(input) > 4095 || String(Number(input)) !== input) {
    throw new Error("Cloud Agent CPU set must be one canonical CPU index from 0 to 4095");
  }
  return input;
}

export function hostedContainerCpuArguments(kind: "trial" | "repository", cpuSet: string | undefined,
  memoryMiB: number, memoryPolicy?: HostedMemoryPolicy): string[] {
  const policy = parseHostedMemoryPolicy(memoryPolicy);
  const selected = parseHostedCpuSet(cpuSet);
  if (selected === undefined) return ["--cpus", kind === "trial" ? "1" : "2"];
  const maximum = kind === "trial" ? 768 : 2048;
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 256 || memoryMiB > maximum) {
    throw new Error("Cloud Agent guarded container memory is invalid");
  }
  const memoryExpectation = policy === "shared-host" ? ["-e", "GT_HOSTED_MEMORY_POLICY=shared-host"]
    : ["-e", `GT_HOSTED_MEMORY_BYTES=${memoryMiB * 1024 * 1024}`];
  return ["--cpuset-cpus", selected, "--entrypoint", HOSTED_CPUSET_ENTRYPOINT,
    "-e", `GT_HOSTED_CPUSET=${selected}`, ...memoryExpectation,
    "-e", `GT_HOSTED_PIDS=${kind === "trial" ? 128 : 256}`];
}
