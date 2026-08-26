# GatherThread

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**GatherThread** 是一个与具体 Agent harness 无关的协作层，让每位协作者都能继续使用各自本地的 AI Agent。

- `solo`：一位所有者发布完整的规范化会话事件流，其他协作者只能查看。
- `multi`：多人共享一个有序的项目会话。普通聊天消息只进入共享会话，不会调用 Agent；Agent 请求只由发送者自己的本地 runtime 领取，回复会标注用户名、设备、harness、provider、模型、本地会话和上下文保真度。

服务器使用 SQLite WAL 持久化只追加的规范事件日志，为每个会话分配权威序号，执行基于角色的访问控制，并提供可持久重放的历史记录和 WebSocket 实时推送。对每个可编辑 Codex 会话，本地 bridge 会分别维护一个由 Desktop 独占写入的交互任务和一个后台执行投影。可信 Hook 通过持久、幂等的 outbox 上传桌面回合；网页请求与规范历史导入只在后台投影运行，避免两个进程争抢同一个原生 writer。

## 项目与权限模型

项目是协作、邀请和权限的边界。项目 Owner 创建其中的 `solo` 与 `multi` 会话，并可随时把其他成员调整为 `participant` 或 `viewer`。Participant 可以在所有 `multi` 会话中聊天并请求自己的本地 Agent，但对所有 `solo` 会话只读；Viewer 对整个项目只读。一次项目邀请会把所选角色授予该项目现有和未来的全部会话，首版不提供单独覆盖某个会话权限的机制。

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
| `apps/web` | 支持 solo/multi、聊天/Agent 请求和断线补偿的响应式协作界面 |
| `packages/protocol` | 规范事件和 API schema |
| `packages/adapters` | 已授权的 Codex、Claude Code 会话发现、解析和脱敏 |
| `packages/bridge` | 本地 runtime 注册、游标、上下文上传和请求领取/完成流程 |
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
npm run owner-host:init -- --display-name "Alice" --device-name "Alice laptop"
npm run owner-host
```

如需自定义端口或路径，可以在初始化前手动复制 `.env.example`；`owner-host:init` 会只填充空的 Pepper，不会覆盖其他设置。`owner-host` 每次启动都会自动构建当前源码。

在 `http://127.0.0.1:8787` 输入命令一次性显示的设备凭据。页面会用它换取一个不透明的 `HttpOnly; SameSite=Strict` 浏览器会话 Cookie，然后立即从 JavaScript 内存中清除设备凭据。刷新页面时可以自动恢复登录，不使用 `localStorage` 或 `sessionStorage`。浏览器会话在服务器端有24小时绝对有效期，Cookie 本身是非持久的会话 Cookie；主动退出、撤销设备或轮换设备 Token 都会使它失效。HTTPS 部署会额外启用 `Secure` 和 `__Host-` Cookie 前缀。WebSocket 仍使用独立的30秒有效、一次性、限定会话的 ticket，任何凭据都不会写入 URL。

如果只开发 UI，运行 `npm --workspace apps/web run dev` 即可启动仅绑定 loopback 的预览服务并代理本地 API。显式 mock 模式只在 `http://127.0.0.1:4173/?mock=1` 可用，演示凭据为 `demo-token`。

## 接入本地 Codex Agent

每位协作者在 GatherThread 网页中选择项目，点击 **Connect Codex / 连接 Codex**，复制与自己系统对应的命令，并在本地 GatherThread 仓库根目录运行。命令类似：

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --project PROJECT_ID \
  --create-workspace \
  --model gpt-5.6-sol \
  --install-hooks
