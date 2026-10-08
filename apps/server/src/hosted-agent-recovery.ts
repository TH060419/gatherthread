import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Pin all runner operations to one local daemon without inheriting provider secrets. */
export function hostedDockerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (["DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG"]
    .some((name) => environment[name])) {
    throw new Error("Cloud Agent Docker contexts, TLS and custom client configuration are unsupported");
  }
  const host = environment.DOCKER_HOST || "unix:///var/run/docker.sock";
  if (!/^unix:\/\/\/[^\u0000-\u0020\u007f?#]+$/u.test(host) || host.endsWith("/")) {
    throw new Error("Cloud Agent DOCKER_HOST must select an absolute local Unix socket");
  }
  return { PATH: environment.PATH ?? "/usr/bin:/bin", HOME: environment.HOME ?? "/", DOCKER_HOST: host };
}

/** Never load the service account's Docker proxies, credentials or contexts. */
export function createHostedDockerClient(): { environment: NodeJS.ProcessEnv; close: () => void } {
  const environment = hostedDockerEnvironment();
  const directory = mkdtempSync(join(tmpdir(), "gt-docker-client-"));
  return { environment: { ...environment, DOCKER_CONFIG: directory },
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

type Docker = (args: string[]) => { status: number | null; stdout: string };
const executorName = /^(?:gt-hosted-[a-f0-9]{16}|gt-repository-(?:[a-f0-9]{20}|[a-f0-9]{32}))$/u;
export class HostedExecutorCleanupError extends Error {
  constructor() { super("Cannot confirm Cloud Agent container exit"); }
}
export function runHostedDockerCommand(args: string[], timeoutMs = 10_000): ReturnType<Docker> {
  const client = createHostedDockerClient();
  try {
    const result = spawnSync("docker", args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 64_000,
      stdio: ["ignore", "pipe", "ignore"], env: client.environment });
    return { status: result.status, stdout: result.stdout ?? "" };
  } finally { client.close(); }
}

export function stopHostedContainer(name: string, docker: Docker = runHostedDockerCommand): void {
  try {
    if (!executorName.test(name)) throw new HostedExecutorCleanupError();
    const present = () => {
      const result = docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
      if (result.status !== 0) throw new HostedExecutorCleanupError();
      return result.stdout.split(/\r?\n/u).includes(name);
    };
    if (present() && docker(["rm", "-f", name]).status !== 0) throw new HostedExecutorCleanupError();
    if (present()) throw new HostedExecutorCleanupError();
  } catch {
    // A client/config/filesystem failure also leaves container exit unknown.
    // Preserve the capacity reservation and do not expose private diagnostics.
    throw new HostedExecutorCleanupError();
  }
}

/** Always attempt private-resource cleanup without masking unknown executor exit. */
export async function cleanupHostedExecution(stop: () => void,
  resources: Array<() => void | Promise<void>>): Promise<void> {
  let exitError: HostedExecutorCleanupError | undefined;
  let resourceError: unknown;
  try { stop(); } catch { exitError = new HostedExecutorCleanupError(); }
  for (const cleanup of resources) {
    try { await cleanup(); } catch (error) { resourceError ??= error; }
  }
  if (exitError) throw exitError;
  if (resourceError) throw resourceError;
}

/** The operator guide requires one active server and a dedicated Docker host.
 * Recover by name, including executors whose account/task rows were deleted.
 * A failed cleanup must never release their database capacity reservations. */
export function stopInterruptedHostedContainers(docker: Docker = runHostedDockerCommand): void {
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
