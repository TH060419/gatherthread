# GatherThread

**GatherThread（共序）** 是面向多人及各自本地 AI 编程 Agent 的开源、可自托管协作空间。Codex Desktop 与 DeepSeek Harness 可以接入同一项目的有序历史和共享上下文：会话按参与者标注、可重放并实时同步，Solo/Multi 模式有明确的角色权限。每位成员保留自己的本地 Agent 和凭据；Git 代码检查点需单独主动授权，不是默认上传。

> **Alpha 7：可选的项目代码协作。** 云端 Git 代码检查点支持每位成员独立分支、手动/空闲时自动上传、安全下载、恢复到新目录，以及创建者审核合并。Codex 需显式添加 `--code-sync` 授权，DSH 可在插件设置中逐项目授权并操作。聊天上传与实时上下文注入不受影响，原有本地 Git 分支和暂存区不被改动。所有项目成员均可读取代码分支，Solo 不提供代码隐私隔离。详见[使用流程、边界与测试清单](docs/CODE_SYNC.md)。

> **Alpha 7：云端代码配额与清理。** 每用户有效云端代码快照限额为 128 MiB；成员可在设置中清理自己的云端分支，项目创建者还可选择清理整个项目的云端 Git。清理个人分支不会撤销已合入共享 `main` 的代码；任何云端清理都不会改动本地 Git 或 Agent 文件。它会撤销云端访问并释放逻辑配额，但物理 Git 对象和旧备份需另行按运维保留策略清理。详见[代码协作指南](docs/CODE_SYNC.md)。

> **原生上下文管理与审计修复。** Alpha 7 优先使用 Codex 原生窗口与用量，保留 DSH 自身模型及压缩设置，不再直接裁剪限额内接收的公开历史。原生压缩不是无限或无损记忆，特殊恢复仍有限制；详见 [Codex 指南](docs/CODEX_CONNECT.zh-CN.md)和 [DSH 指南](docs/DSH_CONNECT.zh-CN.md)。

