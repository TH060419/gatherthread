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
    translateUiText("Your device token is requested by a hidden CLI prompt. It is not included in either command. After hooks are installed for the first time, open Codex Desktop Settings and enable Hooks, then review the generated .codex/hooks.json before use.", "zh-CN"),
    /Hooks（钩子）/,
  );
  assert.equal(
    translateUiText("Your device token is requested by a hidden CLI prompt. It is not included in either command. After hooks are installed for the first time, open Codex Desktop Settings and enable Hooks, then review the generated", "zh-CN"),
    "设备 token 会通过隐藏的 CLI 提示输入，不会出现在任何命令中。首次安装 Hooks（钩子）后，请在 Codex Desktop 设置中启用 Hooks，并检查生成的",
  );
  assert.equal(translateUiText("before use.", "zh-CN"), "，确认无误后再使用。");
  assert.equal(translateUiText("macOS / Linux shell", "zh-CN"), "macOS / Linux 终端");
  assert.equal(translateUiText("Windows PowerShell", "zh-CN"), "Windows PowerShell 终端");
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
  assert.equal(translateUiText("我的自定义会话", "zh-CN"), "我的自定义会话");
  assert.match(
    translateUiText("Configured projection ceiling: 256 KiB (about 65,536 tokens at four UTF-8 bytes per token). The connected model's reported window remains the hard upper bound. Reconnect Codex after changing this value. Desktop Hook updates use a separate 7 KiB capsule and continue across turns.", "zh-CN"),
    /Desktop Hooks（钩子）更新使用独立的 7 KiB 胶囊/,
  );
});
