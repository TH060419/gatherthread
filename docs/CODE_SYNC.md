# Project code collaboration / 项目代码协作

Project code collaboration is included in the `0.1.0-alpha.8` Alpha. The invitation-only hosted service at `https://gatherthread.cn` may use it only after project and local-device opt-in; public registration and public Git transport remain closed. Use the matching Codex connector and DSH plugin if their packages are available, or build a reviewed source checkout.

项目代码协作已纳入 `0.1.0-alpha.8` Alpha。邀请制服务器 `https://gatherthread.cn` 仅在项目与本地设备分别授权后使用该功能；公众注册和公开 Git 传输仍未开放。若匹配的 Codex 连接器与 DSH 插件包可用，可直接安装；否则从经过审核的源码构建。

## Choose source storage / 选择代码存储

The GitHub integration described below is an **unreleased source preview**, not a claim about the hosted service or published packages. Use a reviewed source checkout containing the matching server, Web client, connector and DSH plugin. The existing GatherThread cloud checkpoint option remains available with its existing limits; nothing migrates or uploads automatically when you choose GitHub.

下述 GitHub 接入是**尚未发布的源码预览**，不代表线上服务或已发布安装包已经支持。测试时需使用同一份经过审核的源码构建服务端、网页、连接器和 DSH 插件。原有 GatherThread 云端检查点保留；选择 GitHub 不会自动迁移或上传已有代码。

| Option / 方式 | Suitable use / 适用场景 | Source destination / 代码去向 | Local snapshot handling / 本地快照处理 |
|---|---|---|---|
| GatherThread cloud / 共序云端 | Limited-quota storage for lightweight trials / 有限额存储，适合轻量体验 | GatherThread server / 共序服务器 | 1,000 files; 2 MiB/file; 8 MiB/tree |
| GitHub | Recommended first for real development, especially larger or long-term projects / 实际开发优先推荐，尤其适合较大或长期项目 | Local computer directly to GitHub / 本机直接传到 GitHub | No GT storage quota; preview handles 10,000 files, 20 MiB/file, 128 MiB/tree |
| Native Git / 原生 Git | Trees outside these preview limits, LFS or submodules / 超出预览限制、使用 LFS 或子模块 | Your selected Git remote / 自行选择的远端 | Governed by your tools and hosting provider / 由工具和托管服务决定 |

GitHub uploads do not count against GatherThread storage quotas. The preview numbers are local memory and file-handling safeguards, not a GitHub storage allowance; repositories beyond them can still use native Git with the same GitHub repository. The first fetch also caches the selected branches' Git history locally and can require more disk space and time than a single source snapshot. GitHub repository visibility and collaborator permissions are independent of GatherThread project membership. A private GatherThread project does not make a public GitHub repository private, and a GatherThread invitation does not grant GitHub access.

GitHub 上传不计入共序的存储额度。表中数字是本地预览同步器的内存与文件处理保护，并非 GitHub 存储额度；超出范围的仓库仍可使用原生 Git 操作同一仓库。首次获取还会在本机缓存所选分支的 Git 历史，占用空间和耗时可能大于单次源码快照。GitHub 仓库的可见性和协作者权限独立管理：共序中的私有项目不会把公开 GitHub 仓库变成私有仓库，共序邀请也不会自动授予 GitHub 权限。

## GitHub source preview / GitHub 源码预览

### Configure and authorize / 配置与授权

