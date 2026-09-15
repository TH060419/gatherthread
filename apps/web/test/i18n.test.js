import test from "node:test";
import assert from "node:assert/strict";

import { translateUiText } from "../src/i18n.js";

test("English is the unchanged default and Simplified Chinese preserves product terminology", () => {
  assert.equal(translateUiText("Settings", "en"), "Settings");
  assert.equal(translateUiText("Settings", "zh-CN"), "设置");
  assert.equal(translateUiText("Access token", "zh-CN"), "访问 token");
  assert.equal(translateUiText("Remember this device", "zh-CN"), "记住此设备");
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
