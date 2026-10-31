import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { HttpCollaborationClient, LocalBridge, MemoryCursorStore, BridgeDaemon } from '../../../../packages/bridge/src/index.ts';
const args = process.argv.slice(2), origin = args[args.indexOf('--url') + 1], sessionId = args[args.indexOf('--session') + 1];
if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) || sessionId !== 'desktop-demo-multi') throw new Error('Fixture only');
const token = process.env.GATHERTHREAD_TOKEN; delete process.env.GATHERTHREAD_TOKEN;
const api = new HttpCollaborationClient({ baseUrl: `${origin}/v1`, bearerToken: token });
const controller = new AbortController();
process.stdin.on('data', () => controller.abort()); process.stdin.on('end', () => controller.abort());
process.on('SIGTERM', () => controller.abort()); process.on('SIGINT', () => controller.abort());
const executor = {
  // There is no external model/tool process in this fixture; its only work is
  // this awaited, abortable delay. Never advertise this adapter outside demo.
  executionControlVersion: 1,
  async execute(input) {
    const signal = AbortSignal.any([controller.signal, input.signal ?? new AbortController().signal]);
    const content = String(input.request.payload.content ?? '');
    await delay(content.includes('长任务') ? 30_000 : 400, undefined, { signal });
    const probe = content.split('\n').filter(line => /^GT_TEAM_(?:OK|ROUTE):/u.test(line));
    const sharedDecision = JSON.stringify(input.historyContext ?? input.canonicalHistory).includes('按钮保持绿色');
    let text = probe.length ? probe.join('\n') : `这是本机模拟 Agent 的回复。${sharedDecision ? '我已读取测试用户 B 的共享上下文：沿用最新版 GT 网页界面，按钮保持绿色。' : '已收到当前请求。'}\n\n没有调用真实模型，也没有修改本地文件。`;
    if (input.request.payload.agent_team && input.request.payload.agent_team.purpose !== 'test') text += '\n\n```gatherthread-team\n' + JSON.stringify({ version: 1,
      step_id: input.request.payload.agent_team.step_id, action: 'complete' }) + '\n```';
    return { events: [{ kind: 'assistant', localEventId: randomUUID(), harness: 'codex',
      captureFidelity: 'harness_transcript', content: text }] };
  },
  async readStoppedExecutions() { return []; },
  async acknowledgeExecutionExit() {}, async acknowledgeCanonicalCompletion() {},
};
const bridge = new LocalBridge({ api, cursorStore: new MemoryCursorStore(), runtime: {
  runtimeId: `desktop-runtime-${randomUUID()}`, sessionId, deviceId: 'desktop-user-a-mac', harness: 'codex',
  provider: 'openai', model: 'desktop-fixture', localSessionId: `desktop-native-${randomUUID()}`,
  captureFidelity: 'harness_transcript', contextDeletionVersion: 1,
  executionProfiles: [{ provider: 'openai', model: 'desktop-fixture', reasoningEfforts: ['low', 'medium', 'high'] }],
}, transcriptRoots: {} });
await bridge.connect(executor);
process.stdout.write('GatherThread connector ready.\n');
const daemon = new BridgeDaemon({ bridge, executor, signal: controller.signal, pollIntervalMs: 150, heartbeatIntervalMs: 2000 });
await daemon.run();
process.stdin.destroy(); process.exit(0);
