import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LiveOutputPayloadSchema } from '@gatherthread/protocol';
import { compareCodeSnapshots } from '../src/code-sync-view.js';
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
    const files = new Map(original.snapshot.files.map(file => [file.path, Buffer.from(file.content_base64, 'base64').toString('utf8')]));
    assert.deepEqual([...files.keys()].sort(), ['README.md', 'index.html', 'package.json', 'src/signup.js', 'styles.css', 'tests/signup.test.cjs']);
    const html = files.get('index.html');
    assert.match(html, /<button/);
    assert.match(html, /src\/signup.js/);
    assert.match(files.get('src/signup.js'), /addEventListener/);
    assert.match(html, locale === 'zh-CN' ? /学校操场/ : /school sports field/);
    assert.deepEqual(compareCodeSnapshots(original.snapshot, revision.snapshot).map(change => change.path), ['src/signup.js']);
    const response = events.find(event => event.type === 'agent_response' && event.replyTo === build.id);
    assert.match(response.payload.content, /index.html/);
    assert.match(response.payload.content, /src\/signup.js/);
    assert.match(response.payload.content, /```/);
    const progress = events.filter(event => event.type === 'agent_progress' && event.replyTo === build.id);
    for (const event of progress) assert.equal(LiveOutputPayloadSchema.safeParse(event.payload).success, true);
    assert.ok(progress.some(event => event.payload.stream_kind === 'plan' && event.payload.plan.length === 3));
    assert.ok(progress.some(event => event.payload.stream_kind === 'tool' && /npm test/.test(event.payload.content)));
    assert.equal(events.at(-1).replyTo, response.id, 'teammate review refers to the exact build answer');
  }
});

test('all downloadable demo versions really pass their own dependency-free checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gatherthread-example-check-'));
  try {
    for (const locale of ['en', 'zh-CN']) for (const branch of ['main', 'branch-maya']) {
      const api = new ExampleCollaborationApi(locale);
      const { snapshot } = await api.getProjectCodeSnapshot('project-orbit', branch);
      const folder = join(directory, `${locale}-${branch}`);
      for (const file of snapshot.files) {
        const path = join(folder, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(file.content_base64, 'base64'));
      }
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/signup.test.cjs'], { cwd: folder, encoding: 'utf8', env });
      assert.match(output, /(?:pass 3|# pass 3)/);
      assert.match(output, /(?:fail 0|# fail 0)/);
      assert.equal(JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')).scripts.test, 'node --test tests/signup.test.cjs');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('example code runs, repeats safely, and the approved change survives main download and language changes', async () => {
  for (const locale of ['en', 'zh-CN']) {
    const api = new ExampleCollaborationApi(locale);
    async function clickSignup(branch) {
      const { snapshot } = await api.getProjectCodeSnapshot('project-orbit', branch);
      const source = Buffer.from(snapshot.files.find(file => file.path === 'src/signup.js').content_base64, 'base64').toString('utf8');
      let handler;
      const button = { disabled: false, textContent: '', addEventListener(type, callback) { assert.equal(type, 'click'); handler = callback; } };
      const confirmation = { hidden: true, textContent: '' };
      runInNewContext(source, { document: { getElementById: id => id === 'signup' ? button : confirmation } });
      assert.equal(confirmation.hidden, true);
      handler(); handler();
      assert.equal(confirmation.hidden, false);
      assert.equal(button.disabled, true);
      return confirmation.textContent;
    }
    assert.equal(await clickSignup('main'), locale === 'zh-CN' ? '报名成功。' : 'You’re signed up.');
    assert.equal(await clickSignup('branch-maya'), locale === 'zh-CN' ? '报名成功！周六见。' : 'You’re signed up! See you Saturday.');
    const status = await api.getProjectCode('project-orbit');
    await api.mutateProjectCode('project-orbit', 'merge', { branch_id: 'branch-maya', expected_main_commit: status.repository.main_commit,
      expected_head_commit: status.branches[1].head_commit, idempotency_key: 'demo-reviewed-merge' });
    assert.equal(await clickSignup('main'), await clickSignup('branch-maya'));
    api.setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN');
    assert.equal(await clickSignup('main'), locale === 'zh-CN' ? 'You’re signed up! See you Saturday.' : '报名成功！周六见。');
    assert.match(api.events.get('session-orbit').find(event => event.payload.plan)?.payload.plan[0].step, locale === 'zh-CN' ? /page/i : /页面/);
  }
});
