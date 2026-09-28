# GatherThread Codex Launcher for macOS

This optional arm64/x86_64 prototype uses a native AppKit `.app` and bundles
Node 24, the fixed-version connector, and a copy of the reviewed Codex plugin.
End users do not need Python or npm. Codex Desktop / CLI must already be
installed and signed in. The manual terminal connection remains supported.

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
3. On `https://gatherthread.cn`, choose the project's **Connect Codex** →
   **Open Launcher**. Safari or Chrome may ask whether to open the local app.
   Confirm the project and settings, enter your existing device token in the
   local window, and start the connector. The token never enters the URL or
   command arguments. Keep the app running; its Dock icon restores the window
   after closing it. Use **Stop connection** before quitting.

The scheme is restricted to the official HTTPS origin. A URL opens the form
but never automatically starts a connector or installs Hooks. Local/self-hosted
servers still use the manual command. Moving the app after installing its
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
retrieves the exact Node release license, checks `Info.plist`, signs the app
ad hoc, and creates an architecture-specific ZIP plus SHA-256 sidecar. It
does not publish the archive. Verify a downloaded archive's hash, inspect its
contents, and perform a real macOS/Safari/Codex smoke test before distributing.
The build does not prove a live authenticated connection or that a particular
Codex Desktop version will load the plugin.

For a future production release, use Developer ID signing, notarization, an
updater, and a browser-approved short-lived pairing grant instead of manual
device-token entry. These are release gates, not features of this prototype.
