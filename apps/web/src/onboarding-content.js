// All copy is authored UI text. Never interpolate account names, messages or files.
const step = (id, target, enTitle, zhTitle, en, zh, view) => ({ id, target, title: [enTitle, zhTitle], text: [en, zh], view });
export const GUIDE_LABELS = {
  basics: ["Start here", "从这里开始"],
  members: ["Work with people", "与他人协作"],
  history: ["Share conversation history", "分享会话历史"],
  files: ["Share project files", "分享项目文件"],
  summaries: ["Organize history with summaries", "用摘要整理历史"],
};
export const GUIDE_COPY = {
  next: ["Next", "下一步"], back: ["Back", "上一步"], done: ["Finish", "完成"],
  skip: ["Skip guide", "跳过引导"], more: ["More guides in Settings", "在设置中查看更多引导"],
  readonly: ["You can read this conversation. Writing requires permission; a personal conversation can only be written by its creator.", "你可以阅读此会话。发言需要权限；个人会话仅创建者可发言。"],
};
export function guideText(pair, locale) { return pair[locale === "zh-CN" ? 1 : 0]; }

const qualification = ["During this test, accounts joining by invitation without a test qualification code cannot create projects.", "当前测试阶段，未获得测试资格码、仅通过邀请密钥加入的用户无法创建项目。"];
const basics = [
  step("welcome", "", "A place to work together", "一起做事的地方", "GatherThread brings your team's discussion, shared files and local AI agents together. The guide uses an isolated example without changing your real projects. Skip or return to it in Settings at any time.", "GatherThread 让大家一起讨论、共享文件，并请各自的 AI agent 参与协作。引导使用独立示例，不会影响你的真实项目。可随时跳过，也可从设置重新进入。"),
  { ...step("project", "#project-select", "1 · Create or join a project", "1 · 创建或加入项目", "Create a project to start working with your team, or join an existing project using an invitation key from its owner. Switch projects here.", "创建项目，开始与团队协作；也可以使用创建者提供的邀请密钥加入已有项目。在这里切换项目。", "rail"), note: qualification },
  step("conversation", "#session-list", "2 · Choose a conversation", "2 · 选择会话", "Multi is a group conversation for discussion together. Solo is a personal conversation: only its creator writes, while project members can still read it.", "Multi 是多人会话，供大家一起讨论。Solo 是个人会话，仅会话创建者发言，项目成员仍可阅读。", "rail"),
  step("connect", "#connect-codex-button, #connect-dsh-button", "3 · Connect your AI agent", "3 · 连接自己的 AI agent", "Choose Connect Codex or Connect DeepSeek Harness and follow its setup. Enable your preferred AI agent in Settings. Please keep your computer's connection running during use.", "点击连接 Codex 或连接 DeepSeek Harness，按提示设置。在设置中启用想用的 AI agent，使用时请保持自己电脑上的连接。", "rail"),
  step("chat", "#send-chat-button", "4 · Talk to people", "4 · 与大家交流", "Send chat shares a message without running an AI agent. When you ask your AI agent for help, it can read these shared messages.", "“发送聊天”将消息分享给大家，不会运行 AI agent。你请 AI agent 帮忙时，它可以读取这些共享消息。", "conversation"),
  step("model", "#agent-request-profile", "5 · Choose your AI agent", "5 · 选择 AI agent 如何帮忙", "Choose an AI agent, model and reasoning effort. Use the defaults if unsure. Available choices depend on the connected AI agent; adjust defaults in Settings.", "选择 AI agent、模型和推理强度。不确定时用默认值即可。可选项取决于已连接的 AI agent，默认值可在设置中调整。", "conversation"),
  step("request", "#send-agent-button", "6 · Ask your AI agent", "6 · 请 AI agent 处理", "Request my agent asks your own AI agent to work using the shared conversation messages. Real requests may use model quota or modify local files; review approval prompts.", "“请求我的 Agent”会请你的 AI agent 读取之前的共享会话消息并处理任务。真实请求可能消耗模型额度或修改本地文件，请留意授权提示。", "conversation"),
  step("answer", "#timeline-region", "7 · Follow the discussion and progress", "7 · 查看讨论与协作进展", "Everyone's chat, summaries, AI agent replies and available work updates appear together. You can pause your own active request; continuing or retrying creates a new request.", "这里汇集大家的讨论、摘要、AI agent 回复及可用的工作进度。可暂停自己正在运行的请求；继续或重试会新建请求。", "conversation"),
  step("finish", "#settings-button", "Keep exploring", "继续探索", "Settings offers guides for collaboration, history, files and summaries. Browse the example project at any time to see complete usage examples. It also contains AI agent preferences and notifications. System notifications require your permission.", "设置中可查看协作、历史、文件和摘要教程。“自由浏览示例项目”可随时查看完整用法。这里还可调整 AI agent 偏好和通知，系统通知需要你授权。"),
];
const history = [
  step("sharing", "", "Share history through GatherThread", "通过 GatherThread 共享会话历史", "Messages sent in GatherThread are shared with authorized readers. A connected local AI agent and the cloud conversation can synchronize history in both directions: shared history reaches the AI agent, while local turns upload according to your settings. The following controls let you choose how.", "在 GatherThread 发送的消息会分享给有阅读权限的成员。连接后，本地 AI agent 与云端会话可双向同步历史：共享历史传给 AI agent，本地对话按设置上传。接下来介绍如何选择同步方式。"),
  step("upload", ".codex-auto-upload-control", "Choose automatic history upload", "选择自动上传本地历史", "Connected Codex conversations start with automatic upload on. Turn it off to keep new local turns local; your AI agent can still receive shared messages, and requests sent in GatherThread still work. DeepSeek Harness has this switch in its own GatherThread settings.", "已连接的 Codex 会话默认自动上传本地对话。关闭后，新本地对话不会自动分享；AI agent 仍能收到共享消息，你也仍可在 GatherThread 发起请求。DeepSeek Harness 的共序设置中也有此开关。", "details"),
  step("manual", "#upload-local-turns-button", "Upload completed turns when needed", "按需补传已完成的对话", "Upload local turns to cloud now shares eligible completed turns, including ones missed while disconnected. It does not change the automatic switch. DeepSeek Harness also offers manual upload in its settings.", "“立即从本地上传至云端”可补传符合条件的已完成对话，包括断开连接时遗漏的内容，不会改变自动上传开关。DeepSeek Harness 也可在其设置中手动上传。", "details"),
  step("import", "#import-visible-history-button", "Bring shared history into Codex", "把共享历史带到 Codex", "Import Codex history creates a new local task for a writable conversation. After checking the replacement, you need to archive the old task yourself. Long history may be compressed and use model quota. Disable initial automatic import in Settings if needed.", "可写会话的“导入 Codex 历史”会新建本地任务。检查新任务后，需要由你归档旧任务。长历史可能压缩并消耗模型额度，首次自动导入可在设置中关闭。", "details"),
  step("snapshot", "#download-codex-button", "Take a read-only copy", "带走一份只读副本", "In a read-only conversation, Download to Codex creates a separate copy of its current history. It neither follows later messages nor uploads local activity, and requires a connected Codex download device.", "只读会话可通过“下载到 Codex”创建当前历史的独立副本，不跟随后续消息，也不上传本地活动，需要连接 Codex 下载设备。", "snapshot"),
];
const summaries = [
  step("summary", "#history-summary-select-button", "Select history for a summary", "选择历史生成摘要", "Summaries organize long discussions; they do not change whether messages are shared between GatherThread and your local AI agent. Select completed messages or earlier summaries, then ask your connected AI agent to summarize them. Only writers with an available AI agent can generate a summary.", "摘要帮你整理长讨论，不会改变消息是否在 GatherThread 和本地 AI agent 之间共享。选择已完成的消息或已有摘要，再请已连接的 AI agent 总结。有发言权限且 AI agent 可用时才能生成摘要。", "conversation"),
  step("selection", "#history-summary-toolbar", "Choose sources and confirm", "选择内容并确认生成", "Select 1–100 messages or summaries. The combined text can be roughly 20,000 English letters or 6,000 Chinese characters; if it is too long, you will be asked to select less. Check your AI agent and instructions before confirming. A real request uses model quota; both your instructions and the summary are shared.", "可选 1–100 条消息或摘要。合计内容大约相当于 2 万个英文字母或 6000 个汉字；超出时会提示你减少选择。确认前检查 AI agent 和总结要求。真实生成会消耗模型额度；你的要求与摘要都会共享。", "summary-selection"),
  step("original", "#history-summary-view-button", "Switch between summary and originals", "切换摘要与原文", "After the first summary is completed, this toggle appears. Summaries may omit detail; original messages remain available.", "首次生成摘要后才会出现这个切换按钮。摘要可能遗漏细节，原始消息仍保留。", "conversation"),
  step("versions", "#history-summary-versions-button", "Review earlier summary versions", "查看摘要版本", "Open summary versions to review earlier results and their sources. A section's own toggle switches that section between its summary and original messages. Pending or failed generation is shown separately.", "打开摘要版本，可查看之前的结果及来源。每个摘要区域也可单独切换该段摘要与原文。生成中或失败的请求会单独显示。", "conversation"),
  step("preference", "#settings-history-context-mode", "Choose what your AI agent reads", "选择 AI agent 读取方式", "Under Summaries in Settings, Summary is recommended to help your AI agent focus on agreed conclusions and reduce distraction from unrelated discussion. Summaries organize conversations for easier reading, but may omit detail. Choose Original when exact wording or full details matter. This preference applies only to you in this project; it does not change other members' choices or the displayed view.", "在设置的“摘要”部分，推荐使用摘要，帮助 AI agent 聚焦已达成的核心结论，减少无关讨论干扰，在一定程度上缓解注意力分散。摘要也便于阅读和整理会话，但可能遗漏细节；需要核对完整表达或具体细节时，可选择原文。该偏好只对你在当前项目生效，不改变其他成员的选择或页面显示方式。", "summary-settings"),
];
const files = [
  step("files", "#project-code-button", "Share files within the team", "在项目成员间共享文件", "Project file collaboration lets members and their AI agents share, review, modify and manage files together, making full multiplayer AI agent work possible. Uploaded files are readable by every project member, including viewers, but are not public. Solo does not make project files private.", "项目文件协作让成员及各自的 AI agent 共同查看、修改和管理文件，实现完整的 AI agent 多人联机协作。已上传文件供项目内所有成员（包括访者）阅读，不对外公开；Solo 会话不代表项目文件私密。"),
  step("enable", "#code-enable-button", "The owner enables project sharing", "创建者启用项目文件共享", "The owner enables file sharing within the project. We recommend enabling it for full AI agent collaboration. Turning it off limits collaboration to text, without exchanging file data; reserve that choice for strict privacy needs.", "创建者在这里启用项目内的文件共享。建议开启，以实现完整 AI agent 多人联机协作；关闭后只能共享文字，无法交流文件数据，仅在严格隐私要求下建议关闭。", "code-enable"),
  step("access", "#code-runtime-select", "Authorize each local device separately", "单独授权每台本地设备", "After sharing is enabled, each collaborator must separately authorize their local AI agent to access this project's files, then select that device here. The webpage cannot grant local access. Upload only project files you intend to share.", "开启文件共享后，每位协作者还需单独在本地 AI agent 连接中授权访问该项目的文件，再在这里选择设备，网页不能代为授权。仅上传你希望在项目内共享的文件。", "code-device"),
  step("versions", "#code-upload-button", "Upload your own version", "上传自己的文件版本", "Select an authorized local device and upload to your own version. Automatic file upload starts off and is separate from history upload. Enable it to share settled file changes while your AI agent is idle, or upload manually when ready.", "选择已授权的本地设备，将文件上传到自己的版本。文件自动上传默认关闭，与历史上传独立。开启后可在 AI agent 空闲时分享稳定的文件改动，也可准备好后手动上传。", "code-device"),
  step("review", "#code-branch-list", "Review and combine the team's work", "查看并整合团队成果", "Inspect other members' versions and submit your own for review. Only the owner can approve and merge into the shared version. Conflicts pause integration for review, preserving everyone's work.", "查看其他成员的版本，并将自己的成果提交审核。只有创建者可审核并整合到共享版本；冲突会暂停整合，等待检查，保留大家的工作。", "code-branches"),
  step("download", "#code-download-button", "Bring shared files back locally", "取回共享文件", "Update your own cloud version from the shared version, then download to the selected device. Unuploaded local changes block replacement. Avoid having two AI agents edit the same local folder simultaneously.", "先将共享版本更新到自己的云端版本，再下载到所选设备。有未上传的本地改动时不会覆盖；避免两个 AI agent 同时修改同一个本地文件夹。", "code-device"),
  step("recover", ".code-recovery > summary", "Recover and pause sharing", "恢复文件与暂停共享", "Recovery creates a new folder from your last upload without replacing existing files. Never-uploaded work cannot be recovered. Turn sharing off only when strict privacy requires it: new file collaboration and recovery stop, text still syncs, and stored versions remain until explicitly cleared in Settings.", "恢复会根据上次上传建立新文件夹，不覆盖现有文件，未上传的工作无法恢复。仅在严格隐私要求下建议关闭共享：文件协作和恢复将暂停，文字仍同步；已有云端版本会保留，需在设置中另行清理。", "code-device"),
];
const members = [
  step("quote", ".message-actions button:nth-child(2)", "Point to a message", "引用某条消息", "Use the quote icon beside a message to reference it in your next chat or AI agent request. Cancel the draft quote before sending if needed. Clicking a sent quote locates its original message.", "点击消息旁的引用图标，在下一次聊天或 AI agent 请求中引用它。发送前可取消引用，点击已发送的引用可定位原文。", "conversation"),
  step("mention", "#mentions-button", "Call someone's attention", "请对方留意", "Type @ in the message box and choose a member from the list. The @ inbox shows messages mentioning you; unread marks reset on refresh.", "在输入框中输入 @，从列表选择成员。右上角 @ 可查看提到你的消息；未读标记刷新后会重置。", "conversation"),
  step("roles", "#member-list", "Understand the three project roles", "了解三种项目身份", "Owner: manages the project, members and invitations, creates Multi/Solo conversations and reviews shared file changes. Participant: creates their own Solo and uploads their own file versions. Both can write in Multi and their own Solo. Viewer: reads conversations and uploaded project files, without writing or modifying them.", "创建者：管理项目、成员和邀请，创建 Multi/Solo 会话，并审核整合文件。参与者：可创建自己的 Solo，上传自己的文件版本。两者均可在 Multi 和自己的 Solo 中发言。访者：可阅读会话和已上传项目文件，不能发言或修改。", "members"),
  { ...step("join", "#accept-invitation-form", "Join with an invitation key", "通过邀请密钥加入项目", "Ask the project's owner for a one-use invitation key beginning with gti, then enter it here. The owner chooses whether the invitation grants participant or viewer access.", "向项目创建者获取 gti 开头的一次性邀请密钥，在这里输入并加入。创建者为邀请选择参与者或访者身份。", "members"), note: qualification },
  step("manage", "#rename-project-button", "The owner manages the project", "创建者管理项目", "The owner can use Rename project to update its name. Delete cloud project is a separate action: it permanently deletes cloud data but retains everyone's local files and tasks.", "创建者可通过“重命名项目”更改名称。“删除云端项目”是另一个操作，会永久删除云端数据，保留大家的本地文件和任务。", "rail"),
  step("leave", "#leave-project-button", "Participants and viewers can leave", "参与者与访者退出项目", "Participants and viewers can leave the project. Before leaving, explicitly delete your uploaded version or wait for the owner to review and integrate it. Your local files remain. The owner manages cloud deletion instead.", "参与者与访者可以退出项目。退出前，需明确删除自己已上传的版本，或等待创建者审核整合；本地文件保留。创建者则管理云端项目的删除。", "leave"),
];

export function guideSteps(topic) {
  // Every guide runs in the isolated, fully populated example, even for empty accounts.
  return { basics, members, history, files, summaries }[topic] ?? basics;
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
