# 接入本地 Codex

内置连接器把一个 GatherThread 项目连接到一个本地 Agent 项目目录，并自动发现可见会话。新的实时可写会话首次会得到一个由 Desktop 独占、名为 `会话名 · GatherThread` 的任务，以及一个名为 `会话名 · GatherThread background` 的独立 `exec` 后台投影。这些只是初始标签：云端与本地标题可分别修改，而且绝不作为绑定身份。Desktop 任务通过可信 Hooks（钩子）接收本地交互回合；后台投影导入规范历史并执行网页 **Request my agent**。两者通过服务器规范日志汇合，不再由两个进程写同一个原生任务。

项目角色决定连接模式：

| 项目角色 | `multi` 会话 | `solo` 会话 |
|---|---|---|
| `owner` | 实时双向同步 | 仅本人创建的 Solo 实时双向同步；其他 Solo 为只读快照 |
| `participant` | 实时双向同步 | 仅本人创建的 Solo 实时双向同步；其他 Solo 为只读快照 |
| `viewer` | 只读 **Download to Codex** 快照 | 只读 **Download to Codex** 快照 |

因此 Viewer 也可以运行连接器，但只能注册隔离的 `snapshot_connector` runtime，绝不会注册执行 runtime。

## 准备条件

- Node.js 24 或更新版本。
- 已登录 Codex。连接器会自动查找 PATH 中的 Codex CLI；在 macOS 上也会自动查找 ChatGPT/Codex 桌面应用内置的 CLI。
- 能通过 Tailscale 访问主机，并已接受主机共享。
- 自己设备的 GatherThread Access Token，不能使用另一位协作者的 Token。
- 允许创建 `~/GatherThread Projects/`，或者已有一个允许 Codex 访问的本地源码目录。

## 启动连接器

在 GatherThread 网页中选择项目并点击 **Connect Codex / 连接 Codex**，复制与本机系统对应的固定版本命令并在终端运行。无需 clone GatherThread，也无需本地安装仓库依赖：

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 --url 'https://your-host.your-tailnet.ts.net/v1' --project 'PROJECT_ID' --create-workspace
```

复制的命令不包含浏览器 Cookie、邀请 Secret 或设备 Token；PowerShell 使用 `npx.cmd` 和同样的安全引号。连接器会在终端中隐藏输入 GatherThread 设备 Token，重新验证当前账号对指定项目的权限，并安全创建或精确复用 `~/GatherThread Projects/<安全项目名>`。目录中的私有无凭据 marker 会阻止它被另一台服务器或另一个项目误用。随后连接器按顺序物化所有可实时写入的会话；部分失败后会从各会话自己的持久化状态继续。Token 只保留在当前连接器进程的内存中，不会写入 Codex thread 状态，也不会传给 Codex 子进程。

使用 `--create-workspace` 时，连接器会创建或复用同名的本地 Desktop 项目目录，并在同步开始前打开经过校验的目录。它不会为了显示任务而伪造 Agent 回合；网页执行位于不会被深链接打开的私有后台任务。Codex 没有公开项目归属回执，因此连接器不会修改 Desktop 私有状态。若要绑定已有源码目录，请使用下面的高级形式，不要添加 `--create-workspace`：

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --project PROJECT_ID \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol
```

## 统一 Codex 插件与两档真实体验

仓库内可发布的 **共序 / GatherThread** 插件提供普通用户 MCP 工具，用于查看项目、会话、历史与脱敏连接状态，以及发送经用户确认的消息或 Agent 请求。普通 Beta 路径不会把 `GATHERTHREAD_TOKEN` 写进 MCP 配置。Finder 启动的 Desktop 不保证继承终端环境变量，而且连接器会主动从 Codex 子进程剥离 GatherThread 凭据。因此插件的固定版本 stdio MCP 默认通过私有 Unix socket 或 Windows named pipe 连接常驻连接器。每个连接器只登记含实例、端点、项目路由与租约的非秘密本地记录，另由每次启动随机 capability 授权。MCP 会把同一端点在崩溃重启窗口内重叠的登记合并为租约较新的实例，再聚合所有不同的活动连接器并按唯一 `project_id`/`session_id` 路由；不同端点暴露重复 ID 时仍属于歧义并失败关闭，绝不静默挑选第一个或最新实例。已过期登记会在发现阶段直接忽略并清理租约记录，但不会删除可能已被新实例复用的 endpoint 或 capability。

