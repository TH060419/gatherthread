import assert from 'node:assert/strict';
import test from 'node:test';
import { startCollaborationServer } from '../../apps/server/dist/src/server.js';
import { identityFixture } from '../../apps/server/dist/test/auth-fixtures.js';
import { HttpCollaborationClient, LocalBridge, MemoryCursorStore } from '../../packages/bridge/dist/src/index.js';
import { dshWorkspaceAction } from '../../packages/dsh-host/dist/src/workspace.js';

test('DSH workspace: two members share canonical context; receipt retry creates one request', async () => {
  const server = await startCollaborationServer({ databasePath: ':memory:', authTokenPepper: 'workspace-fixture-pepper-0123456789', allowHttpBootstrap: true }, 0);
  try {
    const a = identityFixture(server, { body: { user_id: 'member-a', display_name: '参与者 A', device_id: 'device-a' } }).body.data;
    const b = identityFixture(server, { body: { user_id: 'member-b', display_name: '参与者 B', device_id: 'device-b' } }).body.data;
    const project = server.service.createProject(a.actor, { title: '多人协作验收', idempotency_key: 'workspace-project' });
    server.service.claimInvitationForActor(b.actor, server.service.createProjectInvitation(a.actor, project.id, { role: 'participant', ttl: '1h' }).invite_token);
    const { session } = server.service.createSession(a.actor, { project_id: project.id, title: '设计讨论', mode: 'multi', idempotency_key: 'workspace-session' });
    const options = identity => ({ grant: { schemaVersion: 2, serverUrl: server.origin, apiUrl: `${server.origin}/v1`,
      deviceId: identity.actor.device_id, deviceName: 'Fixture', token: identity.token, route: { provider: 'deepseek', model: 'fixture-model' } },
      signal: new AbortController().signal, assertCurrent() {}, runtime: () => 'workspace-runtime-a' });
    const optsA = options(a), optsB = options(b);
    const listingA = await dshWorkspaceAction({ action: 'list' }, optsA);
    const listingB = await dshWorkspaceAction({ action: 'list' }, optsB);
    const scopeA = { connectionId: listingA.connectionId, projectId: project.id, sessionId: session.id };
    const scopeB = { ...scopeA, connectionId: listingB.connectionId };
    const api = new HttpCollaborationClient({ baseUrl: `${server.origin}/v1`, bearerToken: a.token });
    const bridge = new LocalBridge({ api, cursorStore: new MemoryCursorStore(), runtime: {
      runtimeId: 'workspace-runtime-a', sessionId: session.id, deviceId: a.actor.device_id,
      harness: 'deepseek-harness', provider: 'deepseek', model: 'fixture-model', localSessionId: 'fixture-native-session', captureFidelity: 'harness_transcript' }, transcriptRoots: {} });
    await bridge.connect();
    await dshWorkspaceAction({ action: 'send', ...scopeB, kind: 'chat', content: '决定：导航按钮统一蓝色。', idempotencyKey: 'workspace-member-b-chat' }, optsB);
    const read = await dshWorkspaceAction({ action: 'read', ...scopeA, afterSequence: 0 }, optsA);
    assert.equal(read.messages[0].author, '参与者 B');
    assert.equal(read.messages[0].content, '决定：导航按钮统一蓝色。');
    const request = { action: 'send', ...scopeA, kind: 'agent', runtimeId: 'workspace-runtime-a', content: '请根据大家的讨论总结设计要求。', idempotencyKey: 'workspace-stable-agent-request' };
    const first = await dshWorkspaceAction(request, optsA);
    const retried = await dshWorkspaceAction(request, optsA);
    assert.equal(first.message.id, retried.message.id);
    const history = await api.readEvents(session.id, 0, 100);
    assert.equal(history.events.filter(e => e.type === 'agent_request').length, 1);
    const claimed = history.events.find(e => e.id === first.message.id);
    const result = await bridge.processAgentRequest(claimed, { async execute({ canonicalHistory }) {
      assert.ok(canonicalHistory.some(e => e.actorId === b.actor.user_id && e.payload.content === '决定：导航按钮统一蓝色。'));
      return { events: [{ kind: 'assistant', localEventId: 'workspace-fixture-answer', harness: 'deepseek-harness', captureFidelity: 'harness_transcript', content: '根据参与者 B 的决定，导航按钮采用蓝色。' }] };
    } });
    assert.equal(result.claimed, true);
    const context = await dshWorkspaceAction({ action: 'context', ...scopeB }, optsB);
    assert.ok(context.items.some(item => item.content.includes('导航按钮统一蓝色')));
    const reply = await dshWorkspaceAction({ action: 'read', ...scopeB, afterSequence: read.cursor, contentRevision: read.contentRevision }, optsB);
    assert.ok(reply.messages.some(item => item.type === 'agent_response' && item.content.includes('参与者 B')), JSON.stringify({messages: reply.messages, completed: result.completed}));

    const newConversation = { action: 'createSession', connectionId: listingA.connectionId, projectId: project.id,
      title: '私有测试笔记', mode: 'solo', idempotencyKey: 'create-private-solo' };
    const created = await dshWorkspaceAction(newConversation, optsA);
    assert.equal((await dshWorkspaceAction(newConversation, optsA)).sessionId, created.sessionId);
    assert.equal((await dshWorkspaceAction({ action: 'sessions', connectionId: listingB.connectionId, projectId: project.id }, optsB)).sessions.some(s => s.id === created.sessionId), false);
    await assert.rejects(dshWorkspaceAction({ action: 'discardEmptySolo', ...scopeB, sessionId: created.sessionId }, optsB), /workspace_access_denied/);
    await assert.rejects(dshWorkspaceAction({ action: 'discardEmptySolo', ...scopeA }, optsA), /workspace_read_only/);
    const emptyScope = { ...scopeA, sessionId: created.sessionId };
    assert.equal((await dshWorkspaceAction({ action: 'discardEmptySolo', ...emptyScope }, optsA)).discarded, true);
    assert.equal((await dshWorkspaceAction({ action: 'sessions', connectionId: listingA.connectionId, projectId: project.id }, optsA)).sessions.some(s => s.id === created.sessionId), false);
    const usedSolo = await dshWorkspaceAction({ ...newConversation, idempotencyKey: 'solo-written-by-other-device' }, optsA);
    // Another UI/device has already submitted content before DSH navigates away.
    await api.appendEvent(usedSolo.sessionId, { type: 'human_chat', payload: { content: '必须保留的记录' }, idempotencyKey: 'concurrent-solo-write' });
    assert.equal((await dshWorkspaceAction({ action: 'discardEmptySolo', ...scopeA, sessionId: usedSolo.sessionId }, optsA)).discarded, false);
    await assert.rejects(dshWorkspaceAction({ action: 'renameSession', ...scopeB, title: '越权改名', idempotencyKey: 'forbidden-rename' }, optsB), /workspace_read_only/);
    await dshWorkspaceAction({ action: 'renameSession', ...scopeA, title: '已改名的设计讨论', idempotencyKey: 'allowed-rename' }, optsA);
    assert.equal((await dshWorkspaceAction({ action: 'sessions', connectionId: listingA.connectionId, projectId: project.id }, optsA)).sessions.find(s => s.id === session.id).name, '已改名的设计讨论');

    const quoted = await dshWorkspaceAction({ action: 'send', ...scopeA, kind: 'chat', content: '赞同这个结论', replyTo: first.message.id,
      contentRevision: reply.contentRevision, idempotencyKey: 'quoted-chat' }, optsA);
    assert.equal(quoted.message.replyTo, first.message.id);
    const second = await dshWorkspaceAction({ ...request, idempotencyKey: 'pausable-agent-request' }, optsA);
    await api.claimAgentRequest(session.id, second.message.id, 'workspace-runtime-a');
    const reference = { ...scopeA, requestId: second.message.id, requestSequence: second.message.sequence, contentRevision: reply.contentRevision };
    assert.equal((await dshWorkspaceAction({ action: 'pause', ...reference }, optsA)).status, 'paused');
    // Another member must never control this local request, even in the same Multi room.
    await assert.rejects(dshWorkspaceAction({ action: 'pause', ...reference, connectionId: scopeB.connectionId }, optsB), /workspace_request_unavailable/);
    const resumeInput = { action: 'resume', ...reference, idempotencyKey: 'resume-stable-identity' };
    const resumed = await dshWorkspaceAction(resumeInput, optsA);
    assert.equal((await dshWorkspaceAction(resumeInput, optsA)).message.id, resumed.message.id);
    assert.equal(resumed.message.content, request.content);
  } finally { await server.close(); }
});
