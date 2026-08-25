# 接入本地 Codex

内置连接器会为一个 GatherThread 会话维护一个持久化的本地 Codex thread。它会自动补齐规范会话历史，只运行当前已认证用户自己发出的 Agent 请求，并把最终回复和可选的已脱敏工具事件写回共享会话，来源信息由服务器生成。

## 准备条件

- 本地已经 clone GatherThread 并安装依赖。
- Node.js 24 或更新版本。
- 已安装并登录 Codex CLI，可用 `codex login status` 检查。
- 能通过 Tailscale 访问主机，并已接受主机共享。
- 自己设备的 GatherThread Access Token，不能使用另一位协作者的 Token。
- 一个允许 Codex 访问的本地项目目录。

## 启动连接器

在 GatherThread 项目目录运行：

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol
```

命令会在终端中隐藏输入 GatherThread 设备 Token。如果账号拥有多个可写会话，再选择要连接的会话编号。Token 只保留在当前连接器进程的内存中，不会写入 Codex thread 状态，也不会传给 Codex 子进程。

保持该终端运行。网页每5秒刷新一次 runtime 状态。成员区域显示 `codex · openai · <模型>` 且为 Online 后，在输入框填写指令并点击 **Request my agent**。

## 自动同步规则

- 第一次请求会创建本地 Codex thread，并输入该请求之前所有当前用户可见的规范事件。
- 后续请求继续同一个 Codex thread，只补入上次成功提交后新增的全部事件。
- 普通聊天和其他协作者的 Agent 回复会成为上下文，但不会触发 Codex。
- 只有由同一认证用户发出的 `agent_request` 才能被其本地 runtime 领取。
- 当前 Codex 自己已经生成过的回复和工具事件不会再次重复注入同一个 thread。
- 连接器离线后会根据持久化服务器游标自动补齐历史，再处理待处理请求。
- Codex 自己负责本地 compact；GatherThread 保存完整规范事件日志，不共享各个 harness 的原生 compact 状态。

## 更保守的运行方式

让 Codex 只能读取项目：

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol \
  --sandbox read-only
```

只共享最终回答，不上传结构化工具调用及有界工具结果：

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol \
  --no-share-tool-events
```

默认沙箱是 `workspace-write`。连接器始终禁止自动提升权限，也不支持 `danger-full-access`。

## 重建本地 Codex 会话

如果确实希望同一个 GatherThread 映射使用一个全新的本地 Codex 上下文，先停止连接器，再运行：

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/你的本地项目绝对路径" \
  --model gpt-5.6-sol \
  --session SESSION_ID \
  --reset-codex-session
```

这个操作只删除私有的本地 thread 映射文件，不会删除 GatherThread 服务器历史，也不会删除 Codex 原生 transcript。下一次请求会从当前用户可见的完整服务器历史重建上下文。

## 停止和重新连接

按 `Control-C` 停止。心跳过期后 runtime 通常会在30秒内显示 Offline。以后运行相同命令，会继续使用原来的 Codex thread 和 GatherThread 持久化游标。

一个连接器进程只为一个共享会话注册一个本地 runtime。如果需要同时参与多个会话，应分别使用不同的 `--session` 启动多个进程。

## 常见问题

- `Codex CLI could not be started`：安装 Codex，或者使用 `--codex-command /Codex绝对路径`。
- `codex login status` 失败：先在本机完成 Codex 登录。
- `No writable GatherThread sessions`：当前用户只有 viewer 权限，或者尚未接受会话邀请。
- 网页一直显示 Offline：保持连接器终端运行，检查 Tailscale 和 HTTPS 地址，然后等待最多5秒让网页刷新成员状态。
- `Codex session state belongs to a different workspace/session`：使用原来的会话和项目路径，或者明确执行 reset。
- hydration prompt 超过限制：审查本地上下文策略后再决定是否提高本地限制；服务器规范历史不会被删除。
- Alpha 版本中，如果进程在领取请求后崩溃，请求可能卡住；可重新发送一条替代请求，自动 claim lease 恢复尚未实现。

## 安全边界

共享历史属于不可信的协作数据。连接器会把服务器验证过的本地请求与之前的上下文分开，保留 Codex 沙箱，禁止自动权限提升，从子进程环境移除 GatherThread 凭据，限制输出大小，排除 raw reasoning 和私有 prompt，并在上传前执行统一脱敏。这些措施只能降低而不能完全消除 prompt injection 风险；只与可信成员协作，对不可信项目使用 `read-only`。

设计依据参见 [ADR-0005](adr/0005-managed-codex-thread-bridge.md)。