- **基础模式：**保持固定版本连接器运行，并显式安装、审查插件。此时 MCP 工具与网页 **请求我的 Agent** 可用，Desktop 直接回合仍留在本地。
- **完整模式：**给同一连接器添加 `--plugin-hooks`，然后在 Codex 中启用 Hooks，审查并信任插件的 `UserPromptSubmit` 与 `Stop` 定义。插件自带的无依赖小脚本直接把 Hook JSON 转发给连接器，每回合不会运行 `npx`。Hook 的 `cwd` 可以是工作区根或其子目录；转发器向上查找连接器的权威根 registry，relay 会拒绝工作区外路径。连接器必须保持在线：插件 Hook 失败放行且不建立离线 spool。Hook 不能唤醒空闲 Codex，也不能启动新回合。

`v0.1.0-beta.1` 发布引用存在后，无需克隆完整仓库即可添加固定版本的仓库插件源并安装插件：

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-beta.1 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

两个重复的 sparse 路径会从同一固定 release ref 获取仓库插件源与插件目录；第二条命令从该插件源安装 **共序 / GatherThread**。随后重启 Codex Desktop，并在启用前审查其 MCP server 与 Hooks。浏览器只显示和复制这些命令，不能代为运行，也不会修改全局 Codex 配置。

`--install-hooks` 作为显式兼容路径保留，用于把相同事件合并进 `<workspace>/.codex/hooks.json`；它不能与 `--plugin-hooks` 同时使用。两个选项都不会默认启用，不会修改 `~/.codex/config.toml`，也不会把插件静默安装到全局目录。

如果从 `--install-hooks` 切换到 `--plugin-hooks` 后项目 Hook 文件仍存在，连接器不会删除它。私有 registry 在运行时只授权一种 Hook 来源，relay 也校验相同的来源封装；因此插件模式下残留项目 Hook 不会返回重复上下文，也不能写入兼容 spool。只有项目 Hook 模式会清空该 spool。

公共 Codex 插件目录条目上线前，仓库插件只能通过显式、本地且可审查的方式安装。Safari、Chrome 与 Edge 只复制连接器命令；浏览器安全边界会阻止网页直接启动或控制本地 Codex。发布前还必须确认 `@gatherthread` npm 组织与包名所有权。

内部的 `collaboration_register_runtime`、领取/完成请求和上传快照工具属于隔离的 runtime profile，普通用户插件绝不会列出它们。环境变量 `server-env` 直连仅是开发者预览。未来远程 Streamable HTTP MCP 必须建立真实账号体系并实现 OAuth 2.1/PKCE，本版本既未实现，也不会拿长期 Token 冒充。即使将来实现，MCP 也不能替代常驻连接器负责的请求领取、逐会话投影、可靠 outbox、断线重连和 App Server 生命周期。

`--model` 选择网页触发 Agent 请求时使用的隔离后台模型，不会锁定 Desktop 任务内部选择的模型。可信 Hook 会把 Desktop 实际报告的模型逐回合冻结到上传记录，因此允许在不同回合之间切换模型。Codex 0.148 的实际 Hook payload 不包含思考强度；若 Hook 提供该可选字段，GatherThread 会逐回合记录，否则保持未设置而不会猜测。

保持该终端运行。网页每5秒刷新一次 runtime 状态。成员区域显示 `codex · openai · <模型>` 且为 Online 后，在输入框填写指令并点击 **Request my agent**。

## 自动同步规则

