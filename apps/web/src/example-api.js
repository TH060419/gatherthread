import { MockCollaborationApi } from './api.js?v=20261018-tabs-2';
import { exampleProjectFiles, EXAMPLE_REVIEWED_COMMIT } from './example-project.js';

// This API is reachable only from the dedicated example document. Its mutations
// are ordinary mock mutations in fresh memory, with no backend or local runtime.
export class ExampleCollaborationApi extends MockCollaborationApi {
  constructor(locale = 'en') {
    super({ latency: 0 });
    this.locale = locale === 'zh-CN' ? 'zh-CN' : 'en';
    const zh = this.locale === 'zh-CN';
    const text = (en, cn) => zh ? cn : en;
    this.currentUser.username = text('Alex', '陈晓');
    this.projects[0].name = text('Club signup page · example', '活动报名页 · 示例');
    const names = [this.currentUser.username, text('Maya', '林悦'), text('Jon', '周宁')];
    for (const session of this.sessions) session.members.forEach((member, index) => {
      member.username = names[index];
      if (member.runtime) Object.assign(member.runtime, { harness: index ? 'DeepSeek Harness' : 'Codex', provider: index ? 'DeepSeek' : 'OpenAI', model: index ? 'deepseek-v4-flash' : 'gpt-5.6-sol' });
    });
    this.sessions[0].name = text('Build the signup page', '一起做报名页');
    this.sessions[0].description = text('You are Alex: ask your AI agent to build the page and review changes. Maya helps choose the content and checks the result.', '你是陈晓：请 AI agent 制作页面并审核改动。林悦一起确定内容、检查成果。');
    this.sessions[1].name = text('My checklist', '我的检查清单');
    this.sessions[1].description = text('Personal preparation, readable by the project.', '个人准备事项，项目成员仍可阅读。');
    const events = this.events.get('session-orbit');
    const files = exampleProjectFiles(this.locale);
    const buttonCode = files.find(file => file.path === 'src/signup.js').content;
    const copy = [
      text('Alex, shall we make a signup page for our club event? People just need to see when and where it is, then click “Sign me up”. Should we add photos too?', '陈晓，咱们给社团做个活动报名页吧？大家看见时间、地点，再点“我要报名”就行。要不要再放几张照片？'),
      text('Yes! Let’s leave photos for later. Put Saturday at 2 pm, at the school sports field. Clicking “Sign me up” should show “You’re signed up”. I’ll ask my AI agent to make it; could you check it afterwards?', '好！照片以后再说。这次写清“周六下午两点，学校操场”，点“我要报名”后显示“报名成功”。我请我的 AI agent 来做，你帮忙检查一下？'),
      text('Build the page using the requirements in the summary above. Keep it to those agreed features, then tell us what you made and checked.', '按上面的摘要把报名页做出来吧，只做已经确定的功能。完成后告诉我们做了什么、检查了什么。'),
      text('The signup page is ready. Open `index.html` and try the button.\n\n**Project files**\n', '报名页做好了。打开 `index.html`，就能试一下按钮。\n\n**项目文件**\n')
        + '```text\nclub-signup/\n├── index.html\n├── styles.css\n├── src/signup.js\n├── tests/signup.test.cjs\n├── package.json\n└── README.md\n```\n\n'
        + text('`index.html` holds the event; `styles.css` sets the appearance. The button behavior lives in `src/signup.js`:\n\n', '`index.html` 放活动内容，`styles.css` 管外观。按钮动作在 `src/signup.js`：\n\n')
        + '```javascript\n' + buttonCode + '```\n\n'
        + text('Checks: `npm test` — 3 passed. Clicking shows “You’re signed up”; the button then disables to prevent repeats. The files are saved to Alex’s version for review. Photos are left out. This frontend demo does not send or save signup data.', '检查：`npm test`，3 项通过。点击后显示“报名成功”，按钮随即禁用，避免重复点击。文件已保存到陈晓的版本供审核，没有加入照片。这是前端示例，不发送或保存实际报名数据。'),
      text('@Alex I tried the page: the time, place and button are right. My Agent changed just one line in `src/signup.js`: “You’re signed up.” → “You’re signed up! See you Saturday.” I submitted my version for review. Check that change before merging it into the shared version.', '@陈晓 我试过页面了，时间、地点和按钮都对！我的 Agent 只改了 `src/signup.js` 中的一行：“报名成功。” → “报名成功！周六见。”，已提交审核。请看过这个改动，再合并到共享版本。'),
    ];
    events.forEach((event, index) => {
      const author = index === 0 || index === 4 ? 1 : 0;
      event.payload.content = copy[index];
      event.actor = { ...event.actor, id: this.sessions[0].members[author].userId, username: names[author] };
    });
    events[4].payload.mentions = [{ user_id: this.currentUser.id, display_name: names[0] }];
    events[4].replyTo = events[3].id;
    events[3].replyTo = events[2].id;
    events[3].provenance.username = names[0]; events[3].provenance.model = 'gpt-5.6-sol';
    // Put completed summaries before production so the visible story follows
    // discussion → focused requirements → AI-built files → team review.
    const discussion = events.slice(0, 2);
    const [build, answer, feedback] = events.slice(2);
    const progress = (id, kind, content, extra = {}) => ({ ...structuredClone(answer), id,
      type: 'agent_progress', replyTo: build.id, payload: { content, phase: 'stream',
        stream_mode: 'snapshot', stream_id: kind === 'plan' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
        stream_kind: kind, stream_revision: 1, stream_state: 'completed', ...extra } });
    const work = [
      progress('example-build-plan', 'plan', '', { plan: [
        { step: text('Build the page and button', '制作页面和报名按钮'), status: 'completed' },
        { step: text('Run the three behavior checks', '运行三个行为检查'), status: 'completed' },
        { step: text('Save files for teammate review', '保存文件，交给同伴检查'), status: 'completed' },
      ] }),
      progress('example-build-files', 'tool', text('Created: index.html, styles.css, src/signup.js\nAdded: tests/signup.test.cjs, package.json, README.md', '已创建：index.html、styles.css、src/signup.js\n已添加：tests/signup.test.cjs、package.json、README.md')),
      progress('example-build-check', 'tool', text(
        'npm test\n\n- ✓ Confirmation starts hidden\n- ✓ Clicking confirms signup\n- ✓ The button prevents repeated signup\n\n3 passed · 0 failed',
        'npm test\n\n- ✓ 初始不显示成功提示\n- ✓ 点击后显示报名成功\n- ✓ 按钮不能重复点击\n\n3 项通过 · 0 项失败'), { stream_id: '33333333-3333-4333-8333-333333333333' }),
    ];
    const summaryEvents = [];
    for (let version = 0; version < 2; version++) {
      const request = { ...structuredClone(events[2]), id: `example-summary-${version}`, replyTo: null,
        payload: { content: version === 0
          ? text('Summarize what we agreed to make. Leave ideas for later out, so the AI agent can focus on this task.', '总结我们这次确定要做的内容。以后再考虑的想法先不放进去，让 AI agent 专注这次的任务。')
          : text('Include the exact time and place, and turn that summary into a short build checklist.', '把具体时间、地点也写清楚，整理成一份简短的制作清单。'), history_summary: { version: 1,
          source_event_ids: discussion.map((event) => event.id), source_digest: '0'.repeat(64) } } };
      const response = { ...structuredClone(events[3]), id: `example-summary-response-${version}`,
        replyTo: request.id, payload: { content: version === 0
          ? text('Make one event signup page: show the time and place; clicking “Sign me up” confirms signup. No photos in this version.', '做一个活动报名页：显示时间、地点；点“我要报名”后提示报名成功。这次不放照片。')
          : text('Agreed build checklist:\n- Event: Saturday at 2 pm, school sports field.\n- One button: “Sign me up”; clicking shows “You’re signed up”.\n- No photos in this version.', '已确定的制作清单：\n- 活动时间、地点：周六下午两点，学校操场。\n- 一个“我要报名”按钮，点击后显示“报名成功”。\n- 这次不放照片。') } };
      summaryEvents.push(request, response);
    }
    events.splice(0, events.length, ...discussion, ...summaryEvents, build, ...work, answer, feedback);
    // Keep sequence and timestamps ordered after arranging the authored story.
    const startTime = Date.parse(events[0].createdAt);
    events.forEach((event, index) => {
      event.sequence = index + 1;
      event.createdAt = new Date(startTime + index * 60_000).toISOString();
    });
    const note = this.events.get('session-notes')[0];
    note.type = 'human_chat'; note.payload = { content: text('Before approving: check the time and place, then click the signup button once. Keep my own checklist here; the team can still read it.', '审核前再检查一遍时间、地点，然后点一下报名按钮。这里记我自己的检查事项，项目成员也能看到。') }; note.actor = { ...note.actor, id: this.currentUser.id, username: names[0] };
    this.codeRepositories.set('project-orbit', { repository: { enabled: true, main_commit: '1'.repeat(40) },
      own_branch_id: 'branch-example', branches: [
        { id: 'branch-example', name: 'gt/alex', user_id: this.currentUser.id, head_commit: '2'.repeat(40), review_status: 'draft' },
        { id: 'branch-maya', name: 'gt/maya', user_id: 'user-maya', head_commit: '3'.repeat(40), review_status: 'requested' },
      ] });
  }
  // Translate only authored seed fields. Practice edits, roles, requests and
  // drafts remain in this instance, including when Settings previews/cancels.
  setLocale(locale, projections = {}) {
    locale = locale === 'zh-CN' ? 'zh-CN' : 'en';
    if (locale === this.locale) return;
    const before = new ExampleCollaborationApi(this.locale);
    const after = new ExampleCollaborationApi(locale);
    const rename = (object, old, next, fields) => {
      if (!object || !old || !next) return;
      for (const field of fields) if (object[field] === old[field]) object[field] = next[field];
    };
    const oldMembers = before.sessions[0].members;
    const newMembers = after.sessions[0].members;
    const renameMember = (object, id) => rename(object,
      oldMembers.find((member) => member.userId === id),
      newMembers.find((member) => member.userId === id), ['username']);
    for (const user of [this.currentUser, projections.currentUser]) renameMember(user, user?.id);
    for (const project of [...this.projects, ...(projections.projects ?? []), projections.project]) {
      rename(project, before.projects.find((item) => item.id === project?.id), after.projects.find((item) => item.id === project?.id), ['name']);
    }
    for (const session of [...this.sessions, ...(projections.sessions ?? []), projections.session]) {
      rename(session, before.sessions.find((item) => item.id === session?.id), after.sessions.find((item) => item.id === session?.id), ['name', 'description']);
      for (const member of session?.members ?? []) renameMember(member, member.userId);
    }
    for (const member of projections.projectMembers ?? []) renameMember(member, member.userId);
    const oldEvents = [...before.events.values()].flat();
    const newEvents = [...after.events.values()].flat();
    for (const event of [...this.events.values()].flat().concat(projections.events ?? [])) {
      const oldPayload = oldEvents.find((item) => item.id === event.id)?.payload;
      const nextPayload = newEvents.find((item) => item.id === event.id)?.payload;
      rename(event.payload, oldPayload, nextPayload, ['content']);
      if (oldPayload?.plan && JSON.stringify(event.payload.plan) === JSON.stringify(oldPayload.plan)) event.payload.plan = structuredClone(nextPayload.plan);
      renameMember(event.actor, event.actor.id);
      renameMember(event.provenance, event.actor.id);
      for (const mention of event.payload.mentions ?? []) {
        const old = oldMembers.find((member) => member.userId === mention.user_id);
        const next = newMembers.find((member) => member.userId === mention.user_id);
        if (old && mention.display_name === old.username) mention.display_name = next.username;
      }
    }
    this.locale = locale;
  }
  async getProjectCodeSnapshot(projectId, branchId) {
    const response = await super.getProjectCodeSnapshot(projectId, branchId);
    response.snapshot.files = exampleProjectFiles(this.locale, response.snapshot.commit === EXAMPLE_REVIEWED_COMMIT)
      .map(file => ({ path: file.path, content_base64: btoa(String.fromCharCode(...new TextEncoder().encode(file.content))), executable: false }));
    return response;
  }
  async restoreSession() { return { ...this.currentUser, device_id: 'device-demo' }; }
  async getHostedGithubStatus() {
    return { enabled: true, connected: true, login: 'example-club', binding: { repository: 'example-club/signup-page', base_branch: 'main' } };
  }
  async listHostedGithubTasks() { return { tasks: [] }; }
  async createSnapshotRequest(...args) {
    const request = await super.createSnapshotRequest(...args);
    // No runtime is contacted. Status is deterministic and immediately usable.
    for (let index = 0; index < 4; index++) await super.getSnapshotRequest(request.id);
    return super.getSnapshotRequest(request.id);
  }
}
