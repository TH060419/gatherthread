import test from 'node:test';
import assert from 'node:assert/strict';
import { ExampleCollaborationApi } from '../src/example-api.js';

test('authored examples obey member identities and Solo write boundaries in both languages', () => {
  for (const locale of ['en', 'zh-CN']) {
    const api = new ExampleCollaborationApi(locale);
    for (const session of api.sessions) {
      for (const event of api.events.get(session.id)) {
        const member = session.members.find((item) => item.userId === event.actor.id);
        assert.equal(event.actor.username, member.username);
        assert.notEqual(member.role, 'viewer', 'read-only member never authors a message');
        if (session.mode === 'solo') assert.equal(event.actor.id, session.ownerUserId);
      }
    }
    assert.equal(api.codeRepositories.get('project-orbit').branches[1].review_status, 'requested');
  }
});

test('free practice cannot mutate another example or the ordinary mock workspace', async () => {
  const { MockCollaborationApi } = await import('../src/api.js');
  const example = new ExampleCollaborationApi(), other = new ExampleCollaborationApi(), ordinary = new MockCollaborationApi({ latency: 0 });
  await example.renameProject('project-orbit', { name: 'Practice change' });
  assert.equal((await example.getProject('project-orbit')).name, 'Practice change');
  assert.equal((await other.getProject('project-orbit')).name, 'Weekend plan · example');
  assert.equal((await ordinary.getProject('project-orbit')).name, 'Project Orbit');
});
