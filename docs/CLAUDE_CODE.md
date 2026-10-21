# Claude Code · GatherThread

This source integration adds a local Claude Code connector and a native plugin. It does not install Claude Code, supply a model subscription, or change your existing Codex/DSH connections. A source build is not a published npm package or Launcher release; use matching reviewed artifacts when released, not an older Launcher that only supports Codex.

## Connect / 连接

1. Install and sign in to Claude Code on your computer. The connector checks its installed version, required safety options and authentication before registering an execution runtime. Unsupported versions stop with an update instruction rather than bypassing permissions.
2. In GatherThread, open **Settings → Agents**, enable **Claude Code**, then choose **Connect Claude Code** in your project. Enter the full model ID you already use in Claude Code. No model catalog is guessed, and an unavailable connection never falls back to Codex, DSH or another model.
3. On supported Windows/macOS desktops, use the matching Claude-compatible Launcher. Your GatherThread email and server are prefilled; enter your GatherThread password only in the Launcher. It authorizes an independently revocable device, not a shared browser session. Keep the computer and connector online to call it from your phone.
4. Install the native GatherThread plugin explicitly. Review and trust its Hooks before opting into local conversation uploads. Installation never silently edits global Hooks or transfers your Claude credentials to GatherThread.

电脑上先安装并登录 Claude Code。在 GatherThread 的「设置 → Agent」启用 Claude Code，再从项目中点击「连接 Claude Code」。填写已配置的完整模型 ID，使用配套启动器连接。网页预填 GatherThread 邮箱；密码只在启动器内输入。手机无需安装或连接本地 Agent，可直接调用同一账号已连接的在线电脑。

## Work inside Claude Code / 在 Claude Code 内协作

The plugin provides commands and user-facing MCP tools for project/session discovery, reading shared history and current context, explicit human chat, Agent requests, connection status and per-conversation upload controls. The connector remains a separate local process so the website can dispatch work while the plugin is idle. MCP receives only a private local routing capability, never the GatherThread device credential.

Native sessions keep their ordinary user-controlled Claude Code workflow. Only explicitly connected project/session content is eligible for upload; other local sessions, private instructions, credentials and hidden thinking are excluded. Turning automatic upload off does not disconnect the project or stop shared context reads. Manual upload remains explicit and idempotent.

After you approve an upload, the connector verifies a bounded region near that captured turn in the exact conversation's local Claude transcript to match the prompt, final answer and actual model. This handles native model changes without guessing from an earlier connection setting. It never scans other conversations or sends the transcript itself; missing or mismatched proof leaves the turn private for review/retry. Deleting or changing the shared context makes an already retained native conversation local-only; start a fresh Claude conversation to use the new context.

插件可在 Claude Code 内查看项目和会话、读取共享历史与当前上下文、发送聊天、发起 Agent 请求、查看连接状态、管理本会话上传。聊天与执行是两个独立动作。未授权的本地会话不会因为安装插件就被扫描或上传。

只有你同意上传之后，连接器才会读取这一会话末尾的有限本地记录，核对当前提问、最终回答和实际模型；不会上传原始记录或扫描其他会话。记录不完整时先保留在本地，不会猜测模型后上传。共享历史被删除或替换后，已有原生会话保持仅本地使用，请新建 Claude 会话以接入最新上下文。

## Web execution and files / 网页调用与文件

Each Web request runs in a separate GatherThread-owned Claude execution using current authorized public context. The connector does not continue an arbitrary private native conversation or reuse deleted/compacted private history. Answer text, selected tool activity and real plans can stream into the existing work log; final completion still requires a successful, stopped native process. Pause cancels that process. Resume is a new request with the recorded target, not restoration of private thinking or an interrupted shell.

Unattended Web execution uses Claude Code's restricted directory mode, explicit file/plan tools and denied permission prompts. It does not enable arbitrary shell, network, other Agents or permission bypass. Use your native Claude Code session for operations needing those interactive permissions. This is deliberately narrower than handing a remote request all of your local Claude settings.

GT Cloud and direct GitHub synchronization reuse the existing separately authorized project-file controls. A connected Agent is not file-upload consent. GitHub uploads go directly to your repository; human review/merge remains explicit. Independent Agents editing one directory can still conflict, so use separate working copies for simultaneous work.

The Launcher's local file-sync checkbox starts unchecked and resets for each new connection. Enable it only for a folder you want this device to synchronize; conversation upload remains a separate per-conversation choice.

网页请求使用当前共享上下文独立执行，不会接管任意私人 Claude 会话。可实时查看答案、允许公开的工具过程及真实计划，并暂停执行。需要终端或额外权限的工作，请在原生 Claude Code 中确认后操作。项目文件同步仍需单独授权，不能由远程消息或插件工具偷偷开启。

## Source checkout / 源码本地验证

Use Node.js 24+. From a reviewed checkout:

```sh
npm ci
npm run build:claude
node packages/claude-connect/dist/claude-connect.js --help
```

Use the CLI's hidden one-time authorization prompt or the Launcher. Do not paste passwords/device tokens into a model prompt, command argument, plugin configuration or project file. The [connector README](../packages/claude-connect/README.md) describes the matching package and source-plugin installation choices.

Codex-only visible-history import and isolated cross-member Agent sharing are not advertised as Claude features. Native GUI appearance, Windows execution, real provider billing and installed-artifact publication need their own evidence. This implementation does not deploy either GatherThread server or publish an npm version.

Official interfaces: [CLI reference](https://code.claude.com/docs/en/cli-reference), [plugin manifest](https://code.claude.com/docs/en/plugins-reference), [Hooks](https://code.claude.com/docs/en/hooks). Architectural and security decisions are in [ADR-0060](adr/0060-claude-code-plugin-and-local-connector.md).
