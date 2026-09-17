# GatherThread 双人线上测试指南：Tailscale 单主机方案

> 适用范围：一位参与者运行 GatherThread 主机，另一位参与者通过互联网远程加入。双方继续使用各自的浏览器和本地 Agent。
> 最后核对日期：2026-08-25

## 1. 测试拓扑

```text
主机用户的电脑
├── GatherThread Web/API/WebSocket
├── SQLite 协作数据库
└── Tailscale Serve 私有 HTTPS
             │
             └── https://<主机名>.<tailnet名>.ts.net
                                      │
                                      └── 远程协作者的浏览器和本地 Agent
```

GatherThread 始终只监听主机的 `127.0.0.1:18787`。Tailscale Serve 在外层提供私有 HTTPS 和 WebSocket 访问，不需要路由器端口转发，也不启用 Tailscale Funnel。

主机关闭、休眠、断网或停止 GatherThread 后，远程协作者将暂时无法访问。已有历史仍保存在主机的 SQLite 数据库中。

## 2. 准备事项

### 主机用户

- macOS、Windows 或 Linux 电脑一台，测试期间保持开机和联网。
- Node.js 24 或更新版本。
- GatherThread 仓库的最新 `main`。
- Tailscale 账号和客户端。
- GatherThread owner 设备 Token；如果是首次初始化，将在后续步骤中生成。

### 远程协作者

- Tailscale 账号和客户端。必须使用自己的账号，不能共用主机用户的账号。
- 支持现代 WebSocket 的浏览器。
- 仅测试网页聊天时不需要克隆 GatherThread 仓库。
- 如需连接本地 Agent，则需要在自己的电脑上安装 GatherThread MCP/bridge，并使用自己的设备 Token。

## 3. 安装 Tailscale

双方根据操作系统安装 Tailscale：

