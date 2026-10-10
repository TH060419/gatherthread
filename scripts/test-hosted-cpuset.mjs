// Linux-only CI smoke. Real Docker/harness execution, exclusively local model/npm fixtures.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refusal = () => new Error("Hosted cpuset smoke requires a canonical allowed Linux CPU and an immutable image ID");

export function firstAllowedCpu(status, platform = process.platform) {
  if (platform !== "linux" || typeof status !== "string" || status.length > 65_536) throw refusal();
  const lines = status.split("\n").filter((line) => line.startsWith("Cpus_allowed_list:"));
  if (lines.length !== 1) throw refusal();
  const match = /^Cpus_allowed_list:[\t ]+([0-9,-]+)$/u.exec(lines[0]);
  if (!match || match[0] !== lines[0]) throw refusal();
  let last = -1;
  let first;
  for (const part of match[1].split(",")) {
    const range = /^(0|[1-9][0-9]{0,3})(?:-(0|[1-9][0-9]{0,3}))?$/u.exec(part);
    if (!range || range[0] !== part) throw refusal();
    const start = Number(range[1]), end = Number(range[2] ?? range[1]);
    if (start <= last || end > 4095 || start > end || (range[2] !== undefined && start === end)) throw refusal();
    first ??= start;
    last = end;
  }
  if (first === undefined) throw refusal();
  return String(first);
}

export function cpusetSmokeEnvironment(image, cpu, home, environment = process.env, memoryPolicy = "limited") {
  if (typeof image !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(image) || image.length !== 71
    || !/^(0|[1-9][0-9]{0,3})$/u.test(cpu) || String(Number(cpu)) !== cpu || Number(cpu) > 4095
    || !["limited", "shared-host"].includes(memoryPolicy)) throw refusal();
  return { PATH: environment.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, CI: "true",
    DOCKER_HOST: "unix:///var/run/docker.sock", GATHERTHREAD_TEST_HOSTED_IMAGE: image,
    GATHERTHREAD_HOSTED_AGENT_CPUSET: cpu, GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB: "512",
    GATHERTHREAD_HOSTED_GITHUB_MEMORY_MIB: "768",
    ...(memoryPolicy === "shared-host" ? { GATHERTHREAD_HOSTED_AGENT_MEMORY_POLICY: memoryPolicy } : {}) };
}

export function runCpusetSmoke({ image, status, platform = process.platform, environment = process.env,
  execute = spawnSync, directory = root, memoryPolicy = "limited" }) {
  const cpu = firstAllowedCpu(status, platform);
  const privateDirectory = mkdtempSync(join(tmpdir(), "gt-cpuset-ci-"));
  try {
    const home = join(privateDirectory, "home"); mkdirSync(home, { mode: 0o700 });
    const env = cpusetSmokeEnvironment(image, cpu, home, environment, memoryPolicy);
    for (const script of ["test-hosted-container.mjs", "test-hosted-repository-container.mjs"]) {
      const result = execute(process.execPath, [join(directory, "scripts", script)], {
        // Allow setup, the unchanged 90s fixture run, bounded diagnostics and
        // confirmed-exit cleanup to finish without killing its finally block.
        cwd: directory, env, stdio: "inherit", timeout: 180_000,
      });
      if (result.error || result.status !== 0 || result.signal) throw new Error("Hosted cpuset smoke failed; image must not be delivered");
    }
    return memoryPolicy === "shared-host" ? { image_id: image, cpu, memory_policy: memoryPolicy, trial: "passed", repository: "passed" }
      : { image_id: image, cpu, trial_memory_mib: 512, repository_memory_mib: 768, trial: "passed", repository: "passed" };
  } finally { rmSync(privateDirectory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const shared = process.argv[2] === "--shared-host";
    const args = process.argv.slice(shared ? 3 : 2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--report")) throw refusal();
    const report = runCpusetSmoke({ image: process.env.GATHERTHREAD_TEST_HOSTED_IMAGE,
      memoryPolicy: shared ? "shared-host" : "limited",
      status: process.platform === "linux" ? readFileSync("/proc/self/status", "utf8") : "" });
    if (args.length === 2) writeFileSync(args[1], JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(`Guarded ${shared ? "shared-host memory " : ""}cpuset trial/repository smoke passed on allowed CPU ${report.cpu}; no real provider calls.\n`);
  } catch {
    process.stderr.write("Hosted cpuset smoke refused or failed; no delivery authorized.\n");
    process.exitCode = 1;
  }
}
