import test from "node:test";
import assert from "node:assert/strict";

import { translateUiText } from "../src/i18n.js";

test("manual summary controls, shared quota boundaries and context policy are bilingual", () => {
  const cases = [
    ["Select history to summarize", "选择历史生成摘要"],
    ["Select sources to regenerate with my Agent", "选择来源，用我的 Agent 重新生成"],
    ["Select message #12", "选择消息 #12"],
    ["Select summary #42", "选择摘要 #42"],
    ["Summary versions", "摘要版本"],
    ["Show original messages", "显示原始消息"],
    ["Summary · less context, lossy", "摘要 · 更省上下文，有损"],
    ["Original · more detail and context", "原文 · 更多细节与上下文"],
    ["Unable to save Agent context policy. Retry saving settings.", "无法保存 Agent 上下文策略，请重试保存设置。"],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateUiText(source, "en"), source);
    assert.equal(translateUiText(source, "zh-CN"), expected);
  }
  assert.match(translateUiText("This uses your selected local Agent and may consume model quota. Only the selected records are supplied as this request's shared-history context; this does not guarantee sandbox isolation from local tools or files. Instructions and the result are shared with session readers.", "zh-CN"), /本地 Agent.*模型额度.*只将所选记录.*不保证与本地工具或文件隔离.*指令及结果.*共享/u);
  assert.match(translateUiText("Summaries are derived and lossy. Original records stay available. Already-loaded Codex or DSH history is not removed; native automatic compaction still manages it.", "zh-CN"), /有损.*原始记录.*不会因此被移除.*原生自动压缩/u);
  assert.match(translateUiText("Applies to future Agent requests started from GatherThread and explicit MCP context reads. It does not rewrite a running turn, remove existing Codex Desktop task history, or replace history already injected into ordinary DSH sessions.", "zh-CN"), /GatherThread 网页.*显式 MCP.*不会重写.*已有 Codex Desktop.*普通 DSH 会话/u);
});

