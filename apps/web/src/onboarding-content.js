// All copy is authored UI text. Never interpolate account names, messages or files.
const step = (id, target, enTitle, zhTitle, en, zh, view) => ({ id, target, title: [enTitle, zhTitle], text: [en, zh], view });
export const GUIDE_LABELS = {
  basics: ["Start here", "从这里开始"],
  history: ["Share conversation history", "分享会话历史"],
  files: ["Share project files", "分享项目文件"],
  members: ["Work with people", "与他人协作"],
};
export const GUIDE_COPY = {
  next: ["Next", "下一步"], back: ["Back", "上一步"], done: ["Finish", "完成"],
  skip: ["Skip guide", "跳过引导"], more: ["More guides in Settings", "在设置中查看更多引导"],
  missing: ["The control is currently outside this view or unavailable. Find it in the section described above, or revisit this guide in Settings.", "对应按钮目前不在可见区域，或功能尚不可用。可到上述位置查找，也可在设置中重新查看引导。"],
  empty: ["Create or join a project, then open a conversation to find these controls.", "建立或加入项目，再打开会话，即可找到这些按钮。"],
  readonly: ["You can read this conversation. Writing requires permission; a personal conversation can only be written by its creator.", "你可以阅读此会话。发言需要权限；个人会话仅创建者可发言。"],
};
export function guideText(pair, locale) { return pair[locale === "zh-CN" ? 1 : 0]; }

