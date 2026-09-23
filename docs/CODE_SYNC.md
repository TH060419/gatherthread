# Project code collaboration / 项目代码协作

This is an **unreleased source-preview feature**, not part of the already published `0.1.0-alpha.6` npm artifacts. Build this checkout and use the source connector / locally packed DSH plugin when testing. No official hosted service is opened by this feature.

这是**尚未发布的源码预览功能**。已发布的 `0.1.0-alpha.6` npm 包不包含本次修改，测试时使用当前源码连接器或本地打包的 DSH 插件。

## What is synchronized

Each project can have one server-managed Git repository. Each member uploads to their own branch, independent of their selected Agent or device. The project owner reviews changes and merges them into shared `main`. Project viewers can inspect code but cannot upload or merge. All project readers can read every code branch: a personal branch is not private, and code visibility is **not** narrowed by a Solo conversation.

Only eligible source files are synchronized. A checkpoint preserves file contents, relative paths and executable flags, not a running process, installed dependencies, model credentials, local chat transcripts, Git index or the original repository's historical commits. The server really stores Git objects and commits, but this first version transports bounded checkpoints through the authenticated GatherThread API; it is not a GitHub/Gitea replacement or a `git push` endpoint.

The code feature never changes conversation upload preferences, Codex visible-history imports, Agent model selection or realtime context injection. Code upload defaults off, requires separate local authorization, and never grants approval for local Agent tools.

每个项目一个云端 Git 仓库，每位成员一个分支，分支不跟随 Codex/DSH 或设备变化。项目创建者审核差异后合入 `main`，其他成员再更新自己的分支并下载。所有项目成员均可读取代码；个人分支和 Solo 会话都**不是代码隐私隔离**。

## Start with a disposable project

1. Install Git on the server and local computers (`git --version`). Server merges require Git 2.38 or newer. Node.js 24 remains required.
2. Start GatherThread normally. As project owner, open the top-bar **Project code** icon and enable code collaboration. This creates an empty repository and uploads nothing from your computer.
3. Authorize a specific local workspace, using one of the two paths below. Test with a small project containing no secrets.
4. Use **Check status** before **Upload code**. A checkpoint includes eligible files across the bound project, not only the open conversation or the last Agent's edits. Review the source directory and exclusions yourself before the first upload.

### Codex (current source)

Keep the existing trusted plugin Hooks. Add `--code-sync` to the source connection command:

```sh
npm run codex:connect -- --url http://127.0.0.1:18787 --project PROJECT_ID --create-workspace --plugin-hooks --code-sync
```

Use your actual server URL, project ID and configured port. The token remains in the hidden terminal prompt. `--code-sync` authorizes only this bound project's source directory; it does not enable automatic upload. The connector requires reviewed Hooks so it can observe Desktop work before code operations. In the Web code dialog, select this exact Codex runtime before upload/download actions.

Without `--code-sync`, existing Codex workflows are unchanged and remote code jobs fail with an actionable local-authorization error. Do not add this flag to old published connectors which do not recognize it.

### DeepSeek Harness

Build/install the local plugin as described in [DSH_CONNECT.md](DSH_CONNECT.md), pair normally, then open **Settings → GatherThread / 共序 → 项目代码 · Git**.

Expand a project and explicitly enable **允许此 DSH 同步该项目代码**. The native panel provides status, upload, download, recovery and **空闲时自动上传本地代码至云端**. Automatic upload is initially off. The Web code dialog can control the same project after selecting this DSH runtime; a Web request cannot grant the plugin's local file-access consent.

Both adapters use the already-bound project directory. Switching between Codex and DSH on the same machine can share the same checkpoint baseline when they use the same canonical directory and authenticated user/project/server. Another directory or device is a separate checkout and must first download or verify the current cloud content. Never run two Agents writing the same directory at once; this preview does not introduce task worktrees or a cross-harness tool lock.

An explicitly customized `DSH_HOME` isolates its private code metadata as well. Such a profile is treated as a separate local checkout even for the same source directory; use **Download updates** on matching files to acknowledge the cloud baseline before changing harnesses. Normal default profiles use the shared local metadata location.

## Daily workflow

| Action | Result | Safety boundary |
|---|---|---|
| Upload code / 上传代码 | Save a Git checkpoint on your member branch | Requires local authorization, no active known Agent run and the expected cloud base |
| Automatic upload / 自动上传 | Upload changed eligible files after idle/stability checks | Separate opt-in; no automatic merge into main or automatic download; large deletions stop for review |
| Submit for review / 提交审核 | Mark the current branch head for owner review | A later upload invalidates that review |
| Review and merge / 审核合并 | Show file changes, then owner merges into main | Expected branch/main heads must still match; conflicts stop without moving either head |
| Update from main / 更新主分支 | Merge main into your cloud branch | Three-way merge; conflicts require deliberate local resolution |
| Download updates / 下载更新 | Apply your cloud branch (or main before you have a branch) locally | Local files must match the acknowledged baseline; ignored-file collisions also refuse |
| Recover / 恢复到新目录 | Write the latest uploaded branch into a new sibling directory | Does not delete/rebind the original workspace or its native conversations |