test("English is the unchanged default and Simplified Chinese preserves product terminology", () => {
  assert.equal(translateUiText("Settings", "en"), "Settings");
  assert.equal(translateUiText("Settings", "zh-CN"), "设置");
  assert.equal(translateUiText("Access token", "zh-CN"), "访问 token");
  assert.equal(translateUiText("Choose either an access token or a project invitation before continuing.", "zh-CN"), "请只填写访问 token 或项目邀请密钥中的一种，再继续。");
  assert.equal(translateUiText("Remember this device", "zh-CN"), "记住此设备");
  assert.equal(translateUiText("Checking…", "zh-CN"), "正在验证…");
  assert.equal(translateUiText("Activating…", "zh-CN"), "正在激活…");
  assert.equal(translateUiText("Joining…", "zh-CN"), "正在加入…");
  assert.equal(translateUiText("Create your first project.", "zh-CN"), "创建你的第一个项目。");
  assert.equal(translateUiText("Create a project to organize your sessions and invite collaborators.", "zh-CN"), "创建项目来组织会话并邀请协作者。");
  assert.equal(translateUiText("Once invited, your projects will appear here. A project invitation does not let you create projects.", "zh-CN"), "收到邀请后，项目会显示在这里。项目邀请不会授予创建项目的权限。");
  assert.equal(translateUiText("This device", "zh-CN"), "当前设备");
  assert.equal(translateUiText("Connect Codex", "zh-CN"), "连接 Codex");
  assert.equal(translateUiText("Conversations", "zh-CN"), "协作");
  assert.equal(translateUiText("Sessions", "zh-CN"), "会话");
  assert.equal(translateUiText("Agent request settings", "zh-CN"), "Agent 请求设置");
  assert.equal(translateUiText("Resize message composer", "zh-CN"), "调整输入区高度");
  assert.equal(translateUiText("Subtle", "zh-CN"), "轻微");
  assert.equal(translateUiText("Pronounced", "zh-CN"), "明显");
  assert.equal(translateUiText("Participant", "zh-CN"), "参与者");
  assert.equal(translateUiText("Viewer", "zh-CN"), "访者");
  assert.equal(translateUiText("Connect your local runtime to request an agent.", "zh-CN"), "连接本地 Agent 后即可发起 Agent 请求。");
  assert.equal(
    translateUiText("People collaborate in one space, each with a local Agent, sharing context that stays ordered, attributable, and live.", "zh-CN"),
    "多人在同一空间协作，各自使用本地 Agent，共享有序、可追溯、实时同步的上下文。",
  );
  assert.equal(
    translateUiText("Connects to this owner host. The token is exchanged for a secure browser session and is never stored by the page.", "zh-CN"),
    "用于连接当前主机。token 会被交换为安全的浏览器会话，且不会被页面存储。",
  );
  assert.equal(
    translateUiText("Connects to https://example.test. The token is exchanged for a secure browser session and is never stored by the page.", "zh-CN"),
    "用于连接 https://example.test。token 会被交换为安全的浏览器会话，且不会被页面存储。",
  );
  assert.equal(
    translateUiText("Use a device token to sign in, or a one-time test access token to create an account on https://example.test. The token is exchanged for a secure browser session and is never stored by the page.", "zh-CN"),
    "使用设备 token 登录，或使用一次性测试资格 token 在 https://example.test 创建账号。token 会被交换为安全的浏览器会话，且不会被页面存储。",
  );
  for (const [source, expected] of [
    [
      "Use your device token to sign in on https://example.test. The token is exchanged for a secure browser session and is never stored by the page.",
      "使用设备令牌登录 https://example.test。令牌会被交换为安全的浏览器会话，且不会被页面存储。",
    ],
    [
      "Use a one-time test qualification code to activate an account on https://example.test and receive a device token.",
      "使用一次性测试资格码在 https://example.test 激活账号，并获取设备令牌。",
    ],
  ]) {
    assert.equal(translateUiText(source, "en"), source);
    assert.equal(translateUiText(source, "zh-CN"), expected);
  }
  assert.match(
    translateUiText("Your device token is requested by a hidden CLI prompt and is not included in any command. This page only copies commands and cannot launch local Codex. Keep the connector running for Web requests and plugin MCP tools. Direct Desktop turn sync additionally requires --plugin-hooks plus explicit review and trust of the plugin Hooks.", "zh-CN"),
    /Hooks（钩子）/,
  );
  assert.equal(translateUiText("macOS / Linux shell", "zh-CN"), "macOS / Linux 终端");
  assert.equal(translateUiText("Windows PowerShell", "zh-CN"), "Windows PowerShell 终端");
  assert.equal(translateUiText("Connect DeepSeek Harness", "zh-CN"), "连接 DeepSeek Harness");
  assert.equal(translateUiText("Open DeepSeek Harness", "zh-CN"), "打开 DeepSeek Harness");
  assert.equal(translateUiText("Install the GatherThread plugin", "zh-CN"), "安装共序 GatherThread 插件");
  assert.equal(translateUiText("Connect inside DSH", "zh-CN"), "在 DSH 中连接共序");
  assert.match(
    translateUiText("Current compatibility authorization uses your existing signed GatherThread browser session or invitation. Public account registration is not assumed.", "zh-CN"),
    /不假设公共账户注册系统已经上线/,
  );
  assert.match(
    translateUiText("The short code expires once and is bound to this server and DSH device. The long-lived device credential stays in DSH’s local credential store and never enters a URL, command, page storage, log, or shared history.", "zh-CN"),
    /长期设备凭据只保存在 DSH 本机凭据库/,
  );
  assert.equal(translateUiText("1. Run the fixed-version connector.", "zh-CN"), "1. 运行固定版本连接器。");
  assert.equal(translateUiText("2. Install the plugin once.", "zh-CN"), "2. 一次性安装插件。");
  assert.equal(translateUiText("3. Optionally sync direct Desktop turns.", "zh-CN"), "3. 可选启用 Desktop 直接回合同步。");
  assert.equal(translateUiText("One-time plugin setup", "zh-CN"), "一次性插件安装");
  assert.equal(translateUiText("Copy commands", "zh-CN"), "复制命令");
  assert.match(
    translateUiText("Run the two commands below to add the fixed GitHub release source and install the", "zh-CN"),
    /固定 GitHub 发布版插件源/,
  );
  assert.match(
    translateUiText("plugin. Restart Codex Desktop and review its MCP server and Hooks; enable Hooks only for optional step 3. This page only copies the commands; it does not run them.", "zh-CN"),
    /只有选择第 3 步时才启用 Hooks/,
  );
  assert.equal(translateUiText("Plugin install commands copied.", "zh-CN"), "插件安装命令已复制。");
});

