# 无云账户连接方案

在暂不使用公网服务器时，GatherThread 提供三种可直接使用的连接方式。三种方式运行同一个单主机服务、SQLite 数据库和权限模型；切换方式只会改写私有 `.env` 中的网络参数，不会更换 Pepper、删除数据库或重新创建用户。

| 方式 | 适合场景 | 用户需要安装 | 入口 | 安全边界 |
|---|---|---|---|---|
| 本机 | 单人开发、UI 和功能测试 | Node.js | `http://127.0.0.1:18787` | 仅当前电脑 |
| 局域网 HTTPS | 同一家庭、实验室或办公室网络 | 主机安装 Caddy；客户端信任专用本地 CA | `https://私网地址:8443` | 指定私网网卡与主机防火墙 |
| Tailscale Serve | 跨网络的小规模已知协作者 | 所有人安装 Tailscale | `https://主机.tailnet.ts.net` | Tailnet、Serve 与 GatherThread ACL |

需要稳定的统一入口时，使用独立的、仅凭邀请加入的[阿里云 ECS 部署方案](ALIYUN_ECS.zh-CN.md)。不要把局域网或 Tailscale 配置改造成路由器端口转发、Tailscale Funnel 或匿名公网隧道。

## 局域网最快流程

首次使用只需完成以下步骤：

1. 主机安装 Node.js 24 和 Caddy 2。
2. 在仓库根目录运行一次 `npm ci` 安装项目依赖。
3. 运行 `npm run lan:start`。
4. 如果检测到多个私网地址，选择当前可信网络对应的地址；只有一个时会自动选择。
5. 新数据库会询问创建者显示名称和设备名称，并打印一次性设备 Token。立即保存该 Token。
6. 脚本自动生成局域网配置、构建项目、启动 GatherThread 与 Caddy，然后打印访问地址、根证书路径和 SHA-256。
7. 每台客户端安装该根证书后，打开脚本打印的 HTTPS 地址。

以后启动只运行：

```bash
npm run lan:start
```

按 `Control-C` 会同时停止 GatherThread 和局域网 HTTPS 代理。如果希望固定地址和端口，使用：

```bash
npm run lan:start -- --address 192.168.50.20 --port 8443
```

无交互终端首次初始化时，同时提供名称：

```bash
npm run lan:start -- \
  --address 192.168.50.20 \
  --port 8443 \
  --display-name "你的名字" \
  --device-name "实验室主机"
```

### 首次安装 Caddy

```bash
# macOS（Homebrew）
brew install caddy

# Windows，二选一
choco install caddy
scoop install caddy
```

