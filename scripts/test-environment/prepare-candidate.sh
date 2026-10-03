#!/usr/bin/env bash
# Local artifact preparation only. Never deploys or changes a service symlink.
set -euo pipefail
if [[ $# != 2 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Usage: prepare-candidate.sh FULL_COMMIT ABSOLUTE_NEW_OUTPUT_DIRECTORY' >&2
  exit 2
fi
[[ "$(uname -s)" == Linux ]] || { echo 'Build on the same Linux architecture/Node runtime as both target services.' >&2; exit 2; }
[[ "$2" == /* && ! -e "$2" ]] || { echo 'Output must be an absolute new directory.' >&2; exit 2; }
task_commit="$1"
task_output="$2"
task_root="$(git rev-parse --show-toplevel)"
git -C "$task_root" cat-file -e "$task_commit^{commit}"
umask 077
mkdir -p "$task_output/build"
git -C "$task_root" archive "$task_commit" | tar -x -C "$task_output/build"
cd "$task_output/build"
npm ci
npm run release:verify
npm run build
# Metadata contains only public build identity. Both environments use this exact tarball.
node -e 'const fs=require("node:fs");fs.writeFileSync("candidate.json",JSON.stringify({commit:process.argv[1],node:process.version,platform:process.platform,arch:process.arch},null,2)+"\n")' "$task_commit"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$task_output/candidate.tar.gz" --exclude=.git --exclude=.local --exclude=.env --exclude=.env.local --exclude=release-artifacts .
cd "$task_output"
sha256sum candidate.tar.gz > candidate.tar.gz.sha256
echo 'Candidate verified and packaged. Test deployment and production promotion each require human approval.'
