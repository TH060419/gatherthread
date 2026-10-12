# GatherThread Codex Launcher for macOS

This optional arm64/x86_64 prototype uses a native AppKit `.app` and bundles
Node 24, the fixed-version connector, and a copy of the reviewed Codex plugin.
End users do not need Python or npm. Codex Desktop / CLI must already be
installed and signed in. The manual terminal connection remains an advanced fallback.
The packaged Launcher and Node require macOS 13.5 or later; the build explicitly
targets that minimum rather than the build machine's OS version.

## Install and connect

1. Download `GatherThreadLauncher-macOS-<architecture>.dmg` (`arm64` for Apple
   silicon; `x86_64` for Intel), verify its SHA-256 sidecar, and open the DMG.
   **Drag `GatherThread Launcher.app` onto the adjacent Applications folder.**
   Open it from Applications once, then eject the DMG. This registers
   `gatherthread-connect:` with macOS Launch Services. The prototype is
   ad-hoc signed, **not Developer ID signed or Apple-notarized**. If macOS
   blocks the first opening, verify the official package, then use
   **System Settings → Privacy & Security → Open Anyway** and confirm the system
   prompt. Never use this exception for a damaged, malware-blocked or untrusted
   download. Do not disable Gatekeeper, remove quarantine, or use sudo.
2. Verify the auto-detected Codex CLI path or select its executable. If the
   GatherThread plugin is not installed, choose **Install bundled plugin**,
   restart Codex, and **review, trust and allow GatherThread Hooks in `/hooks`**
   before syncing turns typed directly in Codex. The bundled plugin
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
connection rather than reusing an uncertain authorization. Install in Applications
before installing the bundled plugin; its private Node path belongs to that app.
Stop an existing Launcher before replacing it. Moving the app afterward requires
explicit plugin reinstallation from its new location. The compatible ZIP remains
available for manual extraction. Removing the app does not delete project workspaces, Codex tasks,
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
ad hoc, and creates an architecture-specific **DMG**, compatible ZIP, SHA-256
sidecars and public `*.dmg.provenance.json` / `*.zip.provenance.json`. Build from a clean committed checkout;
the manifest identifies that exact commit, version, architecture, Node version,
signing limitation and every app-file hash, without local paths or credentials.
Only Git-reviewed plugin files are copied. A fresh stage contains the app,
`/Applications` symlink, bilingual `READ ME FIRST.html` and build provenance.
The builder verifies the actual DMG, mounts it **read-only without opening Finder
or launching the app**, checks its exact inventory, instructions, hashes, versions,
icons and signature, and detaches before publishing the local file. Both formats
privately prepare their checksum and source record, then promote metadata before
the archive with no-clobber links. An existing DMG, ZIP or either sidecar is never
overwritten, including symlinks and collisions arriving during the build. Failure
rolls back only still-owned links and preserves replaced files. Use a fresh output
directory or move previous reviewed candidates aside before a new build.
It does not publish a Release. Verify a downloaded image's hash and perform
a real macOS/Safari/Codex smoke test before distributing.
The build does not prove a live authenticated connection or that a particular
Codex Desktop version will load the plugin.

For a future production release, use Developer ID signing, notarization, and an
updater. These are release gates, not features of this prototype.

## 中文：安装与连接

1. macOS 需为 13.5 或更新版本。下载对应芯片的 DMG（Apple 芯片选 `arm64`，Intel 选 `x86_64`），核对校验和后打开，**将 `GatherThread Launcher.app` 拖入旁边的“Applications（应用程序）”**。从“应用程序”首次打开，再推出安装镜像。若系统阻止打开，核对官方包后前往 **系统设置 → 隐私与安全性 → 仍要打开**，并确认系统提示。当前为临时签名，**尚未经过 Apple 公证**；不要绕过损坏、恶意软件或不可信程序的警告，也不要关闭系统保护、清除隔离标记或使用 sudo。
2. 先确保本机 Codex 已安装并登录。网页登录 GatherThread，进入项目，点击“连接 Codex” → “打开启动器”。邮箱、项目和环境会自动填入；核对“正式环境 / 测试环境”，只输入账号密码，再点击“授权并连接”。其他设备的登录不受影响。
3. 本地目录可留空使用默认项目目录。只有需要安装随包插件时才点击安装；重启 Codex 后，**在 `/hooks` 中审查、信任并允许共序 Hooks**，才会同步直接在 Codex 发送的回合。保持启动器运行；关闭窗口后可从 GatherThread Dock 图标恢复，退出前可点击“停止连接”。替换已有启动器前请先停止旧应用；先装入“应用程序”，再安装随包插件。

密码仅在本机隐藏输入，不保存、不进入链接、命令行或日志。新流程无需复制 Access Token。测试服与正式服账号独立。授权出错时，请回到对应网页重新打开启动器；旧版正式服链接保留明确标注的兼容模式，自部署环境仍可使用终端方式。

The manual security exception follows [Apple's opening guidance](https://support.apple.com/en-us/102445).
Artifact publication and server links require matching reviewed builds; a source
merge never upgrades an already downloaded ZIP. See [ADR-0047](../../../docs/adr/0047-macos-launcher-dmg-installation.md).
