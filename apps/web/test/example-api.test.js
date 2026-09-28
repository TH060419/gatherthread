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
  assert.equal((await other.getProject('project-orbit')).name, 'Club signup page · example');
  assert.equal((await ordinary.getProject('project-orbit')).name, 'Project Orbit');
});

test('language changes localize seed identities and visible projections while retaining practice', async () => {
  const api = new ExampleCollaborationApi('en');
  const project = await api.getProject('project-orbit');
  const session = await api.getSession('session-orbit');
  const events = structuredClone(api.events.get(session.id));
  const currentUser = structuredClone(api.currentUser);
  await api.renameProject(project.id, { name: 'My practice name' });
  project.name = 'My practice name';
  const practice = { id: 'practice', actor: { id: currentUser.id, username: currentUser.username }, payload: { content: 'Leave my practice message as written.' } };
  events.push(practice);
  api.events.get(session.id).push(structuredClone(practice));
  api.setLocale('zh-CN', { project, session, events, currentUser });
  assert.equal(project.name, 'My practice name');
  assert.equal(api.projects[0].name, 'My practice name');
  assert.equal(currentUser.username, '陈晓');
  assert.equal(session.name, '一起做报名页');
  assert.equal(events[0].actor.username, '林悦');
  assert.match(events[0].payload.content, /陈晓，咱们/);
  assert.equal(events.at(-1).payload.content, practice.payload.content);
  assert.equal(events.at(-1).actor.username, '陈晓');
  assert.equal(new Set(session.members.map(member => member.username[0])).size, 3, 'avatars distinguish the three people');
  api.setLocale('en', { project, session, events, currentUser });
  assert.equal(currentUser.username, 'Alex');
  assert.equal(session.name, 'Build the signup page');
  assert.equal(events.at(-1).payload.content, practice.payload.content);
  assert.equal(project.name, 'My practice name');
});


test('the simple production story summarizes discussion before building and reviewing real page files', async () => {
  for (const locale of ['en', 'zh-CN']) {
    const api = new ExampleCollaborationApi(locale);
    const events = api.events.get('session-orbit');
    const build = events.find(event => event.type === 'agent_request' && !event.payload.history_summary);
    const summaries = events.filter(event => event.payload.history_summary);
    assert.equal(summaries.length, 2);
    for (const summary of summaries) {
      const response = events.find(event => event.replyTo === summary.id);
      assert.ok(response.sequence < build.sequence, 'summary precedes production');
      assert.deepEqual(summary.payload.history_summary.source_event_ids, events.slice(0, 2).map(event => event.id));
    }
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.every((event, index) => !index || event.createdAt >= events[index - 1].createdAt));
    assert.match(build.payload.content, locale === 'zh-CN' ? /摘要/ : /summary/);
    assert.match(events.at(-1).payload.content, locale === 'zh-CN' ? /提交审核/ : /review/);
    const original = await api.getProjectCodeSnapshot('project-orbit', 'main');
    const revision = await api.getProjectCodeSnapshot('project-orbit', 'branch-maya');
    assert.equal(original.snapshot.files[0].path, 'signup.html');
    const html = Buffer.from(original.snapshot.files[0].content_base64, 'base64').toString('utf8');
    assert.match(html, /<button/);
    assert.match(html, /addEventListener/);
    assert.match(html, locale === 'zh-CN' ? /学校操场/ : /school sports field/);
    assert.notEqual(original.snapshot.files[0].content_base64, revision.snapshot.files[0].content_base64);
  }
});
