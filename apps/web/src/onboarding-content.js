// All copy is authored UI text. Never interpolate account names, messages or files.
const step = (id, target, enTitle, zhTitle, en, zh, view) => ({ id, target, title: [enTitle, zhTitle], text: [en, zh], view });
export const GUIDE_LABELS = {
  basics: ["Start here", "从这里开始"],
  members: ["Work with people", "与他人协作"],
  history: ["Share conversation history", "分享会话历史"],
  files: ["Share project files", "分享项目文件"],
  summaries: ["Organize history with summaries", "用摘要整理历史"],
  account: ["Your account and devices", "账号与设备"],
};
export const GUIDE_COPY = {
  next: ["Next", "下一步"], back: ["Back", "上一步"], done: ["Finish", "完成"],
  skip: ["Skip guide", "跳过引导"], more: ["More guides in Settings", "在设置中查看更多引导"],
  readonly: ["You can read this conversation. Writing requires permission; a personal conversation can only be written by its creator.", "你可以阅读此会话。发言需要权限；个人会话仅创建者可发言。"],
};
export function guideText(pair, locale) { return pair[locale === "zh-CN" ? 1 : 0]; }

const basics = [
  step("welcome", "", "A place to work together", "一起做事的地方", "GatherThread brings your team's discussion, shared files and local AI agents together. The guide uses an isolated example without changing your real projects. Skip or return to it in Settings at any time.", "GatherThread 让大家一起讨论、共享文件，并请各自的 AI agent 参与协作。引导使用独立示例，不会影响你的真实项目。可随时跳过，也可从设置重新进入。"),
  { ...step("project", "#project-select", "1 · Create or join a project", "1 · 创建或加入项目", "Create a project to start working with your team, or join an existing project using an invitation key from its owner. Switch projects here.", "创建项目，开始与团队协作；也可以使用创建者提供的邀请密钥加入已有项目。在这里切换项目。", "rail") },
  step("conversation", "#session-list", "2 · Choose a conversation", "2 · 选择会话", "Multi is a group conversation for discussion together. Solo is a personal conversation: only its creator writes, while project members can still read it.", "Multi 是多人会话，供大家一起讨论。Solo 是个人会话，仅会话创建者发言，项目成员仍可阅读。", "rail"),
  step("create-conversation", "#new-session-button", "3 · Create a conversation", "3 · 创建会话", "Use + to start a Multi or Solo conversation and name it. After the guide, you can try this in the free example.", "点 + 新建 Multi 或 Solo 会话并命名。结束引导后，可在自由示例中试用。", "rail"),
  step("connect", "#connect-codex-button, #connect-dsh-button", "4 · Choose your AI agent", "4 · 选择 AI agent", "Choose Cloud Agent to start without a local setup, or connect Codex or DeepSeek Harness on your computer. A local AI agent is available only while that computer and its connection stay online.", "可直接选择云端 Agent 开始使用，无需在本地连接；也可在电脑上连接 Codex 或 DeepSeek Harness。使用本地 AI agent 时，电脑和连接程序需要保持在线。", "rail"),
  step("chat", "#send-chat-button", "5 · Talk to people", "5 · 与大家交流", "Send chat shares a message without running an AI agent. When you ask your AI agent for help, it can read these shared messages.", "“发送聊天”将消息分享给大家，不会运行 AI agent。你请 AI agent 帮忙时，它可以读取这些共享消息。", "conversation"),
  step("model", "#agent-request-profile", "6 · Choose your AI agent", "6 · 选择 AI agent 如何帮忙", "Choose an AI agent, model and reasoning effort. Use the defaults if unsure. Available choices depend on the connected AI agent; adjust defaults in Settings.", "选择 AI agent、模型和推理强度。不确定时用默认值即可。可选项取决于已连接的 AI agent，默认值可在设置中调整。", "conversation"),
  step("request", "#send-agent-button", "7 · Ask your AI agent", "7 · 请 AI agent 处理", "Request my agent asks your own AI agent to work using the shared conversation messages. Real requests may use model quota or modify local files; review approval prompts.", "“请求我的 Agent”会请你的 AI agent 读取之前的共享会话消息并处理任务。真实请求可能消耗模型额度或修改本地文件，请留意授权提示。", "conversation"),
  step("answer", "#timeline-region", "8 · Follow the discussion and progress", "8 · 查看讨论与协作进展", "Everyone's chat, summaries, AI agent replies and work updates appear together. You can pause your own active request. Resume starts a new request with your original instructions and the latest shared discussion; it does not restart the paused run in place.", "这里汇集大家的讨论、摘要、AI agent 回复和工作进度。你可以暂停自己的请求。“继续”会带着原来的要求和最新共享讨论发起新请求，不是让已暂停的运行原地接着执行。", "conversation"),
  step("finish", "#settings-button", "Keep exploring", "继续探索", "Settings has more guides and AI agent preferences. Open the isolated example whenever you want to try a complete project workflow without changing your own work.", "设置中还有更多教程和 AI agent 偏好。你可以随时打开独立示例，试用完整项目流程；示例操作不会改动自己的项目。"),
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
  step("files", "#project-code-button", "Choose where the team shares files", "选择团队共享文件的方式", "For real development or larger projects, connect your own GitHub repository. GatherThread does not count those files against its storage quota; GitHub has its own limits and access rules. For a small trial, use GatherThread's limited GT Cloud storage. Neither choice automatically moves files to the other.", "实际开发或较大项目，推荐连接自己的 GitHub 仓库；这些文件不占 GatherThread 存储额度，但仍受 GitHub 的容量和权限规则约束。轻量体验可用 GatherThread 提供的有限额 GT Cloud 存储。两种方式不会自动互相迁移文件。"),
  step("github", "#code-provider-github", "Connect your own GitHub repository", "连接自己的 GitHub 仓库", "Choose GitHub in file sharing. The project owner connects the repository; each collaborator still needs access granted on GitHub. Only share files your team intends to work on, and keep secrets out of uploads.", "在文件共享中选择 GitHub。项目创建者连接仓库；协作者还需要在 GitHub 获得相应权限。只共享团队准备协作的文件，不要上传密钥等敏感内容。", "code-github"),
  step("github-sync", "#github-code-runtime", "Choose a computer for file work", "选择处理文件的电脑", "Each person authorizes a local device for this repository, then selects it here. File synchronization is separate from conversation history. Keep the selected computer and connection online when uploading or downloading files.", "每位成员先为这个仓库授权自己的本地设备，再在这里选择它。文件同步与会话历史同步各自独立；上传和下载时，所选电脑与连接程序需要在线。", "code-github"),
  step("github-auth", "#github-code-auth", "Connect GitHub on this computer", "在这台电脑连接 GitHub", "Use this button to sign in through GitHub in your browser. Each computer handling files needs its own authorization. Never paste GitHub credentials into a chat or shared file.", "点这里在浏览器中登录 GitHub。每台处理文件的电脑都要单独授权，不要把 GitHub 凭据粘贴到聊天或共享文件中。", "code-github"),
  step("github-auto", "#github-code-auto", "Choose automatic file upload", "选择文件自动上传", "A newly authorized GitHub connection starts with automatic upload on: settled changes upload while your AI agent is idle. You can turn it off and upload manually. This switch is separate from conversation history upload and never merges or downloads files automatically.", "新授权的 GitHub 连接默认开启文件自动上传：改动稳定且 AI agent 空闲时才会上传。你可以关闭它，改为手动上传。它与会话历史上传分开，也不会自动合并或下载文件。", "code-github"),
  step("github-upload", "#github-code-upload", "Share your version on GitHub", "将自己的版本传到 GitHub", "Upload sends work to your personal branch. Other members can review it on GitHub before anyone combines it with the shared branch. Unuploaded local changes are never silently replaced.", "上传会把成果送到你的个人分支。其他成员可以先在 GitHub 查看，再决定是否整合到共享分支。未上传的本地改动不会被悄悄覆盖。", "code-github"),
  step("github-recover", "#github-code-recover", "Download or recover GitHub files", "下载或恢复 GitHub 文件", "Update your personal branch from the shared branch, then download to your authorized computer. Recovery creates a separate folder from the last uploaded version; changes never uploaded cannot be recovered. GitHub access and merge decisions remain on GitHub.", "先把共享分支的内容更新到个人分支，再下载到已授权电脑。恢复会按上次上传的版本建立独立文件夹；未上传的改动无法恢复。GitHub 权限和合并仍由 GitHub 管理。", "code-github"),
  step("gt-cloud", "#code-provider-gt-cloud", "Try GatherThread file sharing", "体验 GatherThread 文件共享", "GT Cloud provides limited storage for a small trial. Project members can read uploaded files, including viewers; a Solo conversation does not make files private. Its uploads, branches and recovery are independent of GitHub.", "GT Cloud 提供有限额存储，适合轻量体验。已上传文件对项目成员可读，包括访者；Solo 会话不会让文件变成私密。它的上传、版本和恢复与 GitHub 分开。", "code-enable"),
  step("enable", "#code-enable-button", "The owner enables GT Cloud sharing", "创建者启用 GT Cloud 文件共享", "This guide demonstrates GT Cloud. The owner enables file sharing here. Turning it off pauses GT Cloud transfers and recovery; GitHub and conversation sync remain independent.", "本引导演示 GT Cloud：创建者在这里启用文件共享。关闭后暂停 GT Cloud 文件传输和恢复；GitHub 与会话同步保持独立。", "code-enable"),
  step("access", "#code-runtime-select", "Authorize each local device separately", "单独授权每台本地设备", "After sharing is enabled, each collaborator must separately authorize their local AI agent to access this project's files, then select that device here. The webpage cannot grant local access. Upload only project files you intend to share.", "开启文件共享后，每位协作者还需单独在本地 AI agent 连接中授权访问该项目的文件，再在这里选择设备，网页不能代为授权。仅上传你希望在项目内共享的文件。", "code-device"),
  step("versions", "#code-upload-button", "Upload your own version", "上传自己的文件版本", "Select an authorized local device and upload to your own version. Automatic file upload starts off and is separate from history upload. Enable it to share settled file changes while your AI agent is idle, or upload manually when ready.", "选择已授权的本地设备，将文件上传到自己的版本。文件自动上传默认关闭，与历史上传独立。开启后可在 AI agent 空闲时分享稳定的文件改动，也可准备好后手动上传。", "code-device"),
  step("review", "#code-branch-list", "Review and combine the team's work", "查看并整合团队成果", "Inspect other members' versions and submit your own for review. Only the owner can approve and merge into the shared version. Conflicts pause integration for review, preserving everyone's work.", "查看其他成员的版本，并将自己的成果提交审核。只有创建者可审核并整合到共享版本；冲突会暂停整合，等待检查，保留大家的工作。", "code-branches"),
  step("download", "#code-download-button", "Bring shared files back locally", "取回共享文件", "Update your own cloud version from the shared version, then download to the selected device. Unuploaded local changes block replacement. Avoid having two AI agents edit the same local folder simultaneously.", "先将共享版本更新到自己的云端版本，再下载到所选设备。有未上传的本地改动时不会覆盖；避免两个 AI agent 同时修改同一个本地文件夹。", "code-device"),
  step("recover", ".code-recovery > summary", "Recover and pause sharing", "恢复文件与暂停共享", "Recovery creates a new folder from your last upload without replacing existing files. Never-uploaded work cannot be recovered. Turn sharing off only when strict privacy requires it: new file collaboration and recovery stop, text still syncs, and stored versions remain until explicitly cleared in Settings.", "恢复会根据上次上传建立新文件夹，不覆盖现有文件，未上传的工作无法恢复。仅在严格隐私要求下建议关闭共享：文件协作和恢复将暂停，文字仍同步；已有云端版本会保留，需在设置中另行清理。", "code-device"),
];
const account = [
  step("create-account", "", "Create and sign in to your account", "创建并登录账号", "Register with your email, verify the code, then set a password. Use that email and password to sign in on your other devices. If you forget the password, use the recovery option when it is available on the sign-in page.", "用邮箱注册，验证收到的验证码，再设置密码。之后在其他设备用同一邮箱和密码登录。若忘记密码，可在登录页开放找回功能时使用。"),
  step("sign-in", "#settings-device-title", "Use one account across devices", "在不同设备使用同一账号", "Sign in with the same verified email and password on each device. Your projects and shared conversations follow your account; each device has its own login and local AI agent connection.", "在不同设备用同一个已验证邮箱和密码登录，就能查看自己的项目和共享会话。每台设备分别登录，本地 AI agent 也要在使用它的电脑上连接。", "account-device"),
  step("devices", "#settings-devices-list", "Review signed-in devices", "查看已登录设备", "Settings lists your account devices. Refresh the list when needed, and revoke a device you no longer use. Revoking its access does not erase files already stored on that computer.", "设置中可查看账号设备。需要时刷新列表，并撤销不再使用的设备。撤销访问不会删除那台电脑上已有的本地文件。", "account-device"),
  step("delete-account", "#settings-account-title", "Review account deletion", "了解账号注销", "Before deleting your account, transfer or delete projects you own and resolve uploaded work. Deletion signs out every device and removes your Solo cloud conversations; shared Multi messages remain under a deleted-member label. Local files stay on your devices.", "注销前，先移交或删除自己创建的项目，并处理已上传的成果。注销会退出所有设备并删除你的 Solo 云端会话；Multi 中已共享的消息仍保留，但会显示为已删除成员。本地文件仍留在设备上。", "account-delete"),
];
const members = [
  step("quote", ".message-actions button:nth-child(2)", "Point to a message", "引用某条消息", "Use the quote icon beside a message to reference it in your next chat or AI agent request. Cancel the draft quote before sending if needed. Clicking a sent quote locates its original message.", "点击消息旁的引用图标，在下一次聊天或 AI agent 请求中引用它。发送前可取消引用，点击已发送的引用可定位原文。", "conversation"),
  step("mention", "#mentions-button", "Call someone's attention", "请对方留意", "Type @ in the message box and choose a member from the list. The @ inbox shows messages mentioning you; unread marks reset on refresh.", "在输入框中输入 @，从列表选择成员。右上角 @ 可查看提到你的消息；未读标记刷新后会重置。", "conversation"),
  step("roles", "#member-list", "Understand the three project roles", "了解三种项目身份", "Owner: manages the project, members and invitations, creates Multi/Solo conversations and reviews shared file changes. Participant: creates their own Solo and uploads their own file versions. Both can write in Multi and their own Solo. Viewer: reads conversations and uploaded project files, without writing or modifying them.", "创建者：管理项目、成员和邀请，创建 Multi/Solo 会话，并审核整合文件。参与者：可创建自己的 Solo，上传自己的文件版本。两者均可在 Multi 和自己的 Solo 中发言。访者：可阅读会话和已上传项目文件，不能发言或修改。", "members"),
  step("invite", "#create-invitation-form button[type=submit]", "Create an invitation", "创建项目邀请", "The owner chooses a role and expiry, then creates a one-use invitation here. Share its gti key with the person joining.", "创建者选择成员身份和有效期后，在这里创建一次性邀请，再将生成的 gti 密钥发给要加入的人。", "members"),
  { ...step("join", "#accept-invite-secret", "Join with an invitation key", "通过邀请密钥加入项目", "Ask the project's owner for a one-use invitation key beginning with gti, then enter it here. The owner chooses whether the invitation grants participant or viewer access.", "向项目创建者获取 gti 开头的一次性邀请密钥，在这里输入并加入。创建者为邀请选择参与者或访者身份。", "members") },
  step("manage", "#rename-project-button", "The owner manages the project", "创建者管理项目", "The owner can use Rename project to update its name. Delete cloud project is a separate action: it permanently deletes cloud data but retains everyone's local files and tasks.", "创建者可通过“重命名项目”更改名称。“删除云端项目”是另一个操作，会永久删除云端数据，保留大家的本地文件和任务。", "rail"),
  step("leave", "#leave-project-button", "Participants and viewers can leave", "参与者与访者退出项目", "Participants and viewers can leave the project. Before leaving, explicitly delete your uploaded version or wait for the owner to review and integrate it. Your local files remain. The owner manages cloud deletion instead.", "参与者与访者可以退出项目。退出前，需明确删除自己已上传的版本，或等待创建者审核整合；本地文件保留。创建者则管理云端项目的删除。", "leave"),
];

