# 接入 Codex

共序通过一个轻量本地连接器，把当前选中的云端项目连接到 Codex Desktop。网页不会直接启动 Codex，也不会把任何凭据写进复制的命令。

> Alpha 预览版：`0.1.0-alpha.5` 已为 private 仓库测试准备。npm 包和固定 Git 引用发布后可直接使用；发布前请使用下方“源码测试”路径。

## 正常连接只需三步

### 1. 一次性安装 Codex 插件

先确认 Codex CLI 可用：

```bash
codex --version
```

如果终端提示 `codex: command not found`，请先安装或更新官方 CLI，然后重新打开终端：

```bash
npm install -g @openai/codex
```

运行 `codex plugin --help`，确认当前 Codex 版本支持插件后，再安装共序：

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.5 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

重启 Codex Desktop。在设置中检查 **共序 / GatherThread** 的 MCP 服务和 Hooks，确认无误后启用 Hooks。

### 2. 连接一个共序项目

在共序网页打开目标项目，选择 **连接 Codex**，复制与系统对应的命令。命令形式如下：

```bash
npx --yes @gatherthread/codex-connect@0.1.0-alpha.5 \
  --url 'https://你的共序服务器地址' \
  --project 'PROJECT_ID' \
  --create-workspace \
  --plugin-hooks
```

连接器会在终端的隐藏输入中询问设备 Token。保持这个终端运行。每个需要在线的共序项目运行一个连接器即可。

### 3. 确认连接成功

Codex Desktop 会打开经过验证的本地工作区；共序成员栏会显示 **Agent 在线**。连接器会自动发现当前及之后新增的可写会话。

## npm 发布前的 private 仓库测试

有仓库权限的协作者现在即可测试完整本地体验：

```bash
git clone https://github.com/TH060419/gatherthread.git
cd gatherthread
npm install
npm run build
npm run codex:connect -- \
  --url 'http://127.0.0.1:18787' \
  --project 'PROJECT_ID' \
  --create-workspace \
  --plugin-hooks
```

服务器地址和项目 ID 以本地网页显示内容为准。private `v0.1.0-alpha.5` 引用建立后，上方固定插件命令即可使用。没有经过审查并启用的插件 Hooks 时，网页 Agent 请求仍可运行，但 Codex Desktop 中的直接回合不会上传。

## 会同步什么

- 每个可编辑的共序会话都有独立 Codex 任务。
- 网页 **请求我的 Agent** 在隔离的后台投影中运行，并把最终答复写入规范历史。
- 经过审查的 Hooks 会上传 Desktop 中完成的直接回合，并把新增共享上下文送入任务。
- 每个本地对话默认自动上传。共序工作页会针对当前会话显示所选 Codex 设备、“本地回合自动上传至云端”开关、等待上传至云端的状态和“立即从本地上传至云端”；经审查的 Codex 插件也可按会话名称执行相同操作。
- 在连接器仍以已审查的 `--plugin-hooks` 模式运行时，手动上传会直接扫描对应 Desktop 任务，因此即使受信任 Hook 没有触发、漏记或临时失效，也能补传符合条件的已完成回合；补传不会擅自恢复自动上传。
- 本地新任务只有在首个回合完成后才创建一个由本人创建的云端 Solo；空任务和访者任务始终留在本地。
- 删除云端项目或会话不会删除本地文件和 Codex 任务。

规范历史始终会注入模型上下文。连接器还会单独导入经过验证的原生历史快照，让本地任务具有可直接阅读的 Desktop 气泡。设置只保留两档：`first-connect` 默认在每个会话首次于本地建立时导入一次；`never` 关闭自动可见历史导入。可随时在工作页选择“导入 Codex 历史”，或通过已审查插件调用 `collaboration_import_codex_history`。每次手动导入都会创建一个新的本地 Codex 任务；系统会按配置的上下文上限压缩长历史，验证新任务后再切换持久绑定和 Hook 许可。系统不会覆盖、删除或归档旧任务，请用户检查后自行归档。实时增量上下文注入始终独立保持启用，包括关闭自动可见历史导入时。

## 项目与工作区规则

- `--create-workspace` 会创建或复用 `~/GatherThread Projects/<项目名>`。
- 工作区中的无凭据标记会把该目录严格绑定到一个共序服务器和项目。如果提示工作区属于其他绑定，请连接原项目，或换一个新工作区；不要删除标记绕过检查。
- 若要使用已有源码目录，把 `--create-workspace` 改为 `--workspace '/绝对路径'`。
- 项目名和会话名可以修改，连接身份仍由稳定 ID 决定。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| `Local workspace is already bound...` | 停止连接器，换一个工作区，或重新连接该目录原先绑定的项目和服务器。 |
| `thread/start` 或 `thread/resume request timed out` | 先保持终端运行；连接器会重试并在恢复时显示 `recovered`。若持续出现，重启 Codex Desktop。 |
| 项目出现但没有任务 | 先发送一次网页 Agent 请求，或在本地任务完成一个直接回合，再重新打开 Codex 项目。空会话不会制造虚假回合。 |
| 网页显示 Codex 离线 | 检查连接终端是否仍在运行，并确认命令 URL 与浏览器当前服务器同源。 |
| Desktop 回合没有上传 | 检查命令包含 `--plugin-hooks`、插件已安装、Hooks 已启用，并确认任务属于连接器管理的工作区；随后让共序插件手动补传该会话的本地已完成回合。 |

## 安全边界

复制的命令只包含服务器地址、项目 ID、模型和非敏感参数。设备 Token 仅保留在连接器进程中，并会从 Codex 子进程环境移除。插件 MCP 通过私有本地端点和短期能力连接正在运行的连接器；重复或歧义路由会拒绝执行。

连接器不会自动开启不受限沙箱，不会静默修改全局 Codex 设置，也不会把本地服务暴露到网络。按 `Control-C` 即可停止。

## 发布验证

```bash
npm run release:verify-codex
npm run release:pack-npm
npm run release:dry-run-npm
```

第一条命令会在不含 Git 元数据的临时目录中重建、打包、安装并冒烟测试独立连接器；第二条会把候选 tarball 生成到被 Git 忽略的 `release-artifacts/npm/`；第三条使用 `alpha` dist-tag 走完 npm 发布预检，但不会真正发布。
