# Cloud GitHub development preview

This is an unreleased, disabled-by-default source preview. It extends Cloud Agent with a GitHub + npm Node.js/TypeScript workflow. It does not certify the public deployment or claim Codex-equivalent model quality.

Current Web entry: open **Cloud Git**, then choose **GitHub**, beside **GT Cloud**. Local device GitHub sync and GitHub App account authorization/repository binding remain available in this panel. Saved task review and explicit draft PR publication remain available. New/continued cloud Agent tasks are disabled for a later release. There is no separate Cloud GitHub dialog or connection button in the composer or Agent settings.

中文：当前在“云端 Git”内选择与“GT Cloud”并列的“GitHub”。设备端同步、GitHub 账号授权、仓库绑定和已有任务查看保持可用；新建及继续云端 Agent 任务暂不开放。输入区和 Agent 设置不再另设 GitHub 连接入口。

## User flow after Cloud Agent opens / 使用流程

1. Open **Cloud Git → GitHub** to connect your repository. Once Cloud Agent opens, select **Cloud Agent** in the work page. Choose a DeepSeek or HTTPS Chat Completions-compatible coding profile supplied by the operator. The small Cloudflare trial profile does not support repository tasks.
2. Use the existing **Cloud Git → GitHub** panel. Install the operator's GitHub App on only the intended repositories, then **Connect your GitHub account**. Organization approval or an active SAML session may be required.
3. Enter an existing `OWNER/REPO` and base branch, then select **Use this repository in cloud tasks**. Each member authorizes their own account and chooses their own repository binding; GT membership does not grant GitHub permissions. Both the App and that GitHub user need access and write permission.
4. In the composer, choose **Cloud workspace → GitHub repository**, describe a change, and select **Request my agent**. This explicitly sends eligible repository source and shared conversation context to the selected model. The Agent answer is published to this GT conversation, whose existing membership rules apply. Task source and detailed diffs remain private to the requester. Human chat does not start a task.
5. The server reads a pinned base commit's source snapshot, installs exact locked public npm dependencies in the isolated container, and lets OpenCode inspect, edit, run commands and test. The browser receives a task ID immediately; closing the page does not stop the server task.
6. Reopen **Cloud Git → GitHub**, refresh/select your task, and inspect the answer plus each file's before/after content and executable-mode changes. The preview truncates long displayed content. **Continue task** starts a new, separately charged run from saved source; **New repository task** reads the current base branch. Dependencies are installed again; shell processes, installed tools, OpenCode private state and dependency caches are not persisted across runs.
7. After reviewing the exact revision, fill in the PR title/description and select **Create draft pull request**. The server creates a task-specific branch and draft PR. It does not merge or update the base branch. A changed base or task branch is refused; start a new task from the latest base. If a response is lost, retrying reconciles the existing branch/PR rather than force-pushing or making a duplicate.
8. **Delete saved cloud task** removes that private GT task snapshot. It does not delete GitHub branches/PRs. **Disconnect cloud GitHub** removes GT's stored account credentials and bindings; revoke the App authorization in GitHub for GitHub-side revocation. Disconnecting GT aborts its active repository tasks; model/registry requests recheck access, and an authorization watcher stops tasks when their GT device or membership changes.

中文：在工作页选择“云端 Agent”，选择管理员提供的 DeepSeek 或兼容编码模型。打开“云端 Git → GitHub”，为指定仓库安装 GitHub App 并授权自己的账号，填写仓库和基准分支。输入区选择“GitHub 仓库”后明确请求 Agent，代码与共享会话内容会发送给所选模型。可以关闭页面后回来查看任务、逐文件比较改动，或继续保存的源码。检查后点击“创建草稿 PR”，由 GitHub 正常审核流程决定是否合并。删除 GT 任务不会删除 GitHub 工作；断开 GT 连接后，也可在 GitHub 撤销 App 授权。

## Supported environment

- npm projects with root `package.json` and lockfile version 2 or 3. npm workspace links are supported by npm's own `ci` validation; external dependencies must be exact integrity-pinned `https://registry.npmjs.org/...tgz` URLs. Git dependencies, other/private registries, pnpm/Yarn locks are unsupported and project `.npmrc` is excluded.
- `npm ci --ignore-scripts --no-audit --no-fund` runs before the Agent. Build/test scripts run when explicitly invoked by the Agent's terminal tools. Projects requiring install-time native builds need a separately reviewed environment strategy.
- Source limits: 1000 eligible files, 2 MiB per file, 8 MiB total; non-truncated Git trees with at most 5000 entries. Git blob acquisition uses eight requests at a time and a bounded acquisition window. Symlinks/submodules in eligible source are refused. Private paths, recognizable secrets, generated dependency/build directories and GitHub Actions workflows are excluded or refused. Excluded existing files remain unchanged in the PR's base tree.
- Each container: Node.js 24, Git, OpenCode 1.18.32, 2 GiB RAM, two CPUs, 256 PIDs, 15 minutes, no general network or writable host directory. A local Git repository contains the starting source snapshot, not the complete remote history.
- Model proxy: exact selected provider/model, at most 64 calls, 128000 bytes per request, 2048 output tokens per call. Existing shared per-user/account/global run quotas and host concurrency gates reserve once in the same transaction as the canonical request and private task. These are bounded-run allowances, not invoice-accurate billing; provider-side spend caps remain required.
- Dependency proxy: only tarballs present in the initial validated lockfile, no metadata queries, redirects, credentials or arbitrary URLs. npm verifies the lockfile integrity. Downloads are capped at 32 MiB per tarball and 256 MiB per run. New remote dependencies cannot be added within a running environment; start a new setup from a reviewed updated lockfile.
- Private task source is encrypted in SQLite, bound to task identity, and retained for seven days. At most ten saved tasks per user and 64 for the single server process. Delete old tasks when capacity is reached. Listing tasks returns metadata; source is retrieved only for a selected task.
- Request content uses the same server redaction before canonical/private persistence and execution; the container prompt receives another redaction pass. Recognizable accidentally pasted credentials are removed from task input and model-bound request text. Ordinary instructions and authorized quote references are preserved. A private identity-bound HMAC receipt checks the original request for exact retries, including changes that redact to identical text; no original request is saved for retry comparison. Continuation is a separately charged explicit request. This pattern-based redaction does not identify every possible secret; review requests and source before sending.
- Graceful shutdown stops active repository containers; startup cleans up named containers from interrupted tasks. A restart marks active tasks interrupted and settles their canonical request as failed. It never automatically replays a paid operation or resumes code execution. Saved completed/source snapshots can be used for an explicit new run. A failed run may retain only its starting snapshot. The conversation retry button opens the original repository task for review; it never converts that request into an empty trial or a local Agent run.