const mobileBasics = {
  project: { target: "#toggle-session-rail-button", view: "conversation", text: ["Open the top project and conversation drawer. Create a project, or join with an invitation key from its owner.", "打开顶部的项目与会话抽屉。你可以创建项目，或使用创建者给的邀请密钥加入。"] },
  conversation: { target: "#session-list", view: "mobile-rail" },
  "create-conversation": { target: "#new-session-button", view: "mobile-rail" },
  connect: { target: "#mobile-agent-button", view: "conversation", title: ["4 · Choose an AI agent on your phone", "4 · 在手机上选择 AI agent"], text: ["Choose Cloud Agent to work without a connected computer. To use your own Codex or DeepSeek Harness, sign in on a computer with this account and connect it there. Keep that computer online. When GatherThread is reachable from the internet, your phone can use it from another network; it need not share Wi-Fi. A localhost-only server cannot do this by itself. Sleep or disconnection makes the local AI agent unavailable.", "可直接选择云端 Agent，无需连接电脑。如果想用自己的 Codex 或 DeepSeek Harness，先在电脑用同一账号登录并连接，让电脑保持在线。GatherThread 服务器可从公网访问时，手机在其他网络也能使用电脑上的 AI agent，不必连接同一 Wi-Fi；仅在本机运行的服务不能直接跨网使用。电脑休眠或断网后，本地 AI agent 会暂时不可用。"] },
  model: { target: "#mobile-agent-button", view: "conversation", text: ["Tap the Agent button beside the composer to open the AI agent, model and reasoning choices. The available choices come from connected agents.", "点输入框旁的 Agent 按钮，即可展开 AI agent、模型和推理强度选项。可选内容取决于已连接的 AI agent。"] },
  finish: { target: "#mobile-tools-button", view: "conversation", text: ["Open conversation tools from the top button or the + beside the composer. Settings, members, summaries and file sharing are there. The isolated example lets you explore without changing your projects.", "点顶部的会话工具按钮，或输入框旁的 +，可找到设置、成员、摘要和文件共享。独立示例可自由体验，不会改动自己的项目。"] },
};
const mobileMembers = {
  mention: { target: "#mentions-button", view: "mobile-tools" },
  roles: { target: "#member-list > li:first-child", view: "mobile-members" },
  invite: { target: "#create-invitation-form button[type=submit]", view: "mobile-members" },
  join: { target: "#accept-invite-secret", view: "mobile-members" },
  manage: { target: "#rename-project-button", view: "mobile-rail" },
  leave: { target: "#leave-project-button", view: "mobile-rail" },
};
const mobileHistory = {
  upload: { view: "mobile-details" }, manual: { view: "mobile-details" }, import: { view: "mobile-details" },
  snapshot: { view: "mobile-tools" },
};
const mobileSummaries = {
  summary: { view: "mobile-tools" }, original: { view: "mobile-tools" }, versions: { view: "mobile-tools" },
};
const mobileFiles = {
  files: { target: "#mobile-tools-button", view: "conversation", text: ["Open file sharing from Conversation tools at the top or the + beside the composer. For real development, connect your own GitHub repository; GT Cloud offers limited storage for a small trial. The two choices do not automatically move files between them.", "从顶部的会话工具或输入框旁的 + 打开文件共享。实际开发推荐连接自己的 GitHub 仓库；轻量体验可用有限额的 GT Cloud。两种方式不会自动互相迁移文件。"] },
};

export function guideSteps(topic, context = {}) {
  // Every guide runs in the isolated, fully populated example, even for empty accounts.
  const items = { basics, members, history, files, summaries, account }[topic] ?? basics;
  if (context.layout !== "mobile") return items;
  const overrides = { basics: mobileBasics, members: mobileMembers, history: mobileHistory, summaries: mobileSummaries, files: mobileFiles }[topic] ?? {};
  return items.map((item) => ({ ...item, ...overrides[item.id] }));
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