- 规范事件严格按服务器序号导入后台执行任务。首次同步读取全部可见历史，后续只注入规范增量。
- 每条可见消息都带冻结的 `actor_display_name` 与明确的规范类型前缀：`Human Chat`、`Agent Request`、`Agent Response` 或具体工具/其他事件类型。只有 `Agent Response` 会追加该规范事件自身 runtime 中的 harness 与模型；runtime 缺失时明确使用 `GatherThread · shared` 占位，绝不借用本地连接器 runtime。结构化来源信息保留在私有连接器状态中。
- 普通聊天和其他协作者的 Agent 回复会成为上下文，但不会触发 Codex。普通聊天只能在 GatherThread 中发送。
- 只有尚未绑定、且由同一认证用户发出的 `agent_request` 才能被其执行 runtime 处理。
- 安装并信任项目 Hook 后，`UserPromptSubmit` 会在 Hook 的 2,500-token 附加上下文上限内提供规范 relay capsule，并记录准确 prompt。Agent 只需显示 `Loaded N cloud updates / 已加载 N 条云端更新` 和最多三条短预览；精确顺序正文作为不可信的仅模型上下文。超长 UTF-8 内容会持久记录检查点，并在后续完成的 Desktop 回合继续。独立投递游标只在 `Stop` 后推进；取消会原样重投，任何省略分段都不会被静默确认。`Stop` 把最终助手文本持久加入 outbox，再通过服务器原子 local-turn 接口恰好写入一次。当前公开 Hook 不包含完整结构化工具流，因此 Desktop 回合的工具事件不会上传。
- 对尚未绑定的 Desktop 任务，第一次 `UserPromptSubmit` 同时是发现触发点。Owner 或 Participant 会幂等创建一个由本人所有的 Solo，在不打开竞争 writer 的前提下采用当前原生任务，并通过正常 outbox 上传同一个已完成回合。打开空任务不会创建任何内容；Viewer 的未绑定任务始终仅保留在本地。后台执行与快照任务具有明确的不可发现用途，因此不能递归创建 Solo。
- 当前 Codex 已生成的内容会绑定到服务器返回的规范事件 ID，不会再次注入或再次执行。
- 本地完成回合会先持久化到私有幂等 outbox。断网后，连接器会在网络恢复时继续重试。
- 如果服务器没有越过本地回合的起始序号，确认后只更新绑定与游标；如果云端已经前进，服务器会先按自身权威顺序追加本地回合，再要求连接器对齐。
- 后台对齐会在旁路新建执行投影，导入完整规范序列，按需 compact，验证覆盖序号后才切换私有绑定。连接器不会重命名、归档或替换 Desktop 独占任务。
- 会话对齐只改变 Codex thread 状态，不会 reset、checkout 或覆盖本地项目源码文件。
- Codex compact 始终是本地状态。连接器优先使用 App Server 报告的 token usage 与模型上下文窗口，无法取得时使用保守配置估计。GatherThread 保留完整规范事件日志，不共享原生 compact 状态。
- 云端新会话会被同一个项目连接器自动发现。Owner 与 Participant 为 `multi` 和本人创建的个人 Solo 连接执行 runtime；其他成员的 Solo 保持快照模式。Viewer 在所有会话中始终只有快照模式。
- 服务器明确确认角色降级、会话变为只读、会话归档或项目访问被移除后，连接器会立即从执行 Hook 白名单移除对应原生 thread，并清除尚未发布的 hook draft/outbox。Codex 原生 transcript 会被保留，但只读期间产生的内容始终只留在本地；以后恢复写权限也不会补传。使用 `--install-hooks` 兼容路径时，临时网络故障不会触发这项清理，已授权离线捕获可在网络恢复后继续；插件 Hook 要求连接器进程在线，不提供离线捕获。
- 每个会话始终使用独立 Codex thread，不会把兄弟会话历史混入当前会话。
- 同一个本地目录上的多个会话请求按顺序执行，避免两个 Codex turn 同时修改同一批文件。
- App Server 只通过本机 stdio 短时运行。后台执行与快照使用单次操作子进程。实现任务会明确命名为 `会话名 · GatherThread background`；如果 Codex Desktop 将其列出，请不要把它用于直接工作。若 Desktop 在一次操作完成后从外部接管了后台投影，GatherThread 会新建投影、重放权威规范历史并继续下一次网页请求；若仍有 prepared 或 started 操作，则保持 fail-closed，避免重复执行。Desktop 任务创建后，直接桌面同步只使用可信本地 Hook relay，绝不再通过另一个 App Server 打开它。
- 连接器会显式使用 legacy rollout 历史；在 paginated history 尚不支持完整历史读取、恢复、注入与 compact 前不会采用它。新建 Desktop 任务只有在创建它的 App Server 退出后，另一个全新 App Server 仍能只读打开其 rollout，才会写入本地绑定、Hook 白名单并在 Desktop 中显示；持久化失败的候选不会成为可用任务。
- 既有绑定只通过 project ID、GatherThread session ID、已验证 workspace 和持久化的本地 thread ID 解析。连接器会先检查所有既有绑定，只有确实未绑定的首次输入才会进入 Solo 发现流程。因此任意一侧改名都不会新建云端 Solo，也不会产生第二个本地任务。
- 网页 Agent 执行没有交互式界面。若 MCP server 请求填写表单或打开 URL，GatherThread 会返回协议级 `decline`，既不打开链接、也不代填内容，同时不会因此中断整个 Codex turn。命令执行、文件修改、权限审批以及其他未知的服务端主动交互仍然失败关闭。
- 旧版 `codex exec` 映射会在下一次请求时新建桌面可见 thread，并用规范历史重建；旧的 Codex 原生 transcript 不会被删除。

