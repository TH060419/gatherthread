# 接入 DeepSeek Harness

共序 DSH 插件运行在 DeepSeek Harness 的 Web profile 中，并由 DSH 主动连接到选定的共序服务器。网页不会探测 `localhost`，也不会尝试启动本地进程。

> 邀请制 Alpha：`https://gatherthread.cn` 已对获批测试者开放，但当前 DSH 插件若未配置官方 URL，“共序官方服务”快捷按钮仍禁用。请手动输入该 HTTPS 地址。固定 npm 命令还需对应包已经发布；否则使用下方源码路径。

## 正常连接只需四步

### 1. 一次性安装插件

DSH 的 profile 安装器使用 `pnpm`。若系统尚未安装，请先运行：

```bash
npm install --global pnpm@10
```

再把固定版本的共序插件加入 DSH Web profile：

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add @gatherthread/dsh-host@0.1.0-alpha.7
```

### 2. 打开 DSH

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

保持 DSH 运行，然后打开 **设置 → GatherThread / 共序**。

### 3. 配对当前服务器

输入共序服务器地址（服务器 Alpha 为 `https://gatherthread.cn`），选择 **登录并配对**，核对页面显示的短码，再到已经登录的共序网页批准相同短码。短码只能使用一次，并会很快过期。

### 4. 选择 DSH Provider 与 Model

批准短码只完成配对，本身不会注册任何东西。回到 **设置 → GatherThread / 共序**，选择 Provider 与 Model，再确认连接当前身份可见的全部项目。只有完成这一步，本机才会注册共序运行时；在此之前，共序网页无法发现这台 DSH，面板也会一直显示为已停止。对于兼容的 DeepSeek 路由，该选择既是连接默认值，插件也会声明 DSH 实际提供的模型和推理强度。之后可以在 GatherThread 工作页为单次 Agent 请求选择其中一个组合；这个临时选择不会覆盖 DSH 页面自己的模型设置，也不会回退到 Codex。

## npm 包不可用时的源码路径

在有访问权限的源码目录执行：

```bash
npm install
npm run build
npm run release:pack-npm
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add ./release-artifacts/npm/gatherthread-dsh-host-0.1.0-alpha.7.tgz
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

除非依赖元数据已完整缓存，否则不要加 `--offline`。DSH 会把 profile 包安装交给 `pnpm`；离线镜像不完整时，共序插件尚未开始安装就会失败。

## 会同步什么

- 一次配对会连接当前身份可见的全部活跃项目，并继续发现之后新增的权限。
- 可写的共序会话会成为可编辑的 DSH 原生会话。新建的原生会话初始标题为 `<会话名> · 共序 · MULTI|SOLO`；接入已有会话或重新连接时保留本地标题，包括用户自行修改的标题。
- 云端规范历史会投影到 DSH；本地完成的回合通过持久 outbox 只上传一次。
- 在 **设置 → GatherThread / 共序** 中，每个已连接对话都有独立的“自动上传”开关与“手动上传”。关闭后，新完成的本地回合会继续留在本地，直到用户显式补传；手动上传不会改变开关。
- DSH 新会话只有在首个成功的人类/助手回合完成后，才创建一个由本人创建的云端 Solo。
- 空会话、失败回合和访者会话始终留在本地。
- 网页 Agent 请求只交给明确选择的 DSH 设备，并使用该 runtime 已声明的 Provider、模型和推理强度组合。页面不会提供不支持的值，伪造请求也会失败关闭。旧版和未声明动态能力的路由继续使用连接时的固定模型，不会静默回退到 Codex。

DSH 使用其自身配置的 Provider 额度。`Insufficient Balance` 或 `QUOTA` 表示所选 DSH 模型账户当前无法运行，不是共序同步故障。

Alpha 7 还允许会话写入者在共序网页选取已完成的公开消息，由**本人已连接的 DSH Agent**生成有作者和来源的共享总结。原文和旧版本均保留。每位用户的项目设置默认让**之后从网页发起的 Agent 请求**使用总结视图，也可切换为原文。需要总结视图时，网页请求使用共序自有、同工作区且已验证原生工具预设继承的 DSH 辅助执行会话；没有总结的普通会话仍走原有原生路径。DSH 原会话、本地回合及原生自动压缩不会被改写。远端 Agent 回复在 DSH 中显示为带明确来源标签的插件引用，而非伪造成本机模型回合；这样可保持下一个本地回合的原生编号。共序规范事件仍保留原有作者与类型。若无法验证兼容的原生接口或预设继承，请求会明确失败，不会偷偷回退到原文注入。总结可能遗漏细节，提示词也不是限制工作区工具或文件访问的安全沙箱。详见 [ADR-0027](adr/0027-shared-manual-history-summaries.md)。

## 上下文与原生压缩

从云端同步到 DSH 的公开消息保留完整脱敏正文，不再套用本地向云端上传的 64 KiB 截断。上传脱敏、单次请求和传输资源限额仍保留；完整可见历史并不等于模型能一次读入全部内容。

正常回合由 DSH 根据模型信息及原生配置管理自动压缩，包括非 DeepSeek Provider。共序不覆盖这些设置，也不把网页中的 Codex 备用预算用于 DSH。原生压缩可能消耗模型额度，模型名称或窗口声明也不保证 Provider 一定接受相同输入量。

DSH `0.1.2-rc.1` 存在首次导入限制：自动压缩需要之前的原生请求信息，首次同步的历史可能在建立这些信息前就已超窗；手动压缩本身也需要一次有输入上限的模型请求。若原生输入仍可接受，可使用 DSH 自带压缩；或明确选择已配置且适合该上下文的模型。共序不会在后台轮询时付费压缩、擅自换模型或删减云端记录。任意超长初始历史的自动分段救援尚未实现，详见 [ADR-0026](adr/0026-native-first-context-management.md)。

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
