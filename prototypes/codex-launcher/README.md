# GatherThread Codex Launcher for Windows

This folder builds a Windows x64 ZIP containing a private Python runtime, a
private Node 24 runtime, the repository's `@gatherthread/codex-connect@0.1.0-alpha.7`
bundle, and the matching GatherThread Codex plugin. End users do not need to
install Python, Node, npm, or clone this repository. Codex Desktop / CLI must
already be installed and signed in.

## Install and connect

1. Extract the ZIP and run `GatherThreadLauncher/Install.cmd`. It copies the
   bundle to `%LOCALAPPDATA%/Programs/GatherThread Launcher`, registers the
   `gatherthread-connect:` URL Scheme for the current Windows user, and opens
   the GUI. It does not require administrator privileges.
2. In the GUI, check that the Codex CLI path points to `codex.exe`. If the
   GatherThread plugin is already installed, keep using it and skip the optional
   **Install bundled plugin** button. The existing plugin needs Node/npm
   available to Codex Desktop for its MCP and Hooks. If that is unavailable,
   the optional bundled plugin uses the Launcher's private Node executable;
   review its MCP and Hooks in Codex and restart Codex after installation.
3. Enter the GatherThread origin, project ID, current model/context settings,
   and existing device token, then
   press **Start connection**. The token is passed only to the connector child
   process, not placed in a URL or log. Closing the window minimizes it to the
   taskbar while the connector runs; restore it to stop the connection.

To uninstall, stop the connector and close the Launcher, then run
`Uninstall.cmd` from the extracted bundle or installed directory. It removes
the optional Launcher-owned Codex plugin and local marketplace if installed,
the URL Scheme, and its
per-user installation folder. It retains project workspaces, Codex tasks, and
private connector state under the user profile. `Uninstall.ps1 -DryRun` shows
the removal scope without changing anything.

The ZIP defaults to `https://gatherthread.cn` from the supplied screenshot.
Before installing, change `launcher-config.json` inside the extracted folder
if your server uses another HTTPS origin. Only that origin may be used in the
GUI or a browser link. A browser can open the installed Launcher with:

```text
gatherthread-connect://connect?origin=https%3A%2F%2Fgatherthread.cn&project=PROJECT_ID&model=gpt-5.6-sol&context_window_tokens=65536&visible_history_sync=first-connect
```

The URL Scheme carries no credential. The current server has no Codex browser
pairing endpoint, so the GUI still requires the device token. The updated web
source emits the deep link; the cloud page will continue to show only manual
commands until that web change is deployed.

## Build and verification

On a Windows development machine with Python 3.13, Node 24, npm, and the repo
dependencies installed, run `python prototypes/codex-launcher/build_dist.py`.
The builder creates `dist/GatherThreadLauncher-Windows-x64.zip` and a per-file
`SHA256SUMS.json`. It bundles the local source version of the connector and
plugin, rather than downloading or publishing a package. Check that those
versions match before distributing. The build machine's Node executable is
copied into the ZIP; use a verified official Node distribution and include its
required notices before a public release.

The package is a test distribution. It is not code signed, and the Windows
SmartScreen prompt may appear. It has been verified to start the bundled Python
and Node runtimes, import Tkinter, and show the connector's CLI help. A live
Codex/Desktop/server connection still needs a platform smoke test.

## Follow-up for a production installer

- Add a one-use browser-approved Codex device pairing API, bound to the exact
  user, project, device, and server origin. Pass only a short-lived launch ID
  through the URL Scheme. Store the received credential in OS-protected storage
  and remove manual token entry.
- Add a single-instance handoff and a tray menu for reconnect, stop, and quit.
  This prototype minimizes to the taskbar and can open a second window from a
  second deep link.
- Sign the installer and binaries, ship a verified Node build with notices,
  add automatic updates, and run the relevant Windows/CI gates before
  publishing. Hook trust in Codex must remain an explicit user decision.
