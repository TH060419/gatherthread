# Oracle Always Free 公网试用部署

这套方案面向小规模、仅凭邀请加入的公网测试：GatherThread 仍只监听 `127.0.0.1:8787`，由 Caddy 在公网 `80/443` 端口提供 HTTPS 和 WebSocket。它不会把产品变成匿名公共服务；设备凭据、一次性邀请、项目权限、精确浏览器 Origin、安全 Cookie、一次性 WebSocket ticket 和应用限流仍然生效。

直接接入互联网扩大了当前 Tailscale 私有 Alpha 的威胁边界，因此安装器必须显式传入 `--acknowledge-experimental-public-ingress`。在完成外部安全审查、恢复演练和多人实测前，不要用这套试用部署承载敏感或受监管数据。

## 1. 创建 Oracle 资源

在 Oracle Cloud 控制台中谨慎选择主区域，然后创建：

- 一台 Ubuntu 24.04 Ampere A1 虚拟机。可先使用 1 OCPU、6 GB 内存；GatherThread 运行负载不高，但源码构建需要一定内存。
- 50 GB 启动卷和一个实例公网 IPv4 地址。临时公网地址会在实例存在期间保持绑定；只有当控制台确认该账号与区域的费用估算仍为零时，才改用保留地址。
- 带互联网网关的公共子网。
- 有状态入站规则：TCP 80、443 允许 `0.0.0.0/0`；TCP 22 只允许管理员当前的公网 IP。不要开放 8787。
- 在本地生成并妥善保管的 SSH 公钥。

Always Free 计算资源只能在租户主区域中创建，而且可能暂时没有可用容量。创建前确认每项资源都明确标注 **Always Free eligible**、月度费用估算为零，并启用费用提醒。面向中国大陆测试者时，确定主区域前应实测到周边候选区域的可达性和延迟；不同运营商的路由可能不同，而主区域决定了 Always Free 计算资源可以创建在哪里。Oracle 还可能回收长期空闲的免费计算实例，因此该方案适合早期试用，不是带 SLA 的正式生产托管。

将 `gatherthread.example.com` 一类域名的 DNS `A` 记录指向实例公网 IPv4，等待公网解析生效。Caddy 需要正确的公网域名以及开放的 80/443 端口来申请和续期受信任证书。

## 2. 安装 GatherThread

以 Ubuntu 镜像默认的 `ubuntu` 用户连接服务器，安装 Git，并把经过审查的发布版本或提交克隆到固定目录：

```bash
sudo apt-get update
sudo apt-get install -y git
sudo mkdir -p /opt/gatherthread
sudo git clone https://github.com/TH060419/gatherthread.git /opt/gatherthread/app
cd /opt/gatherthread/app
git rev-parse HEAD
sudo deploy/oracle-free/install.sh \
  --domain gatherthread.example.com \
  --acknowledge-experimental-public-ingress
```

安装器支持 ARM64 或 x86-64 的 Ubuntu 22.04/24.04。它会安装经过校验和验证的固定版 Node.js 24 和 Caddy 官方软件包，按 lockfile 构建应用，创建不可登录的 `gatherthread` 服务用户，生成由 root 管理的生产环境文件，启动加固后的 systemd 服务，并启用每日 SQLite 在线备份。再次运行会保留既有环境和认证 Pepper；若域名不同，它会拒绝覆盖，避免凭据被静默破坏。

## 3. 创建首位用户前完成预检

运行主机与公网链路的完整检查：

```bash
sudo /opt/gatherthread/app/deploy/oracle-free/preflight.sh gatherthread.example.com
```

预检必须确认：应用仅监听回环地址；本机和公网 `/health` 都返回 SQLite `wal`；Caddy 与备份定时器均已运行；私有目录权限正确。还要从另一条网络验证 `https://gatherthread.example.com` 可以打开，而 `http://公网IP:8787` 无法连接。

## 4. 创建首位创建者

初始化命令直接写入 SQLite，不存在公网初始化接口。下面的命令只显示一次首台设备凭据：

```bash
cd /opt/gatherthread/app
sudo -u gatherthread /usr/local/bin/node \
  --env-file=/etc/gatherthread/gatherthread.env \
  apps/server/dist/src/cli.js bootstrap \
  --display-name "创建者姓名" \
  --device-name "创建者设备"
```

把凭据保存到密码管理器，只在完全一致的 HTTPS 地址中输入。不要把它放进 URL、命令参数、截图、日志或共享消息。

## 5. 备份、更新与回滚

定时器会把 SQLite 在线备份写入虚拟机的 `/var/backups/gatherthread`。这能防范数据库层故障，却不能防范 Oracle 账号、区域、实例或启动卷整体丢失。必须把加密备份复制到虚拟机之外，并单独保护 `/etc/gatherthread/gatherthread.env` 中与数据库匹配的 Pepper。邀请测试者前先完成一次校验与恢复演练。

更新前先创建并导出备份、记录当前 Git 提交，再停止服务、切换到经过审查的发布版本、运行 `npm ci && npm run build` 并重启。回滚时恢复旧提交；只有数据库 schema 变化确实要求时，才恢复与旧版本匹配且已验证的备份。WAL 正在写入时，绝不能用普通文件复制覆盖在线数据库。

常用检查命令：

```bash
sudo systemctl status gatherthread caddy gatherthread-backup.timer
sudo journalctl -u gatherthread -n 100 --no-pager
sudo systemctl start gatherthread-backup.service
sudo ls -l /var/backups/gatherthread
```

Oracle 安全列表与虚拟机自身防火墙是两层独立控制。两层都应保持最小开放范围；修改前保留可用的 SSH 恢复路径；任何情况下都不要发布应用端口 8787。