- [Tailscale 下载页面](https://tailscale.com/download)
- [macOS 安装说明](https://tailscale.com/docs/install/mac)

macOS 建议使用官方 Standalone 版本。安装后打开 Tailscale，登录自己的账号，并允许系统创建 VPN 配置。

主机还需要安装 CLI integration：

1. 打开 Tailscale 设置。
2. 找到 **CLI integration**。
3. 选择 **Show me how**。
4. 选择 **Install Now**，按提示输入管理员密码。

在主机终端验证：

```bash
tailscale version
tailscale status
```

## 4. 推荐的 Tailscale 授权方式

双人测试推荐共享主机设备，而不是让协作者加入整个 tailnet：

1. 主机打开 [Tailscale Machines 控制台](https://login.tailscale.com/admin/machines)。
2. 找到运行 GatherThread 的主机。
3. 可选：先将机器名改为容易识别的名称，例如 `gatherthread-host`。之后不要随意改名，否则 HTTPS 地址也会改变。
4. 打开该机器右侧菜单，选择 **Share**。
5. 生成并复制设备共享链接。
6. 通过可信通信渠道把共享链接发给协作者。
7. 协作者登录自己的 Tailscale 账号并接受共享。

这种方式只共享指定主机，不会让协作者自动访问主机所在 tailnet 的其他设备。详情见 [Tailscale 设备共享说明](https://tailscale.com/docs/reference/inviting-vs-sharing)。

设备共享仍可能允许协作者访问这台主机上其他正在监听的服务。测试前建议关闭不需要的 macOS **远程登录、文件共享、屏幕共享**，并在正式使用前用 Tailscale access controls 将协作者限制到主机的 TCP 443。

## 5. 获取私有 HTTPS 地址

在 Tailscale Machines 控制台打开主机详情，复制完整的 MagicDNS 名称，例如：

```text
gatherthread-host.example-tailnet.ts.net
```

对应的 GatherThread 地址是：

```text
https://gatherthread-host.example-tailnet.ts.net
```

共享设备的协作者必须使用完整的 `.ts.net` 地址，不能只输入短机器名。

## 6. 生成主机连接配置

进入 GatherThread 仓库：

```bash
cd "/path/to/gatherthread"
```

使用控制台显示的完整 `.ts.net` HTTPS 地址生成配置：

```bash
npm run connection:tailscale -- --url https://gatherthread-host.example-tailnet.ts.net
```

该命令会创建或更新权限为 `0600` 的 `.env`，保留现有数据库路径和 Pepper，并把应用继续限制在回环地址。随后确认以下关键设置：

```dotenv
NODE_ENV=production

GATHERTHREAD_SERVER_HOST=127.0.0.1
GATHERTHREAD_SERVER_PORT=18787
GATHERTHREAD_DATABASE_PATH=.local/collaboration.sqlite
GATHERTHREAD_STATIC_DIRECTORY=apps/web/dist

GATHERTHREAD_PUBLIC_BASE_URL=https://gatherthread-host.example-tailnet.ts.net
GATHERTHREAD_ALLOWED_ORIGINS=
GATHERTHREAD_TLS_TERMINATED_BY_PROXY=true

GATHERTHREAD_ALLOW_HTTP_BOOTSTRAP=false
```

保留现有的 `GATHERTHREAD_AUTH_TOKEN_PEPPER`。如果该值为空，首次执行 `owner-host:init` 会安全生成。之后不要修改或丢失它，否则已有设备凭据会全部失效。

严禁分享或提交：

- `.env`；
- `GATHERTHREAD_AUTH_TOKEN_PEPPER`；
- owner 设备 Token；
- SQLite 数据库及备份。

建议确认本地权限：

```bash
chmod 600 .env
chmod 700 .local
```

## 7. 首次创建 owner

只有当前数据库从未初始化时才执行：

```bash
npm ci
npm run owner-host:init -- \
  --display-name "主机用户姓名" \
  --device-name "主机设备名称"
```

命令只显示一次 owner 设备 Token。立即保存到密码管理器，不要把它发给协作者。

如果数据库中已经存在 owner，则不要再次运行 `owner-host:init`，直接使用之前保存的 owner Token。

## 8. 启动线上服务

### 终端 A：启动 GatherThread

```bash
cd "/path/to/gatherthread"
npm run owner-host
```

成功时会看到类似：

```text
GatherThread owner host listening at http://127.0.0.1:18787
```

保持该终端运行。

### 终端 B：启动 Tailscale Serve

```bash
cd "/path/to/gatherthread"
npm run owner-host:tailscale-serve
```

第一次启用 Serve 时，Tailscale 可能输出一个授权网页地址，要求允许 HTTPS 证书或 Serve。按页面提示批准，然后检查：

```bash
tailscale serve status
```

预期结果类似：

```text
Available within your tailnet:
https://gatherthread-host.example-tailnet.ts.net

|-- / proxy http://127.0.0.1:18787
```

确认输出写的是 **within your tailnet**。不要运行 `tailscale funnel`。

测试期间如果不希望 Mac 因空闲而休眠，可以另开终端运行：

```bash
caffeinate -i
```

结束时按 `Ctrl+C`。

## 9. 网络连通性检查

主机先打开：

```text
https://gatherthread-host.example-tailnet.ts.net
```

协作者完成以下操作：

1. 确认 Tailscale 显示已连接。
2. 确认已经接受主机设备共享。
3. 使用完整 `.ts.net` 地址打开 GatherThread。

也可以访问健康检查：

```text
https://gatherthread-host.example-tailnet.ts.net/health
```

正常时应返回包含 `"status":"ok"` 的 JSON。健康检查成功只说明网络与服务存活，不代表用户已经加入协作项目。

如果协作者无法访问，按以下顺序检查：

1. 双方 Tailscale 是否在线。
2. 设备共享是否已经接受。
3. `tailscale serve status` 是否显示正确的 HTTPS 转发。
4. `npm run owner-host` 是否仍在运行。
5. `.env` 中 `GATHERTHREAD_PUBLIC_BASE_URL` 是否与浏览器地址完全一致。
6. 主机名是否在配置完成后被修改。

## 10. 创建 GatherThread 项目和邀请

主机用户：

1. 打开 GatherThread 的 `.ts.net` 地址。
2. 输入 owner 设备 Token 登录。页面会把它交换为 `HttpOnly` 浏览器会话，不会保存到 Web Storage。
3. 点击 **Create project**，创建这次协作使用的项目。
4. 在项目中点击 **Create session**，选择 `multi` 并创建测试会话。
5. 在项目的 **Invitations** 中选择 `Participant`。Participant 可以编辑该项目的 multi，会实时编辑本人创建的 solo，但对其他成员创建的 solo 只读。
6. 同步测试建议有效期选择 `1 hour`。
7. 点击 **Create invitation**。
8. 复制一次性 invitation secret。这个邀请授予整个项目权限，也会覆盖之后新建的会话。

主机向协作者分别发送：

1. Tailscale 设备共享链接；
2. GatherThread `.ts.net` 网站地址；
3. GatherThread invitation secret。

建议把 invitation secret 与 Tailscale 共享链接分开传输。GatherThread 不把 invitation secret 放进 URL，避免浏览器历史、代理日志和聊天链接预览泄露凭据。

## 11. 协作者加入 GatherThread

协作者：

1. 打开 GatherThread `.ts.net` 地址。
2. 在 **Join with an invitation** 中输入 invitation secret。
3. 填写自己的 Display name。
4. 填写容易识别的 Device name，例如 `Alice MacBook`。
5. 点击 **Join workspace**。
6. 保存页面只显示一次的个人设备 Token。
7. 进入主机创建的项目及其中的 `multi` 会话。

协作者不能使用主机的 owner Token。每个用户和设备必须有自己的凭据，方便独立归因和撤销。

## 12. 双人验收清单

### A. 网络边界

- [ ] 主机能打开 `.ts.net` 地址。
- [ ] 接受设备共享的协作者能打开。
- [ ] 未授权设备无法访问。
- [ ] 主机端口仍然只绑定 `127.0.0.1`。
- [ ] 没有路由器端口转发或 Tailscale Funnel。

### B. 身份与邀请

- [ ] 主机使用 owner Token 登录。
- [ ] 协作者使用 invitation secret 创建自己的身份。
- [ ] 同一个 invitation secret 不能再次领取。
- [ ] 主机看不到协作者的设备 Token。
- [ ] 双方刷新网页后保持登录并恢复工作区。
- [ ] Owner 可以把协作者在 Participant 和 Viewer 之间切换，刷新后仍保持新权限。

### C. Multi 实时会话

- [ ] 主机发送 Chat，协作者无需刷新即可看到。
- [ ] 协作者发送 Chat，主机无需刷新即可看到。
- [ ] 两端用户名显示正确。
- [ ] sequence 连续，没有重复或缺失。
- [ ] Chat 不会触发本地 Agent。

### D. 断线恢复

- [ ] 协作者关闭 Tailscale 后，页面显示离线。
- [ ] 重新连接 Tailscale 后，页面恢复实时状态。
- [ ] 断线期间的事件通过历史重放补齐。
- [ ] 主机停止并重新启动 GatherThread 后，历史仍然存在。

### E. Solo 权限

- [ ] 主机创建一个 `solo` 会话。
- [ ] 同一项目的 Participant 自动能看到该会话，但不能发送 Chat 或 Agent 请求。
- [ ] Owner 把协作者调整为 Viewer 后，该用户在 multi 和 solo 中都只读。
- [ ] Owner 再调整为 Participant 后，该用户恢复 multi 与本人 solo 的写权限，其他成员的 solo 仍只读。

### F. Agent 路径

- [ ] 每位用户使用自己的设备 Token。
- [ ] 每位 Participant 在自己的电脑运行一个项目级 Codex 连接器，并保持终端开启。
- [ ] 连接器使用完整的 HTTPS 主机地址和各自的本地项目目录，并选择正确的 GatherThread 项目。
- [ ] 同一连接器自动发现该项目中新建的 multi 会话；各会话使用独立 Codex thread。
- [ ] 发送 Agent 请求后、回复到达前，网页显示回答动画；runtime 断线时改为排队提示。
- [ ] 第一次请求完成后，Codex Desktop 显示 `会话名 · GatherThread`，后续网页请求继续同一 thread；分别修改云端与本地标题后仍不得产生重复会话。
- [ ] runtime 显示用户名、设备、harness、provider 和模型。
- [ ] 普通 Chat 会进入后续上下文，但不会触发本地 Codex。
- [ ] Agent 请求只由发出者自己的 runtime 领取。
- [ ] Agent 回复实时同步到另一端。

Codex 的具体命令与验收步骤参见[接入本地 Codex](CODEX_CONNECT.zh-CN.md)。Claude Code 和自定义 harness 目前仍使用通用 bridge 的显式 adapter 接口。

## 13. 测试记录建议

发现问题时请记录：

- 操作时间和时区；
- 主机和协作者操作系统；
- 浏览器与版本；
- Tailscale 版本；
- GatherThread commit ID；
- 会话模式和角色；
- 出问题前最后一个连续 sequence；
- 页面显示的 Live、Offline 或其他状态；
- 可复现步骤。

不要在 issue、聊天截图或日志中包含：

- 设备 Token；
- invitation secret；
- Cookie；
- Pepper；
- 真实敏感会话内容。

## 14. 结束测试

1. 在 GatherThread 中撤销尚未使用的邀请。
2. 在主机终端停止 GatherThread：按 `Ctrl+C`。
3. 关闭 443 上的 Tailscale Serve：

   ```bash
   tailscale serve --https=443 off
   ```

4. 验证 Serve 已关闭：

   ```bash
   tailscale serve status
   ```

5. 如果不再需要远程访问，在 Tailscale Machines 控制台撤销主机设备共享。
6. 如果测试数据需要保留，使用 SQLite 在线备份脚本：

   ```bash
   scripts/backup-sqlite.sh .local/collaboration.sqlite .local/backups
   ```

不要在 SQLite 正在写入时直接复制单个数据库文件。

## 15. 参考资料

- [GatherThread 单主机部署说明](SELF_HOSTING.md)
- [GatherThread 安全模型](SECURITY.md)
- [GatherThread 运维说明](OPERATIONS.md)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale MagicDNS](https://tailscale.com/docs/features/magicdns)
- [Tailscale 设备共享](https://tailscale.com/docs/reference/inviting-vs-sharing)