test("dynamic collaboration labels translate without touching unknown user text", () => {
  assert.equal(translateUiText("2 members · participant", "zh-CN"), "2 位成员 · 参与者");
  assert.equal(translateUiText("You are owner", "zh-CN"), "你的角色是 创建者");
  assert.equal(translateUiText("You are viewer", "zh-CN"), "你的角色是 访者");
  assert.equal(translateUiText("Only the creator can edit this Solo session.", "zh-CN"), "Solo 会话仅可由其创建者编辑。");
  assert.equal(translateUiText("Delete cloud project", "zh-CN"), "删除云端项目");
  assert.equal(translateUiText("Delete the cloud session “长会话名称”?", "zh-CN"), "删除云端会话“长会话名称”？");
  assert.equal(
    translateUiText("Delete the cloud project “量子项目” and all of its cloud sessions?", "zh-CN"),
    "删除云端项目“量子项目”及其全部云端会话？",
  );
  assert.equal(
    translateUiText("Participants edit multi sessions and read solo sessions. Viewers are read only everywhere.", "zh-CN"),
    "参与者可编辑 Multi；访者在所有位置均为只读。",
  );
  assert.equal(translateUiText("Contiguous through sequence #42", "zh-CN"), "连续历史已到 sequence #42");
  assert.equal(translateUiText("Session status details", "zh-CN"), "会话状态详情");
  assert.equal(translateUiText("Show session status details", "zh-CN"), "展开会话状态详情");
  assert.equal(translateUiText("Offline · 3 pending", "zh-CN"), "离线 · 3 项待同步");
  assert.equal(translateUiText("3 local changes are waiting to reconcile.", "zh-CN"), "3 项本地更改正在等待协调。");
  assert.equal(
    translateUiText("Manual import creates a new local Codex task and never overwrites or archives the old task. After confirming the new task works, archive the old task yourself. Realtime context injection is unaffected.", "zh-CN"),
    "手动导入会创建新的 Codex 本地任务，不会覆盖或归档旧任务。确认新任务可用后，请自行归档旧任务。实时上下文注入不受影响。",
  );
  assert.equal(translateUiText("2 online", "zh-CN"), "2 个在线");
  assert.equal(translateUiText("off", "zh-CN"), "关闭");
  assert.equal(
    translateUiText("2 DeepSeek Harness runtimes are online for this session.", "zh-CN"),
    "当前会话有 2 个 DeepSeek Harness runtime 在线。",
  );
  assert.equal(
    translateUiText("Online · Local Provider · CaseSensitive/Model-X · last seen 09:30", "zh-CN"),
    "在线 · Local Provider · CaseSensitive/Model-X · 最近在线 09:30",
  );
  assert.equal(
    translateUiText("Revoke Studio DSH? Its DSH plugin must pair again before accepting requests.", "zh-CN"),
    "撤销 Studio DSH？其 DSH 插件必须重新配对后才能接收请求。",
  );
  assert.equal(translateUiText("我的自定义会话", "zh-CN"), "我的自定义会话");
  assert.match(
    translateUiText("Configured projection ceiling: 256 KiB (about 65,536 tokens at four UTF-8 bytes per token). The connected model's reported window remains the hard upper bound. Reconnect Codex after changing this value. Codex Desktop Hooks use a separate 7 KiB capsule and continue across turns.", "zh-CN"),
    /Codex Desktop Hooks（钩子）使用独立的 7 KiB 胶囊/,
  );
  assert.match(
    translateUiText("Configured projection ceiling: 128 KiB (about 32,768 tokens at four UTF-8 bytes per token). The connected model's reported window remains the hard upper bound. DeepSeek Harness uses the context limit configured by its GatherThread plugin instead of this browser value. Reconnect the DSH plugin after changing its local limit.", "zh-CN"),
    /DeepSeek Harness 使用其 GatherThread 插件中配置的上下文上限/,
  );
  assert.equal(translateUiText("Harness", "zh-CN"), "Agent");
  assert.equal(
    translateUiText("Connect Codex before requesting this Agent.", "zh-CN"),
    "请先连接 Codex，再请求此 Agent。",
  );
  const combinedDiagnostic = translateUiText("Configured projection ceiling: 256 KiB (about 65,536 tokens at four UTF-8 bytes per token). The connected model's reported window remains the hard upper bound. Reconnect Codex after changing this value. Codex Desktop Hooks use a separate 7 KiB capsule and continue across turns. DeepSeek Harness uses the context limit configured by its GatherThread plugin instead of this browser value. Reconnect the DSH plugin after changing its local limit.", "zh-CN");
  assert.match(combinedDiagnostic, /重新连接 Codex/);
  assert.match(combinedDiagnostic, /重新连接 DSH 插件/);
});

