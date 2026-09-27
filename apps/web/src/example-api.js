import { MockCollaborationApi } from './api.js?v=20260927-1';

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
    const copy = [
      text('Alex, shall we make a signup page for our club event? People just need to see when and where it is, then click “Sign me up”. Should we add photos too?', '陈晓，咱们给社团做个活动报名页吧？大家看见时间、地点，再点“我要报名”就行。要不要再放几张照片？'),
      text('Yes! Let’s leave photos for later. Put Saturday at 2 pm, at the school sports field. Clicking “Sign me up” should show “You’re signed up”. I’ll ask my AI agent to make it; could you check it afterwards?', '好！照片以后再说。这次写清“周六下午两点，学校操场”，点“我要报名”后显示“报名成功”。我请我的 AI agent 来做，你帮忙检查一下？'),
      text('Build the page using the requirements in the summary above. Keep it to those agreed features, then tell us what you made and checked.', '按上面的摘要把报名页做出来吧，只做已经确定的功能。完成后告诉我们做了什么、检查了什么。'),
      text('Done: I created the page file with the event time, place and a “Sign me up” button. I checked that clicking it shows “You’re signed up”. The file is uploaded to Alex’s version for Maya to review. I followed the summarized requirements and left photos out.', '做好了：已生成页面文件，写上活动时间、地点和“我要报名”按钮。我检查了按钮，点击后会显示“报名成功”。文件已上传到陈晓的版本，林悦可以查看并继续修改。这次按摘要中的要求制作，没有加入照片。'),
      text('@Alex Looks good! I asked my AI agent to make the confirmation friendlier: “You’re signed up! See you Saturday.” My updated file version is submitted for your review; once you approve it, we can bring it into the shared version.', '@陈晓 看过啦，时间地点都对！我让我的 AI agent 把提示改成“报名成功！周六见。”，并把改好的文件版本提交审核了。你确认后，我们就能整合到共享版本。'),
    ];
    events.forEach((event, index) => {
      const author = index === 0 || index === 4 ? 1 : 0;
      event.payload.content = copy[index];
      event.actor = { ...event.actor, id: this.sessions[0].members[author].userId, username: names[author] };
    });
    events[4].payload.mentions = [{ user_id: this.currentUser.id, display_name: names[0] }];
    events[3].replyTo = events[2].id;
    events[3].provenance.username = names[0]; events[3].provenance.model = 'gpt-5.6-sol';
    // Put completed summaries before production so the visible story follows
    // discussion → focused requirements → AI-built files → team review.
    const discussion = events.slice(0, 2);
    const production = events.slice(2);
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
    events.splice(0, events.length, ...discussion, ...summaryEvents, ...production);
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
      rename(event.payload, oldEvents.find((item) => item.id === event.id)?.payload,
        newEvents.find((item) => item.id === event.id)?.payload, ['content']);
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
    const zh = this.locale === 'zh-CN';
    const improved = branchId === 'branch-maya';
    const title = zh ? '社团活动报名' : 'Club event signup';
    const button = zh ? '我要报名' : 'Sign me up';
    const confirmation = zh ? `报名成功${improved ? '！周六见。' : '。'}` : `You’re signed up${improved ? '! See you Saturday.' : '.'}`;
    const html = `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:20px system-ui;background:#f2f8f5;color:#18382e;display:grid;place-items:center;min-height:100vh;margin:0}main{background:white;padding:40px;border-radius:24px;max-width:480px;margin:20px}button{font:inherit;color:white;background:#087f69;padding:14px 24px;border:0;border-radius:12px;cursor:pointer}</style>
<main><h1>${title}</h1><p>${zh ? '时间：周六下午两点' : 'When: Saturday at 2 pm'}</p><p>${zh ? '地点：学校操场' : 'Where: school sports field'}</p><button type="button" id="signup">${button}</button><p id="confirmation" role="status" hidden>${confirmation}</p></main>
<script>document.getElementById('signup').addEventListener('click',()=>{document.getElementById('confirmation').hidden=false;});</script></html>`;
    response.snapshot.files = [{ path: 'signup.html', content_base64: btoa(String.fromCharCode(...new TextEncoder().encode(html))), executable: false }];
    return response;
  }
  async restoreSession() { return { ...this.currentUser, device_id: 'device-demo' }; }
  async createSnapshotRequest(...args) {
    const request = await super.createSnapshotRequest(...args);
    // No runtime is contacted. Status is deterministic and immediately usable.
    for (let index = 0; index < 4; index++) await super.getSnapshotRequest(request.id);
    return super.getSnapshotRequest(request.id);
  }
}