```

命令不含任何 Token；连接器会在终端中隐藏输入自己的设备 Token，在 `~/GatherThread Projects/` 下安全创建或复用与云端项目同名的本地工作区，并在 Codex Desktop 中打开它。每个可编辑会话会得到一个名为 `GatherThread · 项目名 · 会话名` 的 Desktop 任务，以及一个实现私有的 `exec` 后台投影。Desktop 是可见任务的唯一 writer；网页 **Request my agent** 在后台投影执行，再通过规范历史汇合。连接器会自动发现后续新会话，请保持终端运行。若要绑定已有源码目录，请改用 `--workspace "/本地项目绝对路径"`。

规范事件会按顺序导入后台投影，并使用冻结且按类型区分的前缀：`用户名 · Human Chat：`、`用户名 · Agent Request：` 和 `用户名 · Agent Response · harness · model：`。安装并信任项目 Hook 后，`UserPromptSubmit` 会把有界的规范增量作为上下文交给 Desktop Agent，`Stop` 则把这次 prompt 与最终回复恰好上传一次。当前公开 Hook 不提供完整结构化工具流，因此桌面端工具事件会被省略，而不是通过争抢 writer 去补读。远端事件始终显示在 GatherThread Web，并在下一次本地 prompt 时进入 Desktop 上下文；当前公开 Codex API 无法把它们补画成 Desktop 已有任务中的历史气泡。后台长历史会独立 compact，会话对齐不会回滚源码文件。

只读会话不显示输入框，而显示 **Download to Codex**。每次点击都会冻结一个新的 `through_sequence`，创建互相独立的本地快照任务，之后绝不向云端回传。Owner 同步全部会话；Participant 同步 `multi`、下载 `solo`；Viewer 下载全部会话。若要回传 Desktop prompt，必须先在 Codex Desktop 设置中启用 Hooks，再检查生成工作区中的 `.codex/hooks.json`。GatherThread 凭据不会进入 Codex 子进程环境，自动权限提升始终禁用，并且不支持 `danger-full-access`。当前流程参见[Codex 接入指南](docs/CODEX_CONNECT.zh-CN.md)和[ADR-0013](docs/adr/0013-single-writer-dual-codex-projections.md)。

## 安全机制与当前限制

首个版本已经包含：使用 pepper 保护的设备凭据、仅存 HMAC 摘要且可撤销的浏览器会话、严格的 Cookie 写请求 Origin 校验、一次性邀请与设备授权、绑定设备的 runtime 来源证明、设备或项目权限撤销后立即使对应浏览器会话、socket 和授权失效、solo/multi ACL、事件脱敏、限定会话的幂等校验、单 runtime 请求串行化、一次性实时连接 ticket、严格的生产环境 WebSocket Origin 检查、有界 JSON 复杂度和按字节分页的历史重放、按设备限流、事件与快照任务存储配额、断线重放，以及 SQLite 备份/恢复脚本。非 Owner 成员查看他人活动时，只会看到用户名、harness、provider、model 和捕获保真度，不会得到本地设备或原生会话标识。新邀请用户的设备 Token 只展示一次，必须在关闭提示前妥善保存。

当前支持的零成本 Alpha 部署方式是：由一位参与者提供主机，服务器仅绑定 loopback，再通过 Tailscale Serve 在私有网络中共享。参见[单主机部署指南](docs/SELF_HOSTING.md)。不要通过路由器端口转发、Tailscale Funnel 或未经身份验证的公网隧道暴露当前服务。

尚未实现：主机自动故障转移、多进程 WebSocket fan-out、无人处理的 Agent 请求领取恢复、Agent token 级流式显示、附件对象存储、保留期清理任务、Web 离线 outbox、回复/搜索界面，以及原生安装包。

更多信息请参阅[产品规格](docs/PRODUCT_SPEC.md)、[架构](docs/ARCHITECTURE.md)、[架构决策记录](docs/adr/README.md)、[单主机部署](docs/SELF_HOSTING.md)、[Tailscale 双人线上测试流程](docs/ONLINE_TESTING_TAILSCALE.zh-CN.md)、[安全模型](docs/SECURITY.md)、[运维说明](docs/OPERATIONS.md)，以及[相关项目与致谢](docs/REFERENCES.md)。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。版权所有 © 2026 Yuhan He 及项目贡献者。
