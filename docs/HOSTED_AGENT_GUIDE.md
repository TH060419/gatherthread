# Try the cloud Agent

The cloud trial Agent is being prepared for preview. **Cloud Agent** appears alongside Codex and DeepSeek Harness in the Agent selector only after an operator connects a model API, validates the isolated container, and enables the service. If the option is absent, this server has not enabled the feature; you can still connect a local Codex or DeepSeek Harness.

## First run

1. Sign in and open a project session where you may write. Viewers cannot start Agent requests.
2. Choose **Cloud Agent** and a cloud model in the Agent selector (also available in **Settings → Default Agent**). Enter a small, clear task, such as “Create `hello.txt` with one greeting and check its content in the terminal.”
3. For a first try, leave **Use GT Cloud code and save changes to my GT Cloud branch** unchecked. To work on project code, first check that its owner has enabled GT Cloud sharing and that the code is already shared there, then select the checkbox yourself. The checkbox clears after submission, so choose again for each run. This runner does not read code from the separate direct GitHub integration.
4. Choose **Request my agent** and review the confirmation. OpenCode runs in an isolated container, can read and edit files and execute terminal commands, and receives model responses through a server proxy. Its final answer appears in the current session.
5. With cloud code selected, eligible changes are checkpointed to your own cloud branch. Review that checkpoint in the project's code collaboration view. The owner still reviews merges into shared `main`. This action does not automatically upload or change local files.

## Before you try

- Your request and a short selection of shared session context go to the selected model provider for inference. If you opt in to project cloud code, selected source can also enter model requests. Avoid submitting content you do not want this provider to process.
- Each run starts in a fresh temporary environment. Files created without the cloud code option are discarded after the run.
- The container has no general Internet access and cannot download dependencies online. A run accepts about 100 files, 500 KiB of code, and 12 KiB of session context, with a two-minute time limit and daily model allowance. Use your local Agent for larger projects or builds needing downloads.
- Ordinary chat does not call an Agent. Local Agent requests still run on your own device; the cloud trial uses the same Agent selector and send action.
- Settings and the composer show the selected provider/model and remaining daily runs. Busy models and temporarily unavailable providers never switch silently to a different model. API keys are managed by the operator, so you do not need to enter one.
- If the daily allowance is exhausted, try again the next day. If the runner is unavailable, contact the server operator rather than repeatedly submitting the task.

For container build, quotas, and credentials, see the [operator guide](HOSTED_AGENT.md).

## GitHub cloud projects / GitHub 云端项目

For npm Node.js/TypeScript repositories, open **Cloud GitHub project** in the composer or Settings. Authorize your own GitHub account, choose a repository, then choose **GitHub repository** as the cloud workspace. Inspect saved task changes before explicitly creating a draft PR. This separately enabled source preview is documented in [Cloud GitHub workflow and setup](HOSTED_GITHUB.md).

对于 npm Node.js/TypeScript 仓库，可在输入区或设置打开“云端 GitHub 项目”，授权自己的 GitHub 账号并选择仓库，再将云端工作区选为“GitHub 仓库”。查看保存的任务改动后，主动创建草稿 PR。该功能需要管理员单独启用；完整步骤与限制见上方指南。