const basics = [
  step("welcome", "#current-username", "A place to work together", "一起做事的地方", "People discuss a project here. Your own AI assistant can help when you ask. This guide only shows the controls; you can skip any time.", "大家在这里讨论项目，需要时请自己的 AI 助手帮忙。引导只介绍按钮，你可以随时跳过。"),
  step("project", "#project-select, #new-project-button, #topbar-create-project-button", "1 · Choose a project", "1 · 选择项目", "A project holds your conversations and members. Create one if your account allows it, or use an invitation from its owner to join.", "项目放着会话和成员。有创建资格时可新建项目，也可用负责人给的邀请加入。", "rail"),
  step("conversation", "#new-session-button, #session-list, #empty-state", "2 · Open a conversation", "2 · 打开会话", "The owner can create a group conversation (Multi). You can create a personal one (Solo) if allowed: only you write, but project members can read. Viewers only read.", "负责人可建多人会话（Multi）。有权限时可建个人会话（Solo）：仅你发言，项目成员仍可阅读。只读成员只能阅读。", "rail"),
  step("connect", "#connect-codex-button, #connect-dsh-button", "3 · Connect your assistant", "3 · 连接自己的助手", "Choose Connect Codex or Connect DeepSeek Harness and follow its setup. Enable your preferred assistant in Settings. Keep it connected on your computer to receive requests.", "点击连接 Codex 或连接 DeepSeek Harness，按提示设置。在设置中启用想用的助手，使用时保持自己电脑上的连接。", "rail"),
  step("chat", "#send-chat-button", "4 · Talk to people", "4 · 与大家交流", "Send chat shares your words with the conversation. It does not ask an assistant to work. Optional idea: “I would like to plan our weekend trip.”", "“发送聊天”把文字分享给会话中的大家，不会让助手开始工作。可尝试说：“我想一起安排周末出游。”", "conversation"),
  step("model", "#agent-request-profile", "5 · Choose how it helps", "5 · 选择助手如何帮忙", "Choose your assistant, model and thinking level here. Use the defaults if unsure. Available choices depend on your connection; defaults can be adjusted in Settings.", "在这里选助手、模型和思考程度。不确定时用默认值即可。选项取决于已连接的助手，默认值可在设置中调整。", "conversation"),
  step("request", "#send-agent-button", "6 · Ask your assistant", "6 · 请助手处理", "Request my agent asks your own assistant to work. Optional idea: “Turn this plan into three clear steps.” It may use paid model quota or change local files; review its approvals.", "“请求我的 Agent”会让自己的 AI 助手处理。可尝试发送：“把这份计划整理成三个步骤。”可能消耗模型额度或修改本地文件，请留意授权提示。", "conversation"),
  step("answer", "#timeline-region", "7 · Read the answer", "7 · 查看回答", "The answer appears here, with work updates when available. You can pause your own active request; continuing or retrying starts a new request. No need to send the examples.", "回答会出现在这里，有时也会显示工作进度。自己的请求可暂停；继续或重试会新建请求。不必实际发送示例。", "conversation"),
  step("finish", "#settings-button", "Ready when you are", "可以开始了", "Settings has short guides for quotes, history, files and invitations. You can also adjust your assistant, history preferences and notifications there. System notifications need your permission.", "设置中可按需查看引用、历史、文件和邀请的简短引导，也可调整助手、历史偏好和通知。系统通知需要你授权。"),
];
const history = [
  step("sharing", "#session-context-details > summary", "What gets shared?", "哪些内容会分享？", "Messages sent here are shared with authorized conversation readers. Local assistant history is shared only through an enabled connection and its upload choice. Review private content before sharing.", "在这里发送的消息会分享给有阅读权限的人。本地助手的会话历史通过已启用的连接和上传选择来分享，请先检查私密内容。"),
  step("upload", "#codex-auto-upload-toggle, #codex-local-sync-controls", "Choose local history upload", "选择本地历史上传", "For a connected Codex conversation, automatic upload starts on. Turn it off to keep new local turns local. This does not stop shared messages arriving or requests you send here. DSH has the same choice in its own GatherThread settings.", "已连接的 Codex 会话默认自动上传。关闭后，新本地对话不自动分享；共享消息接收和在这里发起的请求仍独立运行。DSH 在自己的共序设置中也有此开关。", "details"),
  step("manual", "#upload-local-turns-button", "Share missed conversations", "补传已完成的对话", "Upload local turns to cloud now shares eligible completed turns, including missed ones. It does not change the automatic switch. DSH offers manual upload in its own settings too.", "“立即上传本地对话到云端”可补传符合条件的已完成对话，不会改变自动上传开关。DSH 也可在自己的设置中手动上传。", "details"),
  step("import", "#import-visible-history-button, #visible-history-controls", "Bring shared history into Codex", "把共享历史带到 Codex", "Import Codex history creates a new local task for a writable conversation. Check it, then archive the old task yourself. Long history may be summarized and use model quota. Initial import can be disabled in Settings.", "可写会话的“导入 Codex 历史”会新建本地任务。检查后由你归档旧任务。长历史可能压缩并消耗模型额度，首次自动导入可在设置中关闭。", "details"),
  step("snapshot", "#download-codex-button", "Take a read-only copy", "带走一份只读副本", "For a conversation you cannot write, Download to Codex makes a separate copy of the history so far. It does not follow later messages or publish local activity. This needs a connected Codex download device.", "不能发言的会话可“下载到 Codex”，得到当时历史的独立副本。它不跟随后续消息，也不上传本地活动，需要连接 Codex 下载设备。"),
  step("summary", "#history-summary-select-button, .session-header", "Make a shared summary", "生成共享总结", "When allowed, select finished messages and generate a summary with your own connected assistant. It may use model quota. The summary and your instructions are shared; check them for private details.", "有权限时可选择已完成的消息，请自己已连接的助手生成总结，可能消耗模型额度。总结和你的要求会共享，请检查私密内容。"),
  step("original", "#history-summary-view-button, #history-summary-versions-button, .session-header", "Keep the original within reach", "随时查看原文", "Switch between summaries and original messages, and inspect earlier summary versions. Summaries can miss details. The assistant's reading preference is separate and can be adjusted in Settings for your account and project.", "可切换总结与原文，也可查看之前的总结版本。总结可能遗漏细节。助手读取总结还是原文是独立偏好，可在设置中按自己的账号和项目调整。"),
];
const files = [
  step("files", "#project-code-button", "Files are a separate choice", "文件分享单独选择", "File sharing is optional. All project members can read uploaded files, including viewers. A personal conversation does not make files private. Check for secrets before uploading.", "文件分享是可选的。上传后，全部项目成员，包括只读成员，都可阅读。个人会话不代表文件私密，上传前请检查敏感信息。"),
  step("enable", "#code-enable-section, #code-enabled-home, #code-no-project", "The owner enables sharing", "负责人启用分享", "The owner enables project file storage. Each person also allows file access on their own computer. A webpage cannot grant that access. If sharing is off, these controls appear after it is enabled.", "负责人启用项目文件存储，每个人还需在自己电脑上允许文件访问，网页不能替你授权。功能关闭时，对应按钮会在启用后出现。", "code-overview"),
  step("versions", "#code-upload-button, #code-device-view", "Save your own version", "保存自己的版本", "Choose your connected device and upload files to your own version. Automatic file upload starts off and is separate from history upload. You can turn it off here without turning off conversations.", "选自己的已连接设备，将文件上传到自己的版本。文件自动上传默认关闭，与会话历史上传独立；关闭它不影响会话。", "code-device"),
  step("review", "#code-branch-list, #code-branches-view", "Compare and combine", "查看与整合", "Read other members' versions here. Submit yours for review; only the owner can approve and combine it into the project's shared version. Conflicts stop the update for review.", "在这里查看他人版本，将自己的版本提交审核。只有负责人可审核并整合到项目的共享版本，遇到冲突会暂停等待检查。", "code-branches"),
  step("download", "#code-download-button, #code-device-view", "Get the shared result", "取回整合结果", "First update your cloud version from the shared version, then download your own version to your device. Unuploaded changes block replacement. Avoid two assistants editing one folder at the same time.", "先将共享版本更新到自己的云端版本，再下载到设备。有未上传改动时不会覆盖；避免两个助手同时修改同一个文件夹。", "code-device"),
  step("recover", ".code-recovery > summary, #code-device-view", "Recover uploaded files", "恢复已上传文件", "Recovery creates a new folder from your last upload. It preserves existing files, but cannot recover anything never uploaded. The owner can pause file sharing; stored versions remain until explicitly cleared in Settings.", "恢复会用上次上传内容建立新文件夹，保留现有文件，未上传内容无法恢复。负责人可暂停文件分享；已存版本仍保留，需在设置中明确清理。", "code-device"),
];
const members = [
  step("quote", ".message-actions button:nth-child(2), #timeline-region", "Point to a message", "指向某条消息", "Use the quote icon beside a message to reference it in your next chat or assistant request. You can cancel the draft quote. Clicking a sent quote opens the original.", "点击消息旁的引用图标，下一次聊天或助手请求可引用它。发送前可取消引用，点击已发送的引用可定位原文。"),
  step("mention", "#message-input, #mentions-button", "Call someone's attention", "请对方留意", "Type @ and choose a member from the list. A typed name alone does not notify them. The @ inbox finds messages mentioning you; its unread marks reset on refresh.", "输入 @ 后从列表选择成员，只打名字不会提醒对方。右上角 @ 可查看提到你的消息；未读标记刷新后会重置。"),
  step("invite", "#owner-invitations, #member-list, #member-panel", "Invite people with the right role", "按合适角色邀请成员", "Only the owner creates one-use invitations and changes member roles. Participants can write in group conversations and their own personal ones. Viewers read only. Never share your own login credential.", "只有负责人能创建一次性邀请和修改成员角色。参与者可在多人会话和自己的个人会话发言，只读成员只能阅读。不要分享自己的登录凭证。", "members"),
  step("join", "#accept-invitation-form, #member-panel", "Join another project", "加入另一个项目", "Use its owner's invitation here. Project access and account creation eligibility are separate; an invitation does not grant permission to create new projects.", "在这里使用另一个项目负责人给的邀请。项目权限和账号创建资格独立，收到项目邀请不代表可以新建项目。", "members"),
  step("leave", "#leave-project-button, #rename-project-button, #project-select", "Leave or manage a project", "退出或管理项目", "Participants and viewers can leave. Resolve your uploaded version first: delete it explicitly, or wait for owner review and integration. Local files stay. Owners manage names and cloud deletion; deletion is permanent in the cloud.", "参与者和只读成员可退出。先处理自己已上传的版本：明确删除，或等待负责人审核整合。本地文件保留。负责人可改名和删除云端项目，云端删除不可恢复。", "rail"),
];

export function guideSteps(topic, context = {}) {
  const items = { basics, history, files, members }[topic] ?? basics;
  // Empty accounts finish a small actionable tour; optional guides still explain
  // the unavailable features without inventing a conversation or running an AI.
  return topic === "basics" && !context.session
    ? items.filter((item) => ["welcome", "project", "conversation", "connect", "finish"].includes(item.id))
    : items;
}

export function onboardingKey({ userId, deviceId, origin }) {
  if (![userId, deviceId, origin].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)) return null;
  return `gatherthread.onboarding.v1:${JSON.stringify([origin, userId, deviceId])}`;
}

export function createOnboardingProgress(storage) {
  const seen = new Set();
  return {
    has(key) {
      if (!key) return true;
      try { return seen.has(key) || ["completed", "skipped"].includes(storage?.getItem(key)); }
      catch { return seen.has(key); }
    },
    mark(key, status) {
      if (!key || !["completed", "skipped"].includes(status)) return;
      seen.add(key);
      try { storage?.setItem(key, status); } catch { /* Retain progress for this page when storage is unavailable. */ }
    },
  };
}
