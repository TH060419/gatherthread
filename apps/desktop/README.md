# GatherThread Desktop · macOS 本地原型

独立 macOS 桌面工作区，**尚未发布，也不替代现有 Launcher 或 DSH 插件**。协作窗口直接使用所选服务器的最新版 `/app/`，不复制或改写网页 UI；本机 Agent 管理复用仓库的编译样式和官方 logo。

架构见 [ADR-0066](../../docs/adr/0066-isolated-macos-desktop-workspace.md)，IPC 见[接口契约](../../docs/INTERFACE_CONTRACTS.md#desktop-native-management-preview)。

## 构建和体验

需要 macOS、Node.js 24、npm。目前仅验收 Apple Silicon；其他平台没有验收结论。

```sh
npm ci
# 若安装策略跳过了 Electron 下载脚本：
node node_modules/electron/install.js
npm run desktop:prepare-license
npm run desktop:build
npm run desktop:start -- --demo
```

`desktop:prepare-license` 下载当前 Node 版本的官方许可证，保存在 `.local/desktop-build/` 并记录来源和哈希。构建复制当前 Node 可执行文件作为私有运行时，验证许可证版本；不会修改系统 PATH 或安装 Agent 插件。

打包工具 `@electron/asar` 的依赖暂以 root scoped overrides 固定到 `glob 14.0.3` 和 `minimatch 11.0.3`，处理 [glob 取消后仍遍历](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)及 [minimatch 模式放大](https://github.com/advisories/GHSA-g3hv-75wg-m249)漏洞。范围仅限 ASAR 构建依赖；更改后必须重做实际 `.app` 打包和 Smoke，不能只看 audit。上游采用修复版本后再移除覆盖。

本机演示使用随机回环端口、真实服务器/Web 构建、内存数据库、两个虚构用户和模拟 Agent。演示页面不能连接外部服务；不调用真实模型，也不读取现有浏览器账号。退出后虚构会话与 Team 不保留；示例文件和验收截图留在独立演示目录。

1. 确认首次项目文件说明，退出可选的新手示例。
2. Mac 菜单选择 **工作区 → 本机 Agent**（`⌘⇧A`）。
3. 点击 **准备模拟连接 → 授权并连接**，无需密码。
4. 返回工作区，选择在线的 `desktop-fixture` 模型，再提交 Agent 请求。
5. 在 **管理我的 Agent** 中编辑 Team；模拟模型支持连通性测试与完成任务。普通模拟请求会说明是否读到测试用户 B 的团队约定。
6. 输入“长任务”可体验停止连接。关闭协作窗口会留在菜单栏；使用 **退出 GatherThread** 停止连接并退出。

## 真实环境入口（待人工验收）

不带 `--demo` 进入正式服；`--test-environment` 进入测试服。两者有不同的持久 Cookie 分区，与 Safari、Codex、DSH 和旧 Launcher 的登录隔离。

网页选择 **管理我的 Agent → 添加我的 Agent → 连接 Codex / Claude Code → 打开启动器**，当前项目会进入独立的本机管理窗口。检查服务器、账号、模型、Agent 程序和目录，再输入密码并连接。文件同步默认关闭；Hook 信任仍需用户在原生 Agent 中检查授权。

启动器会自动检查上次成功选择的位置、常见独立 CLI 安装目录、绝对 PATH 目录及有界的 nvm/fnm 安装目录，找到后显示版本，完整路径折叠显示。每次打开都会重新验证；也可点击 **重新查找**。通用扫描不启动应用包内的私有程序，包括指向这些程序的 PATH 链接。手动选择支持整个 `.app`、CLI 文件或安装文件夹；只检查其中已知的程序位置，不递归扫描文件系统。成功位置保存为本机私有 `agent-programs.json`，不保存账号凭据、不上传；保存失败时本次仍可连接，并显示未记住位置。

版本检查核对 Agent 类型，并区分签名无效、进程终止、超时和其他启动失败。仅当原生签名诊断明确返回无效时，才报告签名错误并避免启动该文件；其他信号退出不猜测原因。发生签名或启动问题时，请按 [Codex 官方安装说明](https://developers.openai.com/codex/cli)安装独立 CLI，再选择新程序。启动器不会修补第三方签名、关闭系统校验或替换现有安装。检测只运行版本检查，连接仍需用户显式授权。

本整合分支同时包含独立的 [DSH 原生工作区插件](../../packages/dsh-host/README.md)。两种入口使用同一套协议、服务器和品牌资源；桌面端不会自动安装或接管 DSH 插件，也不意味着这些原型已经合并主线或正式上线。

DSH 继续使用自己的插件和连接生命周期。这里仅提供选择并打开已安装 DSH 的入口，不改写 profile。共享、Team、云端 Agent 和文件/Git 仍受现有服务器及连接能力约束；桌面外壳不会扩展权限或补齐不支持的 Agent 类型。

## 验证和打包

```sh
npm run typecheck
npm run desktop:test
npm --workspace @gatherthread/desktop run smoke
npm run desktop:package
```

Smoke 仅使用虚构项目，检查隔离渲染器、严格 IPC、共享上下文、Team 保存/测试/启用/执行、刷新恢复和停止。截图位于开发 profile 的 `local-demo/validation/`。打包路径记录在 `.local/desktop-build/latest-package.json`，产物只有本地 ad-hoc 签名，**没有 Apple 公证、正式安装器或自动更新**。必须再运行实际 `.app --desktop-smoke`；可附加 `--demo-profile=/absolute/local/directory` 将打包验收数据留在指定目录。

未包含离线协作数据库/持久发送队列、本地文件编辑器、DSH 自动配对、自动安装/升级 Agent、开机启动或自动恢复任务。真实账号、模型、系统通知、下载选择器、断网恢复、Safari 布局和跨机器安装仍需独立人工验收；模拟结果不代表这些项目已通过。
