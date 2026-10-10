# 独立测试环境准备与验收

本指南用于 `https://test.gatherthread.cn` 的独立测试环境：账号、密码、设备授权、文件与密钥都和正式环境分开。源码能力以最新 `main` 为准，实际启用状态由运营配置决定；历史候选验收记录见 [TEST_ENVIRONMENT_VALIDATION](TEST_ENVIRONMENT_VALIDATION.md)，不能替代最新固定提交的复测。部署由服务器管理会话执行，需负责人逐次授权。

本轮版本为 **Beta 1 / `0.1.0-beta.1`**，只发布同版 npm 包并部署测试服；不更新正式服。具体候选提交、产物校验和及实际验收以 [Beta 1 记录](releases/0.1.0-beta.1.md)与部署报告为准，不能仅以分支名判断。云端 Agent 网页入口已开放，服务端默认关闭；实际运行需私密模型配置及真实模型、镜像、Docker/socket 验收后由运营启用。入口开放不代表服务器已验收，不自动修改账号注册/找回开关。

## 用户流程与依赖

打开测试站 → 输入负责人私下发放的测试人员代码 → 邮箱验证注册或邮箱/密码登录 → 完整工作页 → 单独授权测试环境的 Codex/DSH。测试代码只控制环境准入，不创建账号、提升项目角色或替代密码。两环境的同一邮箱可分别注册并设置不同密码；不迁移、合并或继承旧账号。

通过门禁后复用当前邮箱注册、找回、登录与独立设备授权。旧浏览器 token、资格码激活、记住账号菜单和邀请创建身份的路由保持退役。测试门禁不重写账号实现；直接使用库接口但缺少账号配置时，仅显示“账号系统准备中”的安全拒绝页面；正常 CLI 加载本环境的账号配置。正式公开 Beta 注册不需要测试人员代码。

服务端门禁位于 Origin/OPTIONS 处理之后、**所有账号与回调路由之前**。保留已有账号配置、原验证器与 Turnstile CSP。后续改动不能把门禁块放回 DSH 路由旁边，因为邮箱 API 在它之前。

邮件适配已接入现有 `apps/server/src/registration-providers.ts`：`ResendRegistrationMailer` 的第三参数在测试部署使用 `testEmailTransport(origin.origin)`，正式使用原 `fetch`。适配器给注册、找回和密码更改通知加 `[测试环境 / TEST]`，正文带测试站 `/app/` 链接；验证码、账号、预算与提供商逻辑仍由原账号系统管理。**经最终候选与真实提供商检查后，才开测试注册/找回邮件。**

## 负责人生成、发放与撤销

安装、构建和配置完成后，由负责人在测试服务的私密运维终端运行。环境文件必须是 `/etc/gatherthread-test/gatherthread.env`，不得读取或复制正式环境文件。下面的命令只创建测试门禁代码，和旧 `owner-host:issue-test-access` 无关。本文没有任何可发放代码。

```sh
cd /opt/gatherthread-test/current
umask 077
node --env-file=/etc/gatherthread-test/gatherthread.env apps/server/dist/src/test-gate-cli.js issue --hours 168 --count 1 --output /var/lib/gatherthread-test/distribution-NEW.txt
# 批量：--count 10；输出路径每次必须新建，已有文件/符号链接会拒绝。
node --env-file=/etc/gatherthread-test/gatherthread.env apps/server/dist/src/test-gate-cli.js list
node --env-file=/etc/gatherthread-test/gatherthread.env apps/server/dist/src/test-gate-cli.js revoke --grant-id GRANT_ID
```

发放文件为 0600，包含逐人的中文说明、测试网址、代码、撤销编号和北京时间截止时间。终端不打印代码。请用私密通道逐人发放，不放进链接、群聊、工单、截图、PR 或源码；负责人发送后按自己的密钥交付流程移除私密发放文件。`list` 仅显示管理编号/有效期/撤销状态，不显示代码。`revoke` 对存在的编号撤销关联准入会话；重复撤销已撤销编号会确认其状态，未知编号返回非零退出码，不能视为撤销成功。撤销记录保留到原有效期截止，计入 1,000 个未过期记录的容量，之后清理。