Debian、Ubuntu 和其他 Linux 发行版应使用 [Caddy 官方安装说明](https://caddyserver.com/docs/install) 中对应的官方仓库步骤。安装后确认：

```bash
caddy version
```

脚本不会自动执行包管理器或提权命令，也不会替用户修改路由器和客户端证书信任库。

## 共同准备

在仓库根目录安装依赖：

```bash
npm ci
```

使用仅本机、Tailscale 或手动局域网流程时，第一次使用该数据库需创建首位创建者：

```bash
npm run owner-host:init -- \
  --display-name "你的名字" \
  --device-name "这台电脑"
```

`lan:start` 会在新数据库上自动询问这些名称并完成同一步骤，无需再运行本命令。设备 Token 只显示一次；立即保存到密码管理器，不要把它放进 URL、聊天、截图、命令参数或 Git 文件。之后切换连接方式时不要再次初始化。

## 方案一：仅本机

配置本机入口：

```bash
npm run connection:local
npm run owner-host
```

浏览器打开：

```text
http://127.0.0.1:18787
```

这种方式不接受其他电脑连接，适合单人验证完整 Web/API/WebSocket 流程。不要把 `127.0.0.1` 改成 `0.0.0.0`。

## 方案二：局域网 HTTPS

局域网模式仍让 GatherThread 只监听 `127.0.0.1:18787`。独立的 Caddy 进程仅绑定选定的 RFC1918/ULA 私网地址，在未特权端口上提供 HTTPS 和 WebSocket。它不会监听公网地址，也不会自动配置路由器。

校园网通常属于学校统一管理的局域网络，因此在校方策略允许终端间入站访问、两台设备能够直接互访时，可以使用本方案。但校园 Wi-Fi 常启用客户端隔离、VLAN 分区或额外防火墙；连接同一 SSID 不代表一定可达，也不应自动视为可信网络。先测试下面的 `/health` 地址；无法互访时，改用项目已经配置的远程入口。当前可使用 Tailscale，统一服务器上线后应优先使用服务器入口。

### 1. 固定主机私网地址

在路由器 DHCP 设置中，为主机建立地址保留，例如：

```text
192.168.50.20
```

也可以在本地 DNS 中把 `gatherthread.home.arpa` 指向该地址。避免使用经常与其他网络冲突的临时地址；主机地址变化后，证书入口、Origin 和 Codex 连接命令都必须同步更新。

### 2. 安装 Caddy 2

使用 [Caddy 官方安装说明](https://caddyserver.com/docs/install) 安装 `caddy`，然后确认：

```bash
caddy version
```

局域网助手使用独立的 Caddy 数据目录，不读取 `.env` 中的 Pepper，也不会把 GatherThread、Codex 或模型凭据传给 Caddy 子进程。

### 3. 自动启动或手动选择入口

推荐直接运行：

```bash
npm run lan:start
```

下面的手动配置只用于固定域名、分开运行进程或故障排查。

推荐使用 `8443`，避免用管理员权限绑定 `443`：

```bash
npm run connection:lan -- \
  --url https://192.168.50.20:8443
```

如果已经配置 `home.arpa` 本地 DNS，也可以使用：

```bash
npm run connection:lan -- \
  --url https://gatherthread.home.arpa:8443
```

助手只接受 RFC1918 私网地址、ULA IPv6 或 `.home.arpa` 名称，并清空旧的附加 Origin，防止模式切换后意外扩大浏览器信任范围。

### 4. 手动启动两个进程

终端 A：

```bash
npm run owner-host
```

终端 B：

```bash
npm run owner-host:lan
```

第二个命令会生成私有 Caddyfile，把代理限制在所选私网地址，并在下面的位置建立专用于 GatherThread 局域网测试的本地 CA：

```text
.local/network/lan/caddy-data/caddy/pki/authorities/local/root.crt
```

### 5. 在客户端信任专用根证书

把 `root.crt` 通过可信的本地方式复制到每台测试设备，并先核对主机上显示的 SHA-256：

```bash
shasum -a 256 .local/network/lan/caddy-data/caddy/pki/authorities/local/root.crt
```

常见系统的安装方式：

```bash
# macOS，需管理员确认
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain root.crt

# Ubuntu / Debian
sudo cp root.crt /usr/local/share/ca-certificates/gatherthread-lan.crt
sudo update-ca-certificates

# Windows 管理员 PowerShell / CMD
certutil -addstore -f ROOT root.crt
```

Safari、Chrome 和 Edge 通常使用操作系统信任库；Firefox 或移动设备可能需要单独导入。任何客户端如果仍显示证书警告，都应停止并修复证书或地址配置，不要点击绕过。

信任一个根 CA 是安全敏感操作。只在已知测试设备上安装，绝不要复制 `.local/network/lan/caddy-data` 中的 CA 私钥；局域网测试结束后可从设备信任库删除该根证书。

### 6. 限制防火墙并检查

只允许可信局域网网段访问所选端口，例如 TCP `8443`。不要配置路由器端口转发、UPnP 映射或公网 DNS。访客 Wi-Fi 和启用了“客户端隔离”的无线网络通常不能访问主机。

客户端打开：

```text
https://192.168.50.20:8443/health
```

看到包含 `"status":"ok"` 的 JSON 后，再打开站点根地址并通过项目邀请加入。健康检查不等于已通过 GatherThread 身份验证。

## 方案三：Tailscale Serve

主机和协作者都安装并登录 Tailscale。先在 Tailscale 管理页获得主机完整的 `.ts.net` 名称，然后配置：

```bash
npm run connection:tailscale -- \
  --url https://gatherthread-host.example-tailnet.ts.net
```

终端 A：

```bash
npm run owner-host
```

终端 B：

```bash
npm run owner-host:tailscale-serve
tailscale serve status
```

状态必须显示 **within your tailnet**。助手明确不会启用 Funnel。成员仍需 GatherThread 项目邀请和自己的设备 Token；Tailscale 身份不能替代 GatherThread 权限。

双人操作步骤和最小授权方式参见 [Tailscale 双人线上测试指南](ONLINE_TESTING_TAILSCALE.zh-CN.md)。

## 切换连接方式

1. 停止 `owner-host`、Caddy 或 Tailscale Serve 相关进程。
2. 执行新的 `connection:local`、`connection:lan` 或 `connection:tailscale` 命令。
3. 重新启动主机与对应网络入口。
4. 用新的精确 Origin 登录；旧 Origin 的浏览器 Cookie 不会跨站复用。
5. 使用旧 URL 的 Codex connector 需要停止后，以网页“连接 Codex”生成的新命令重新连接。

配置命令会保留数据库路径、Pepper、设备凭据、配额和项目历史，但会把 `GATHERTHREAD_ALLOWED_ORIGINS` 重置为空，使服务只接受当前入口。

## 常见问题

- **局域网地址打不开**：确认设备在同一可信网络、主机没有休眠、防火墙允许所选端口、Caddy 和 `owner-host` 都在运行。
- **证书警告**：确认访问地址与配置完全一致，并在该设备的有效信任库中安装正确的 `root.crt`。
- **页面能开但实时状态断线**：通常是 `GATHERTHREAD_PUBLIC_BASE_URL` 与浏览器 Origin 不一致，或代理没有运行。
- **换 Wi-Fi 后失效**：检查 DHCP 地址是否变化或新网络是否启用了客户端隔离；不要在陌生公共 Wi-Fi 上使用局域网模式。
- **其他成员需要调用本地 Agent**：每个人都在自己的电脑运行 Codex connector，并把 `--url` 指向当前选定的精确入口。

无论选择哪一种模式，都要定期使用 `scripts/backup-sqlite.sh` 创建在线备份，并把加密备份与匹配的 Pepper 分开保存。