## Codex 桌面端边界

Codex Desktop 是每个可见任务的唯一 writer。网页请求不会 resume 这个任务，而是在后台投影执行并把结果发布到规范 Web 记录。下一次 Desktop prompt 时，Hook 会从该任务独立投递游标之后提供下一批已确认 capsule。很长的积压会按规范顺序在多个已完成回合中继续排空，而可见回复始终只显示简短预览；后台投影仍保有并在本地 compact 完整规范序列。这样能限制 Desktop 上下文并保持服务器顺序，但当前公开 Codex API 无法把远端事件补画为 Desktop 已有任务中的历史气泡。

旧版连接器状态无法证明先前固定长度截断是否已真正交付所有事件。因此升级后的首次加载会把 Desktop 投递游标安全设为零，再用有界 capsule 重放规范历史。重放内容只作为上下文，绝不会作为新的 Agent 请求执行。

只有显式信任插件或项目 Hook 的受管执行 thread，才会把桌面端直接输入双向同步。私有 `0600` thread registry 会在 relay 前校验原生 thread ID，无关 Codex 任务和不可变快照 thread 会在本地直接丢弃。兼容项目 Hook 还可使用有界离线 spool，插件 Hook 则只转发给运行中的连接器。`--plugin-hooks` 或 `--install-hooks` 会在 POSIX 上启动私有 Unix socket，在 Windows 上启动项目映射 named pipe；两者都未启用时，连接器不会监听 Hook IPC 端点。用户 MCP 写操作另由每次启动随机 capability 授权，不依赖可猜路径。IPC 端点、capability、registry 与兼容 spool 都不包含 GatherThread Bearer Token。受管 prompt 仍可能包含敏感内容，因此必须保密的工作应在另一个未受管 Codex 任务中进行。

网页执行和 Desktop 回合现在可以独立运行，因为它们不再共享原生 writer；服务器规范序号负责排序两边最终接受的输出。稳定错误会自动合并：立即显示一次，之后最多每分钟一次，并在恢复时显示一次。

## 下载只读会话

当前角色无法写入某个会话时，网页会显示 **Download to Codex** 而不是输入框。每次点击都会创建一个服务器任务，并冻结当次请求的 `through_sequence`。本地连接器只导入截至该序号的历史，创建名为 `GatherThread snapshot · 项目 · 会话 · through 序号` 的新 thread。

每次下载都互相独立且不可变：不会追踪后续云端事件，不会领取 Agent 请求，也不会回传任何桌面回合。再次点击会再建一个快照，而不是更新或转化此前的 thread。包括 Viewer 在内，请求者都需要保持自己的连接器运行，才能领取自己的快照任务。

## 更保守的运行方式

让 Codex 只能读取项目：

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol \
  --sandbox read-only
```

只共享最终回答，不上传结构化工具调用及有界工具结果：

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol \
  --no-share-tool-events
```

默认沙箱是 `workspace-write`。连接器始终禁止自动提升权限，也不支持 `danger-full-access`。

## 重建本地 Codex 会话

如果确实希望该项目下所有会话重新建立本地 Codex 上下文，先停止连接器，再运行：

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol \
  --project PROJECT_ID \
  --reset-codex-session