每个代码 256 位随机，服务端仅保存以独立 pepper 和 Origin 域分隔的 HMAC-SHA256 摘要。有效期 1..720 小时，默认 168 小时，一批 1..50 个，最多 1,000 个未过期记录。代码允许本人再次进入或更换浏览器，每个代码同时最多 32 个门禁会话。门禁 Cookie 最长 24 小时且不超过代码截止时间；代码过期或撤销后所有关联门禁会话失效。撤销环境准入不会注销邮箱账号或自动撤销已经授权的原生设备；需要同时停用 Agent 时，在测试账号设备管理中撤销相应设备。共享内容持久化前的递归脱敏同时覆盖 `GATHERTHREAD_TEST_GATE_PEPPER` 环境赋值和结构化 `testGatePepper` / `test_gate_pepper` 字段，依 [SECURITY](SECURITY.md) 执行；不因此屏蔽普通统计或状态字段。

浏览器通过 HTTPS POST 换取 Host-only `__Host-gatherthread_test_gate`，带 `HttpOnly; Secure; SameSite=Strict; Path=/`。不在 URL、Web Storage、日志或响应 JSON 中返回代码/Cookie。DELETE `/v1/test-gate` 退出准入，邮箱会话依然独立但不能绕过门禁。无/错/过期/撤销代码统一不可用提示；每真实 TCP 对端 20 次/分钟、全实例 300 次/分钟，计数持久化，不信任来访者伪造的转发头。Caddy 下对端是代理，这会保守地共享 20 次预算，适合小范围测试；若调整，需另审可信代理 IP 边界。

门禁沿用首页、登录页与工作页的 `gt-lang` 语言偏好，值为 `zh` 或 `en`。已有偏好优先；没有共享值时继承已保存的工作页 locale，再使用浏览器语言。门禁选择会带入账号页，账号页切换也会更新已打开的门禁标签页，刷新或退出后保留该偏好。浏览器禁止存储时，当页仍可安全切换；不使用准入凭据或其他秘密作为替代存储。

HTTP 在入口、异步读取请求体后及账号异步操作后的写入边界复核摘要与有效期；等待期间撤销、退出或过期的准入不能继续创建项目、账号、登录会话或重设密码。挑战验证后、邮件投递前和投递完成后也复核准入；已经被邮件提供商接受的投递不能撤回，但撤销后完成的验证码不会变为可验证状态。已提交的密码修改及其设备撤销不因后续通知失败而回滚。

现有页面每 30 秒检查门禁状态；现有 WebSocket 在消息、广播和 heartbeat 检查，失效后关闭。无 Cookie 的健康检查只说明进程/存储状态。原生 DSH begin/poll 与 Codex 一次性授权 claim 可到达各自已有、限速的凭据校验器，不能直接创建账号或得到设备。已有**本测试实例**的有效设备 bearer 可以调用明确允许的项目/会话/runtime/snapshot/code/`me` API 和取得 realtime ticket；它不允许绕过注册、密码登录、找回或浏览器账号管理门禁。带浏览器 Origin 的 bearer 请求仍需准入 Cookie。MCP 没有新增公开服务器端口，用户插件走私密本地 relay，连接器持有测试设备凭据。浏览器 WS 要求准入 Cookie 和原有一次性 ticket；原生 WS 豁免同时要求由无浏览器 Origin 的设备凭据取得 ticket，且握手本身无 Origin。原生 ticket 用于带 Origin 的握手时，仍需有效准入 Cookie，并持续接受浏览器准入撤销检查。所有连接随后仍检查设备/项目 ACL。设备撤销与账号密码重设由账号系统负责。

## 独立配置与提供商

| 项目 | 正式 | 测试 |
|---|---|---|
| Origin | `https://gatherthread.cn` | `https://test.gatherthread.cn` |
| 进程/Unix 用户 | `gatherthread` | `gatherthread-test` |
| loopback 端口 | 18787 | 28787 |
| 配置 | `/etc/gatherthread/` | `/etc/gatherthread-test/` |
| DB/云 Git | `/var/lib/gatherthread/` | `/var/lib/gatherthread-test/`，Git 为 DB 路径加 `.code` |
| 门禁 DB | 无 | `/var/lib/gatherthread-test/admission.sqlite` |
| 备份/恢复 | `/var/backups/gatherthread/` | `/var/backups/gatherthread-test/` |
| 当前产物路径 | `/opt/gatherthread/current` | `/opt/gatherthread-test/current` |
| 设备/账号/会话摘要 pepper | 正式独立 pepper | 新生成独立账号 pepper，门禁再用单独 pepper |
| Origin/CORS/WS | 正式唯一 Origin | 测试唯一 Origin |

