# Try the cloud Agent

Choose the cloud trial Agent, describe a small task, and read its answer in the same shared conversation. You do not need to install a local Agent or provide an API key. Available models, usage allowances and service status are shown in the workspace.

[Illustrated workflow](PRODUCT_GUIDE.md) · [简体中文](HOSTED_AGENT_GUIDE.zh-CN.md)

## Your first task

1. Sign in and open a project session where you may write. Viewers cannot start Agent requests.
2. Check **Cloud Agent** in **Settings → Available Agents**. Its existing child settings then show the configured models; unchecking it hides those settings. Choose **Cloud Agent** and a cloud model in the existing Agent selector. Enter a small, clear task, such as “Create `hello.txt` with one greeting and check its content in the terminal.”
3. For a first try, leave **Use GT Cloud code and save changes to my GT Cloud branch** unchecked. To work on project code, first check that its owner has enabled GT Cloud sharing and that the code is already shared there, then select the checkbox yourself. The checkbox clears after submission, so choose again for each run. This runner does not read code from the separate direct GitHub integration.
4. Choose **Request my agent** and review the confirmation. OpenCode runs in an isolated container, can read and edit files and execute terminal commands, and receives model responses through a server proxy. Its final answer appears in the current session.
5. With cloud code selected, eligible changes are checkpointed to your own cloud branch. Review that checkpoint in the project's code collaboration view. The owner still reviews merges into shared `main`. This action does not automatically upload or change local files.

## Before you try

The limits below describe temporary-workspace and GT Cloud code tasks. GitHub repository tasks use the separate workflow and limits linked at the end.

- Your request and a short selection of shared session context go to the selected model provider for inference. If you opt in to project cloud code, selected source can also enter model requests. Avoid submitting content you do not want this provider to process.
- Each run starts in a fresh temporary environment. Files created without the cloud code option are discarded after the run.
- The container has no general Internet access and cannot download dependencies online. A run accepts about 100 files, 500 KiB of code, and 12 KiB of session context, with a two-minute time limit. Use your local Agent for larger projects or builds needing downloads.
- Ordinary chat does not call an Agent. Local Agent requests still run on your own device; the cloud trial uses the same Agent selector and send action.
- By default, each user may run one task at a time, with at least 30 seconds between accepted starts across projects, models and devices. Wait for the current task or short cooldown; the status field shows the reason. Any configured daily allowance and provider/server capacity limits also apply.
- Settings and the composer show the selected provider/model; remaining daily runs appear only if an administrator configured a daily allowance. Busy models and temporarily unavailable providers never switch silently to a different model. API keys are managed by the operator, so you do not need to enter one. If the runner is unavailable, contact the server operator.

For container build, quotas, and credentials, see the [operator guide](HOSTED_AGENT.md).

## GitHub cloud projects

Computer-to-GitHub synchronization is available independently in **Project file collaboration → GitHub**. The small trial profile does not support cloud GitHub repository tasks. Those tasks need a separately enabled service and an eligible coding profile; for their workflow, saved task review, limits and operator setup, see [GitHub cloud workspace](HOSTED_GITHUB.md).
