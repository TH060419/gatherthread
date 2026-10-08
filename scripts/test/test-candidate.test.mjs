import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('candidate archive validation passes its cross-platform synthetic negative contracts', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = execFileSync(python, ['-B', 'scripts/test-environment/test_verify_candidate.py', '-v'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result, '');
});

test('isolated candidate workflow pins identity and uploads only after the complete canonical gate', () => {
  const workflow = readFileSync('.github/workflows/test-candidate.yml', 'utf8');
  const canonical = readFileSync('scripts/test-environment/prepare-candidate.sh', 'utf8');
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: 24\.16\.0/);
  for (const action of ['checkout', 'setup-node', 'upload-artifact']) {
    assert.match(workflow, new RegExp(`uses: actions/${action}@[a-f0-9]{40}\\b`));
  }
  assert.match(workflow, /REQUESTED_COMMIT: \$\{\{ inputs\.commit \}\}/);
  assert.match(workflow, /--workflow-sha "\$GITHUB_WORKFLOW_SHA" --workflow-ref "\$GITHUB_WORKFLOW_REF"/);
  assert.match(workflow, /--repository "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$task_commit" refs\/remotes\/origin\/main/);
  assert.match(workflow, /\[\[ "\$task_commit" == "\$GITHUB_SHA" \]\]/);
  assert.match(workflow, /env -i PATH="\$PATH" HOME="\$task_private\/home" CI=true/);
  assert.match(workflow, /umask 077/);
  assert.match(workflow, /retention-days: 3/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|continue-on-error|always\(\)|curl|ssh|sudo|npm publish/);
  const build = workflow.indexOf('bash scripts/test-environment/prepare-candidate.sh');
  const verify = workflow.indexOf('python3 scripts/test-environment/verify-candidate.py');
  const upload = workflow.indexOf('uses: actions/upload-artifact');
  assert.ok(build > 0 && build < verify && verify < upload);
  const uploads = workflow.slice(upload).match(/^\s+\$\{\{ steps\.build\.outputs\.directory \}\}\/([^\n]+)$/gm);
  assert.deepEqual(uploads.map(line => line.trim().split('/').at(-1)),
    ['candidate.tar.gz', 'candidate.tar.gz.sha256', 'provenance.json']);
  assert.match(canonical, /set -euo pipefail/);
  assert.ok(canonical.indexOf('npm ci') < canonical.indexOf('npm run release:verify'));
  assert.ok(canonical.indexOf('npm run release:verify') < canonical.indexOf('npm run build'));
  assert.ok(canonical.indexOf('npm run build') < canonical.indexOf('writeFileSync("candidate.json"'));
});
