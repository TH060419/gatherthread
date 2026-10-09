// Public build identity only. Never reads server configuration, credentials or project data.
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const invalid = () => new Error("Hosted image delivery identity is invalid");
const fullMatch = (expression, value) => typeof value === "string" && expression.exec(value)?.[0] === value;
const commitPattern = /^[a-f0-9]{40}$/u;
const imagePattern = /^sha256:[a-f0-9]{64}$/u;
const repository = "TH060419/gatherthread";
const featureRef = "refs/heads/codex/hosted-cpuset-katex-20261010";
export const MAX_IMAGE_BYTES = 2 * 1024 ** 3;
export const MAX_IMAGE_ARCHIVE_BYTES = 1024 ** 3;

export function validateSource(metadata, commit, runtime = { node: process.version, platform: process.platform, arch: process.arch }) {
  if (!fullMatch(commitPattern, commit) || !metadata || Array.isArray(metadata)
    || Object.keys(metadata).sort().join(",") !== "arch,commit,node,platform"
    || metadata.commit !== commit || metadata.node !== "v24.16.0" || metadata.platform !== "linux" || metadata.arch !== "x64"
    || runtime.node !== metadata.node || runtime.platform !== metadata.platform || runtime.arch !== metadata.arch) throw invalid();
  return metadata;
}

export function validateImage(inspection, id) {
  if (!fullMatch(imagePattern, id) || !Array.isArray(inspection) || inspection.length !== 1
    || inspection[0]?.Id !== id || inspection[0]?.Os !== "linux" || inspection[0]?.Architecture !== "amd64"
    || !Number.isSafeInteger(inspection[0]?.Size) || inspection[0].Size <= 0 || inspection[0].Size > MAX_IMAGE_BYTES
    || inspection[0]?.Config?.User !== "10001:10001"
    || JSON.stringify(inspection[0]?.Config?.Entrypoint) !== JSON.stringify(["node", "/usr/local/lib/gatherthread-hosted-entrypoint.mjs"])) throw invalid();
  return { image_id: id, platform: "linux", architecture: "amd64", image_uncompressed_bytes: inspection[0].Size };
}

export function validateWorkflow(workflow) {
  if (!workflow || Object.keys(workflow).sort().join(",") !== "event,ref,repository,run_attempt,run_id,workflow_ref,workflow_sha"
    || workflow.repository !== repository || !fullMatch(commitPattern, workflow.workflow_sha)
    || workflow.workflow_ref !== `${repository}/.github/workflows/test-candidate.yml@${workflow.ref}`
    || !fullMatch(/^[1-9][0-9]*$/u, workflow.run_id) || !fullMatch(/^[1-9][0-9]*$/u, workflow.run_attempt)
    || !((workflow.event === "workflow_dispatch" && workflow.ref === "refs/heads/main")
      || (workflow.event === "push" && workflow.ref === featureRef))) throw invalid();
  return workflow;
}

export function imageProvenance({ source, commit, inspection, image, quota, cpuset, docker, archive, workflow, runtime }) {
  validateSource(source, commit, runtime);
  const identity = validateImage(inspection, image);
  validateWorkflow(workflow);
  if (!quota || Object.keys(quota).sort().join(",") !== "image_id,memory_mib,repository,trial"
    || quota.image_id !== image || quota.memory_mib !== 512 || quota.trial !== "passed" || quota.repository !== "passed"
    || !cpuset || Object.keys(cpuset).sort().join(",") !== "cpu,image_id,memory_mib,repository,trial"
    || cpuset.image_id !== image || !fullMatch(/^(0|[1-9][0-9]{0,3})$/u, cpuset.cpu) || Number(cpuset.cpu) > 4095
    || cpuset.memory_mib !== 512 || cpuset.trial !== "passed" || cpuset.repository !== "passed"
    || !fullMatch(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u, docker?.Client?.Version)
    || !fullMatch(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u, docker?.Server?.Version)
    || !fullMatch(/^[a-f0-9]{64}$/u, archive?.sha256) || !Number.isSafeInteger(archive?.bytes)
    || archive.bytes <= 0 || archive.bytes > MAX_IMAGE_ARCHIVE_BYTES) throw invalid();
  return { source_commit: commit, builder_runtime: { node: source.node, platform: source.platform, architecture: source.arch },
    ...identity, image_archive: "hosted-image.tar.gz", image_archive_sha256: archive.sha256,
    image_archive_bytes: archive.bytes, docker_client_version: docker.Client.Version, docker_server_version: docker.Server.Version,
    smoke: [
      { mode: "quota", kind: "trial", image_id: image, memory_mib: 512, cpus: 1, status: "passed" },
      { mode: "quota", kind: "repository", image_id: image, memory_mib: 512, cpus: 2, status: "passed" },
      { mode: "cpuset", kind: "trial", image_id: image, memory_mib: 512, cpu: cpuset.cpu, status: "passed" },
      { mode: "cpuset", kind: "repository", image_id: image, memory_mib: 512, cpu: cpuset.cpu, status: "passed" },
    ], provider_calls: "local fixtures only", host_aggregate_isolation: "requires independent deployment acceptance",
    reviewed_main: workflow.event === "workflow_dispatch" && workflow.ref === "refs/heads/main", ...workflow };
}

// Stream compressed bytes with a hard CI artifact bound; no complete image is buffered in memory.
export async function writeHostedArchive(input, path, maximum = MAX_IMAGE_ARCHIVE_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAX_IMAGE_ARCHIVE_BYTES) throw invalid();
  const file = await open(path, "wx", 0o600);
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk) || bytes + chunk.length > maximum) throw invalid();
      bytes += chunk.length;
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw invalid();
        offset += bytesWritten;
      }
    }
    if (!bytes) throw invalid();
    await file.sync();
    return { sha256: hash.digest("hex"), bytes };
  } catch (error) {
    await unlink(path); // Only this helper's newly created partial file; never an existing artifact.
    throw error;
  } finally { await file.close(); }
}

function readJson(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(65_537);
    let bytes = 0, read;
    do { read = readSync(descriptor, buffer, bytes, buffer.length - bytes, null); bytes += read; } while (read && bytes < buffer.length);
    if (bytes === buffer.length) throw invalid();
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally { closeSync(descriptor); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, commit, sourcePath, ...args] = process.argv.slice(2);
    if (action === "archive" && args.length === 0) {
      const metadata = await writeHostedArchive(process.stdin, commit);
      writeFileSync(sourcePath, JSON.stringify(metadata) + "\n", { flag: "wx", mode: 0o600 });
    } else if (action === "source" && args.length === 1) {
      validateSource(readJson(sourcePath), commit); validateWorkflow(readJson(args[0]));
    }
    else if (action === "image" && args.length === 2) {
      validateSource(readJson(sourcePath), commit); validateImage(readJson(args[0]), args[1]);
    } else if (action === "provenance" && args.length === 8) {
      const [inspectionPath, image, quotaPath, cpusetPath, dockerPath, archivePath, workflowPath, output] = args;
      const provenance = imageProvenance({ source: readJson(sourcePath), commit, inspection: readJson(inspectionPath),
        image, quota: readJson(quotaPath), cpuset: readJson(cpusetPath), docker: readJson(dockerPath), archive: readJson(archivePath), workflow: readJson(workflowPath) });
      writeFileSync(output, JSON.stringify(provenance, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } else throw invalid();
  } catch { process.stderr.write("Hosted image delivery identity is invalid.\n"); process.exitCode = 1; }
}
