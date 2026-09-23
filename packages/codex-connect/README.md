# `@gatherthread/codex-connect`

The standalone GatherThread connector for a locally installed and authenticated Codex Desktop / CLI. It creates or safely reuses one local workspace, opens Codex Desktop, connects every currently writable project session, and keeps discovering new eligible sessions while it runs.

## Minimum connection

Copy the fixed-version command from GatherThread Web. It contains the server origin and project ID, but no browser cookie, invitation secret, device token, or local path:

```sh
npx --yes @gatherthread/codex-connect@0.1.0-alpha.7 --url https://gatherthread.example --project PROJECT_ID --create-workspace --plugin-hooks --visible-history-sync first-connect
```

The connector requests the device access token with hidden terminal input. It supports Web **Request my agent**, canonical per-session projections, read-only snapshots, and a verified Desktop-visible history snapshot. `first-connect` imports once when each session is first established locally; `never` disables automatic import. Each manual import creates a new task and leaves the previous task for the user to archive. Realtime context injection stays active in both modes. Keep the process running.

After the matching Git release ref exists, install the fixed plugin source and plugin explicitly:

```sh
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.7 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

Restart Codex Desktop and review the plugin's MCP server and Hooks before enabling them. Neither the Web page nor the connector runs these commands or edits global Codex configuration.

The connector also exposes a private local API for the **共序 / GatherThread** Codex plugin. The plugin's stdio MCP process receives no device token. Multiple running project connectors publish leased, non-secret instance/endpoint/project registrations; their separate random per-run capabilities authorize calls. MCP discovery collapses crash/restart overlap for the same endpoint to its newest lease, aggregates distinct projects, and routes unique project/session IDs, while duplicate IDs across distinct endpoints or an offline target fail closed.

For direct Codex Desktop turns to synchronize back to GatherThread, install and review the GatherThread plugin, add `--plugin-hooks`, then enable and trust its `UserPromptSubmit` and `Stop` Hooks in Codex. The plugin ships a dependency-free local forwarder, so Hook execution never runs `npx`; it requires the connector to remain online and does not spool missed turns. `--install-hooks` remains an explicit compatibility path for a reviewed project Hook file with bounded offline spooling. These options are mutually exclusive and trust is never implicit. A private runtime source gate prevents a retained project Hook file from also returning context or adding to the spool while plugin mode is active; only project Hook mode drains that spool.

Each bound Desktop conversation keeps its own local-to-cloud automatic-upload preference, enabled by default. The GatherThread workspace and the user MCP tools can show that state, turn automatic upload off or on, and manually scan and upload completed eligible turns to the cloud. Manual upload is the recovery path when a Hook did not run or did not leave a draft; it keeps the preference unchanged and uses the same idempotent local-turn outbox. Turning automatic upload off blocks Hook commits without disabling cloud-to-local context projection or Web Agent requests.

## Security boundary

- The connector accepts HTTPS origins or loopback HTTP only. URL credentials, queries, fragments, unsafe project IDs, unsupported sandbox modes, and control characters are rejected.
- GatherThread credentials remain in this process, are redacted from errors, and are removed from Codex child environments, MCP children, Hook commands, URLs, local binding markers, and logs.
- Codex runs with `workspace-write` or `read-only`, with automatic approval disabled. `danger-full-access` is unsupported.
- The package does not modify `~/.codex/config.toml`, install MCP configuration, elevate privileges, publish packages, or change project source-control state.

The packaged `mcp` subcommand defaults to the running connector's private IPC relay, so it works when Desktop was launched by Finder without terminal credentials. `GATHERTHREAD_MCP_TRANSPORT=server-env` is developer preview only. Future remote Streamable HTTP MCP requires a real OAuth 2.1/PKCE server and is not claimed here. MCP cannot replace the continuously running local runtime, Web request claiming, per-session projection, reliable outbox, or Codex App Server lifecycle. A future `--install-mcp` would require separate implementation, user authorization, and verification.

## Programmatic entry

The package exports the same connector functions used by the executable, including `runCodexConnectCli` and `parseCodexConnectArgs`. A future trusted plugin can call this entry without invoking a monorepo script. The executable itself is `gatherthread-codex-connect`.

Requires Node.js 24 or newer and an authenticated Codex installation. Licensed under Apache-2.0. The scoped npm organization and package-name ownership must be confirmed before publishing.

## 中文说明

这是面向本地已安装并登录的 Codex Desktop / CLI 的独立连接器。网页复制的固定版本 `npx` 命令不含凭据；设备 Token 在终端中隐藏输入。默认基础模式支持网页发起 Agent 请求、逐会话规范投影、只读快照，以及插件通过私有 IPC 调用普通用户 MCP 工具。`--visible-history-sync first-connect` 默认在每个会话首次于本地建立时导入一次可见原生历史；也可设为 `never` 关闭自动导入。每次从网页或 MCP 手动导入都会创建新任务，旧任务由用户自行归档，实时上下文注入不受影响。需要把 Codex Desktop 直接回合双向同步时，显式添加 `--plugin-hooks` 并在 Codex 中审查和信任插件 Hooks；`--install-hooks` 只作为项目 Hook 兼容路径。每个已绑定会话默认自动上传，也可由工作页或 MCP 单独关闭；Hook 漏传时可手动扫描并补传已完成回合，且手动操作不会改回自动设置。

此包不会修改 `~/.codex/config.toml`，也没有实现 `--install-mcp`。发布前必须确认 `@gatherthread` 组织与包名所有权。