模板位于 [deploy/test-environment](../deploy/test-environment/)。公开测试以 `NODE_ENV=production` 启用真实安全预检，同时 `GATHERTHREAD_DEPLOYMENT_ENVIRONMENT=test` 与门禁必须一致。生产默认 `production/false`；误开测试门禁或测试模式误关门禁会拒绝启动。测试服务用户不能读取正式配置、数据或备份，systemd 限制测试进程写入自己的数据目录，内存 512 MiB、CPU 50%。服务器管理者还必须给测试数据设置独立磁盘/文件系统配额并验证余量，否则事件逻辑配额无法约束全部 SQLite/WAL/Git/备份占用。共享 Caddy、CPU、磁盘或提供商账号仍有公共资源风险；余量不足时使用独立主机。

部署前，服务器管理会话分别用各自进程的 env 生成私密的公共隔离报告：`node --env-file=OWN_ENV scripts/test-environment/isolation-report.mjs write NEW_REPORT`。再在测试 env 下运行 `compare PRODUCTION_REPORT`。报告只包含公开路径/Origin/端口与高熵密钥的指纹；比较器不加载正式 env，也不输出密钥。它拒绝数据/Git/备份路径重叠、symlink 和密钥/端口/Origin 复用。另验 Unix 权限与 Cookie；不能把配置报告当成上线证明。不得复制正式用户、聊天、代码或备份到测试站。

所有浏览器 Cookie 都无 Domain 属性。上线前实际检查正式站 Set-Cookie，若存在历史 `Domain=.gatherthread.cn` Cookie，先由负责人清理/迁移并确认浏览器不再将它发送到测试站。默认代码符合 `__Host-` 规则，测试会话不被正式 pepper/数据库接受；不要为了“方便”设置父域 Cookie。配对回调、设备 state 与本地连接器工作区也必须选择测试 Origin，并使用新的私密连接器状态目录。

Turnstile 建议新建测试 widget，只准许 `test.gatherthread.cn`，邮箱服务端继续核对 hostname、action、cData；正式 widget/API secret 不进入测试配置。[官方 hostname 配置](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)。

