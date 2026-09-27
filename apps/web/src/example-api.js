import { MockCollaborationApi } from './api.js?v=20260927-1';

// This API is reachable only from the dedicated example document. Its mutations
// are ordinary mock mutations in fresh memory, with no backend or local runtime.
export class ExampleCollaborationApi extends MockCollaborationApi {
  constructor(locale = 'en') {
    super({ latency: 0 });
    const zh = locale === 'zh-CN';
    const text = (en, cn) => zh ? cn : en;
    this.currentUser.username = text('Avery', '小何');
    this.projects[0].name = text('Weekend plan · example', '周末计划 · 示例');
    const names = [this.currentUser.username, text('Maya', '小林'), text('Jon', '小周')];
    for (const session of this.sessions) session.members.forEach((member, index) => {
      member.username = names[index];
      if (member.runtime) Object.assign(member.runtime, { harness: index ? 'DeepSeek Harness' : 'Codex', provider: index ? 'DeepSeek' : 'OpenAI', model: index ? 'deepseek-v4-flash' : 'gpt-5.6-sol' });
    });
    this.sessions[0].name = text('Plan together', '一起制定计划');
    this.sessions[0].description = text('Agree on a route and budget, then share the itinerary file.', '商量路线与预算，再共同整理行程文件。');
    this.sessions[1].name = text('Personal notes', '个人备忘');
    this.sessions[1].description = text('Personal preparation, readable by the project.', '个人准备事项，项目成员仍可阅读。');
    const events = this.events.get('session-orbit');
    const copy = [
      text('Let’s walk by the river on Saturday morning.', '周六上午沿江散步吧。'),
      text('I suggest a lunch budget of 60 per person.', '午餐预算建议每人 60 元。'),
      text('Combine everyone’s route and budget into a weekend plan.', '结合大家的路线和预算，整理周末计划。'),
      text('From Maya’s route and Avery’s budget: meet at 10, walk by the river, then have lunch within 60 per person. The team can review itinerary.md together.', '结合小林的路线和小何的预算：10 点集合，沿江散步，再安排每人 60 元以内的午餐。大家可以共同检查 itinerary.md。'),
      text('@Avery I can check the itinerary file and add a meeting point.', '@小何 我可以检查行程文件并补充集合地点。'),
    ];
    events.forEach((event, index) => {
      const author = index === 0 || index === 4 ? 1 : 0;
      event.payload.content = copy[index];
      event.actor = { ...event.actor, id: this.sessions[0].members[author].userId, username: names[author] };
    });
    events[4].payload.mentions = [{ user_id: this.currentUser.id, display_name: names[0] }];
    events[3].replyTo = events[2].id;
    events[3].provenance.username = names[0]; events[3].provenance.model = 'gpt-5.6-sol';
    // Two valid completed summary versions expose all summary controls on first visit.
    for (let version = 0; version < 2; version++) {
      const sequence = events.length + 1;
      const request = { ...structuredClone(events[2]), id: `example-summary-${version}`, sequence, replyTo: null,
        payload: { content: text('Summarize our plan.', '总结我们的计划。'), history_summary: { version: 1,
          source_event_ids: events.slice(0, 2).map((event) => event.id), source_digest: '0'.repeat(64) } } };
      const response = { ...structuredClone(events[3]), id: `example-summary-response-${version}`, sequence: sequence + 1,
        replyTo: request.id, payload: { content: text('Saturday: riverside walk, lunch budget 60 per person. Review itinerary.md together.', '周六沿江散步，午餐预算每人 60 元；共同检查 itinerary.md。') } };
      events.push(request, response);
    }
    const note = this.events.get('session-notes')[0];
    note.type = 'human_chat'; note.payload = { content: text('Remember comfortable shoes and check the weather.', '记得穿舒适的鞋，并查看天气。') }; note.actor = { ...note.actor, id: this.currentUser.id, username: names[0] };
    this.codeRepositories.set('project-orbit', { repository: { enabled: true, main_commit: '1'.repeat(40) },
      own_branch_id: 'branch-example', branches: [
        { id: 'branch-example', name: 'gt/avery', user_id: this.currentUser.id, head_commit: '2'.repeat(40), review_status: 'draft' },
        { id: 'branch-maya', name: 'gt/maya', user_id: 'user-maya', head_commit: '3'.repeat(40), review_status: 'requested' },
      ] });
  }
  async getProjectCodeSnapshot(projectId, branchId) {
    const response = await super.getProjectCodeSnapshot(projectId, branchId);
    response.snapshot.files = [{ path: "itinerary.md", content_base64: btoa("# Weekend plan\nMeet at 10. Riverside walk, then lunch. Budget: 60 per person.\n" + (branchId === "branch-maya" ? "Meeting point: riverside entrance.\n" : "")), executable: false }];
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
