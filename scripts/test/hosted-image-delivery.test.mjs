import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { firstAllowedCpu, cpusetSmokeEnvironment, runCpusetSmoke } from "../test-hosted-cpuset.mjs";
import { validateSource, validateImage, validateWorkflow, imageProvenance, writeHostedArchive,
  MAX_IMAGE_BYTES, MAX_IMAGE_ARCHIVE_BYTES } from "../test-environment/hosted-image-metadata.mjs";

const commit = "a".repeat(40), image = `sha256:${"b".repeat(64)}`;
const source = { commit, node: "v24.16.0", platform: "linux", arch: "x64" };
const runtime = { node: source.node, platform: source.platform, arch: source.arch };
const inspection = [{ Id: image, Os: "linux", Architecture: "amd64", Size: 1234, Config: { User: "10001:10001",
  Entrypoint: ["node", "/usr/local/lib/gatherthread-hosted-entrypoint.mjs"] } }];
const workflow = { repository: "TH060419/gatherthread", workflow_sha: commit,
  workflow_ref: "TH060419/gatherthread/.github/workflows/test-candidate.yml@refs/heads/main",
  run_id: "123", run_attempt: "1", event: "workflow_dispatch", ref: "refs/heads/main" };
const cpuset = { image_id: image, cpu: "24", trial_memory_mib: 512, repository_memory_mib: 768, trial: "passed", repository: "passed" };
const quota = { image_id: image, trial_memory_mib: 512, repository_memory_mib: 768, trial: "passed", repository: "passed" };
const options = { source, commit, inspection, image, runtime, quota, cpuset, workflow,
  docker: { Client: { Version: "29.0.1" }, Server: { Version: "29.0.1" } },
  archive: { sha256: "c".repeat(64), bytes: 1234 } };
const failure = { message: "Hosted image delivery identity is invalid" };

