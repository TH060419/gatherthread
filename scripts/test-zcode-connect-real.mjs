#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertUsableZcodeCli,
  probeZcodeCli,
  probeZcodeProtocol,
  resolveZcodeCommand,
  runZcodeProtocolTurn,
} from "../packages/bridge/dist/src/index.js";

/**
 * Real ZCode compatibility smoke test.
 *
 * Exercises the actual installed official ZCode CLI end to end at the
 * protocol level: structural probe, live app-server handshake, one real
 * turn with a trivial prompt, native session resume with a second turn, and
 * a clean bounded shutdown. It requires a signed-in ZCode CLI with a default
 * model (run `zcode login` once); without an installed CLI the test skips so
 * CI machines without ZCode stay green, but a present-yet-broken CLI fails.
 *
 * Set GATHERTHREAD_ZCODE_SMOKE=required to fail (instead of skipping) when
 * no CLI can be resolved, e.g. on a release verification machine.
 */

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const spec = await resolveZcodeCommand(process.env.ZCODE_COMMAND?.trim() || undefined).catch((error) => {
  if (process.env.GATHERTHREAD_ZCODE_SMOKE === "required") throw error;
  process.stdout.write(`SKIP: ${error.message}\n`);
  process.exit(0);
});

const probe = await probeZcodeCli(spec);
assertUsableZcodeCli(probe);
process.stdout.write(`ZCode CLI ${probe.version} (${spec.source})\n`);

const workspace = await mkdtemp(path.join(tmpdir(), "gtz-real-"));
try {
  const protocol = await probeZcodeProtocol(spec, { cwd: workspace, timeoutMs: 20_000 });
  process.stdout.write(`ZCode Protocol handshake: ${protocol.protocolName} version ${protocol.protocolVersion}\n`);

  const first = await runTurn(workspace, undefined,
    "Reply with exactly the word PONG and nothing else. Do not use any tools.",
    "PONG");
  process.stdout.write(`First turn completed in native session ${first.nativeSessionId}\n`);

  const second = await runTurn(workspace, first.nativeSessionId,
    "What exact single word did you reply with in your previous answer? Reply with that word only.",
    "PONG");
  process.stdout.write(`Resumed turn completed in native session ${second.nativeSessionId}\n`);
  assert.equal(second.nativeSessionId, first.nativeSessionId, "resume must continue the same native session");
  process.stdout.write("Real ZCode protocol smoke test passed.\n");
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function runTurn(workspacePath, resumeSessionId, prompt, expected) {
  const outcome = await runZcodeProtocolTurn({
    spec,
    workspacePath,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    prompt,
    timeoutMs: 300_000,
    maxOutputBytes: 4_194_304,
    signal: undefined,
    onTurnEvent: () => undefined,
  });
  assert.ok(outcome.finalResponse.trim().length > 0, "the real turn must produce a final answer");
  assert.ok(
    outcome.finalResponse.toUpperCase().includes(expected),
    `expected the turn answer to include "${expected}" but received: ${outcome.finalResponse.slice(0, 200)}`,
  );
  return outcome;
}
