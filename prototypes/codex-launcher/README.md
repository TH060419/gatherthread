# GatherThread Codex Launcher for Windows

For the corresponding native macOS app, see [macOS README](macos/README.md).

This folder builds a Windows x64 ZIP containing a private Python runtime, a
private Node 24 runtime, the repository's `@gatherthread/codex-connect@0.1.0-alpha.8`
bundle, and the matching GatherThread Codex plugin. End users do not need to
install Python, Node, npm, or clone this repository. Codex Desktop / CLI must
already be installed and signed in.

## Install and connect

1. Extract the ZIP and run `GatherThreadLauncher/Install.cmd`. It copies the
   bundle to `%LOCALAPPDATA%/Programs/GatherThread Launcher`, registers the
   `gatherthread-connect:` URL Scheme for the current Windows user, and opens
   the GUI. It does not require administrator privileges.
2. In the GUI, check the Codex CLI path. A Windows `codex.cmd` wrapper from
   the official npm CLI is resolved to that package's native `codex.exe`; a
   Codex Desktop installation can also supply its native executable. If the
   GatherThread plugin is already installed, keep using it and skip the optional
   **Install bundled plugin** button. The existing plugin needs Node/npm
   available to Codex Desktop for its MCP and Hooks. If that is unavailable,
   the optional bundled plugin uses the Launcher's private Node executable;
   review its MCP and Hooks in Codex and restart Codex after installation.
3. From the project's Web **Connect Codex** dialog, choose **Open Launcher**;
   the current project ID and connection settings fill automatically. If you
   open the Launcher directly, enter the Web project ID (`project-***`). The
   Launcher always connects to `https://gatherthread.cn`. Optionally choose an
   existing local working directory with **Browse**; leave it blank to use the
   connector's default per-project directory. Enter the one-time device authorization, then
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

The Launcher accepts only `https://gatherthread.cn`. A browser can open the
installed Launcher with:

```text
gatherthread-connect://connect?v=1&origin=https%3A%2F%2Fgatherthread.cn&project=PROJECT_ID&model=gpt-5.6-sol&context_window_tokens=65536&visible_history_sync=first-connect
```

The URL Scheme carries no credential. Create a ten-minute one-use authorization in the signed-in Connect Codex dialog,
then enter it in the GUI. Only the connector claims the device credential. The Web launcher
action emits the selected project's deep link; manual commands remain available.

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
