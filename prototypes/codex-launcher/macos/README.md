# GatherThread Agent Launcher for macOS

## Claude Code adaptation in this source tree

The source now also builds a separate Claude Code connector and Claude plugin
into the existing app, retaining the same GatherThread icon and URL scheme.
This is not a claim that an earlier published installer contains Claude support;
a new installer still needs an explicit build and release. Claude Code must
already be installed and signed in.

When several Claude installations exist, automatic discovery scans PATH and
known native/user npm locations in the background and prefers an existing
version 2.1.259 or newer. It runs only a short `--version` probe, never installs
or calls a model, and does not replace a manually edited path. If no compatible
version is found, the old path is retained with an update prompt. The connector
still checks the complete safe streaming interface before accepting work.

Choose Claude Code in the Web project's connection entry. A strict version-3
link fills the selected Agent, exact model, email, project and production/test
environment. The app asks only for the account password locally and uses the
existing one-use independent-device authorization. The grant remains an
account/project authorization; it is not a harness-bound credential. Codex
version-1/version-2 links retain their existing meaning. No URL starts execution
or installs a plugin without a separate button click.

The native **Allow this device to synchronize project files** checkbox starts
off and resets with every new connection. Only an explicit check adds the local
`--code-sync` authorization; it does not itself turn on sharing or upload files.
Codex-only history-import and context-window controls are hidden for Claude.
Supply a full `claude-...` model ID, not a `sonnet`, `opus` or `haiku` alias.

The optional **Install bundled plugin** action explicitly installs only the
selected Agent's reviewed plugin. Claude's local marketplace is separate from
Codex's and its private Node/MCP/Hook resources cannot overwrite Codex files.
Review Hooks and restart or reload the Claude Code session after installation.
Claude Code's own tool permissions remain in effect. Remove the optional plugin
with `claude plugin uninstall gatherthread@gatherthread-launcher-claude --scope user`
and `claude plugin marketplace remove gatherthread-launcher-claude` before removing
the app if desired; existing Claude conversations and project files remain local.

This optional arm64/x86_64 prototype uses a native AppKit `.app` and bundles
Node 24, the fixed-version connector, and a copy of the reviewed Codex plugin.
Launcher 0.1.3/build 13 is the installer/app display version; the bundled connector
and plugin use the matching `0.1.0-beta.3` package version. The earlier Beta 2
downloads remain available under their original release.
End users do not need Python or npm. Codex Desktop / CLI must already be
installed and signed in. The manual terminal connection remains an advanced fallback.
The packaged Launcher and Node require macOS 13.5 or later; the build explicitly
targets that minimum rather than the build machine's OS version.

## Install and connect

1. Download `GatherThreadLauncher-macOS-<architecture>.dmg` (`arm64` for Apple
   silicon; `x86_64` for Intel), verify its SHA-256 sidecar, and open the DMG.
   **Drag `GatherThread Launcher.app` from the right onto Applications on the left.**
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
repo dependencies installed. Create an isolated build environment for the
hash-pinned, build-only Finder metadata helpers:

```sh
GT_DMG_BUILD_ENV="$(mktemp -d /tmp/gatherthread-dmg-build.XXXXXX)"
python3 -m venv "$GT_DMG_BUILD_ENV"
"$GT_DMG_BUILD_ENV/bin/python" -m pip install --require-hashes --only-binary=:all: -r prototypes/codex-launcher/macos/requirements-dmg.txt
"$GT_DMG_BUILD_ENV/bin/python" -m unittest discover -s prototypes/codex-launcher/macos -p 'test_build_dist.py' -v
"$GT_DMG_BUILD_ENV/bin/python" prototypes/codex-launcher/macos/build_dist.py
```

The builder compiles the AppKit executable, runs the shared URI vectors,
builds the fixed connector, copies the matching plugin and Node executable,
retrieves the exact Node release license, includes and validates the high-resolution
`GatherThread.icns` icon declared by `Info.plist`, signs the app
ad hoc, and creates an architecture-specific **DMG**, compatible ZIP, SHA-256
sidecars and public `*.dmg.provenance.json` / `*.zip.provenance.json`. Build from a clean committed checkout;
the manifest identifies that exact commit, version, architecture, Node version,
signing limitation and every app-file hash, without local paths or credentials.
Only Git-reviewed plugin files are copied. Finder shows exactly two root items:
the application on the right and `/Applications` shortcut on the left. A clear
leftward arrow and bilingual security/Hook instructions are part of the static
background. Detailed `READ ME FIRST.html`, `BUILD_PROVENANCE.json`, background
and layout source stay in the hidden `.gatherthread` directory; external checksum
and provenance sidecars remain available for verification. A private writable
intermediate receives the fixed `.DS_Store` using pinned build-only helpers,
without driving Finder or requesting Apple Events permission. It is detached
before conversion to the final read-only compressed DMG.
The builder verifies the actual DMG, mounts it **read-only without opening Finder
or launching the app**, checks its exact inventory, instructions, hashes, versions,
icons, exact Finder view/icon positions/background target, and signature, and
detaches before publishing the local file. Only mounted images may additionally
contain ordinary `.fseventsd`, `.Spotlight-V100` or `.Trashes` system directories;
the unmounted stage rejects them. Symlinks, special types, other root entries,
application bytes and Finder metadata are still strictly checked. Inventory
failures report the validation phase and bounded missing/unexpected filenames.
Both formats
privately prepare their checksum and source record, then promote metadata before
the archive with no-clobber links. An existing DMG, ZIP or either sidecar is never
overwritten, including symlinks and collisions arriving during the build. Failure
rolls back only still-owned links and preserves replaced files. Use a fresh output
directory or move previous reviewed candidates aside before a new build.
It does not publish a Release. Verify a downloaded image's hash and perform
a real macOS/Safari/Codex smoke test before distributing.
The build does not prove a live authenticated connection or that a particular
Codex Desktop version will load the plugin.

The approved background is generated locally with `dmg-background/RenderBackground.swift`
and `layout.json`, retaining the byte-identical approved logo. To preview a copy
without changing the packaged source asset (use a new output path):

```sh
swiftc -O -framework AppKit -o /tmp/gatherthread-render-dmg prototypes/codex-launcher/macos/dmg-background/RenderBackground.swift
/tmp/gatherthread-render-dmg prototypes/codex-launcher/macos/dmg-background/layout.json "$PWD" /tmp/gatherthread-dmg-background-preview.png
```

The background is 720 × 560 points at 2× with native bilingual UI text. The
renderer verifies the approved logo's SHA-256 and refuses an existing output.
Build-tool wheel sources, pinned hashes and MIT attribution are documented in
[`dmg-background/THIRD_PARTY_NOTICES.md`](dmg-background/THIRD_PARTY_NOTICES.md).

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
