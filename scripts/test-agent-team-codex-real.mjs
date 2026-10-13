#!/usr/bin/env node
// Optional live test: consumes the installed Codex account's allowance.
// Synthetic in-memory GT identity, read-only ephemeral native threads, no production state.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServerClient } from '../packages/bridge/dist/src/codex-app-server.js';
import { CollaborationDatabase } from '../apps/server/dist/src/database.js';
import { CollaborationService } from '../apps/server/dist/src/service.js';
import { AgentTeams } from '../apps/server/dist/src/agent-teams.js';
const command = process.env.GATHERTHREAD_CODEX_COMMAND?.trim();
assert.ok(command && path.isAbsolute(command), 'Set GATHERTHREAD_CODEX_COMMAND to the absolute installed official Codex executable');
const root = await mkdtemp(path.join(tmpdir(), 'gt-team-native-'));
await mkdir(`${root}/native-workspace`);
const timeout = AbortSignal.timeout(180000);
const client = new CodexAppServerClient({
  command,
  cwd: `${root}/native-workspace`, signal: timeout, turnTimeoutMs: 60000,
});
let db, teams;
let stage = 'catalog';
try {
  const catalog = await client.listModels();
  const selected = catalog.find(model => model.isDefault && typeof model.model === 'string');
  assert.ok(selected?.model, 'The installed Codex catalog must declare an explicit default model');
  assert.ok(selected.defaultReasoningEffort, 'The selected model must declare its reasoning effort');
  db = new CollaborationDatabase(':memory:');
  const service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: 'Synthetic native acceptance', device_name: 'Synthetic local device' }).actor;
  const session = service.createSession(actor, { mode: 'multi', title: 'Synthetic arithmetic team', idempotency_key: 'native-team-fixture' }).session;
  const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness: 'codex',
    provider: 'openai', model: selected.model, context_deletion_version: 1,
    execution_profiles: [{ provider: 'openai', model: selected.model, reasoning_efforts: [selected.defaultReasoningEffort] }],
    local_session_id: 'synthetic-ephemeral-native-team', capture_fidelity: 'harness_transcript' });
  const target = { kind: 'local', runtime_id: runtime.id, harness: 'codex', provider: 'openai', model: selected.model, reasoning_effort: selected.defaultReasoningEffort };
  const plan = { name: 'Native arithmetic acceptance', team_prompt: 'This is a synthetic protocol test. Use no tools, files, MCP, network or native subagents. Reply briefly with only public task results and the required terminal routing block.',
    nodes: [{ id: 'lead', label: 'Native director', role: 'Delegate the multiplication to worker exactly once. After its result returns, verify that it is 42 and complete. Do not delegate again.', x: 0, y: 0, target },
      { id: 'worker', label: 'Native calculator', role: 'Compute the assigned arithmetic mentally. Return the answer and complete. Do not use tools.', x: 350, y: 0, target }],
    edges: [{ id: 'lead-worker', source: 'lead', target: 'worker', direction: 'one_way' }] };
  teams = new AgentTeams(service, undefined, { autoStart: false });
  const threads = new Map(), reports = [];
  const run = teams.start(actor, session.id, { plan, entry_node_id: 'lead', content: 'Delegate calculating 6 × 7 to worker, then verify its returned result. This task needs no files or tools.',
    max_calls: 3, max_duration_minutes: 3, idempotency_key: 'native-arithmetic-start' }).run;
  for (let turn = 0; turn < 3; turn++) {
    stage = `accept-${turn + 1}`;
    for (let poll = 0; poll < 100; poll++) {
      service.heartbeatRuntime(actor, runtime.id); await teams.pump();
      if (teams.read(actor, session.id, run.id).run.calls_used === turn + 1) break;
      await delay(10);
    }
    const current = teams.read(actor, session.id, run.id).run;
    assert.equal(current.calls_used, turn + 1); assert.equal(current.status, 'running');
    const step = current.steps.find(step => step.id === current.current_step_id);
    const request = db.getEvent(session.id, step.request_event_id);
    const claim = service.claimAgentRequest(actor, session.id, request.id, runtime.id);
    stage = `native-turn-${turn + 1}`;
    if (!threads.has(step.node_id)) threads.set(step.node_id, await client.startThread({ cwd: `${root}/native-workspace`, model: selected.model, sandbox: 'read-only', threadSource: 'exec' }));
    const result = await client.runTurn({ threadId: threads.get(step.node_id), model: selected.model,
      effort: selected.defaultReasoningEffort, prompt: request.payload.content, clientUserMessageId: randomUUID(), signal: timeout });
    const tools = result.items.filter(item => !['userMessage','agentMessage','reasoning'].includes(item.type));
    assert.equal(tools.length, 0, 'the arithmetic acceptance must not use tools');
    const answer = result.items.filter(item => item.type === 'agentMessage').map(item => item.text ?? '').join('\n');
    assert.ok(answer.trim());
    service.completeAgentRequest(actor, session.id, request.id, runtime.id, `native-finish-${turn}`, { text: answer }, selected.model, selected.defaultReasoningEffort, claim.attempt_count);
    reports.push({ node: step.node_id, publicAnswer: answer, tools: 0 });
    await teams.pump();
  }
  const finished = teams.read(actor, session.id, run.id).run;
  assert.equal(finished.status, 'completed'); assert.equal(finished.calls_used, 3);
  assert.deepEqual(reports.map(report => report.node), ['lead', 'worker', 'lead']);
  assert.match(reports[1].publicAnswer, /42/); assert.match(reports[2].publicAnswer, /42/);
  console.log(JSON.stringify({ passed: true, model: selected.model, calls: 3, sequence: reports.map(report => report.node), tools: 0 }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, stage, errorType: error?.name ?? 'Error' })); process.exitCode = 1;
} finally { teams?.close(); await client.close(); db?.close(); await rm(root, { recursive: true, force: true }); }