After another member's work merges, first update your branch from main, then download. A stale device must not force an upload. If both local and cloud have changed, preserve the local files, recover the cloud version into a second directory, then compare/resolve locally there. The recovered copy has a separate baseline for the restored commit and automatic upload off. Explicitly connect/open that directory before uploading the combined result; the original Agent stays bound to its old directory. Automatic conflict resolution and force-push are intentionally absent.

下载只在本地与上次确认的版本一致时进行。遇到本地未上传修改、文件覆盖风险或云端版本前进，会明确停止。恢复始终放到旁边的新目录；请自行检查后在 Agent 中打开它，不会自动切换旧会话的工作目录。

## Lost local files

When the connector is online, choose **Recover to a new folder** in Web or DSH. When the original directory is missing or Codex is unavailable, the source connector also supports a one-shot recovery before Codex startup:

```sh
npm run codex:connect -- --url http://127.0.0.1:18787 --project PROJECT_ID --workspace '/absolute/path/to/previous/project' --recover-code
```

It prints the new local recovery directory and exits without starting an Agent. This recovers the latest uploaded eligible source files, not edits that never reached the server, excluded files, dependencies or credentials. Check the recovered code before running install/build commands; collaborators' source is untrusted until reviewed.

## Limits and operational requirements

- A checkpoint: at most 1,000 regular files, 2 MiB per file and 8 MiB total decoded content. No submodules, symlinks or arbitrary local paths from Web commands.
- Common generated/dependency directories, `.git`, private GatherThread/Codex/DSH state, `.env` secrets and credential-file patterns are excluded or refused. `.env.example` may be shared if it contains only placeholders. Recognizable secret scanning is a safety net, not proof that a file contains no secrets.
- Names must be portable across supported filesystems: malformed Unicode, Windows device names, NTFS short-name aliases and paths aliasing private state on HFS are refused. Known credentials are checked before sending file content and again before server persistence. Chinese and normal emoji file names remain supported.
- A project has at most 128 member branches and 4,096 idempotent code mutations; conservative storage charges and disk quotas also apply. These preview limits are deliberately bounded, not a large-repository backup service.
- Disk checks are bounded and cached; exceeding their safety budget pauses code writes until operator maintenance/restart. Large concurrent rewrites may need local resolution instead of server merge. This preview is for small private projects, not high-throughput Git hosting.
- Local code metadata and download recovery journals stay in the user's private state outside the source tree. Source sync never resets, commits or switches the original Git repository.
- A temporary local lock or lost completion acknowledgement is retryable. Corrupt/unknown bindings are preserved and block code operations, not conversation synchronization; inspect the connector error before retrying, and do not delete binding files to force an upload. Auto-upload rechecks the exact stable inventory before sending it.
- Server storage is `<absolute database path>.code` plus additive SQLite metadata. Back up both together; see [OPERATIONS.md](OPERATIONS.md). Git is required only when the feature is used; deployments that never enable code collaboration retain their existing workflow.
- Cloud project deletion revokes API access and removes code metadata; retained Git objects remain in operator-controlled storage pending explicit retention/backup cleanup. No cloud deletion deletes a member's local files.
- No external Git hosting credentials, Git smart HTTP, task-specific worktrees, historical-version picker, LFS or automatic conflict resolution in this version. Main and member history remain ordinary Git commits in server storage.

## Manual acceptance checklist

1. **Opt-in:** create a project and session; confirm code upload remains disabled until owner enablement and local authorization. Existing chat/Agent actions must still work without either.
2. **First checkpoint:** create two harmless source files, upload once, refresh status and inspect changes. Repeat unchanged upload; no duplicate content commit should appear.
3. **Two members:** invite a participant on another local directory/device. Download main, change separate files, upload to separate branches, submit review, inspect and merge as owner. Viewer attempts to upload/merge must fail.
4. **Main update:** after merge, update the participant branch from main and download. Verify both sets of files, not just a green status.
5. **Conflict:** two devices of the same member start from one checkpoint, edit and upload sequentially. The second stale upload must refuse and preserve local files. Two members editing the same lines must produce a merge conflict, leaving main unchanged.
6. **Dirty download:** edit a local file without uploading; remote changes must not overwrite it. Check ignored-file collisions and missing files as well.
7. **Recovery:** recover into a sibling directory and compare bytes/executable flags with cloud content. Repeat with the original directory absent, using `--recover-code`. Do not delete real work for this test.
8. **Automation:** enable code auto-upload, finish a small Agent change, wait for idle/stable checks and verify the uploaded source. Disable it and confirm further edits stay local until manual upload. A large removal should stop automation rather than publish an empty tree.
9. **Harness switch:** point both adapters to the same bound project, stop work in one before using the other. Verify source baseline and cloud branch stay the same while model selection, chat upload and context injection remain independent.
10. **DSH/Web:** test controls in both DSH settings and GatherThread, including reconnect, local authorization revoke, project removal and wrong runtime/device targets. Check Safari, Chrome and Edge layout/focus.
