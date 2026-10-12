# Try the cloud Agent

**Beta 1 availability:** the Cloud Agent entry is open. Running a task still requires the operator's validated provider/container configuration; publishing npm or deploying the build does not supply API credentials or enable an unconfigured server. Check the workspace's current model/status before requesting a task. This release targets the isolated test service, not production activation.

Choose the cloud Agent, describe a small task, and read its answer in the same shared conversation. No local Agent installation is needed. Platform trial models need no personal key; you can also add your own API in Settings. Available models, usage allowances and service status are shown in the workspace.

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
- The container has no general Internet access and cannot download dependencies online. A run accepts about 100 files, 500 KiB of code, and 12 KiB of session context, with a five-minute time limit. Use your local Agent for larger projects or builds needing downloads.
- Ordinary chat does not call an Agent. Local Agent requests still run on your own device; the cloud trial uses the same Agent selector and send action.
- By default, each user may run one task at a time, with at least 30 seconds between accepted starts across projects, models and devices. Wait for the current task or short cooldown; the status field shows the reason. Any configured daily allowance and provider/server capacity limits also apply.
- Settings and the composer show the selected provider/model; remaining daily runs appear only if an administrator configured a daily allowance. Busy models and temporarily unavailable providers never switch silently to a different model. API keys are managed by the operator, so you do not need to enter one. If the runner is unavailable, contact the server operator.
- The same request button becomes **Pause Agent** while a cloud trial runs, then **Resume Agent** after you pause it. Resume starts a new request with newer shared history and the original model, not the exact point where the old run stopped. Your unsent draft stays in place. A failed answer offers **Retry Agent request** using the same model; capacity limits may require waiting briefly.
- Use the summary button to select completed messages and generate a shared summary with your selected cloud or local Agent. Cloud summaries send only those messages and your summary instructions to the selected provider, not project files. Original messages remain available. No local Agent installation is required for a cloud summary.

For container build, quotas, and credentials, see the [operator guide](HOSTED_AGENT.md).

## Use your own API

1. Open **Settings → Personal API → Add API connection**. Choose the provider, enter a name, its exact model ID and your key. Saving does not invoke a model or run a billable test.
2. Open Agent options beside the message box, choose **Cloud Agent** and your saved model, then request a task. It also supports shared summaries and eligible authorized GitHub repository tasks.
3. Only your account may use the connection. Keys are encrypted on the server and never shown again. Leave the key blank when editing to retain it; switching provider requires a new key. Pausing or deleting a connection stops active work using it. Retry and resume stay pinned to the original configuration; after it changes, select the current settings and start a new request. No silent model or payer fallback occurs.

Fixed official APIs support OpenAI, Anthropic, DeepSeek, SiliconFlow CN/global and OpenRouter; arbitrary addresses or headers are unsupported. Your provider bills your account, so set spending limits there too. Personal APIs accept up to 100 tasks/account and 1,000 tasks/server per UTC day and retain common concurrency, resource and runtime limits. They do not consume the platform trial allowance. Check current availability in the workspace.

## GitHub cloud projects

Computer-to-GitHub synchronization is available independently in **Project file collaboration → GitHub**. Beta 1 also opens the cloud repository-task workflow there, but running it needs the separately enabled GitHub service, App authorization and an eligible coding profile. The Cloudflare small-trial profile does not support repository tasks; other profiles still require actual coding and resource validation. For saved task review, limits and operator setup, see [GitHub cloud workspace](HOSTED_GITHUB.md).