Resend 建议独立测试发件子域和仅发送权限的域限定 API key；可在现有提供商账号内建隔离配置，但账号级配额仍共享，测试预算不能耗尽正式邮件额度。先确认现有套餐支持域数量，不自行升级或购买。[官方子域说明](https://resend.com/docs/dashboard/domains/introduction)、[API key 权限](https://resend.com/docs/dashboard/api-keys/introduction)。模板只留空值；模拟测试没有真实发信。

设备端 GitHub 连接仍由本地连接器授权/操作。可选服务器端 GitHub 功能依 [HOSTED_GITHUB](HOSTED_GITHUB.md) 单独配置；门禁仍覆盖其授权、回调、绑定和 PR 发布。Strict Cookie 的跨站返回使用公共 403 门禁页进行同站复查，规则由 [Security](SECURITY.md#test-admission-boundary) 定义。管理员须核对真实回调，不推测其已配置；推荐独立测试 App 与测试仓库。[GitHub App 可配置多个 callback](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)，仍须为测试明确选择 redirect_uri、独立 client secret 和环境绑定 state。测试不能接收正式 OAuth state 或使用正式 GitHub 仓库/用户代码。未知回调仍默认拒绝，不宽泛放行门禁。可选 Launcher v1 固定正式 Origin，测试先用工作页生成的手动终端命令；不要放宽已发布 v1 协议。其他 Origin 的启动器支持需要独立协议审核与配套版本。

Beta 1 的轻量云端任务与 GitHub 云端仓库任务都已开放网页入口，但服务端分别依赖 `GATHERTHREAD_HOSTED_AGENT_ENABLED`、`GATHERTHREAD_HOSTED_GITHUB_ENABLED` 与独立私密配置。按 [完整测试宿主预检](HOSTED_AGENT.md#isolated-test-host-activation) 保留 systemd 沙箱，使用宿主可见的 `TMPDIR=/var/lib/gatherthread-test/hosted-tmp`，以实际服务 UID 验证镜像、Docker、只读文件与 socket 挂载和清理。测试模板设置试用容器 512 MiB、仓库容器 768 MiB、全局及用户并发 1，禁止容器使用额外 swap。原先 512 MiB 仓库检查因内存不足失败，负责人已授权适度上调；CI 与导出镜像证据须在新的精确目标下重新通过，不将原失败记录算作成功。镜像构建报告分别记录 `trial_memory_mib` 与 `repository_memory_mib`，旧的单一 `memory_mib` 报告不能证明新目标。父级 cgroup 的总预算须独立计算和验收；实测完整任务及正式服务响应后才启用，超限须明确失败而非自动扩容或重试。API/App 秘密不得进入聊天或源码，也不通过放宽 Docker socket 权限、开放 daemon 或取消沙箱来解决配置失败。真实模型价格/条款与工具调用、独立 App 回调和少量私有测试仓库任务须验收后才启用；不因此变更正式服。

## 先测试，再由人工推广

1. 选择经审核的最终 `main` full SHA 作为唯一候选来源。提交、推送、合并、发 tag/npm、DNS/TLS/服务器变更各按 [CONTRIBUTING](../CONTRIBUTING.md) 授权，不因文档更新自动执行。
2. 使用下述隔离构建器，或在独立的目标兼容 Linux/架构/Node 24 环境运行 `bash scripts/test-environment/prepare-candidate.sh FULL_SHA ABSOLUTE_NEW_DIR`。脚本从固定提交归档到新目录，`npm ci`、完整 `release:verify`、构建全部成功后生成带 commit/Node/平台信息的 tarball 和 SHA256。没有 env、Git 或真实数据；不切换任何服务。代码更新后用新 SHA 重建，不在正式服务所在的小容量 ECS 上运行完整构建，也不在服务器重编两份产物。
3. 服务器管理会话验证 tarball 校验和，将**同一产物**解到测试的版本目录；env 与数据在产物外。创建 `gatherthread-test` 用户、0700 数据/备份目录、私密配置与独立随机密钥，检查报告、磁盘/内存余量与 backup/restore。只安装测试 units，追加独立 Caddy block，不能替换正式配置。28787/18787 都不开放公网；防火墙只让 Caddy 80/443 入站。
4. 获 DNS/TLS 授权后添加 test 子域 A/AAAA、签发 TLS；Caddy validate 成功才由管理会话 reload。核对反向代理 Host、可信 client-IP 覆写与证书，测试 service ready 和页面标记。在邮件接入复测后，负责人只在测试 env 开注册/找回并用少量授权收件地址验证，无批量邮件或付费模型测试。
5. 完成下表验收，记录 commit、产物 SHA、配置指纹、浏览器/OS 版本、模拟与真实检查范围；负责人审核后再给正式推广授权。测试通过**不自动**修改正式配置、公开注册或更新正式服务。
6. 正式推广使用已验收的同一 tarball/SHA，保留正式 env、生产默认关闭门禁、现有独立 DB/密钥。在正式自己的 verified backup 后，按既有 [OPERATIONS](OPERATIONS.md) 升级与有限烟测。正式与测试日志、定时器、删除登记与回滚记录分别管理。

### 隔离 Linux 候选构建与校验

经审核合并后，在 GitHub Actions 的 **Isolated test candidate** 工作流选择 `main`，填入本次审核的完整 40 位小写提交 SHA。工作流拒绝非 `main` 的手动调用及不属于已获取 `origin/main` 历史的提交；运行时固定为 GitHub 托管 Ubuntu 24.04 / Linux x64 / Node `24.16.0`，不用生产 ECS。它在新建 0700 目录、`umask 077` 和无私密配置的环境中调用原有完整构建脚本；不跳过检查、不拼接多次失败的部分结果、不调用真实模型，也不自动部署。构建器的特定开发分支 push 仅用于合并前验证，其产物标为 `reviewed_main: false`，不能作为正式审核后的安装候选。

只有完整构建与归档安全验证都成功，才上传 **三个文件**：`candidate.tar.gz`、`candidate.tar.gz.sha256`、`provenance.json`，保留三天。下载后在隔离目录运行 `python3 scripts/test-environment/verify-candidate.py candidate.tar.gz FULL_SHA` 再次验证。包内 `candidate.json` 固定只有 `commit`、`node`、`platform`、`arch` 四字段；单独的公开 provenance 记录源提交、实际工作流提交/运行编号、版本、tar SHA256、压缩大小与展开大小，不含环境、私密路径、账号或项目数据。`reviewed_main` 只是工作流来源标记，不是审批签名或部署许可。

归档验证拒绝私密配置、凭据/数据库文件、路径逃逸、特殊文件、危险或循环链接，以及超出安装器边界的包（100,000 个成员、单文件 64 MiB、文件展开总量 512 MiB）。额外限制压缩包 500 MiB、完整解压 tar 流 640 MiB 和扩展元数据，防止在解析前耗尽资源。校验使用有界的私有磁盘临时副本，不修改原包；需另预留约一个压缩包大小的临时空间。内部依赖链接仍须指向包内已存在目标，硬链接仅允许不含符号链接的普通文件链。GitHub Actions 显示的 artifact digest 是其外层产物的校验，不等于 tar SHA256；普通 SHA256 也不是加密签名。服务器会话须以实际新提交、tar SHA/字节数和新的版本路径重新固定安装器，再独立核验磁盘余量、权限和真实宿主验收；旧产物、旧路径、CI 成功都不能替代这些门。

## 备份与回滚

测试 backup unit 对应用 SQLite+`.code` 复用现有在线备份/校验工具；门禁无应用 schema，使用独立 `backup-admission.sh`，存 `admission/` 子目录。两者都保持 13 天阈值并监控定时器，不能复制正式 backup。测试 cloud Git 清理与日志保留计时器需从正式模板按测试用户/目录独立实例化，不能运行正式 timers。

每次测试升级前做各自 verified backup，验证 SQLite integrity/foreign keys、事件 replay 与代码 heads。门禁恢复校验 SHA256、`PRAGMA integrity_check` 和 namespace，恢复到**新的测试路径**，先删恢复副本的 `sessions`，重放恢复时间之后的代码撤销记录，再开放。账号恢复依 [OPERATIONS](OPERATIONS.md) 的独立删除/设备撤销登记，不复活已删除账号；检查测试 pepper 与 Origin 仍匹配。备份和密钥分别受限保存。

代码回滚只能指向与当前 schema 兼容的旧产物；不兼容时停测试进程并恢复测试自己的完整应用+Git+门禁备份到新路径。邮箱账号整合前的二进制会重新暴露旧账号路径，不得作为开放测试/正式账号的回滚服务；必要时保持外部流量关闭。正式回滚绝不能使用测试 DB、Cookie、Git 或密钥。不要覆盖失败现场。

## 验收记录要求

| 验收 | 本地自动化/模拟 | 服务器上线还需检查 |
|---|---|---|
| 无/错/过期/撤销代码、直接 API/编码路径/深链接 | store/HTTP/WS 负向测试 | 真实反向代理与过期/撤销现有页面 |
| 代码→注册→验证码→密码登录→找回→记住设备 | 当前 main + 门禁，两环境邮件/挑战用 fixtures | 实际 Turnstile、两种语言真实邮件、Safari |
| 同邮箱两环境、改密/注销/退出/设备撤销独立 | 两独立进程与随机 pepper/fixture 账号 | 两浏览器、同邮箱真实注册与独立密码 |
| Cookie/device/配对/WS/MCP 跨环境拒绝 | HTTP/原生能力/WS tests + 原有协议回归 | TLS Host-only Cookie、匹配的 Codex/DSH 插件 |
| 项目、会话、邀请、GT Cloud/GitHub、摘要兼容 | release:verify，无真实付费模型 | 测试仓库/工作区的少量双客户端烟测 |
| 页面标记、键盘、手机、中英文 | Chromium/WebKit 本地浏览器检查 | 原生 Safari/Chrome/Edge 支持版本 |
| 生产默认与隔离 | config 与独立实例负向测试 | Unix 权限/磁盘/secret 指纹/备份恢复验证 |

最终测试证据见 [TEST_ENVIRONMENT_VALIDATION.md](TEST_ENVIRONMENT_VALIDATION.md)。源码模拟通过不代表 DNS、TLS、邮件、原生 Agent 或服务器已经验收。
