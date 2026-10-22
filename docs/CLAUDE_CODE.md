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

Each Web request runs in a separate GatherThread-owned Claude execution using current authorized public context and its explicit public quote. The connector does not continue an arbitrary private native conversation or reuse deleted/compacted private history. Answer text, selected tool calls, tool completion states and real plans can stream into the existing work log; raw tool-result bodies stay local. Final completion still requires a successful, stopped native process. Pause cancels that process. Resume is a new request with the recorded target, not restoration of private thinking or an interrupted shell.

Calling your own connected Claude uses its normal local tools, settings, permission mode, sandbox, trusted Hooks, skills and configured MCP servers. GatherThread does not impose a file/plan-only tool list or add permission-bypass flags. Terminal commands, dependency installation and other native tools can run when the connected computer's Claude permissions and environment allow them. This is not a container or a separate project-only security sandbox: connect only a trusted workspace under your own account.

The default connector mode is `native`, which leaves Claude's configured permission mode unchanged. Explicit `--permission-mode manual` and `--permission-mode plan` remain available. Like the unattended Codex adapter, this path cannot answer a new permission prompt: an operation requiring additional approval is refused, with an instruction to authorize it in Claude Code locally and start a new request. It never treats website access as permission to bypass a local denial. Calling another member's shared Agent remains a separate, project-file-only boundary; Claude cross-member sharing is not implemented.

GT Cloud and direct GitHub synchronization reuse the existing separately authorized project-file controls. A connected Agent is not file-upload consent. GitHub uploads go directly to your repository; human review/merge remains explicit. Independent Agents editing one directory can still conflict, so use separate working copies for simultaneous work.

The Launcher's local file-sync checkbox starts unchecked and resets for each new connection. Enable it only for a folder you want this device to synchronize; conversation upload remains a separate per-conversation choice.

网页调用自己的 Claude 使用本机已有工具、配置、权限模式和沙箱，不再额外限制为文件与计划工具；终端、安装依赖等操作在本机 Claude 允许时正常执行。可实时查看答案、工具执行状态及真实计划，并暂停执行；原始命令、MCP 参数和工具结果不会直接公开。需要额外批准的操作会明确提示，请在已连接电脑的 Claude Code 中授权后重新请求，网页不会代替你批准。网页请求仍独立接收当前共享上下文，不接管私人会话；项目文件同步仍需单独授权。

## Source checkout / 源码本地验证

Use Node.js 24+. From a reviewed checkout:

```sh
npm ci
npm run build:claude
node packages/claude-connect/dist/claude-connect.js --help
```

Use the CLI's hidden one-time authorization prompt or the Launcher. Do not paste passwords/device tokens into a model prompt, command argument, plugin configuration or project file. The [connector README](../packages/claude-connect/README.md) describes the matching package and source-plugin installation choices.

Maintainers can run `node scripts/verify-claude-native-permissions.mjs /absolute/path/to/claude` after building. This opt-in check uses the installed native CLI, an isolated temporary configuration and a loopback fake provider: an allowed offline npm installation must succeed, a denied installation must leave no dependency files, and local Hooks must run without modifying their settings. It does not use a real model account or validate provider billing/network availability.

Codex-only visible-history import and isolated cross-member Agent sharing are not advertised as Claude features. Native GUI appearance, Windows execution, real provider billing and installed-artifact publication need their own evidence. This implementation does not deploy either GatherThread server or publish an npm version.

Official interfaces: [CLI reference](https://code.claude.com/docs/en/cli-reference), [plugin manifest](https://code.claude.com/docs/en/plugins-reference), [Hooks](https://code.claude.com/docs/en/hooks). Architectural and security decisions are in [ADR-0060](adr/0060-claude-code-plugin-and-local-connector.md).
