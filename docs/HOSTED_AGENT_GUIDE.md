# Try the cloud Agent

Platform trial models and personal APIs use the same Cloud Agent entry. Available models, allowances and status are shown in the workspace. Self-hosted model and executor setup is covered by the [administrator guide](HOSTED_AGENT.md).

Choose the cloud Agent, describe a small task, and read its answer in the same shared conversation. No local Agent installation is needed. Platform trial models need no personal key; you can also add your own API in Settings. Available models, usage allowances and service status are shown in the workspace.

[Illustrated workflow](PRODUCT_GUIDE.md) · [简体中文](HOSTED_AGENT_GUIDE.zh-CN.md)

## Your first task

1. Sign in and open a project session where you may write. Viewers cannot start Agent requests.
2. Open the Agent options beside the message box, choose **Cloud Agent** and a model, and enter a small, clear task, such as “Create `hello.txt` with one greeting and check its content in the terminal.” If you previously hid Cloud Agent, enable it in **Settings → Available Agents**.
3. **Use GT Cloud code and save changes to my GT Cloud branch** starts on and remembers your choice for this account and project; sending a message does not clear it. With GT Cloud sharing enabled and write access, selected project files go to the model and eligible edits return to your branch; a first run can start from the shared version. Turn it off for an empty temporary workspace; this off choice is remembered too. With sharing paused or without write access, project code is not sent. The separate local/GitHub files are not read by this option.
4. Choose **Request my agent** and review the confirmation. OpenCode runs in an isolated container, can read and edit files and execute terminal commands, and receives model responses through a server proxy. Its final answer appears in the current session.
5. With cloud code selected, eligible changes are saved to your own cloud branch. Open **Files → GT Cloud → Your branch** in the right workspace to inspect them. You do not need a connected computer Agent to view these online files. The owner still reviews merges into shared `main`; local files are not changed automatically.

## Before you try

The limits below describe temporary-workspace and GT Cloud code tasks. GitHub repository tasks use the separate workflow and limits linked at the end.

- Your request and a short selection of shared session context go to the selected model provider for inference. The enabled project-code selection also sends eligible GT Cloud source. Check this option before sending and avoid submitting content you do not want this provider to process.
- Each run starts in a fresh temporary environment. Files created without the cloud code option are discarded after the run.
- The container has no general Internet access and cannot download dependencies online. A run accepts about 100 files, 500 KiB of code, and 12 KiB of session context, with a twelve-minute time limit. Use your local Agent for larger projects or builds needing downloads.
- A timed-out result is labelled separately from a failure and offers **Continue**. Continue starts another round of at most 12 minutes, with the original task/model, current shared history and saved cloud code if selected. It consumes normal quota. Unsaved files, private thinking and stopped processes cannot be restored. Repeated identical task text is represented once in the continuation context; distinct conversation remains available under the same context limit.
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

Fixed official APIs support Qwen (DashScope China), GLM (BigModel), Doubao (Volcengine Ark China), OpenAI, Anthropic, DeepSeek, SiliconFlow CN/global and OpenRouter. Presets show a model example; enter the exact tool-capable model or endpoint ID available to your provider account. Arbitrary addresses or headers are unsupported. Your provider bills your account, so set spending limits there too. Personal APIs accept up to 100 tasks/account and 1,000 tasks/server per UTC day and retain common concurrency, resource and runtime limits. They do not consume the platform trial allowance. Check current availability in the workspace.

## GitHub cloud projects

Computer-to-GitHub synchronization is available independently in **Project file collaboration → GitHub**. Beta 2 also opens the cloud repository-task workflow there, but running it needs the separately enabled GitHub service, App authorization and an eligible coding profile. The Cloudflare small-trial profile does not support repository tasks; other profiles still require actual coding and resource validation. For saved task review, limits and operator setup, see [GitHub cloud workspace](HOSTED_GITHUB.md).
