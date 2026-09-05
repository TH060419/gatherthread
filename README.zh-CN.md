# GatherThread

[English](README.md) | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/badge/release-0.1.0--beta.1-0f766e.svg)](docs/releases/0.1.0-beta.1.md) [![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**一个空间，汇聚众智。**

**GatherThread** 让多人在同一空间协作，各自使用本地 Agent，共享有序、可追溯、实时同步的上下文。它不绑定具体 Agent harness，每位协作者都可以保留自己熟悉的本地 Agent 和工作方式。

- `solo`：由创建者发布完整的规范化会话事件流；项目内其他所有人只读，即使对方是项目创建者。
- `multi`：多人共享一个有序的项目会话。普通聊天消息只进入共享会话，不会调用 Agent；Agent 请求只由发送者自己的本地 runtime 领取，回复会标注用户名、harness、provider、模型和上下文保真度，不会向其他成员暴露本地设备或原生会话标识。

服务器使用 SQLite WAL 持久化只追加的规范事件日志，为每个会话分配权威序号，执行基于角色的访问控制，并提供可持久重放的历史记录和 WebSocket 实时推送。对每个可编辑 Codex 会话，本地 bridge 会分别维护一个由 Desktop 独占写入的交互任务和一个后台执行投影。可信 Hook 通过持久、幂等的 outbox 上传桌面回合；网页请求与规范历史导入只在后台投影运行，避免两个进程争抢同一个原生 writer。

中英文网页工作区会响应窗口尺寸，并允许调整主要区域大小。项目级设置统一管理默认 Agent 模型、推理强度和上下文注入上限；无障碍自定义控件、默认高对比度和适配日夜主题的环境柔光，让界面保持清晰，同时不干扰会话内容。

网页 Agent 回合采用接近 Codex Desktop 的阅读层级：公开工作进展实时出现，最终答复到达后自动收进可展开的“工作过程”。最终答复与工作进展均使用安全的 GitHub 风格 Markdown 渲染，并通过本地打包的 KaTeX 显示行内与块级公式；隐藏推理不会上传或显示。

## 项目与权限模型

项目是协作、邀请和权限的边界。项目创建者（`owner`）创建 `multi` 会话，并可随时把其他成员调整为参与者（`participant`）或访者（`viewer`）。创建者与参与者都可以创建自己的个人 `solo`；只有该 Solo 的创建者可以写入或改名，项目内其他人全部只读。参与者还可以在所有 `multi` 会话中聊天并请求自己的本地 Agent。访者对整个项目只读，其本地新任务不会创建任何云端会话。会话创建者或项目创建者可永久删除该会话的云端副本，只有项目创建者可删除整个云端项目。云端删除会停止同步并清除服务器上的共享历史，但不会删除任何本地工作区、文件、Codex 任务或 Agent 对话。

## “完整上下文”的含义

项目明确记录三种上下文保真度：

1. `canonical_history`：该成员可见的完整共享事件历史。
2. `harness_transcript`：从已授权的本地 harness 会话记录中实际观察到的内容。
3. `provider_request`：由明确授权的 harness hook 或 provider 代理观察到的原始请求。

MCP 服务器无法自行读取 host 中的完整会话。因此，根据历史重建的上下文绝不会被标记为 `provider_request`；只有本地 bridge 获得明确授权并确认捕获到原始请求时，才能上传这一保真度的上下文。上下文压缩由每个本地 Agent 自行处理，共享的规范事件日志保持完整和持久。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `apps/server` | 带身份验证的 HTTP/WebSocket 服务、SQLite WAL、ACL、历史重放和 runtime 请求领取 |
| `apps/web` | 支持中英文、区域调节、Agent 设置、solo/multi、聊天/Agent 请求和断线补偿的响应式工作区 |
| `packages/protocol` | 规范事件和 API schema |
| `packages/adapters` | 已授权的 Codex、Claude Code 会话发现、解析和脱敏 |
| `packages/bridge` | 本地 runtime 注册、游标、上下文上传和请求领取/完成流程 |
| `packages/dsh-host` | 默认关闭的 DeepSeek Harness Host/Client 插件、配对、项目绑定、恢复与脱敏 |
| `packages/mcp` | MCP 工具、资源和无状态 Streamable HTTP JSON-RPC handler |
| `tests` | 契约、安全、备份和真实 server-to-bridge 集成测试 |

## 环境要求与验证

服务器使用 `node:sqlite`，因此需要 Node.js 24 或更新版本。

```bash
npm install
npm run verify
```

`verify` 会运行严格的 TypeScript 检查、server/protocol/adapter/bridge/MCP 测试、Web 测试和构建、真实的 server-to-bridge Agent 回合、协作契约测试、参考项目与许可证检查、密钥扫描和 npm 漏洞审计。密钥扫描检查所有可能被 Git 提交的文件，但不会读取 `.gitignore` 已排除的本地 `.env`；如果有人强制跟踪 `.env`，扫描仍会阻止提交。

## 本地端到端运行

首次初始化会在缺少 `.env` 或 Pepper 留空时自动生成权限为 `0600` 的私有 `.env` 和稳定随机 Pepper。直接创建第一位所有者，然后启动同源的 Web/API/WebSocket 服务：

```bash
npm run connection:local
npm run owner-host:init -- --display-name "Alice" --device-name "Alice laptop"
npm run owner-host
```

如需自定义端口或路径，可以在初始化前手动复制 `.env.example`；`owner-host:init` 会只填充空的 Pepper，不会覆盖其他设置。`owner-host` 每次启动都会自动构建当前源码。

在 `http://127.0.0.1:8787` 输入命令一次性显示的设备凭据。页面会用它换取一个不透明的 `HttpOnly; SameSite=Strict` 浏览器会话 Cookie，然后立即从 JavaScript 内存中清除设备凭据。刷新页面时可以自动恢复登录，不使用 `localStorage` 或 `sessionStorage`。默认会话在服务器端有 24 小时绝对有效期，Cookie 本身不持久；勾选“记住此设备”后，会改用 30 天持久 Cookie。主动退出、撤销设备或轮换设备 Token 都会立即使两种会话失效。HTTPS 部署会额外启用 `Secure` 和 `__Host-` Cookie 前缀。WebSocket 仍使用独立的 30 秒有效、一次性、限定会话的 ticket，任何凭据都不会写入 URL。

如果只开发 UI，运行 `npm --workspace apps/web run dev` 即可启动仅绑定 loopback 的预览服务并代理本地 API。显式 mock 模式只在 `http://127.0.0.1:4173/?mock=1` 可用，演示凭据为 `demo-token`。

## 选择连接方式

无需云账户即可使用三种连接方式，它们会保留同一个私有 `.env`、数据库、凭据 Pepper、用户和历史：

| 方式 | 命令 | 场景 |
|---|---|---|
| 仅本机 | `npm run connection:local` | 一台电脑完整测试，不开放网络 |
| 局域网 HTTPS | `npm run lan:start` | 同一可信局域网内的已知设备；自动选址并启动两个服务 |
| Tailscale Serve | `npm run connection:tailscale -- --url https://主机.tailnet.ts.net` | 跨网络的小规模已知协作者 |

局域网模式仍把应用限制在 loopback，只让专用 Caddy HTTPS 代理绑定选定的私网地址；客户端必须显式信任专用本地 CA，不能绕过证书警告，也不能配置路由器端口转发。校园网通常属于学校管理的局域网络，但不保证终端可以直接互访：只有校方策略允许且设备间可达时才使用局域网模式；遇到客户端隔离或 VLAN 分区时，应改用项目已经配置的远程入口。当前可使用 Tailscale，统一服务器上线后应优先使用服务器入口。完整操作与模式切换参见[无云账户连接方案](docs/CONNECTION_MODES.zh-CN.md)，Tailscale 权限和备份参见[单主机部署指南](docs/SELF_HOSTING.md)。

## 接入本地 Codex Agent

每位协作者在 GatherThread 网页中选择项目，点击 **Connect Codex / 连接 Codex**，复制与自己系统对应的固定版本命令。无需 clone GatherThread，也无需预先执行 `npm install`：

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 --url 'https://your-host.your-tailnet.ts.net/v1' --project 'PROJECT_ID' --create-workspace
```

PowerShell 使用 `npx.cmd` 传递同一组无凭据参数。项目级 Agent 设置继续控制网页请求；非默认模型或上下文设置经过严格校验后才会进入连接命令。

命令不含任何 Token；连接器会在终端中隐藏输入自己的设备 Token，在 `~/GatherThread Projects/` 下安全创建或复用与云端项目同名的本地工作区，并在 Codex Desktop 中打开它。连接器还会建立由每次启动随机 capability 保护的私有用户工具 IPC；设备 Token 只留在连接器内存，不会传给插件 MCP 进程或 Codex。首次实体化可编辑会话时，会建立一个名为 `会话名 · GatherThread` 的 Desktop 任务，以及一个名为 `会话名 · GatherThread background` 的实现私有 `exec` 后台投影。Desktop 是可见任务的唯一 writer；网页 **请求我的 Agent** 在后台投影执行，再通过规范历史汇合。连接器会自动发现后续新会话，请保持终端运行。若要绑定已有源码目录，请改用 `--workspace "/本地项目绝对路径"`。

仓库内可发布的 **共序 / GatherThread** Codex 插件提供项目、会话、历史、发送消息/请求和脱敏连接状态等普通用户 MCP 工具。真实的 Beta 基础模式是“一个或多个固定版本常驻项目连接器 + 插件”；Finder 启动的 Desktop 通常不会继承终端凭据环境，因此插件会把同一端点的崩溃重启重叠登记合并为租约较新的实例，再聚合所有不同的非秘密活动登记，并按唯一项目/会话 ID 路由私有 IPC；不同端点的 ID 歧义或目标下线时失败关闭。环境变量直连仅属于开发者预览。完整模式再给连接器加 `--plugin-hooks`，并在 Codex 中明确审查和信任 Hooks。插件自带极小 Hook 转发脚本，每回合不运行 `npx`，但要求连接器在线且不会离线暂存；它允许从工作区根目录或子目录发起回合，并以连接器生成的根 registry 为准。Hook 不能唤醒空闲 Codex，也不能启动新回合。旧的 `--install-hooks` 项目文件方式保留为带有界离线暂存的显式兼容入口；切换模式后即使该文件仍在，运行时来源门也会阻止两套 Hook 同时返回上下文或共用 spool。

Safari、Chrome 和 Edge 只负责复制命令；出于浏览器安全边界，网页不会直接启动、安装或控制本地 Codex。固定 release ref 存在后，先运行 `codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-beta.1 --sparse .agents/plugins --sparse plugins/gatherthread`，再运行 `codex plugin add gatherthread@gatherthread`。随后重启 Desktop，并在启用前审查 **共序 / GatherThread** 及其 Hooks。公开发布前仍须确认 npm scope/包名所有权；通用公共插件目录仍是后续工作。

规范事件会按顺序导入后台投影，并使用冻结且按类型区分的前缀：`用户名 · Human Chat：`、`用户名 · Agent Request：` 和 `用户名 · Agent Response · harness · model：`。安装并信任项目 Hook 后，`UserPromptSubmit` 会把经过确认、受上下文预算约束的 capsule 交给 Desktop Agent。可见回复先显示 `Loaded N cloud updates / 已加载 N 条云端更新`，最多展示三条短预览；精确正文只放在供模型推理的上下文块中。超长事件会按 UTF-8 安全分段，在后续完成的 Desktop 回合继续同步。取消回合不会确认任何分段，持久投递游标也绝不会越过被省略的内容。同步内容被明确标成不可信共享历史，不会作为新请求再次执行。`Stop` 则把这次 prompt 与最终回复恰好上传一次。当前公开 Hook 不提供完整结构化工具流，因此桌面端工具事件会被省略，而不是通过争抢 writer 去补读。当前公开 Codex API 无法把远端事件补画成 Desktop 已有任务中的历史气泡。后台长历史会独立 compact，会话对齐不会回滚源码文件。

启用并信任 Hook 后，此前尚未绑定的 Codex Desktop 任务会以“第一次提交 prompt”为创建边界。项目创建者或参与者的连接器会幂等创建一个本人所有的个人 Solo，绑定现有 Desktop 任务，并把同一个已完成回合恰好上传一次；仅仅打开空任务不会创建云端内容。访者的任务始终留在本地。连接器自己的后台执行任务与快照任务会被明确排除，不能递归触发创建。

只读会话不显示输入框，而显示 **下载到 Codex**。每次点击都会冻结一个新的 `through_sequence`，创建互相独立的本地快照任务，之后绝不向云端回传。创建者与参与者实时同步 `multi` 和自己创建的个人 Solo，并下载其他成员的 Solo；访者下载全部会话。Hook 安装和信任始终是显式操作。GatherThread 凭据不会进入 Codex 子进程环境，自动权限提升始终禁用，并且不支持 `danger-full-access`。当前流程参见[Codex 接入指南](docs/CODEX_CONNECT.zh-CN.md)、[ADR-0013](docs/adr/0013-single-writer-dual-codex-projections.md)、[ADR-0014](docs/adr/0014-acknowledged-bounded-desktop-relay-capsules.md)、[ADR-0015](docs/adr/0015-create-personal-solos-from-first-local-prompt.md)和[ADR-0018](docs/adr/0018-unified-codex-plugin-and-connector.md)。

## 接入 DeepSeek Harness

DeepSeek Harness 采用“插件优先”的连接方式。在 GatherThread 当前项目中打开 **连接 DeepSeek Harness**。网页不会探测 localhost，也不会尝试静默拉起本机进程；没有在线 runtime 时，Safari、Chrome 和 Edge 都使用同一套三步降级引导：

```bash
npx @deepseek-ai/dsh web
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add @gatherthread/dsh-host@0.1.0-beta.1
```

第二条是 DSH 0.1.2 已验证的官方 profile 插件机制；该版本没有已证实的公开插件市场。本候选只把 `@gatherthread/dsh-host` 准备为可发布包，没有实际发布，因此 npm 安装命令要等包发布后才能使用。可用 `npx @deepseek-ai/dsh --version` 检查版本；当前已验证 npm 版本为 `0.1.2-rc.1`，不一致时使用 `npx @deepseek-ai/dsh@0.1.2-rc.1 web`。DSH 0.1.2 没有通过稳定 Host service 暴露根 CLI 版本，所以 GatherThread 会严格校验所需 Host API 并安全失败，不读取 npx 缓存私有路径来伪装版本检测。

安装后，在 DSH 中打开 **Settings → GatherThread / 共序**。可以选择未来的共序官方服务，也可以输入一个自定义服务器 origin，统一覆盖 HTTPS 局域网、自托管和 Tailscale。插件只主动向外连接，服务器不会反向访问本地 DSH。点击 **登录并配对** 后，会用五分钟有效、只能消费一次的短码打开所选 GatherThread 地址。当前授权复用已有的签名浏览器会话或邀请身份，不假设独立公共账户注册系统已经上线。长期设备凭据只保存在 DSH 的 credential store 中，不进入 URL、argv、Web Storage、日志、状态响应或 canonical history。

runtime 上线后，在项目设置或 composer 中选择 **DeepSeek Harness**，再选择精确的 DSH 设备/provider/model，点击 **请求我的 Agent**。请求只会由匹配 runtime 领取，绝不会静默降级到 Codex。多台设备可以选择、重命名和撤销；仅有一台在线时会自动选中。仓库里的 `dsh:connect` 只保留为源码 checkout 的高级诊断工具，不是普通用户路径。维护者可运行 `npm run test:dsh-npm-plugin:real`，在不使用真实凭据和真实 DSH_HOME 的前提下验证固定 npm 包、Loader、浏览器配对和 Agent 闭环；运行前需让固定依赖已经存在于本机缓存。

## 安全机制与当前限制

首个版本已经包含：使用 pepper 保护的设备凭据、仅存 HMAC 摘要且可撤销的浏览器会话、严格的 Cookie 写请求 Origin 校验、一次性邀请与设备授权、绑定设备的 runtime 来源证明、设备或项目权限撤销后立即使对应浏览器会话、socket 和授权失效、solo/multi ACL、事件脱敏、限定会话的幂等校验、单 runtime 请求串行化、一次性实时连接 ticket、严格的生产环境 WebSocket Origin 检查、有界 JSON 复杂度和按字节分页的历史重放、按设备限流、按用户/项目/部署限制会话数量、事件与快照任务存储配额、断线重放，以及 SQLite 备份/恢复脚本。成员查看他人活动时，只会看到用户名、harness、provider、model 和捕获保真度，不会得到本地设备或原生会话标识。新邀请用户的设备 Token 只展示一次，必须在关闭提示前妥善保存。

无需云账户时可使用仅本机、局域网 HTTPS 和私有 Tailscale Serve。需要统一的公网 Beta 入口时，`0.1.0-beta.1` 提供仅凭邀请加入的[阿里云 ECS 部署方案](docs/ALIYUN_ECS.zh-CN.md)。所有方式都让应用只监听 loopback，只有文档规定的 Caddy 边界可以接收公网流量。不要开放 8787、使用路由器端口转发、启用 Tailscale Funnel，或接入未经身份验证的公网隧道。

尚未实现：主机自动故障转移、多进程 WebSocket fan-out、无人处理的 Agent 请求领取恢复、Agent token 级流式显示、附件对象存储、保留期清理任务、Web 离线 outbox、回复/搜索界面，以及原生安装包。

更多信息请参阅 [`0.1.0-beta.1` 候选说明](docs/releases/0.1.0-beta.1.md)、[产品规格](docs/PRODUCT_SPEC.md)、[架构](docs/ARCHITECTURE.md)、[架构决策记录](docs/adr/README.md)、[无云账户连接方案](docs/CONNECTION_MODES.zh-CN.md)、[阿里云 ECS 部署](docs/ALIYUN_ECS.zh-CN.md)、[单主机部署](docs/SELF_HOSTING.md)、[Tailscale 双人线上测试流程](docs/ONLINE_TESTING_TAILSCALE.zh-CN.md)、[安全模型](docs/SECURITY.md)、[运维说明](docs/OPERATIONS.md)，以及[相关项目与致谢](docs/REFERENCES.md)。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。版权所有 © 2026 Yuhan He 及项目贡献者。
