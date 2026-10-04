# 独立测试环境本地验收记录

2026-10-04 对 [Draft PR64](https://github.com/TH060419/gatherthread/pull/64) 的三项 P2 修复及追加两项 P2（门禁 pepper 脱敏、跨入口语言同步）完成本地复验，尚未上线。源码仍位于独立分支 `codex/test-environment`，源于 main `ca4860d4fb26375eff26191fc7993fba21af7b4e`；另外对当前 main `4aa5a1b3ac06d6e0ff7d0613f062f201177a27b3`（含 PR65）生成临时合并候选并完整验收，没有合并 PR 或改动 main。以下结果不能替代新提交的远端 CI、最终固定头审核与上线验收。

## 实例与执行范围

源码工作树为 `/private/tmp/gatherthread-test-environment`。本轮从固定头 `344e9f618c1f3f8bf74da49732cf41134151c095` 及其与当前 main 的 merge-tree `500aeae6e38b87d6d8acd22bc840747a7f84bf50` 各导出 Git-less 源码，再应用本轮修复，生成 `/private/tmp/pr64-second-head-clean.63TiDF` 与 `/private/tmp/pr64-second-main-clean.j6PsyA`。两目录起始均无 node_modules 或 dist，经独立 `npm ci` 后串行执行完整 gate，保留原超时。编译出的 server 测试文件与 17 个源码测试文件逐一对应，没有旧 ignored dist 测试。代码字节已与交付源码核对；日志中的测试总数差异来自当前 main 的 PR65 用例。

环境为 macOS 26.3.1 arm64、Node 24.16.0。浏览器使用实际 Chrome 154.0.8037.93 的 headless Chromium 和 Playwright WebKit 26.5。WebKit 的结果不等同于原生 Safari、真实 iPhone 或 Windows 浏览器验收。

所有新增账号/配对用例使用回环服务、独立临时 SQLite、随机 fixture 凭据以及模拟邮件/挑战；没有读取正式 env、数据库、备份或用户代码，没有调用真实邮箱、Turnstile 或模型。浏览器用本地 HTTP 的开发门禁 Cookie；Secure `__Host-` Cookie 属性由服务端配置/HTTP 响应用例验证，真实 TLS 与浏览器 Secure Cookie 行为仍须线上确认。

## 自动化结果

| 检查 | 最终结果 |
|---|---|
| PR64 本轮修复的干净源码 `npm run release:verify` | 1,086 项：1,081 通过、5 跳过、0 失败、0 取消；退出码 0 |
| 修复与当前 main 的干净候选 `npm run release:verify` | 1,096 项：1,091 通过、5 跳过、0 失败、0 取消；退出码 0 |
| 依赖漏洞审计 | 0 vulnerabilities |
| Git-less Codex/DSH 产物验证 | 通过，无真实凭据的安装/接口预检 |
| 新增邮箱/门禁/原生跨环境集成 | 运行通过，未跳过账号依赖 |
| Chrome/WebKit 原分支及当前 main 候选 UI | 每份 14/14 场景通过，无未捕获页面错误 |
| 新脱敏专项 | 3/3 通过：原有规则、递归键/环境文本、真实服务写入和 replay；退出码 0 |
| `git diff --check`、秘密模式检查、两份 shell 语法 | 通过 |

本轮完整发布日志：`/private/tmp/pr64-second-head-release.log`、`/private/tmp/pr64-second-main-release.log`。脱敏专项日志：`/private/tmp/pr64-second-redaction-green.log`。浏览器日志：`/private/tmp/pr64-second-browser-green.log`、`/private/tmp/pr64-second-main-browser.log`。提交或 main 变化后仍需按变更范围重跑，不能将本地结果称为远端 CI 通过。

先在旧实现上执行新增回归，九项在途/异步用例及原有 WS、CLI 测试共十一项失败，记录在 `/private/tmp/pr64-repair-red.log`。修复后上述专项全部通过；完整发布检查串行运行，保留原有测试超时参数。

本轮新增两个脱敏测试在旧实现上失败，单次语言切换的浏览器测试也在旧门禁未保存 `gt-lang` 时失败；记录在 `/private/tmp/pr64-second-redaction-red.log`、`/private/tmp/pr64-second-browser-red.log`。修复后检查共享事件返回值、直接存储的 JSON、getEvent 和 replay 都不含明确标注为非秘密的 fixture pepper，普通 tokenCount 和轮换日期保留。未读取真实配置或密钥。

`release:verify` 包含 TypeScript、Web/connector/DSH 构建、单元/脚本/Web/集成/e2e、引用/许可/品牌/秘密/依赖漏洞审计、发布元数据，以及 Git-less Codex/DSH tarball 验证。最终只保留五项已有 DSH 外部 harness 可选检查；邮箱链路测试已随已合入账号接口运行，不把缺少依赖算作通过。

一次并行完整检查在既有 replay/reconnect 与 PR62 password-reset WebSocket 等待用例超时。串行复测保留原超时参数，不放宽测试或权限。结果以最终串行日志为准。Web 构建仍报告已有 i18n 重复键 warning，相关 i18n 文件不在本分支修改范围。

## 新增边界覆盖

| 边界 | 验证内容 |
|---|---|
| 门禁存储 | 256 位随机代码/会话、摘要而无明文、批量生成、有效期、撤销、独立 namespace、持久化限速、容量限制与严格协议 |
| 配置/生产默认 | 默认关闭；test/开关不一致拒绝；单一 HTTPS Origin、独立路径、非占位独立 pepper；测试/正式凭据互拒 |
| HTTP | 未准入账号/项目 API 与编码路径拒绝；慢请求体等待期间撤销、退出或过期后返回 403，项目表无写入；挑战等待后撤销不发送邮件或预留投递；投递完成后撤销清除验证码；注册/登录/重设密码运算期间撤销不修改账号、设备、登录会话或密码 |
| Cookie/WS | Host-only HttpOnly Secure Strict 响应；重复门禁 Cookie 拒绝；原生 ticket 用于带 Origin 的握手时，缺/错/撤销 Cookie 拒绝；有效 Cookie 的浏览器与原生 ticket 浏览器连接均在准入撤销后关闭；真正无 Origin 原生连接继续工作，独立设备撤销后关闭 |
| 两环境邮箱 | 同邮箱分别注册不同密码；跨密码、Cookie、Codex 一次性授权和 DSH 配对拒绝；测试改密撤销其设备/会话，正式不受影响；测试账号删除不删除正式账号 |
| CLI/隔离报告 | 新建 0600 发放文件、拒绝覆盖、终端与列表不含代码；未知撤销编号非零退出且不假报成功，有效会话不受影响；真实编号撤销关联会话而不影响其他编号，清理后重复撤销仍确认状态；隔离报告拒绝共享密钥/路径/备份/Origin/端口与不完整/格式错误的报告 |
| 邮件显示 | 两种语言的注册、找回与密码通知均加测试标记和测试链接，保留收件人、provider receipt 与幂等参数 |
| 共享内容脱敏 | 嵌套对象/数组中的门禁 pepper 命名形式、环境赋值文本；human_chat/tool_call/tool_result 经真实服务持久化再 replay 不保留 fixture 值，普通统计字段不被屏蔽 |
| 浏览器 | 8 个 Chromium/WebKit × 1440/390 × 中英文场景包含单次门禁切换直接进入账号页、账号切换同步另一门禁标签、返回和刷新；另外 4 个已有 gt-lang 与浏览器 locale 相反的场景及 2 个 localStorage getter 抛 SecurityError 的安全退化场景；保留键盘、无溢出、凭据不在 Web Storage 和模拟注册/恢复检查 |

Chrome/WebKit 英文桌面场景额外完成模拟邮箱注册、文件协作确认、独立示例退出，以及 reload 后账号会话恢复。中文与手机场景验证正常账号入口和环境标记；没有宣称每个视口都完成真实注册/找回。Safari/WebKit 在 macOS 使用系统全控件导航 `Option-Tab`；Chrome 使用 `Tab`。

截图仅在输入已清空时生成，只显示模拟账号或空表单；它们是布局证据，不是底层权限或真实提供商证明。所有浏览器场景均无未捕获页面 JavaScript 错误。

## 重跑命令

在 Node 24 环境与已安装的 Playwright/浏览器下：

```sh
npm ci
npm run release:verify
npm run build
node --test apps/server/dist/test/redaction.test.js apps/server/dist/test/test-gate-races.test.js apps/server/dist/test/test-gate.test.js apps/server/dist/test/test-email-transport.test.js scripts/test/test-environment.test.mjs tests/integration/test-environment-email.test.mjs
PLAYWRIGHT_MODULE_PATH=/ABSOLUTE/playwright/index.mjs PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ABSOLUTE/chrome BROWSER_OUTPUT_DIRECTORY=/ABSOLUTE/private-output node tests/browser/test-environment.mjs
git diff --check
bash -n scripts/test-environment/prepare-candidate.sh scripts/test-environment/backup-admission.sh
```

`PLAYWRIGHT_MODULE_PATH` 未设时使用安装的 `playwright`；Chrome 路径未设时使用 Playwright bundled Chromium。不要在缺少浏览器时把跳过当作通过。当前分支已包含 provider 接入，不需要另外应用补丁。main 或门禁最终合并头发生变化后重跑。

## 部署前仍须验收

1. 门禁 PR 的最终固定头审核、合并后的 Linux/Windows CI；按目标 Linux/架构/Node 生成固定 SHA 的单一产物，记录 checksum。Linux candidate/backup 脚本本次仅做语法检查，systemd/Caddy 模板没有在服务器执行。
2. 经逐次授权设置 DNS/TLS、独立服务用户/配置/随机密钥、测试 SQLite/云 Git/备份与 Unix 权限、磁盘配额/余量、Caddy Host/IP 边界；生成两个进程自己的隔离报告并比较。
3. 测试 Turnstile widget、域限定发送 key、发件子域与小预算；应用邮件 seam 后少量真实中英文注册/找回，实际 Secure Host-only Cookie、历史父域 Cookie 与 OAuth 回调检查。
4. 原生 Safari/Chrome/Edge/移动端；匹配版本的真实 Codex/DSH 私密连接器状态目录。测试工作区的项目、Solo/Multi、邀请、GT Cloud/GitHub、摘要、replay/reconnect 和撤销烟测，不能使用正式仓库或付费模型。
5. 独立测试应用/Git/门禁备份及恢复演练、撤销/删除登记、保留与回滚。测试成功后仍需负责人单独授权正式推广，使用同一 tarball/SHA 并保留正式独立数据/配置。

完整操作约束与发放说明见 [TEST_ENVIRONMENT.md](TEST_ENVIRONMENT.md)。尚未生成可供真实发放的测试代码，也未执行 DNS、服务器、正式配置、注册开关、真实邮件、merge、tag、npm 或 GitHub Release 操作。
