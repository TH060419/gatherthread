# 接入 DeepSeek Harness

共序 DSH 插件运行在 DeepSeek Harness 的 Web profile 中，并由 DSH 主动连接到选定的共序服务器。网页不会探测 `localhost`，也不会尝试启动本地进程。

> Alpha 预览版：`0.1.0-alpha.5` 已为 private 仓库测试准备。“共序官方服务”入口已经保留但暂时禁用，请使用本机、局域网、自托管或 Tailscale 服务器。

## 正常连接只需四步

### 1. 一次性安装插件

DSH 的 profile 安装器使用 `pnpm`。若系统尚未安装，请先运行：

```bash
npm install --global pnpm@10
```

再把固定版本的共序插件加入 DSH Web profile：

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add @gatherthread/dsh-host@0.1.0-alpha.5
```

### 2. 打开 DSH

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

保持 DSH 运行，然后打开 **设置 → GatherThread / 共序**。

### 3. 配对当前服务器

输入共序服务器地址，选择 **登录并配对**，核对页面显示的短码，再到已经登录的共序网页批准相同短码。短码只能使用一次，并会很快过期。

### 4. 选择 DSH Provider 与 Model

批准短码只完成配对，本身不会注册任何东西。回到 **设置 → GatherThread / 共序**，选择 Provider 与 Model，再确认连接当前身份可见的全部项目。只有完成这一步，本机才会注册共序运行时；在此之前，共序网页无法发现这台 DSH，面板也会一直显示为已停止。运行只使用显式选择的 Provider 与 Model，不会回退到 Codex。

## npm 发布前的 private 仓库测试

在 private 源码目录执行：

```bash
npm install
npm run build
npm run release:pack-npm
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add ./release-artifacts/npm/gatherthread-dsh-host-0.1.0-alpha.5.tgz
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

除非依赖元数据已完整缓存，否则不要加 `--offline`。DSH 会把 profile 包安装交给 `pnpm`；离线镜像不完整时，共序插件尚未开始安装就会失败。

## 会同步什么

- 一次配对会连接当前身份可见的全部活跃项目，并继续发现之后新增的权限。
- 可写的共序会话会成为可编辑的 DSH 原生会话，标题带 `<会话名> · 共序 · MULTI|SOLO` 标记，便于在 DSH 会话栏中与普通本地会话区分。
- 云端规范历史会投影到 DSH；本地完成的回合通过持久 outbox 只上传一次。
- 在 **设置 → GatherThread / 共序** 中，每个已连接对话都有独立的“自动上传”开关与“手动上传”。关闭后，新完成的本地回合会继续留在本地，直到用户显式补传；手动上传不会改变开关。
- DSH 新会话只有在首个成功的人类/助手回合完成后，才创建一个由本人创建的云端 Solo。
- 空会话、失败回合和访者会话始终留在本地。
- 网页 Agent 请求只交给明确选择的 DSH 设备、Provider 和模型，不会静默回退到 Codex。

DSH 使用其自身配置的 Provider 额度。`Insufficient Balance` 或 `QUOTA` 表示所选 DSH 模型账户当前无法运行，不是共序同步故障。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| `pnpm not found on PATH` | 安装 `pnpm@10`，关闭旧终端后重试。 |
| 使用 `--offline` 时出现 `Failed to resolve dependency tree` | 去掉 `--offline` 重试，或修复当前 pnpm registry/cache。 |
| 插件按钮空白或文字不可见 | 重新构建并安装 tarball，重启 DSH，再强制刷新网页。 |
| 配对提示操作未完成 | 检查服务器地址、当前共序浏览器登录状态和 DSH Provider/模型配置。 |
| runtime 在线但回合显示 `QUOTA` | 在 DSH 配置有可用额度的 Provider 模型后重试。 |
| 同步会话显示只读 | 确认共序角色和会话权限后刷新配对。访者及他人创建的 Solo 本来就只读。 |

## 安全边界

插件只主动向外连接。配对短码短时有效、只能使用一次，并绑定当前服务器与 DSH 设备。长期设备凭据只保存在 DSH 本机凭据库，不会进入命令、URL、浏览器存储、日志或共享历史。

只有允许公开的助手输出和经过脱敏的工具投影可以离开 DSH。隐藏推理、私有流、请求头和原生元数据不会上传。

## 发布验证

```bash
npm run release:verify-dsh
npm run test:dsh-npm-plugin:real
npm run release:pack-npm
npm run release:dry-run-npm
```

这些命令会验证无 Git 元数据安装与导入、真实 DSH profile 安装流程、被 Git 忽略的候选 tarball，以及使用非默认 `alpha` dist-tag 的 npm 发布预检。
