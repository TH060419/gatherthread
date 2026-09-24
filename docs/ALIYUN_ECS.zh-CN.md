# 阿里云 ECS 部署：0.1.0-alpha.7 预览版

本方案说明 `https://gatherthread.cn` 邀请制 `0.1.0-alpha.7` 服务采用的部署模式。应用始终只监听 `127.0.0.1:18787`，Caddy 独占公网 80/443 并自动管理 HTTPS；阿里云安全组不得开放 18787。当前版本没有匿名注册：首位创建者在服务器本机创建，测试资格码由运维人员在服务器私有终端签发，项目邀请只让访客加入指定项目。以下命令供新版本经过审核后部署，不应在已运行服务器上重复安装。

## 1. 上线前条件

- 阿里云中国内地 ECS，Ubuntu 22.04 或 24.04，固定公网 IPv4。建议至少 2 vCPU、2 GiB 内存，并为数据库和备份保留独立余量。
- 已实名认证的域名，A 记录指向 ECS 公网 IP。
- 使用中国内地节点时，先完成 ICP 备案再对外开通网站。阿里云官方说明：中国内地服务器必须在实际接入商完成备案，域名指向内地服务器即受此要求约束，与端口或用途无关。以[阿里云备案流程](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview)和主体所在地管局的最新要求为准。
- ECS 安全组：TCP 22 仅允许管理员固定 IP；TCP 80、443 面向预期用户；不添加 18787 入方向规则。参见[阿里云 ECS 安全组说明](https://help.aliyun.com/zh/ecs/user-guide/start-using-security-groups)。
- 本地已经得到通过 `npm run release:verify` 的 `v0.1.0-alpha.7` 预览候选提交或归档。

备案审核完成之前，可以完成系统安装和回环健康检查，但不要把域名解析到服务器，也不要开放公网 Web 入口。

## 2. 上传候选版本

把候选归档上传为 `/tmp/gatherthread-0.1.0-alpha.7.tar.gz`，然后在 ECS 上执行：

```sh
sudo install -d -m 0755 /opt/gatherthread/releases/0.1.0-alpha.7
sudo tar -xzf /tmp/gatherthread-0.1.0-alpha.7.tar.gz \
  -C /opt/gatherthread/releases/0.1.0-alpha.7 --strip-components=1
cd /opt/gatherthread/releases/0.1.0-alpha.7
```

也可以在发布 Git 标签后，把该标签直接克隆到同一路径。目录必须准确，因为部署脚本会拒绝从临时工作树或未标明候选版本的源码启动。

## 3. 安装并启动

确认备案、DNS 与安全组准备好后执行：

```sh
sudo deploy/aliyun-ecs/install.sh \
  --domain gatherthread.example.com \
  --acknowledge-private-alpha \
  --acknowledge-mainland-icp-ready
```

脚本会安装并校验 Node.js 24.16.0，安装 Caddy，创建无登录权限的 `gatherthread` 系统用户，以 `npm ci` 构建候选版本，生成只允许服务账户读取的环境文件，配置 systemd、Caddy 和每日 SQLite 在线备份，最后把 `/opt/gatherthread/current` 原子切换到该 release。已有 `/etc/gatherthread/gatherthread.env` 不会被覆盖；域名不一致时脚本会停止。

## 4. 创建首位创建者

仅第一次部署执行：

```sh
sudo deploy/aliyun-ecs/create-owner.sh \
  --display-name "你的显示名称" \
  --device-name "服务器初始化"
```

命令只显示一次设备 Token。立即保存到密码管理器，不要粘贴到聊天、Issue、日志或 URL。浏览器首次登录后可以勾选“记住此设备”，也可以在设置中修改设备名称。

部署包含 [ADR-0028](adr/0028-separate-test-qualification-from-project-invitations.md) 的版本后，先审核通过 [GitHub Alpha 测试申请 Issue](https://github.com/TH060419/gatherthread/issues/new?template=test-access.yml)，再在自己的服务器私有终端签发一次性资格码。系统不提供收集申请者资料的服务器表单。不要通过可能记录输出的 Agent 终端运行签发命令：

```sh
sudo /opt/gatherthread/current/deploy/aliyun-ecs/test-access.sh issue --ttl 7d
```

把显示的 `gtq_` 资格码私下交给一位测试者，绝不贴在公开 Issue 中。如需私密投递，已获批申请者可以主动把 Issue 链接发至 `coolhezi@sjtu.edu.cn`；邮箱不替代 Issue 申请。测试者在登录页先填写自己的用户名和设备名，再在“首次使用 · 激活资格”中输入资格码。激活后另行获得只展示一次的 `gta_` 设备 Token，之后从“已有账号”登录。尚未使用的资格码可用 `sudo /opt/gatherthread/current/deploy/aliyun-ecs/test-access.sh revoke --grant-id GRANT_ID` 撤销，不影响已激活账号的设备。项目创建者若只想邀请访客加入一个项目，则使用产品内的项目邀请；这不会授予创建新项目的资格，也不会给访客 ECS SSH 权限。

## 5. 完整预检

```sh
sudo deploy/aliyun-ecs/preflight.sh gatherthread.example.com
sudo systemctl start gatherthread-backup.service
sudo journalctl -u gatherthread -n 100 --no-pager
```

预检必须全部通过，包括候选版本、systemd、Caddy、回环存活、SQLite WAL/外键/可写性、公网 HTTPS、HSTS、监听边界、文件权限和数据库完整性。随后在两个独立浏览器中完成：创建项目、生成邀请、第二位用户加入、Multi 聊天、请求本地 Agent、断线重连和历史补齐。

## 6. 日常管理

```sh
sudo systemctl status gatherthread caddy gatherthread-backup.timer
sudo journalctl -u gatherthread -f
sudo ls -lh /var/backups/gatherthread
curl -fsS http://127.0.0.1:18787/health/ready
```

数据库位于 `/var/lib/gatherthread/collaboration.sqlite`；环境与 Pepper 位于 `/etc/gatherthread/gatherthread.env`。每日备份任务仅在成功后使用 `-mtime +14` 清理符合条件的顶层完整备份组，不能保证严格的 14 天上限，也不覆盖恢复演练、不完整或异地副本。若使用云端 Git，SQLite 备份须与同名 `.db.code` 目录一起校验、异地保存、恢复和轮换。新版备份单元调用 `scripts/prune-sqlite-backups.sh` 清理符合条件的备份组；仅切换 `/opt/gatherthread/current` 不会更新已安装的 systemd 单元。备份组和 Pepper 必须分别加密保存到另一故障域，否则服务器丢失后设备凭据无法继续验证。在对外声明固定保留期限前，须为所有副本位置设置并验证到期清理。

## 7. 升级与回滚

每次升级都使用新的 `/opt/gatherthread/releases/<版本>`，不要覆盖旧 release：

1. 运行当前版本预检并执行一次在线备份。
2. 上传并验证新候选，运行经过审核的新版本 `install.sh`。确认 `/etc/systemd/system/gatherthread-backup.service` 已调用配套备份清理脚本、`systemctl daemon-reload` 已完成；仅切换 release 符号链接不会刷新这个单元。
3. 再运行预检和双浏览器冒烟测试。
4. 只有确认旧代码兼容新数据库 schema 时，才可把 `/opt/gatherthread/current` 指回旧 release 并重启；否则停止服务，将已验证的升级前备份恢复到新数据库路径后再启动。

恢复属于破坏性运维操作，必须按 [OPERATIONS.md](OPERATIONS.md) 保留原数据库、`-wal` 和 `-shm` 作为受限证据，不能直接覆盖。

## 当前 Alpha 限制

这是单进程、单 SQLite 实例，不具备自动故障转移或多机扩容；没有公开注册、附件存储、自动保留期清理、Agent token 级流式输出和无人领取任务恢复。后续对外预览应保持小规模、仅邀请加入，并设置 ECS 磁盘、内存、证书、服务退出、备份失败和数据库完整性告警。
