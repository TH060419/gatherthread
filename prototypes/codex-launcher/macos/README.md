# GatherThread Codex Launcher for macOS

This optional arm64/x86_64 prototype uses a native AppKit `.app` and bundles
Node 24, the fixed-version connector, and a copy of the reviewed Codex plugin.
End users do not need Python or npm. Codex Desktop / CLI must already be
installed and signed in. The manual terminal connection remains an advanced fallback.
The packaged Launcher and Node require macOS 13.5 or later; the build explicitly
targets that minimum rather than the build machine's OS version.

## Install and connect

1. Extract `GatherThreadLauncher-macOS-<architecture>.zip`, move
   `GatherThread Launcher.app` to Applications, and open it once. This registers
   `gatherthread-connect:` with macOS Launch Services. The prototype is
   ad-hoc signed, not Developer ID signed or notarized; macOS may require you
   to review it in Privacy & Security before opening it. Do not bypass a
   warning for an untrusted archive.
2. Verify the auto-detected Codex CLI path or select its executable. If the
   GatherThread plugin is not installed, choose **Install bundled plugin**,
   restart Codex, and review `/hooks` before trusting them. The bundled plugin
   is copied to the current user's Application Support directory; it does not
   alter an existing plugin installation without this explicit action.
3. Sign in with your email account on `https://gatherthread.cn` (or the separate
   `https://test.gatherthread.cn` test environment), then choose **Connect Codex** →
   **Open Launcher**. Safari or Chrome may ask whether to open the local app.
   The current email, project, environment, and settings fill automatically.
   Check the displayed environment, enter only your account password, and choose
   **Authorize and connect**. This creates an independent local device without
   signing other devices out. Optionally select
   an existing local working directory; leave it blank to use the connector's
   default per-project directory. Passwords are masked, are not saved, and never
   enter the connection URL, command arguments, or logs. A private device credential
   is exchanged over HTTPS and passed only to the connector process. Keep the app
   running; its GatherThread Dock icon restores the window
   after closing it. Use **Stop connection** before quitting.

New `v=2` links are restricted to those two exact official HTTPS origins. An email
account in the test environment is separate from the production account. A URL opens the form
but never automatically starts a connector or installs Hooks. Local/self-hosted
servers still use the manual command. Older production-only `v=1` links remain
compatible and show a clearly labelled legacy authorization form; new email
connections do not require copying an access token or authorization token.
If a password or network attempt fails, return to the Web page and open a fresh
connection rather than reusing an uncertain authorization. Moving the app after installing its
bundled plugin changes the private Node path; reinstall that plugin from its
new location. Removing the app does not delete project workspaces, Codex tasks,
or connector state. Remove the optional plugin separately in Codex if desired.

## Build and verify

On macOS arm64 or x86_64 with Node 24, npm, Swift command-line tools, and the
repo dependencies installed:

```sh
python3 prototypes/codex-launcher/macos/build_dist.py
```

The builder compiles the AppKit executable, runs the shared URI vectors,
builds the fixed connector, copies the matching plugin and Node executable,
retrieves the exact Node release license, includes and validates the high-resolution
`GatherThread.icns` icon declared by `Info.plist`, signs the app
ad hoc, and creates an architecture-specific ZIP plus SHA-256 sidecar. It
does not publish the archive. Verify a downloaded archive's hash, inspect its
contents, and perform a real macOS/Safari/Codex smoke test before distributing.
The build does not prove a live authenticated connection or that a particular
Codex Desktop version will load the plugin.

For a future production release, use Developer ID signing, notarization, and an
updater. These are release gates, not features of this prototype.

## 中文：安装与连接

1. macOS 需为 13.5 或更新版本。解压对应架构的安装包，将 `GatherThread Launcher.app` 移到“应用程序”，首次打开并按系统提示确认来源。当前为临时签名，尚未经过 Apple 公证；不要绕过不可信安装包的安全警告。
2. 先确保本机 Codex 已安装并登录。网页登录 GatherThread，进入项目，点击“连接 Codex” → “打开启动器”。邮箱、项目和环境会自动填入；核对“正式环境 / 测试环境”，只输入账号密码，再点击“授权并连接”。其他设备的登录不受影响。
3. 本地目录可留空使用默认项目目录。只有需要安装随包插件时才点击安装，并在 Codex 的 `/hooks` 中自行审查。保持启动器运行；关闭窗口后可从 GatherThread Dock 图标恢复，退出前可点击“停止连接”。

密码仅在本机隐藏输入，不保存、不进入链接、命令行或日志。新流程无需复制 Access Token。测试服与正式服账号独立。授权出错时，请回到对应网页重新打开启动器；旧版正式服链接保留明确标注的兼容模式，自部署环境仍可使用终端方式。