[English](README.md) | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/badge/release-0.1.0--alpha.7-0f766e.svg)](docs/releases/0.1.0-alpha.7.md) [![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**一个空间，汇聚众智。**

**GatherThread** 不绑定具体 Agent harness，每位协作者都可以保留自己熟悉的本地 Agent、模型选择和工作方式。

> **邀请制 Alpha 测试。** [gatherthread.cn](https://gatherthread.cn/) 已进行小规模服务器测试，尚未开放公众注册或公共 Beta。每位测试者需要一次性测试资格码来激活账号；仅凭项目邀请，只能进入被邀请的项目。本机、局域网和 Tailscale 自托管方式仍可使用。

当前邀请制服务器运行的源码提交是 `52aac1a5ffda`，现已由 `v0.1.0-alpha.7` Git 标签标识；它包含记住账号快捷登录、首次进入工作区的云端 Git 须知，以及个人云端代码配额与清理。移动 Git 标签不会重建此前已发布的 Alpha 7 npm 包；目前仍没有 Alpha 7 GitHub Release。

## 申请 Alpha 测试资格

**[在 GitHub 发起 Alpha 测试申请 Issue](https://github.com/TH060419/gatherthread/issues/new?template=test-access.yml)**。源码仓库现已公开，但服务器账号仍须经维护者审核并取得一次性测试资格码才能激活；申请仅通过 Issue 发起，不提供邮件表单，也不会在服务器建立申请人资料。模板可选填申请理由、希望测试的内容、了解 GatherThread 的渠道，以及愿意公开的邮箱。Issue 内容公开；只有在愿意公开邮箱时才填写，填写后便于获批时通过邮件私下发送资格码。请勿发布资格码、设备 Token、密码、密钥或私有代码。

维护者审核后会在 Issue 中回复结果与后续步骤。资格码是一次性秘密，绝不在公开 Issue 中发送。若不愿在 Issue 公开邮箱，申请获批后可主动将 Issue 链接发至 [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn)，再通过邮件私下接收资格码；邮件仅用于私密联系，不替代 Issue 申请。拿到资格码后，打开[服务器登录页](https://gatherthread.cn/app/)，先填写自己的用户名与设备名，再在“首次使用 · 激活资格”中输入资格码。请妥善保存随后另行签发的设备 Token，供以后登录使用。已有资格的用户也可以邀请访客加入某个项目，但项目邀请不会赋予访客创建新项目的资格。

使用疑问、缺陷和非敏感反馈，请[提交 GitHub Issue](https://github.com/TH060419/gatherthread/issues)；安全问题请私下联系 [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn)，不要附上凭据或未脱敏的私人会话。

- `solo`：由创建者发布完整的规范化会话事件流；项目内其他所有人只读，即使对方是项目创建者。
- `multi`：多人共享一个有序的项目会话。普通聊天消息只进入共享会话，不会调用 Agent；Agent 请求只由发送者自己的本地 runtime 领取，回复会标注用户名、harness、provider、模型和上下文保真度，不会向其他成员暴露本地设备或原生会话标识。

服务器使用 SQLite WAL 持久化只追加的规范事件日志，为每个会话分配权威序号，执行基于角色的访问控制，并提供可持久重放的历史记录和 WebSocket 实时推送。Codex 与 DeepSeek Harness 分别维护同一份规范历史的原生投影，通过持久游标和 outbox 断线恢复；每个 Agent 请求只会路由到用户明确选择的 runtime。

中英文网页工作区会响应窗口尺寸，并允许调整主要区域大小。项目级设置统一管理默认 Agent 模型、推理强度和 Codex 备用上下文预算；无障碍自定义控件、默认高对比度和适配日夜主题的环境柔光，让界面保持清晰，同时不干扰会话内容。

网页 Agent 回合采用接近 Codex Desktop 的阅读层级：公开工作进展实时出现，最终答复到达后自动收进可展开的“工作过程”。最终答复与工作进展均使用安全的 GitHub 风格 Markdown 渲染，并通过本地打包的 KaTeX 显示行内与块级公式；隐藏推理不会上传或显示。

## 项目与权限模型

项目是协作、邀请和权限的边界。项目创建者（`owner`）可以重命名项目、创建 `multi` 会话、在 `solo` 与 `multi` 之间切换自己创建的会话，并可随时把其他成员调整为参与者（`participant`）或访者（`viewer`）。创建者与参与者都可以创建自己的个人 `solo`；只有该 Solo 的创建者可以写入或改名，项目内其他人全部只读。参与者还可以在所有 `multi` 会话中聊天并请求自己的本地 Agent。访者对整个项目只读，其本地新任务不会创建任何云端会话。会话创建者或项目创建者可永久删除该会话的云端副本，只有项目创建者可删除整个云端项目。云端删除会停止同步并清除服务器上的共享历史，但不会删除任何本地工作区、文件、Codex 任务或 Agent 对话。

## “完整上下文”的含义

项目明确记录三种上下文保真度：

1. `canonical_history`：该成员可见的完整共享事件历史。
2. `harness_transcript`：从已授权的本地 harness 会话记录中实际观察到的内容。
3. `provider_request`：由明确授权的 harness hook 或 provider 代理观察到的原始请求。

MCP 服务器无法自行读取 host 中的完整会话。因此，根据历史重建的上下文绝不会被标记为 `provider_request`；只有本地 bridge 获得明确授权并确认捕获到原始请求时，才能上传这一保真度的上下文。上下文压缩由每个本地 Agent 自行处理，共享的规范事件日志保持完整和持久。

Alpha 7 还支持**手动总结部分会话历史**：只有该会话的写入者能选取公开且已完成的消息，交给自己已连接的本地 Agent 生成带作者与来源的共享总结；访者能阅读和切换视图，不能发起生成。原文永远保留，可切换查看、再次选择，也可将已有总结的正文与其他消息一起选入下一次总结。每位成员可独立设置今后从 GatherThread 网页发起的 Agent 请求默认注入“总结后内容”（默认，较精简但可能遗漏细节）或“原文”（更完整但占用更多上下文），并修改或重置自己的总结提示词；这一选择也适用于显式读取派生上下文的 MCP 工具，但不会反向改写 Codex/DSH 已有原生会话。这与原生自动压缩及本地回合自动上传开关相互独立。详见 [ADR-0027](docs/adr/0027-shared-manual-history-summaries.md)。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `apps/server` | 带身份验证的 HTTP/WebSocket 服务、SQLite WAL、ACL、历史重放和 runtime 请求领取 |
| `apps/web` | 支持中英文、区域调节、Agent 设置、solo/multi、聊天/Agent 请求和断线补偿的响应式工作区 |
| `site` | 介绍 GatherThread 并进入同源应用的中英文产品首页 |
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

打开 `http://127.0.0.1:18787` 进入产品首页，再选择“开始使用”进入同源的 `/app/` 登录页与工作区。在这里输入命令一次性显示的设备凭据；应用会用它换取一个不透明的 `HttpOnly; SameSite=Strict` 浏览器会话 Cookie，然后立即从 JavaScript 内存中清除设备凭据。刷新页面时可以自动恢复登录，设备 Token 不进入 `localStorage` 或 `sessionStorage`。默认会话在服务器端有 24 小时绝对有效期，Cookie 本身不持久；勾选“记住此设备”后，会建立 30 天持久会话和独立的 `HttpOnly` 已记住账号凭据。此账号会出现在同一浏览器资料的登录下拉列表中，带出上次使用的用户名和设备名，登录前仍可修改。主动退出会撤销当前会话，但仍可从下拉列表快捷登录；30 天到期、选择“忘记此账号”或撤销/轮换设备 Token 后，此快捷资格失效。共用浏览器资料时不要勾选“记住此设备”。HTTPS 部署会额外启用 `Secure` 和 `__Host-` Cookie 前缀。WebSocket 仍使用独立的 30 秒有效、一次性、限定会话的 ticket，任何凭据都不会写入 URL。较高的默认端口可以减少 Windows 上常见的低端口占用冲突。已经显式设置 `GATHERTHREAD_SERVER_PORT=8787` 的既有安装仍会继续使用该值；`18787` 只作为新的默认端口。

如果只开发 UI，运行 `npm --workspace apps/web run dev` 即可启动仅绑定 loopback 的预览服务并代理本地 API。产品首页位于 `http://127.0.0.1:4173/`；工作区显式 mock 模式只在 `http://127.0.0.1:4173/app/?mock=1` 可用，演示凭据为 `demo-token`。

## 服务器 Alpha 与其他连接方式

当前服务器 Alpha 入口为 [https://gatherthread.cn](https://gatherthread.cn/)，同源工作区位于 `/app/`。所有者管理的 ECS 服务由 Caddy 提供 HTTPS，应用本身只监听 loopback；不提供匿名注册或公开 Git 传输。加入项目后，再从自己的设备连接 Codex 或 DeepSeek Harness。普通产品测试不需要服务器 SSH 账号。

如需独立自托管，无需阿里云账号也可使用三种方式；它们保留该部署自己的私有 `.env`、数据库、凭据 Pepper、用户和历史：

| 方式 | 命令 | 场景 |
|---|---|---|
| 仅本机 | `npm run connection:local` | 一台电脑完整测试，不开放网络 |
| 局域网 HTTPS | `npm run lan:start` | 同一可信局域网内的已知设备；自动选址并启动两个服务 |
| Tailscale Serve | `npm run connection:tailscale -- --url https://主机.tailnet.ts.net` | 跨网络的小规模已知协作者 |

局域网模式仍把应用限制在 loopback，只让专用 Caddy HTTPS 代理绑定选定的私网地址；客户端必须显式信任专用本地 CA，不能绕过证书警告，也不能配置路由器端口转发。校园网通常属于学校管理的局域网络，但不保证终端可以直接互访：只有校方策略允许且设备间可达时才使用局域网模式；遇到客户端隔离或 VLAN 分区时，已有资格的测试者可改用服务器 Alpha，或使用私有 Tailscale 部署。完整操作与模式切换参见[无云账户连接方案](docs/CONNECTION_MODES.zh-CN.md)，Tailscale 权限和备份参见[单主机部署指南](docs/SELF_HOSTING.md)。

## 接入本地 Codex Agent

网页里的 **连接 Codex** 统一为三个步骤：

1. 一次性安装固定版本的 **共序 / GatherThread** Codex 插件。
2. 复制网页生成的 macOS/Linux 或 PowerShell 连接命令。命令已包含 `--plugin-hooks`，但不含任何凭据。
3. 重启 Codex Desktop，审查并启用插件 Hooks，然后保持连接器终端运行。

插件只需安装一次：

如果 `codex --version` 不可用或终端提示 `codex: command not found`，请先运行 `npm install -g @openai/codex` 安装或更新官方 Codex CLI。重新打开终端，确认 `codex plugin --help` 可用后再继续。

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.7 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

连接器会在终端隐藏提示中读取设备 token，创建或复用本地项目，打开 Codex Desktop，并自动发现后续会话。可编辑的 GatherThread 会话会成为 Codex 任务；网页 Agent 请求在隔离的后台投影中运行，经信任的 Hooks 则把 Desktop 直接回合写回同一份规范历史。工作页为当前对话提供“本地回合自动上传至云端”开关和“立即从本地上传至云端”保底操作，Codex 插件也提供相同控制；Hook 漏记或失效时可扫描并补传已完成回合，且不会擅自重新开启自动上传。默认在每个会话首次于本地建立时导入一次经过验证、可直接阅读的原生历史快照；设置中可以关闭这次初始导入。“导入 Codex 历史”每次都会创建一个经过验证的新本地任务，公开消息不再按备用预算直接裁剪；在独立快照资源限额内，长历史由 Codex 原生压缩，后续 Hook 和上下文投递会切换到新任务。GatherThread 不覆盖或归档旧任务，请用户检查后自行归档。无论是否启用初次导入或执行手动导入，实时上下文注入都继续独立运行。本地新任务只有在首个回合成功完成后才会创建个人 Solo，访者任务始终留在本地。

固定 Alpha 命令见[Codex 接入指南](docs/CODEX_CONNECT.zh-CN.md)。匹配的 `v0.1.0-alpha.7` Git 引用已存在；registry 命令还需要对应 npm 包已经发布。若 npm 包不可用，请使用同一指南中的源码路径。

## 接入 DeepSeek Harness

DeepSeek Harness 使用四步流程：

1. 把 `@gatherthread/dsh-host` 安装到已验证的 DSH Web profile。
2. 启动 `@deepseek-ai/dsh@0.1.2-rc.1 web` 并保持运行。
3. 打开 **Settings → GatherThread / 共序**，输入当前服务器地址，并在已经登录的 GatherThread 浏览器中批准一次性配对码。
4. 返回 DSH 设置，选择 Provider 和 Model，确认连接项目；仅配对不会注册可用的 Agent runtime。

一次明确配对会连接该身份可见的全部活跃项目，并继续发现后续新增权限。可写的 GatherThread 会话会成为可编辑的 DSH 原生会话；完成的 DSH 回合只上传一次，服务器规范历史按顺序投影回来。DSH 设置页会为每个已连接对话提供“自动上传”开关和“手动上传”。在 DSH 新会话中完成首个成功回合会创建本人所有的云端 Solo；空会话、失败回合和访者会话继续留在本地。连接的 DSH 路由公开 DeepSeek 模型元数据时，GatherThread 工作页可为每次 Agent 请求选择该 runtime 实际支持的模型和推理强度；该选择只作用于本次 GatherThread 回合，不会永久改写 DSH 内的模型设置。旧版或未声明动态能力的路由继续使用固定模型。Agent 请求只交给用户明确选择的 runtime，不会回退到 Codex。

当前 DSH 插件若未配置官方服务 URL，“共序官方服务”快捷按钮仍处于禁用状态，但可手动输入 `https://gatherthread.cn` 连接邀请制服务器 Alpha；本机、局域网和 Tailscale 地址也可使用。包与源码测试路径见[DSH 接入指南](docs/DSH_CONNECT.zh-CN.md)。

## 安全机制与当前限制

首个版本已经包含：使用 pepper 保护的设备凭据、仅存 HMAC 摘要且可撤销的浏览器会话、严格的 Cookie 写请求 Origin 校验、一次性邀请与设备授权、绑定设备的 runtime 来源证明、设备或项目权限撤销后立即使对应浏览器会话、socket 和授权失效、solo/multi ACL、事件脱敏、限定会话的幂等校验、单 runtime 请求串行化、一次性实时连接 ticket、严格的生产环境 WebSocket Origin 检查、有界 JSON 复杂度和按字节分页的历史重放、按设备限流、按用户/项目/部署限制会话数量、事件与快照任务存储配额、断线重放，以及 SQLite 备份/恢复脚本。成员查看他人活动时，只会看到用户名、harness、provider、model 和捕获保真度，不会得到本地设备或原生会话标识。新邀请用户的设备 Token 只展示一次，必须在关闭提示前妥善保存。

[gatherthread.cn](https://gatherthread.cn/) 已向获批测试者开放邀请制 Alpha；公众注册和公共 Beta 仍未开放。本机、局域网 HTTPS 与私有 Tailscale Serve 也可使用。[阿里云 ECS 方案](docs/ALIYUN_ECS.zh-CN.md)说明当前服务器部署模式。所有方式都让应用只监听 loopback，只有文档规定的 Caddy 边界可以接收公网流量。

尚未实现：主机自动故障转移、多进程 WebSocket fan-out、Agent token 级流式显示、附件对象存储、保留期清理任务、Web 离线 outbox、回复/搜索界面，以及原生安装包。

更多信息请参阅[文档索引](docs/README.md)、[`0.1.0-alpha.7` 说明](docs/releases/0.1.0-alpha.7.md)、[产品规格](docs/PRODUCT_SPEC.md)、[架构](docs/ARCHITECTURE.md)、[连接方式](docs/CONNECTION_MODES.zh-CN.md)、[Codex 指南](docs/CODEX_CONNECT.zh-CN.md)、[DSH 指南](docs/DSH_CONNECT.zh-CN.md)、[单主机部署](docs/SELF_HOSTING.md)、[安全模型](docs/SECURITY.md)和[运维说明](docs/OPERATIONS.md)。

## 参与开发与版本治理

开发者和用于开发的 Agent 应先阅读 [`AGENTS.md`](AGENTS.md) 与 [`CONTRIBUTING.md`](CONTRIBUTING.md)；公开及内部接口边界统一记录在 [`docs/INTERFACE_CONTRACTS.md`](docs/INTERFACE_CONTRACTS.md)。

每个版本更新都必须通过 Pull Request，由项目主要负责人及指定发布维护者（目前为 `@TH060419`）审核后才能合并和发布。未经负责人对该次操作的明确授权，开发者与 Agent 不得发布 npm 包、创建或移动版本标签、创建 GitHub Release、部署服务器或删除其他贡献者的分支。`CODEOWNERS` 会自动请求负责人审核；要在 GitHub 上强制执行，还需由仓库管理员按开发规范开启 `main` 分支保护。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。版权所有 © 2026 Yuhan He 及项目贡献者。