```

这个操作只删除该项目绑定下私有的本地 thread、游标、outbox 与 hook 映射文件，使用前应先检查是否还有待上传 outbox。它不会删除 GatherThread 服务器历史，也不会删除 Codex 原生 transcript。可实时写入的会话会从当前用户可见的完整服务器历史重建；以后点击下载仍会创建互相独立的快照。

## 停止和重新连接

按 `Control-C` 停止。心跳过期后各会话 runtime 通常会在30秒内显示 Offline。以后运行相同命令，会继续使用每个会话原来的 Codex thread 和 GatherThread 持久化游标。一个连接器进程管理一个完整项目，不需要为每个会话另开进程。

正常停止连接器时会为显式 `--install-hooks` 兼容路径保留当前执行白名单，使其项目转发器能够捕获有界离线回合。首选插件转发器没有离线 spool，因此要求连接器持续运行。只有成功取得服务器权威 ACL，或服务器明确返回项目访问 `403`/`404` 后，才会执行权限清理。

## 常见问题

- `Codex CLI could not be started`：安装 Codex/ChatGPT 桌面应用，或者使用 `--codex-command /Codex绝对路径`。
- `Codex App Server could not be started`：更新本机 Codex/ChatGPT 桌面应用；连接器要求 CLI 提供 `codex app-server --stdio`。
- `codex login status` 失败：先在本机完成 Codex 登录。
- `No active GatherThread projects are available for this user`：先接受项目邀请，或请 Owner 恢复访问权限。Viewer 项目同样有效，会进入纯快照模式。
- 网页一直显示 Offline：保持连接器终端运行，检查 Tailscale 和 HTTPS 地址，然后等待最多5秒让网页刷新成员状态。
- `Codex session state belongs to a different workspace/session`：使用原来的项目路径，或者明确执行项目 reset。
- 导入接近上下文上限：保持连接器运行，让它 compact 后继续。如果 App Server 未报告模型窗口，先审查保守回退值再决定是否提高；服务器历史不会被删除。
- 受管任务没有出现在 Desktop：保持连接器运行，重新打开生成的工作区，并核对终端显示的准确任务名。网页 Agent 回合有意保留在后台投影，不会生成 Desktop 历史气泡。
- 只读快照任务没有出现：点击 **Download to Codex**，并保持快照连接器运行直到冻结任务完成。
- Desktop 回合完成后仍未上传：确认连接器使用了 `--plugin-hooks`、在整个回合中保持在线，且插件 Hooks 已审查和信任。只有显式 `--install-hooks` 兼容文件能在连接器停止时暂存已授权 Hook，并在重启后清空。插件 Hook 漏掉的回合，以及可信 Hook 生效前完成的回合，都不会被事后猜测或上传。
- `already has an active writer`：请更新到双投影连接器。当前版本不会再用后台 App Server 打开 Desktop 独占任务；同一稳定错误只会立即显示一次，之后最多每分钟一次。
- Alpha 版本中，如果进程在领取请求后崩溃，请求可能卡住；可重新发送一条替代请求，自动 claim lease 恢复尚未实现。

## 安全边界

共享历史属于不可信的协作数据。连接器会把服务器验证过的本地请求与之前的上下文分开，保留 Codex 沙箱，禁止自动权限提升，从子进程环境移除 GatherThread 凭据，限制输出和 hook 输入大小，排除 raw reasoning 和私有 prompt，并在上传前执行统一脱敏。私有状态文件和兼容项目 Hook 的离线 spool 仍可能包含本地会话内容，因此需要保护本地用户账号和磁盘。这些措施只能降低而不能完全消除 prompt injection 风险；只与可信成员协作，对不可信项目使用 `read-only`。

服务器会为每条快照任务保守计入 1 KiB 元数据，把单条快照结果限制为 8 KiB UTF-8 JSON，并默认执行累计任务配额：每位用户 4 MiB、每个会话 8 MiB、整个部署 64 MiB。未终结任务还分别限制为每位用户 64 条、每个会话 256 条、整个部署 4096 条。快照结果只存投影元数据，不包含导入的规范 transcript 正文。

[ADR-0013](adr/0013-single-writer-dual-codex-projections.md)记录双投影边界，[ADR-0014](adr/0014-acknowledged-bounded-desktop-relay-capsules.md)记录有确认的 relay 投递，[ADR-0015](adr/0015-create-personal-solos-from-first-local-prompt.md)记录首条 prompt 创建个人 Solo 的规则。Codex App Server 的协议能力参见 [OpenAI 官方文档](https://developers.openai.com/codex/app-server)。
