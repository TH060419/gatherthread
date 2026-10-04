# Try the cloud Agent

Cloud Agent is reserved for a later release. Its Settings checkbox and Agent option are unavailable, including on a server with a configured provider. Use a local Codex or DeepSeek Harness for now. GitHub connections remain available under **Cloud Git → GitHub**, beside **GT Cloud**.

Settings keeps at least one usable local Agent selected. The closed cloud option is not checked automatically and cannot be used to uncheck the last local Agent. Its child settings stay hidden while it is unavailable.

## First run after the feature opens

1. Sign in and open a project session where you may write. Viewers cannot start Agent requests.
2. Check **Cloud Agent** in **Settings → Available Agents**. Its existing child settings then show the configured models; unchecking it hides those settings. Choose **Cloud Agent** and a cloud model in the existing Agent selector. Enter a small, clear task, such as “Create `hello.txt` with one greeting and check its content in the terminal.”
3. For a first try, leave **Use GT Cloud code and save changes to my GT Cloud branch** unchecked. To work on project code, first check that its owner has enabled GT Cloud sharing and that the code is already shared there, then select the checkbox yourself. The checkbox clears after submission, so choose again for each run. This runner does not read code from the separate direct GitHub integration.
4. Choose **Request my agent** and review the confirmation. OpenCode runs in an isolated container, can read and edit files and execute terminal commands, and receives model responses through a server proxy. Its final answer appears in the current session.
5. With cloud code selected, eligible changes are checkpointed to your own cloud branch. Review that checkpoint in the project's code collaboration view. The owner still reviews merges into shared `main`. This action does not automatically upload or change local files.

## Before you try

- Your request and a short selection of shared session context go to the selected model provider for inference. If you opt in to project cloud code, selected source can also enter model requests. Avoid submitting content you do not want this provider to process.
- Each run starts in a fresh temporary environment. Files created without the cloud code option are discarded after the run.
- The container has no general Internet access and cannot download dependencies online. A run accepts about 100 files, 500 KiB of code, and 12 KiB of session context, with a two-minute time limit. Use your local Agent for larger projects or builds needing downloads.
- Ordinary chat does not call an Agent. Local Agent requests still run on your own device; the cloud trial uses the same Agent selector and send action.
- The first selected free models are Qwen3.5-4B and Qwen3-8B through SiliconFlow. The free setup has no daily task-count quota. By default, each user may run one task at a time, with at least 30 seconds between accepted starts across projects, models and devices. Wait for the current task or short cooldown; the existing status field shows the reason. Provider and server capacity limits still apply.
- Settings and the composer show the selected provider/model; remaining daily runs appear only if an administrator configured a daily allowance. Busy models and temporarily unavailable providers never switch silently to a different model. API keys are managed by the operator, so you do not need to enter one. If the runner is unavailable, contact the server operator.

首批计划接入硅基流动的 Qwen3.5-4B 和 Qwen3-8B。免费方案默认不设每日任务次数上限，每位用户同时运行一个任务，两次启动至少间隔 30 秒；换项目、模型或设备共用同一限制。未勾选“云端 Agent”时隐藏其子设置，勾选后使用已有模型选择和状态提示。功能仍待真实 API 联调与后续开放。

For container build, quotas, and credentials, see the [operator guide](HOSTED_AGENT.md).

## GitHub cloud projects / GitHub 云端项目

For npm Node.js/TypeScript repositories, open the existing **Cloud Git → GitHub** category. Authorize your own GitHub account and choose a repository there. Saved task review and explicit draft PR creation remain there; new or continued Agent tasks wait for the cloud entry to open. This separately configured source preview is documented in [Cloud GitHub workflow and setup](HOSTED_GITHUB.md).

对于 npm Node.js/TypeScript 仓库，在现有“云端 Git → GitHub”分类中授权自己的 GitHub 账号并选择仓库，已保存任务的查看与主动创建草稿 PR 也在这里。云端 Agent 入口开放前，不能新建或继续执行任务。完整步骤与限制见上方指南。