test("native context guidance covers every enabled Agent without claiming a shared model ceiling", () => {
  const codex = "Codex: use the native model window first; fallback 256 KiB (about 65,536 tokens). Reconnect Codex after changing the fallback. Codex Desktop Hooks retain a separate 7 KiB transfer capsule.";
  const dsh = "DeepSeek Harness: automatic compaction follows its native model and plugin settings, not this browser value. Oversized first imports may still exceed native limits.";
  for (const guidance of [codex, dsh, `${codex} ${dsh}`, `${dsh} ${codex}`]) {
    const source = `Native context management. ${guidance}`;
    const translated = translateUiText(source, "zh-CN");
    assert.match(translated, /^原生上下文管理。/u);
    assert.doesNotMatch(translated, /fallback|automatic compaction|native model/u);
    if (guidance.includes(codex)) assert.match(translated, /65,536 tokens.*Codex Desktop Hooks/u);
    if (guidance.includes(dsh)) assert.match(translated, /DeepSeek Harness：自动压缩.*首次导入/u);
    assert.equal(translateUiText(source, "en"), source);
  }
  assert.equal(translateUiText("Codex fallback context budget", "zh-CN"), "Codex 备用上下文预算");
});

test("agent failure and retry wording is bilingual", () => {
  assert.equal(translateUiText("This Agent request failed before it produced an answer.", "zh-CN"), "该 Agent 请求未能产出回答。");
  assert.equal(translateUiText("Retry Agent request", "zh-CN"), "重试 Agent 请求");
});

test("native context failures explain safe pauses and unchanged bindings in both languages", () => {
  const cases = [
    ["Native compaction completed without fresh context usage; cannot safely fit the pending projection", /压缩已完成.*新的上下文用量/u],
    ["Canonical projection cannot fit below the native context high-water mark after compaction", /压缩后.*安全预算/u],
    ["Native compaction left the visible history candidate above its context high-water mark; the current task binding remains unchanged", /原任务绑定保持不变/u],
    ["Native context recovery is waiting for fresh token usage from Codex App Server; automatic compaction and rebuild are paused, and reconnecting with the same usage will not resume them", /自动压缩和重建已暂停.*重复报告/u],
    ["Visible history exceeds the 8 MiB JSON resource limit; the current task binding remains unchanged", /8 MiB.*原任务绑定保持不变/u],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateUiText(source, "en"), source);
    assert.match(translateUiText(source, "zh-CN"), expected);
  }
});