## Operator setup

Implementation checks passed locally: `release:verify`, an actual npm installation through the production dependency proxy, and Chrome/WebKit English/Chinese browser flows. GitHub, model and container results in the browser/server tests are fixtures. Account/session changes discard old private previews and late responses. The real Linux repository container smoke and real App/provider workflow below remain activation gates; passing local tests does not establish a live cloud service.

1. Register a GitHub App in GitHub's developer settings. Enable expiring user access tokens. Set the user-authorization callback to `https://YOUR_GT_ORIGIN/v1/hosted-github/callback`. Request repository **Contents: read/write**, **Pull requests: read/write**, and the required metadata read permission. Do not grant workflow or administration permission. No GitHub App private key is used by this implementation: actions use the intersection of the App's permissions and the authorizing user's permissions through expiring user access tokens. Webhook delivery is not implemented; disable an unused webhook endpoint.
2. Set these private server environment variables, keeping literal credentials out of source, screenshots and PRs:

   ```text
   GATHERTHREAD_HOSTED_GITHUB_ENABLED=true
   GATHERTHREAD_HOSTED_GITHUB_CLIENT_ID=<GitHub App client ID>
   GATHERTHREAD_HOSTED_GITHUB_CLIENT_SECRET=<private App client secret>
   GATHERTHREAD_HOSTED_GITHUB_APP_SLUG=<App URL slug>
   GATHERTHREAD_HOSTED_GITHUB_ENCRYPTION_KEY=<base64-encoded random 32-byte key>
   ```

   The normal [Cloud Agent setup](HOSTED_AGENT.md) must also be enabled with a compatible model profile and a newly built digest-pinned image. Production requires HTTPS. OAuth uses a ten-minute single-use state bound to the GT user/device plus PKCE. The external callback redirects to a same-origin page fragment; that page removes the fragment and completes via an authenticated Origin-checked POST, preserving existing Strict cookies.
3. Preserve the encryption key separately from database backups, with access limited to the service operator. Changing or losing it makes stored credentials and snapshots unreadable and prevents original-request fingerprint verification; the preview has no automatic key rotation. The additive `hosted_github_*` tables preserve existing local GitHub and GT Cloud data. Turning the flag off keeps encrypted records; account/project/session deletion cascades through the new tables. The separate current-day budget ledger follows [Cloud Agent upgrade compatibility](HOSTED_AGENT.md#upgrade-compatibility).
4. Budget at least 2 GiB and two CPUs per simultaneous repository container, plus the collaboration server and Docker overhead. The existing concurrency maximum controls both trial and repository runs; it is not a distributed worker queue.
5. Before activation run both real Linux container checks:

   ```sh
   docker build -f ops/hosted-agent/Dockerfile -t gt-hosted-reviewed .
   GATHERTHREAD_TEST_HOSTED_IMAGE=gt-hosted-reviewed node scripts/test-hosted-container.mjs
   GATHERTHREAD_TEST_HOSTED_IMAGE=gt-hosted-reviewed node scripts/test-hosted-repository-container.mjs
   ```

   The repository smoke uses a fixture tarball and fake model, but executes actual OpenCode bash tools, npm installation and project test/build scripts. It does not call a paid model or publish a GitHub PR. Then validate the real App authorization and selected provider on an operator-owned test repository: pinned source → dependency preparation → observed edit/test/build → diff review → one draft PR → retry → disconnect. This live gate requires actual operator credentials and must precede public activation.

Official protocol references: [GitHub App user access tokens and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [Git trees](https://docs.github.com/en/rest/git/trees), [pull requests](https://docs.github.com/en/rest/pulls/pulls), [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/).

## Task input migration

Stop the old process before upgrading. Cloud GitHub startup adds `input_fingerprint` when absent and scrubs retained task `input_json` inside one SQLite transaction before any task can be used. For earlier tasks it computes the keyed receipt from the original serialized input before redaction, so the original exact retry remains valid while a changed request still conflicts. Repeated startup preserves this receipt. Invalid stored inputs fail startup with a generic error and roll back the migration; they are never passed to a container or model. Interrupted tasks remain interrupted and require an explicit new run; startup never replays them.

This migration removes original request content from live task records. It does not rewrite earlier backups or guarantee erasure from old disk/WAL copies; those stay under the operator's private retention and incident process. The pre-redaction preview must not be resumed against this upgraded database. Restore only a reviewed backup with the matching encryption key and rerun the migration before using tasks.
