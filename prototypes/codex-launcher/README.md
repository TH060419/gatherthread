# GatherThread Codex Launcher for Windows

For the corresponding native macOS app, see [macOS README](macos/README.md).
Mac users receive a DMG with a drag-to-Applications folder and bilingual install
instructions; the Windows ZIP/`Install.cmd` path below is unchanged. Both Web
and native guides prominently require **reviewing, trusting and allowing Hooks**
before syncing turns typed directly in Codex. Mac's verified-download-only
**System Settings → Privacy & Security → Open Anyway** step is not a Windows
installation step.

This folder builds a Windows x64 ZIP containing a private Python runtime, a
private Node 24 runtime, the repository's `@gatherthread/codex-connect@0.1.0-beta.1`
bundle, and the matching GatherThread Codex plugin. End users do not need to
install Python, Node, npm, or clone this repository. Codex Desktop / CLI must
already be installed and signed in.

## Install and connect

1. Extract the ZIP and run `GatherThreadLauncher/Install.cmd`. It copies the
   bundle to `%LOCALAPPDATA%/Programs/GatherThread Launcher`, registers the
   `gatherthread-connect:` URL Scheme for the current Windows user, and opens
   the GUI. The window, taskbar, URL Scheme and current-user Start menu entry
   use the GatherThread application icon. It does not require administrator
   privileges or modify Python's own executable icon.
2. In the GUI, check the Codex CLI path. A Windows `codex.cmd` wrapper from
   the official npm CLI is resolved to that package's native `codex.exe`; a
   Codex Desktop installation can also supply its native executable. If the
   GatherThread plugin is already installed, keep using it and skip the optional
   **Install bundled plugin** button. The existing plugin needs Node/npm
   available to Codex Desktop for its MCP and Hooks. If that is unavailable,
   the optional bundled plugin uses the Launcher's private Node executable;
   review its MCP and Hooks in Codex and restart Codex after installation.
3. From the project's Web **Connect Codex** dialog, choose **Open Launcher**;
   the current email, project and server environment fill automatically. Enter
   only your account password, then press **Start connection**. The Launcher
   creates an independent local Agent device under that same email account;
   other signed-in computers, phones and tablets stay signed in. You do not
   paste an access token. If you open the Launcher directly, its **Open website**
   button takes you to sign-in and the project's connection dialog. Optionally choose an
   existing local working directory with **Browse**; leave it blank to use the
   connector's default per-project directory. The password is sent once in an
   HTTPS request body to the visibly selected official environment, never in
   a URL, process argument or log. Password input is cleared, and the resulting
   independent device credential is passed only to the connector child environment.
   Closing the window minimizes it to the
   taskbar while the connector runs; restore it to stop the connection.

The new `v=2` handoff accepts only the exact production origin
`https://gatherthread.cn` or isolated test origin `https://test.gatherthread.cn`.
The selected origin is retained all the way to the connector; test credentials
and projects are never sent to production. Passwords remain 8–128 characters
with the account's 512-byte bound. A failed, expired or uncertain authorization
requires reopening the Launcher from the Web dialog; there is no automatic
password retry. Revoke an unused Agent device from the account's device settings.

中文快速连接：先在网页用邮箱和密码登录项目，点击「连接 Codex → 打开启动器」。
邮箱、项目和正式/测试环境会自动填入；只需输入密码并点击「启动连接」，无需复制
Access Token。每台本地 Agent 使用独立设备授权，不会退出同一账号的其他设备。
授权失败或超时后，请回网页重新打开启动器。插件安装和 Hooks 信任仍需单独确认。

To uninstall, stop the connector and close the Launcher, then run
`Uninstall.cmd` from the extracted bundle or installed directory. It removes
the optional Launcher-owned Codex plugin and local marketplace if installed,
the URL Scheme, its owned Start menu shortcut, and its
per-user installation folder. It retains project workspaces, Codex tasks, and
private connector state under the user profile. `Uninstall.ps1 -DryRun` shows
the removal scope without changing anything.

The Web's new email-account handoff has exactly eight parameters. This is a
synthetic format example, not a usable authorization:

```text
gatherthread-connect://connect?v=2&origin=https%3A%2F%2Fgatherthread.cn&project=PROJECT_ID&model=gpt-6-sol&context_window_tokens=128000&visible_history_sync=first-connect&email=you%40example.com&authorization_id=11111111-2222-4333-8444-555555555555
```

The authorization ID alone is not a credential: the server rechecks the matching
email password, creating browser, current project permission and ten-minute
one-use handoff before issuing a local device credential. The URI contains the
prefilled email, but no password, device credential or Cookie. The Launcher
refuses redirected claims and bounds response size and the foreground claim
deadline. Legacy six-field `v=1` production links remain accepted through a
separate old one-use-authorization form; the new Web path no longer requires it.
Unsupported/self-hosted origins retain the folded manual terminal path.

## Build and verification

On a Windows development machine with Python 3.13, Node 24, npm, and the repo
dependencies installed, run `python prototypes/codex-launcher/build_dist.py`.
Then run `python prototypes/codex-launcher/verify_dist.py`.
The builder creates `dist/GatherThreadLauncher-Windows-x64.zip` and a per-file
`SHA256SUMS.json`. It bundles the local source version of the connector and
plugin, rather than downloading or publishing a package. Check that those
versions match before distributing. The build machine's Node executable is
copied into the ZIP. The builder retrieves the matching Node release's official
`LICENSE` (including bundled dependency notices), validates it, and includes it
as `runtime/Node-LICENSE.txt`; a missing or invalid notice fails the build.
The checked-in application assets are derived from the approved GatherThread
product logo, without additional image/runtime dependencies. Verification also
requires the 512-pixel window icon and all seven ICO sizes (16–256 pixels), so
an icon-free package can no longer pass the distribution gate.

The package remains unsigned; the Windows SmartScreen prompt may appear.
Source and mocked boundary tests do not establish native Windows icon rendering,
shell registration or a live Codex/Desktop/server connection. A new build needs
the Windows distribution verifier plus those platform smoke checks before release.

## Follow-up for a production installer

- Add a single-instance handoff and a tray menu for reconnect, stop, and quit.
  This prototype minimizes to the taskbar and can open a second window from a
  second deep link.
- Sign the installer and binaries, ship a verified Node build with notices,
  add automatic updates, and run the relevant Windows/CI gates before
  publishing. Hook trust in Codex must remain an explicit user decision.
