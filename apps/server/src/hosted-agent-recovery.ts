import { spawnSync } from "node:child_process";

type Docker = (args: string[]) => { status: number | null; stdout: string };
const executorName = /^(?:gt-hosted-[a-f0-9]{16}|gt-repository-(?:[a-f0-9]{20}|[a-f0-9]{32}))$/u;
export class HostedExecutorCleanupError extends Error {
  constructor() { super("Cannot confirm Cloud Agent container exit"); }
}
const runDockerCommand: Docker = (args) => {
  const result = spawnSync("docker", args, { timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: result.status, stdout: result.stdout ?? "" };
};

export function stopHostedContainer(name: string, docker: Docker = runDockerCommand): void {
  if (!executorName.test(name)) throw new HostedExecutorCleanupError();
  const present = () => {
    const result = docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
    if (result.status !== 0) throw new HostedExecutorCleanupError();
    return result.stdout.split(/\r?\n/u).includes(name);
  };
  if (present() && docker(["rm", "-f", name]).status !== 0) throw new HostedExecutorCleanupError();
  if (present()) throw new HostedExecutorCleanupError();
}

/** The operator guide requires one active server and a dedicated Docker host.
 * Recover by name, including executors whose account/task rows were deleted.
 * A failed cleanup must never release their database capacity reservations. */
export function stopInterruptedHostedContainers(docker: Docker = runDockerCommand): void {
  const names = () => {
    const result = docker(["ps", "-a", "--format", "{{.Names}}"]);
    if (result.status !== 0) throw new Error("Cannot verify interrupted Cloud Agent containers");
    return result.stdout.split(/\r?\n/u).filter((name) => executorName.test(name));
  };
  for (const name of names()) {
    if (docker(["rm", "-f", name]).status !== 0) throw new Error("Cannot stop interrupted Cloud Agent container");
  }
  if (names().length) throw new Error("Interrupted Cloud Agent container is still present");
}
