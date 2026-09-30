# 试用云端 Agent

云端体验 Agent 仍在预览准备中。服务器管理员完成模型 API 接入、隔离容器测试并启用服务后，项目会话的 Agent 选择器才会出现与 Codex、DeepSeek Harness 并列的 **云端 Agent**。选项未出现时，当前服务器尚未开放这项功能；你仍可连接自己的本地 Codex 或 DeepSeek Harness。

## 第一次使用

1. 登录 GatherThread，进入一个允许你发言的项目会话。访者只能阅读，不能发起 Agent 请求。
2. 在 Agent 选择器选择 **云端 Agent** 和云端模型，也可到 **设置 → 默认 Agent** 中选择。然后在消息框写下一个明确的小任务，例如“新建一个 `hello.txt` 文件，写入一行问候语，然后用终端确认文件内容”。
3. 如果只想体验，在空的临时工作区运行即可。**使用 GT Cloud 代码，改动保存到我的 GT Cloud 分支**默认不勾选。若要处理项目代码，先确认项目创建者已启用 GT Cloud 文件共享，且代码已在其中，然后主动勾选。提交后勾选会清除，每次都须重新选择。此功能不会读取独立的 GitHub 直连代码。
4. 点击 **请求我的 Agent**，阅读确认提示。Agent 会在隔离容器中使用 OpenCode 读写文件、运行终端命令，并通过服务器的模型代理获取回答。完成后，答复进入当前会话。
5. 勾选了项目云端代码时，符合代码规则的改动会保存到你自己的云端分支。到项目的代码协作界面查看检查点；共享 `main` 仍需项目创建者审核合并。本地目录不会因为这次试用自动上传或改动。

## 使用前了解

- 你的请求和当前会话的一小段共享上下文会发送到你所选的模型服务商。勾选项目云端代码后，所选代码也会进入模型请求。不要输入不愿意交给该服务商处理的内容。
- 每次运行是新的临时环境，结束即清理。未勾选代码选项时，Agent 创建的文件不会保存。
- 云端容器没有通用外网访问，不能在线下载依赖。每次最多处理约 100 个文件、500 KiB 代码与 12 KiB 会话上下文，运行最长两分钟；每日还有模型额度。较大的项目或需要联网安装依赖时，请连接自己的本地 Agent。
- 普通聊天不会调用 Agent。本地 Agent 请求仍由你的本地设备处理；云端体验使用同一个 Agent 选择器和发送按钮。
- 设置和输入区会显示所选服务商、模型和今日剩余次数。模型忙碌或服务商暂时不可用时，不会自动换成别的模型。API Key 由管理员配置，使用者无需自行填写。
- 若显示额度已用完，请第二天再试。若提示运行服务不可用，请联系服务器管理员；不要反复提交同一任务。

服务器管理员的构建、配额与凭据配置见[运维指南](HOSTED_AGENT.md)。

## GitHub cloud projects / GitHub 云端项目

For npm Node.js/TypeScript repositories, open **Cloud GitHub project** in the composer or Settings. Authorize your own GitHub account, choose a repository, then choose **GitHub repository** as the cloud workspace. Inspect saved task changes before explicitly creating a draft PR. This separately enabled source preview is documented in [Cloud GitHub workflow and setup](HOSTED_GITHUB.md).

对于 npm Node.js/TypeScript 仓库，可在输入区或设置打开“云端 GitHub 项目”，授权自己的 GitHub 账号并选择仓库，再将云端工作区选为“GitHub 仓库”。查看保存的任务改动后，主动创建草稿 PR。该功能需要管理员单独启用；完整步骤与限制见上方指南。
