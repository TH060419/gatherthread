#!/usr/bin/env bash
# CI-only local export. No registry push, credentials, service changes or deployment.
set -euo pipefail
if [[ $# != 4 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Usage: export-hosted-image.sh FULL_COMMIT ABSOLUTE_BUILD ABSOLUTE_NEW_OUTPUT ABSOLUTE_PUBLIC_WORKFLOW_JSON' >&2
  exit 2
fi
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Hosted image delivery requires Linux amd64.' >&2; exit 2; }
[[ "$2" == /* && -d "$2" && ! -L "$2" && "$3" == /* && ! -e "$3" && ! -L "$3" && "$4" == /* && -f "$4" && ! -L "$4" ]] \
  || { echo 'Use the private Git-less build and a new absolute output directory.' >&2; exit 2; }
task_commit="$1"
task_build="$(cd "$2" && pwd -P)"
[[ "$task_build" == "$2" ]] || { echo 'Build path must be canonical.' >&2; exit 2; }
task_output="$3"
task_workflow="$4"
task_path="$PATH"
task_node="$(command -v node)"
task_docker="$(command -v docker)"
[[ "$task_node" == /* && "$task_docker" == /* ]] || exit 2
umask 077
mkdir "$task_output"
# Keep Unix model/npm socket paths below Linux's pathname bound.
task_private="$(mktemp -d /tmp/gt-image.XXXXXXXX)"
trap 'rm -rf -- "$task_private"' EXIT
mkdir "$task_private/home" "$task_private/tmp" "$task_private/docker"
clean() {
  env -i PATH="$task_path" HOME="$task_private/home" TMPDIR="$task_private/tmp" CI=true \
    DOCKER_HOST=unix:///var/run/docker.sock "$@"
}
docker_client() { clean env DOCKER_CONFIG="$task_private/docker" "$task_docker" "$@"; }
task_metadata="$task_build/scripts/test-environment/hosted-image-metadata.mjs"
clean "$task_node" "$task_metadata" source "$task_commit" "$task_build/candidate.json" "$task_workflow"
# Build once from the same verified Git-less tree as the application archive.
docker_client build --platform linux/amd64 --iidfile "$task_private/image.id" \
  --file "$task_build/ops/hosted-agent/Dockerfile" "$task_build"
task_image="$(< "$task_private/image.id")"
[[ "$task_image" =~ ^sha256:[a-f0-9]{64}$ && ${#task_image} == 71 ]] || exit 1
docker_client image inspect "$task_image" > "$task_private/inspection.json"
clean "$task_node" "$task_metadata" image "$task_commit" "$task_build/candidate.json" "$task_private/inspection.json" "$task_image"
docker_client version --format '{{json .}}' > "$task_private/docker.json"
# Exact same content-addressed image, first quota paths, then guarded cpuset paths.
for task_smoke in test-hosted-container.mjs test-hosted-repository-container.mjs; do
  clean env GATHERTHREAD_TEST_HOSTED_IMAGE="$task_image" GATHERTHREAD_HOSTED_AGENT_MEMORY_MIB=512 \
    GATHERTHREAD_HOSTED_GITHUB_MEMORY_MIB=768 "$task_node" "$task_build/scripts/$task_smoke"
done
clean "$task_node" -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({image_id:process.argv[2],trial_memory_mib:512,repository_memory_mib:768,trial:"passed",repository:"passed"})+"\n",{flag:"wx",mode:0o600})' \
  "$task_private/quota.json" "$task_image"
clean env GATHERTHREAD_TEST_HOSTED_IMAGE="$task_image" "$task_node" "$task_build/scripts/test-hosted-cpuset.mjs" \
  --report "$task_private/cpuset.json"
# Save the tested immutable ID, never rebuild or resolve a mutable tag for delivery.
docker_client save "$task_image" | gzip -n | clean "$task_node" "$task_metadata" archive \
  "$task_private/hosted-image.tar.gz" "$task_private/archive.json"
gzip -t "$task_private/hosted-image.tar.gz"
docker_client image inspect "$task_image" > "$task_private/exported-inspection.json"
clean "$task_node" "$task_metadata" image "$task_commit" "$task_build/candidate.json" "$task_private/exported-inspection.json" "$task_image"
clean "$task_node" "$task_metadata" provenance "$task_commit" "$task_build/candidate.json" \
  "$task_private/exported-inspection.json" "$task_image" "$task_private/quota.json" "$task_private/cpuset.json" "$task_private/docker.json" \
  "$task_private/archive.json" "$task_workflow" "$task_private/hosted-image-provenance.json"
task_hash="$(clean "$task_node" -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).sha256)' "$task_private/archive.json")"
printf '%s  hosted-image.tar.gz\n' "$task_hash" > "$task_private/hosted-image.tar.gz.sha256"
for task_file in hosted-image.tar.gz hosted-image.tar.gz.sha256 hosted-image-provenance.json; do
  mv "$task_private/$task_file" "$task_output/$task_file"
done
echo 'Verified hosted image exported; deployment-host aggregate isolation still requires independent acceptance.'