test("quality quota checks use the same exact trial/repository memory targets as delivery", () => {
  const quality = readFileSync(new URL('../../.github/workflows/quality.yml', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  for (const [script, key, memory] of [
    ['test-hosted-container.mjs', 'GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB', 512],
    ['test-hosted-repository-container.mjs', 'GATHERTHREAD_HOSTED_GITHUB_MEMORY_MIB', 768],
  ]) {
    const step = quality.split(`- run: node scripts/${script}\n`)[1]?.split('\n      - ')[0];
    assert.ok(step, `Missing quota step: ${script}`);
    assert.ok(step.split('\n').some(line => line.trim() === `${key}: ${memory}`), `Wrong quota target: ${script}`);
  }
});

test("CI selects the first actual allowed canonical CPU, never assumes zero", () => {
  assert.equal(firstAllowedCpu("Name:\tnode\nCpus_allowed_list:\t24-27,30,40-63\n", "linux"), "24");
  assert.equal(firstAllowedCpu("Cpus_allowed_list: 0\n", "linux"), "0");
  assert.equal(firstAllowedCpu("Cpus_allowed_list:\t4095\n", "linux"), "4095");
  for (const status of ["", "Cpus_allowed_list:\t\n", "Cpus_allowed_list:\t01\n", "Cpus_allowed_list:\t4096\n",
    "Cpus_allowed_list:\t0-0\n", "Cpus_allowed_list:\t2-1\n", "Cpus_allowed_list:\t1,1\n",
    "Cpus_allowed_list:\t2,0\n", "Cpus_allowed_list:\t1-2,2-3\n", "Cpus_allowed_list:\t1,\n",
    "Cpus_allowed_list:\t1\r\n", "Cpus_allowed_list:\t1\nCpus_allowed_list:\t2\n", "x".repeat(65_537)]) {
    assert.throws(() => firstAllowedCpu(status, "linux"));
  }
  for (const platform of ["darwin", "win32"]) assert.throws(() => firstAllowedCpu("Cpus_allowed_list:\t0\n", platform));
});

test("smoke children share one immutable image with bounded memory and no inherited credential/client state", () => {
  const secretEnvironment = { PATH: process.env.PATH, HOME: "/private-account", DOCKER_CONTEXT: "remote",
    DOCKER_TLS_VERIFY: "1", DOCKER_HOST: "tcp://remote", DOCKER_CONFIG: "/private-config",
    HTTPS_PROXY: "private-proxy", GITHUB_TOKEN: "private-token", OPENAI_API_KEY: "private-key",
    NODE_OPTIONS: "--require=/private-injection", BASH_ENV: "/private-injection" };
  const calls = [];
  const report = runCpusetSmoke({ image, platform: "linux", status: "Cpus_allowed_list:\t24-25\n", environment: secretEnvironment,
    execute: (command, args, settings) => { calls.push({ command, args, settings }); return { status: 0, signal: null }; } });
  assert.equal(calls.length, 2);
  assert.match(calls[0].args[0], /test-hosted-container\.mjs$/u);
  assert.match(calls[1].args[0], /test-hosted-repository-container\.mjs$/u);
  for (const { settings } of calls) {
    assert.equal(settings.env.GATHERTHREAD_TEST_HOSTED_IMAGE, image);
    assert.equal(settings.env.GATHERTHREAD_HOSTED_AGENT_CPUSET, "24");
    assert.equal(settings.env.GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB, "512");
    assert.equal(settings.env.GATHERTHREAD_HOSTED_GITHUB_MEMORY_MIB, "768");
    assert.equal(settings.env.DOCKER_HOST, "unix:///var/run/docker.sock");
    assert.equal(settings.timeout, 180_000);
    assert.ok(!existsSync(settings.env.HOME), "private home is cleaned after fixture execution");
    for (const name of ["DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CONFIG", "HTTPS_PROXY", "GITHUB_TOKEN", "OPENAI_API_KEY", "NODE_OPTIONS", "BASH_ENV"]) {
      assert.equal(settings.env[name], undefined);
    }
  }
  assert.deepEqual(report, cpuset);
  for (const bad of ["latest", "gt-hosted-smoke", image + "\n", `sha256:${"B".repeat(64)}`]) {
    assert.throws(() => cpusetSmokeEnvironment(bad, "24", "/fixture"));
  }
});

test("smoke failure stops the sequence and never returns successful delivery metadata", () => {
  for (const result of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { status: 0, error: new Error("fixture-private-value") }]) {
    let calls = 0;
    assert.throws(() => runCpusetSmoke({ image, platform: "linux", status: "Cpus_allowed_list:\t24\n",
      execute: () => { calls++; return result; } }), { message: "Hosted cpuset smoke failed; image must not be delivered" });
    assert.equal(calls, 1);
  }
});

test("source and image identities require the exact Linux x64 runtime, source commit and nonroot immutable image", () => {
  assert.deepEqual(validateSource(source, commit, runtime), source);
  assert.deepEqual(validateImage(inspection, image), { image_id: image, platform: "linux", architecture: "amd64", image_uncompressed_bytes: 1234 });
  for (const entry of [{ ...source, commit: "d".repeat(40) }, { ...source, node: "v24.15.0" }, { ...source, platform: "darwin" },
    { ...source, arch: "arm64" }, { ...source, credential: "fixture-private-value" }]) assert.throws(() => validateSource(entry, commit, runtime), failure);
  for (const actual of [{ ...runtime, node: "v24.15.0" }, { ...runtime, platform: "darwin" }, { ...runtime, arch: "arm64" }]) {
    assert.throws(() => validateSource(source, commit, actual), failure);
  }
  for (const id of ["latest", image + "\n", `sha256:${"b".repeat(63)}`]) assert.throws(() => validateImage(inspection, id), failure);
  for (const entry of [{ ...inspection[0], Id: `sha256:${"d".repeat(64)}` }, { ...inspection[0], Os: "windows" },
    { ...inspection[0], Architecture: "arm64" }, { ...inspection[0], Size: 0 }, { ...inspection[0], Size: MAX_IMAGE_BYTES + 1 },
    { ...inspection[0], Config: { ...inspection[0].Config, User: "0" } },
    { ...inspection[0], Config: { ...inspection[0].Config, Entrypoint: ["unreviewed"] } }]) assert.throws(() => validateImage([entry], image), failure);
  assert.throws(() => validateImage([...inspection, ...inspection], image), failure);
});

test("public provenance binds every smoke and archive to the same image; arbitrary branch and failed fixtures are refused", () => {
  const provenance = imageProvenance(options);
  assert.equal(provenance.source_commit, commit);
  assert.equal(provenance.image_archive_sha256, options.archive.sha256);
  assert.equal(provenance.reviewed_main, true);
  assert.equal(provenance.smoke.length, 4);
  assert.ok(provenance.smoke.every((smoke) => smoke.image_id === image && smoke.status === "passed"));
  assert.deepEqual(provenance.smoke.map(smoke => smoke.memory_mib), [512, 768, 512, 768]);
  assert.deepEqual(provenance.smoke.map((smoke) => `${smoke.mode}:${smoke.kind}`), ["quota:trial", "quota:repository", "cpuset:trial", "cpuset:repository"]);
  assert.match(provenance.host_aggregate_isolation, /independent deployment acceptance/u);
  assert.equal(JSON.stringify(provenance).includes("fixture-private-value"), false);
  for (const changed of [undefined, { ...quota, image_id: `sha256:${"d".repeat(64)}` }, { ...quota, trial: "failed" },
    { ...quota, repository: "skipped" }, { ...quota, trial_memory_mib: 768 }, { ...quota, repository_memory_mib: 512 },
    { ...quota, repository_memory_mib: 2048 }, { ...quota, memory_mib: 512 }, { ...quota, credential: "fixture-private-value" }]) {
    assert.throws(() => imageProvenance({ ...options, quota: changed }), failure);
  }
  for (const changed of [{ ...cpuset, image_id: `sha256:${"d".repeat(64)}` }, { ...cpuset, trial: "failed" },
    { ...cpuset, repository: "skipped" }, { ...cpuset, cpu: "24-25" }, { ...cpuset, cpu: "24\n" },
    { ...cpuset, trial_memory_mib: 768 }, { ...cpuset, repository_memory_mib: 512 },
    { ...cpuset, repository_memory_mib: 2048 }, { ...cpuset, memory_mib: 512 }, { ...cpuset, token: "fixture-private-value" }]) {
    assert.throws(() => imageProvenance({ ...options, cpuset: changed }), failure);
  }
  for (const changed of [{ ...workflow, ref: "refs/heads/other" }, { ...workflow, event: "pull_request_target" },
    { ...workflow, repository: "other/repository" }, { ...workflow, run_attempt: "0" },
    { ...workflow, workflow_sha: commit + "\n" }, { ...workflow, credential: "fixture-private-value" }]) assert.throws(() => validateWorkflow(changed), failure);
  const ref = "refs/heads/codex/hosted-cpuset-katex-20261010";
  const premerge = { ...workflow, event: "push", ref, workflow_ref: `TH060419/gatherthread/.github/workflows/test-candidate.yml@${ref}` };
  assert.doesNotThrow(() => validateWorkflow(premerge));
  assert.equal(imageProvenance({ ...options, workflow: premerge }).reviewed_main, false);
  for (const archive of [{ sha256: "latest", bytes: 123 }, { sha256: "c".repeat(64), bytes: 0 },
    { sha256: "c".repeat(64), bytes: MAX_IMAGE_ARCHIVE_BYTES + 1 }]) assert.throws(() => imageProvenance({ ...options, archive }), failure);
});

test("archive streaming hashes exact bytes, bounds disk writes and removes only new partial output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-image-archive-test-"));
  const input = async function* (chunks) { for (const chunk of chunks) yield chunk; };
  try {
    const path = join(directory, "archive.tar.gz");
    const chunks = [Buffer.from("first"), Buffer.from("second")];
    const metadata = await writeHostedArchive(input(chunks), path, 11);
    assert.deepEqual(metadata, { bytes: 11, sha256: createHash("sha256").update(Buffer.concat(chunks)).digest("hex") });
    assert.deepEqual(readFileSync(path), Buffer.concat(chunks));
    await assert.rejects(writeHostedArchive(input(chunks), path, 11), { code: "EEXIST" });
    assert.deepEqual(readFileSync(path), Buffer.concat(chunks), "existing archive must not be deleted or replaced");
    for (const chunks of [[], [Buffer.from("first"), Buffer.from("exceeds")], ["not a byte buffer"]]) {
      const rejected = join(directory, "rejected.tar.gz");
      await assert.rejects(writeHostedArchive(input(chunks), rejected, 10), failure);
      assert.ok(!existsSync(rejected));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("metadata CLI invalid input exits generically with no output artifact or private path disclosure", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-image-metadata-test-"));
  try {
    const path = join(directory, "source.json"), output = join(directory, "provenance.json");
    writeFileSync(path, JSON.stringify({ ...source, credential: "fixture-private-value" }));
    const result = spawnSync(process.execPath, ["scripts/test-environment/hosted-image-metadata.mjs", "source", commit, path, output],
      { encoding: "utf8", env: {} });
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Hosted image delivery identity is invalid.\n");
    assert.equal(result.stderr.includes(directory), false);
    assert.ok(!existsSync(output)); assert.ok(readFileSync(path, "utf8").includes("fixture-private-value"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local export helper preserves one-build immutable-image order and has no public upload/deploy operation", () => {
  const script = readFileSync("scripts/test-environment/export-hosted-image.sh", "utf8");
  assert.match(script, /set -euo pipefail/u);
  assert.match(script, /umask 077/u);
  assert.match(script, /mktemp -d \/tmp\/gt-image\./u);
  assert.match(script, /env -i PATH="\$task_path" HOME="\$task_private\/home"/u);
  assert.match(script, /DOCKER_HOST=unix:\/\/\/var\/run\/docker\.sock/u);
  assert.equal((script.match(/docker_client build /gu) ?? []).length, 1);
  assert.match(script, /--platform linux\/amd64 --iidfile/u);
  const quota = script.indexOf("for task_smoke in test-hosted-container.mjs test-hosted-repository-container.mjs");
  const cpuset = script.indexOf('"$task_build/scripts/test-hosted-cpuset.mjs"');
  const save = script.indexOf('docker_client save "$task_image" | gzip -n');
  const provenance = script.indexOf('"$task_metadata" provenance');
  const deliver = script.indexOf('mv "$task_private/$task_file"');
  assert.ok(quota > 0 && quota < cpuset && cpuset < save && save < provenance && provenance < deliver);
  assert.doesNotMatch(script, /docker_client (?:push|login)|curl|sudo|ssh|npm publish|--build-arg|--secret|continue-on-error/u);
  // The shell helper is Linux-only; portable static/metadata tests must not require Bash on Windows.
  if (process.platform !== "win32") {
    const invalid = spawnSync("bash", ["scripts/test-environment/export-hosted-image.sh", "main"], { encoding: "utf8" });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /^Usage:/u);
  }
});

test("public image modules explicitly remain readable by the nonroot user from a private 0600 source tree", () => {
  const dockerfile = readFileSync("ops/hosted-agent/Dockerfile", "utf8").replace(/\r\n/gu, "\n");
  const copies = dockerfile.split("\n").filter((line) => line.startsWith("COPY "));
  assert.deepEqual(copies, [
    "COPY --chmod=0644 ops/hosted-agent/entrypoint.mjs /usr/local/lib/gatherthread-hosted-entrypoint.mjs",
    "COPY --chmod=0555 ops/hosted-agent/cpuset-entrypoint.mjs /usr/local/lib/gatherthread-hosted-cpuset-entrypoint.mjs",
    "COPY --chmod=0644 ops/hosted-agent/resource-check.mjs /usr/local/lib/resource-check.mjs",
    "COPY --chmod=0644 ops/hosted-agent/public-answer.mjs /usr/local/lib/public-answer.mjs",
    "COPY --chmod=0644 ops/hosted-agent/opencode-session.mjs /usr/local/lib/opencode-session.mjs",
    "COPY --chmod=0644 ops/hosted-agent/npm-setup.mjs /usr/local/lib/npm-setup.mjs",
  ]);
  assert.match(dockerfile, /^USER 10001:10001$/mu);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "\/usr\/local\/lib\/gatherthread-hosted-entrypoint\.mjs"\]$/mu);
  const directory = mkdtempSync(join(tmpdir(), "gt-image-source-mode-"));
  try {
    for (const copy of copies) {
      const [, mode, source] = /^COPY --chmod=(0[0-7]{3}) (\S+) /u.exec(copy);
      const path = join(directory, source.split("/").at(-1));
      writeFileSync(path, readFileSync(source), { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.ok(Number.parseInt(mode, 8) & 0o004, "public runtime modules must be readable by the nonroot image user");
      assert.equal(Number.parseInt(mode, 8) & 0o022, 0, "group and others must never gain write permission");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function assertCandidateWorkflowUploads(raw) {
  const script = raw.replace(/\r\n/gu, "\n");
  const build = script.indexOf("Full canonical gate and fresh Git-less candidate");
  const verify = script.indexOf("Verify archive and write public provenance");
  const image = script.indexOf("Build, verify and export the same-source hosted image");
  const uploads = [...script.matchAll(/- name: Upload verified ([^\n]+)\n([\s\S]*?)(?=\n      - name:|$)/gu)];
  assert.equal(uploads.length, 2);
  assert.ok(build >= 0 && build < verify && verify < image && image < uploads[0].index);
  const imageStep = script.slice(image, uploads[0].index);
  assert.match(imageStep, /SOURCE_COMMIT: \$\{\{ steps\.source\.outputs\.commit \}\}/u);
  assert.match(imageStep, /CANDIDATE_DIRECTORY: \$\{\{ steps\.build\.outputs\.directory \}\}/u);
  assert.match(imageStep, /set -euo pipefail/u);
  assert.match(imageStep, /umask 077/u);
  assert.match(imageStep, /env -i PATH="\$PATH" HOME="\$task_private\/home" CI=true/u);
  assert.match(imageStep, /bash "\$CANDIDATE_DIRECTORY\/build\/scripts\/test-environment\/export-hosted-image\.sh"/u);
  assert.match(imageStep, /"\$SOURCE_COMMIT" "\$CANDIDATE_DIRECTORY\/build" "\$task_output" "\$task_private\/workflow\.json"/u);
  assert.doesNotMatch(imageStep, /process\.env|JSON\.stringify\(process|docker build|--build-arg|--secret/u);
  for (const name of ["GITHUB_REPOSITORY", "GITHUB_WORKFLOW_SHA", "GITHUB_WORKFLOW_REF", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_EVENT_NAME", "GITHUB_REF"]) {
    assert.ok(imageStep.includes(`"$${name}"`));
  }
  const names = [];
  const selectedFiles = [];
  for (const [, , upload] of uploads) {
    assert.match(upload, /if: \$\{\{ success\(\) \}\}/u);
    assert.match(upload, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
    assert.match(upload, /retention-days: 3/u);
    assert.match(upload, /if-no-files-found: error/u);
    assert.match(upload, /compression-level: 0/u);
    names.push(upload.match(/^\s+name: ([^\n]+)$/mu)[1]);
    selectedFiles.push([...upload.matchAll(/^\s+\$\{\{ steps\.(build|image)\.outputs\.directory \}\}\/([^\n]+)$/gmu)]
      .map(([, owner, file]) => `${owner}/${file}`));
  }
  assert.deepEqual(names, ["test-candidate-${{ steps.source.outputs.commit }}-${{ github.run_id }}-${{ github.run_attempt }}",
    "test-hosted-image-${{ steps.source.outputs.commit }}-${{ github.run_id }}-${{ github.run_attempt }}"]);
  assert.deepEqual(selectedFiles, [["build/candidate.tar.gz", "build/candidate.tar.gz.sha256", "build/provenance.json"],
    ["image/hosted-image.tar.gz", "image/hosted-image.tar.gz.sha256", "image/hosted-image-provenance.json"]]);
  assert.doesNotMatch(script, /secrets\.|continue-on-error|always\(\)|docker push|docker login|npm publish|ssh|sudo|pull_request_target/u);
}

test("candidate workflow uploads exact-source artifacts only after all checks succeed with either LF or CRLF checkout", () => {
  const source = readFileSync(".github/workflows/test-candidate.yml", "utf8");
  assertCandidateWorkflowUploads(source.replace(/\r?\n/gu, "\n"));
  assertCandidateWorkflowUploads(source.replace(/\r?\n/gu, "\r\n"));
});

test("workflow metadata producer records only its seven public identity fields, never inherited environment", () => {
  const workflowSource = readFileSync(".github/workflows/test-candidate.yml", "utf8");
  const producer = workflowSource.match(/env -i PATH="\$PATH" HOME="\$task_private\/home" node -e '([^']+)'/u)?.[1];
  assert.ok(producer);
  const directory = mkdtempSync(join(tmpdir(), "gt-image-producer-test-"));
  try {
    const path = join(directory, "workflow.json");
    const fields = ["repository", "workflow_sha", "workflow_ref", "run_id", "run_attempt", "event", "ref"];
    const result = spawnSync(process.execPath, ["-e", producer, path, ...fields.map((field) => workflow[field])], {
      encoding: "utf8", env: { GITHUB_TOKEN: "fixture-private-token", OPENAI_API_KEY: "fixture-private-key",
        HTTPS_PROXY: "fixture-private-proxy", HOME: directory },
    });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), workflow);
    assert.doesNotMatch(readFileSync(path, "utf8"), /fixture-private/u);
    const again = spawnSync(process.execPath, ["-e", producer, path, ...fields.map((field) => workflow[field])], { encoding: "utf8", env: {} });
    assert.notEqual(again.status, 0, "producer must refuse replacing existing workflow identity");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), workflow);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