1. Prepare the intended GitHub repository and grant each collaborator the required GitHub access. Review its visibility, branch rules and Actions workflows. The integration never creates a repository, invites GitHub members, grants privileges or opens/merges a pull request for you.
2. As the GatherThread project owner, open **Project code → GitHub**, save `OWNER/REPO` and the shared base branch, then enable the connection. Enter only the repository slug, without a URL or `.git` suffix. Use a base such as `main`, outside the reserved `gatherthread/` namespace. Saving this metadata uploads no source and grants no local file access.
3. On each local device, install Git 2.38+ and GitHub CLI. Select that device in the Web code panel and click **Connect GitHub on this device** for a Codex runtime, or click **连接 GitHub · 打开浏览器** in DSH settings. The local GitHub CLI opens browser sign-in when needed; complete authorization in that browser. GitHub CLI normally uses the local credential store, but [may fall back to a plain-text file when no credential store is available](https://cli.github.com/manual/gh_auth_login); inspect `gh auth status` on your device if this matters to you. If browser launching is unavailable, use the local CLI fallback:

   ```sh
   gh auth login --hostname github.com --git-protocol https --web
   gh auth status --hostname github.com
   ```

4. Review eligible source files and separately authorize that exact repository/base configuration in Codex or DSH. A new local GitHub binding automatically uploads settled changes while the Agent is idle; the device switch can turn this off at any time. Existing explicit off choices survive reconnects. Repository/base changes and configuration revisions require renewed local authorization; an owner cannot silently redirect an already-authorized device to another repository.

先在 GitHub 准备仓库，并独立授予协作者权限。项目创建者在共序“项目代码 → GitHub”填写 `OWNER/REPO` 和主分支；每位成员在自己的设备上安装 Git 与 GitHub CLI。Codex 可在网页选择自己的在线设备并点击“在此设备连接 GitHub”，DSH 可在插件设置点击“连接 GitHub · 打开浏览器”。本地 CLI 会在需要登录时打开浏览器，用户在 GitHub 完成确认；也可使用上方终端命令。检查上传范围并在 Codex 或 DSH 单独授权后，新设备默认会在 Agent 空闲时自动上传稳定的文件改动，可随时关闭，关闭状态在重连后保留。仓库、主分支或配置版本变化后需重新确认本地授权，包括暂停后重新开启；网页保存配置不能替代设备授权。

### Codex source commands / Codex 源码命令

In the source preview, add explicit GitHub authorization to the existing connection command. This is separate from cloud `--code-sync` and requires reviewed Hooks for normal connected operation:

```sh
npm run codex:connect -- --url http://127.0.0.1:18787 --project PROJECT_ID --workspace '/absolute/path/to/project' --plugin-hooks --github-code-sync OWNER/REPO --github-base-branch main
```

Use your actual server and project. The GatherThread device token stays in its hidden prompt; do not put GitHub credentials in that prompt, a GatherThread form or a command URL. The local transport uses HTTPS Git with the local `gh` credential helper. It does not use your workspace's Git remotes or change its branch/index.

For explicit one-shot recovery with no Agent startup, the source CLI adds `--recover-github-code`; this recovery path does not require Hooks:

```sh
npm run codex:connect -- --url http://127.0.0.1:18787 --project PROJECT_ID --workspace '/absolute/path/to/previous/project' --github-code-sync OWNER/REPO --github-base-branch main --recover-github-code
```

Recovery creates a new directory for uploaded eligible files. It does not restore excluded secrets/dependencies, unuploaded changes or native conversation state. Inspect the returned path and recovered files before opening or running them. These flags belong to the unreleased source integration; do not assume an older npm package accepts them.

这些参数仅适用于未发布源码中的新连接器。正常连接需审阅并信任 Hooks；一次性恢复不启动 Agent，也不需要 Hooks。GitHub 凭据由本机 `gh` 管理，不能粘贴到共序设备 token 提示或网页中。恢复会创建新目录，不会改绑旧会话，也无法恢复未上传修改、被排除的文件或原生对话。

### DSH and daily use / DSH 与日常使用

The matching native plugin adds **Settings → GatherThread / 共序 → 项目代码 · GitHub（推荐）**. Check the displayed repository/base branch and authorize that project locally. Its GitHub controls provide status, upload, download, recovery, update from the shared base and a separate idle automatic-upload switch. The Web page can request those operations only through the exact selected same-user Codex/DSH execution runtime; it cannot grant DSH consent.

Each GatherThread user has a stable branch `gatherthread/<project hash>/<user hash>`, shared across their devices. Upload pushes only that personal branch with ordinary fast-forward checks. It never force-pushes, writes the shared base/default branch, or changes the original workspace Git branch/index. Review and merge the personal branch through your normal GitHub pull-request process. **Update from base** merges the configured shared base into your personal branch, then **Download** applies the result only when local files match the acknowledged baseline. Conflicts or stale heads stop for manual resolution. Use **Recover** for a separate comparison copy when both sides changed.

DSH 原生设置中新增独立的 GitHub 区域。核对仓库和主分支后逐项目授权，再选择状态、上传、下载、恢复、从主分支更新或空闲自动上传。每位用户跨设备共用稳定的个人分支；上传只推进本人分支，不强推、不直接改共享主分支。审核合并使用 GitHub 常规 PR 流程。共享主分支有更新时先更新个人分支，再下载；本地有未上传修改或发生冲突时会停止，需自行处理。

### Privacy, pause and limits / 隐私、暂停与限制

GitHub source bytes and GitHub credentials travel directly between the local computer and GitHub. GatherThread stores repository/base/enablement/revision metadata and bounded private job/status metadata, not the GitHub source or credential. Existing GatherThread cloud code uploads remain a separate destination and still store source on that server when explicitly used. Conversation sharing also remains a separate feature.

Turning off GitHub synchronization, removing a GatherThread member or deleting the GatherThread project does not revoke that person's GitHub permissions or delete any GitHub branch, repository, clone or backup. Manage those in GitHub separately. Stop active transfers before changing configuration; a push already sent cannot be recalled by pausing GatherThread. GitHub pushes may trigger [repository Actions workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push), including from automatic uploads. Review workflow triggers and secrets before enabling automation.

The preview refuses symlinks, submodules, Git LFS pointers, non-portable/private paths and tracked generated/dependency trees instead of silently dropping them from a remote snapshot. Secret checks cover recognizable patterns, not all possible sensitive content. Review files before sharing, and use native Git for unsupported repositories. Synchronization operations share a local workspace lock, but this does not lock native Agent tools or editors: use separate working copies for simultaneous writers.

GitHub 源码和 GitHub 凭据由本机直接传给 GitHub，共序只保存连接与任务状态元数据。若另外使用共序云端代码上传，代码仍会按该功能存储在共序服务器。暂停、移除共序成员或删除共序项目，不会撤销 GitHub 权限，也不会删除 GitHub 分支、仓库、克隆或备份；需在 GitHub 单独处理。已发出的推送不能由暂停操作撤回。自动上传同样可能触发仓库 Actions，请先检查触发规则与机密使用范围。

本预览拒绝符号链接、子模块、LFS 指针、不安全路径和远端已跟踪的生成产物或依赖树；超限或不支持的仓库请使用原生 Git。已知密钥扫描不能证明文件完全不含敏感内容。不同 Agent 同时写入时仍需使用独立工作目录。实现与验证边界见 [ADR-0035](adr/0035-direct-local-github-code-synchronization.md)。

## GatherThread cloud: what is synchronized

Each project can have one server-managed Git repository. Each member uploads to their own branch, independent of their selected Agent or device. The project owner reviews changes and merges them into shared `main`. Project viewers can inspect code but cannot upload or merge. All project readers can read every code branch: a personal branch is not private, and code visibility is **not** narrowed by a Solo conversation.

Only eligible source files are synchronized. A checkpoint preserves file contents, relative paths and executable flags, not a running process, installed dependencies, model credentials, local chat transcripts, Git index or the original repository's historical commits. The server really stores Git objects and commits, but this first version transports bounded checkpoints through the authenticated GatherThread API; it is not a GitHub/Gitea replacement or a `git push` endpoint.

The code feature never changes conversation upload preferences, Codex visible-history imports, Agent model selection or realtime context injection. Code upload defaults off, requires separate local authorization, and never grants approval for local Agent tools.

Cloud Git is used only to synchronize project code among that project's collaborators. Uploaded source is not used for GatherThread product development or other unrelated purposes. Turning cloud code sync off leaves conversation collaboration available, but limits cloud code collaboration. Review eligible files before authorizing upload; every project reader can see the synced branches.

每个项目一个云端 Git 仓库，每位成员一个分支，分支不跟随 Codex/DSH 或设备变化。项目创建者审核差异后合入 `main`，其他成员再更新自己的分支并下载。所有项目成员均可读取代码；个人分支和 Solo 会话都**不是代码隐私隔离**。

## Start with a disposable project

1. Install Git on the server and local computers (`git --version`). Server merges require Git 2.38 or newer. Node.js 24 remains required.
2. Start GatherThread normally. As project owner, open the top-bar **Project code** icon and enable code collaboration. This creates an empty repository and uploads nothing from your computer. The owner can later pause cloud code sync from the same dialog, even before configuring a local Agent; re-enabling restores the existing cloud branches rather than starting over.
3. Authorize a specific local workspace, using one of the two paths below. Test with a small project containing no secrets.
4. Use **Check status** before **Upload code**. A checkpoint includes eligible files across the bound project, not only the open conversation or the last Agent's edits. Review the source directory and exclusions yourself before the first upload.

### Codex

Keep the existing trusted plugin Hooks. Add `--code-sync` to the connection command:

```sh
npm run codex:connect -- --url http://127.0.0.1:18787 --project PROJECT_ID --create-workspace --plugin-hooks --code-sync
```

Use your actual server URL, project ID and configured port. The token remains in the hidden terminal prompt. `--code-sync` authorizes only this bound project's source directory; it does not enable automatic upload. The connector requires reviewed Hooks so it can observe Desktop work before code operations. In the Web code dialog, select this exact Codex runtime before upload/download actions.

Without `--code-sync`, existing Codex workflows are unchanged and remote code jobs fail with an actionable local-authorization error. Use `0.1.0-alpha.7` or newer; earlier published connectors do not recognize this flag.

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
| Pause / 暂停云端同步 | Stop new cloud code transfers while retaining cloud Git history | Owner-only; conversation collaboration remains available, and local files are never deleted |
| Clear my cloud branch / 清理本人云端分支 | Remove only the current member's cloud branch from active access | Available to its owner, including a project owner; does not change shared `main` or anyone's local Git |
| Clear project cloud Git / 清理项目云端 Git | Remove the project's cloud code from active access | Project-owner only; affects all members' cloud branches and `main`, never local Git |

Pausing is a server-side transfer gate, not a purge or an instruction to a local Agent to forget its existing preferences. Status and the control for disabling local automatic code upload remain available while paused; upload, download, recovery, review, merge and update cannot proceed until the owner resumes. A transfer already running on a device may have local side effects before its completion is refused, so stop active Agent/code work first and check local state afterward. If automatic source upload was enabled locally, turn it off before resuming unless you intend to use it again.

After another member's work merges, first update your branch from main, then download. A stale device must not force an upload. If both local and cloud have changed, preserve the local files, recover the cloud version into a second directory, then compare/resolve locally there. The recovered copy has a separate baseline for the restored commit and automatic upload off. Explicitly connect/open that directory before uploading the combined result; the original Agent stays bound to its old directory. Automatic conflict resolution and force-push are intentionally absent.

下载只在本地与上次确认的版本一致时进行。遇到本地未上传修改、文件覆盖风险或云端版本前进，会明确停止。恢复始终放到旁边的新目录；请自行检查后在 Agent 中打开它，不会自动切换旧会话的工作目录。

## Storage quota and cloud cleanup / 存储配额与云端清理

Cloud code has a **128 MiB per-user logical active-snapshot quota**, counting that user's own branch and, for a project owner, the shared `main` they own. The existing **256 MiB per-project** and **1 GiB per-deployment** charged caps remain. A rejected checkpoint does not partially advance a branch. These are logical charges, not a promise about immediate filesystem byte reclamation.

In Settings, a member can see projects with cloud Git data and select **Clear my cloud branch** for their own branch; an owner may choose either their own branch or **Clear project cloud Git**. A participant cannot clear `main` or another member's branch. Clearing a personal branch does not undo content already merged into `main`. Project-wide cleanup makes all that project's cloud Git data inaccessible through GatherThread. Confirm the selected project and scope before proceeding; local Git history, branch, index, files, and Agent conversations are untouched. Clearing cloud code can limit or stop future cloud code collaboration until the project is re-enabled and a new baseline is established.

Cloud cleanup immediately revokes API access and releases the active logical quota. It **does not immediately erase physical Git objects or prior backups**. The updated ECS profile schedules retention maintenance for deleted/unreachable objects and backup copies, with a 14-day maximum only after all on-host and off-host jobs are deployed, monitored, and verified. The ECS online backup includes a companion `.db.code` directory for reachable Git objects; keep, verify, restore and rotate it together with the SQLite backup (see [OPERATIONS.md](OPERATIONS.md)). Do not describe a cleanup result as secure erasure of every old copy.

云端代码按**每用户 128 MiB 有效快照逻辑用量**计费，包括本人分支；项目创建者还承担其项目共享 `main` 的用量。既有**每项目 256 MiB**、**整个部署 1 GiB** 配额仍适用。超限上传不会只写入一半。这些是逻辑计费上限，不代表磁盘空间立刻回收。

设置中会列出有云端 Git 数据的项目。成员可选择清理自己的云端分支，项目创建者既可只清理自己的分支，也可清理整个项目的云端 Git；参与者不能清理共享 `main` 或其他成员分支。清理个人分支不会撤销已合入 `main` 的内容；清理整个项目会让所有成员无法继续读取该项目的云端代码。操作前应核对项目与范围。本地 Git 历史、分支、暂存区、文件和 Agent 对话均不受影响；之后若要恢复云端代码协作，需重新启用并建立基线。

清理会立即撤销云端 API 访问并释放有效逻辑配额，**不会立刻抹除物理 Git 对象或此前的备份**。新版 ECS 配置会定时清理删除后不可达的对象和备份；只有本机与异地副本清理均已部署、监控和验证，才可承诺最多 14 天。ECS 在线备份会生成包含可达 Git 对象的配套 `.db.code` 目录，必须与 SQLite 备份一同保留、校验、恢复和轮换（见 [OPERATIONS.md](OPERATIONS.md)）。不能把页面上的“清理成功”理解为所有旧副本已经安全擦除。

## Lost local files

When the connector is online, choose **Recover to a new folder** in Web or DSH. When the original directory is missing or Codex is unavailable, the source connector also supports a one-shot recovery before Codex startup:

```sh
npm run codex:connect -- --url http://127.0.0.1:18787 --project PROJECT_ID --workspace '/absolute/path/to/previous/project' --recover-code
```

It prints the new local recovery directory and exits without starting an Agent. This recovers the latest uploaded eligible source files, not edits that never reached the server, excluded files, dependencies or credentials. Check the recovered code before running install/build commands; collaborators' source is untrusted until reviewed.

## GatherThread cloud limits and operational requirements

- A checkpoint: at most 1,000 regular files, 2 MiB per file and 8 MiB total decoded content. No submodules, symlinks or arbitrary local paths from Web commands.
- Common generated/dependency directories, `.git`, private GatherThread/Codex/DSH state, `.env` secrets and credential-file patterns are excluded or refused. `.env.example` may be shared if it contains only placeholders. Recognizable secret scanning is a safety net, not proof that a file contains no secrets.
- Names must be portable across supported filesystems: malformed Unicode, Windows device names, NTFS short-name aliases and paths aliasing private state on HFS are refused. Known credentials are checked before sending file content and again before server persistence. Chinese and normal emoji file names remain supported.
- A project has at most 128 member branches and 4,096 active idempotent code-mutation receipts; invalidated receipts fail closed for up to 30 days before pruning. Per-user, project, deployment and physical-disk limits also apply. These preview limits are deliberately bounded, not a large-repository backup service.
- Disk checks are bounded and cached; exceeding their safety budget pauses code writes until operator maintenance/restart. Large concurrent rewrites may need local resolution instead of server merge. This preview is for small private projects, not high-throughput Git hosting.
- Local code metadata and download recovery journals stay in the user's private state outside the source tree. Source sync never resets, commits or switches the original Git repository.
- A temporary local lock or lost completion acknowledgement is retryable. Corrupt/unknown bindings are preserved and block code operations, not conversation synchronization; inspect the connector error before retrying, and do not delete binding files to force an upload. Auto-upload rechecks the exact stable inventory before sending it.
- Server storage is `<absolute database path>.code` plus additive SQLite metadata. Back up both together; see [OPERATIONS.md](OPERATIONS.md). Git is required only when the feature is used; deployments that never enable code collaboration retain their existing workflow.
- Cloud project deletion revokes API access and removes code metadata; retained Git objects remain in operator-controlled storage pending explicit retention/backup cleanup. No cloud deletion deletes a member's local files.
- No external Git hosting credentials, Git smart HTTP, task-specific worktrees, historical-version picker, LFS or automatic conflict resolution in this version. Main and member history remain ordinary Git commits in server storage.

## GitHub preview manual acceptance checklist

These are required manual checks, not a statement that live GitHub or supported desktop platforms have already passed.

1. In a disposable GitHub repository, verify separate owner configuration, local account login and local consent. Change repository/base or pause/resume; confirm renewed consent is required and chat remains usable.
2. Upload from two users and inspect the exact personal refs on GitHub. Confirm the shared base/default branch and each original workspace's index/branch are unchanged. Run two devices of one user from the same baseline and confirm the stale upload refuses.
3. Review/merge using GitHub, update the personal branch from base and download only onto a clean acknowledged tree. Verify conflicting/dirty trees stop. Recover separately and compare file bytes without deleting the original workspace.
4. Confirm that a newly authorized GitHub binding defaults to auto-upload on, waits for idle/stable files and stops after disabling; reconnect and verify the off preference remains off. Review any GitHub Actions run triggered by the disposable test push. Exercise native DSH and exact-runtime Web controls independently.
5. Verify unsupported tracked trees and preview limits stop without dropping remote content. Remove GatherThread access and confirm its controls stop while GitHub permissions remain separately administered. Repeat relevant paths on each supported platform/browser before claiming compatibility.

## GatherThread cloud manual acceptance checklist

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
11. **Pause and resume:** before completing local configuration, pause and confirm no upload/download/review can start. Resume and verify the same main commit and member branch heads return. If local automatic source upload was previously enabled, turn it off explicitly before resuming when no further sharing is wanted.
