export type HostedMemoryPolicy = "limited" | "shared-host";

/** Shared-host is an administrator opt-in, never inferred from a missing limit. */
export function parseHostedMemoryPolicy(value: string | undefined): HostedMemoryPolicy {
  if (value === undefined || value === "limited") return "limited";
  if (value === "shared-host") return value;
  throw new Error("Cloud Agent memory policy must be limited or shared-host");
}

export function validateHostedMemoryPolicy(value: HostedMemoryPolicy | undefined, maxConcurrent: number,
  cpuSet?: string): void {
  if (parseHostedMemoryPolicy(value) === "shared-host") {
    if (maxConcurrent !== 1) throw new Error("Cloud Agent shared-host memory requires maxConcurrent to be 1");
    if (cpuSet === undefined) throw new Error("Cloud Agent shared-host memory requires a guarded CPU set");
  }
}

export function hostedContainerMemoryArguments(memoryMiB: number, value: HostedMemoryPolicy | undefined): string[] {
  if (parseHostedMemoryPolicy(value) === "shared-host") return [];
  const memory = `${memoryMiB}m`;
  return ["--memory", memory, "--memory-swap", memory];
}
