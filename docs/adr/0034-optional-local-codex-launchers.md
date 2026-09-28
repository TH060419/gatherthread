# ADR-0034: Use optional local Codex Launchers on Windows and macOS

- Status: proposed / source preview
- Date: 2026-09-28

## Context

ADR-0018 chose copyable, credential-free terminal commands for the initial
Codex connection. They remain the universal recovery path, but installing
Node and keeping a terminal open is unnecessarily difficult for some Windows
and macOS Alpha testers. A browser cannot safely start a local process or
assume a URL handler has been installed.

## Decision

Offer separately installed, optional per-user Launchers on Windows and macOS.
They use the same versioned `gatherthread-connect:` URI v1, defined in
`../INTERFACE_CONTRACTS.md`, only from the official HTTPS Web origin. It
contains the project and non-secret settings, never a device credential. Both
handlers validate the complete URI, show a local form, and require a deliberate
button press and local token entry before starting a bundled connector. They
never automatically install Hooks or start a connection on receipt of a link.
Users may optionally install the bundled plugin and must review its Hooks in
Codex. Manual commands remain available for all origins and platforms.

The Windows prototype bundles a private Python/Node runtime and uses a per-user
registry entry. The macOS prototype is a native AppKit `.app` with private
Node, registered through Launch Services. Its bundled plugin is copied into a
per-user application-support directory only after explicit confirmation. Both
bundles retain Node and connector licensing notices. The cloud server and its
authentication, protocol, and Codex runtime-selection boundaries do not change.

## Consequences

- A forged or malformed URI cannot start a connector, choose a different
  server, or supply a token. The OS scheme itself does not authenticate the
  website that invoked it; the handler therefore pins the origin and still
  requires local user action.
- The Web action may fail when the local app is absent. The manual command is
  always visible and is required for localhost, LAN, tailnet, and self-hosted
  deployments in this prototype.
- The current server has no one-use Codex pairing grant; the existing device
  token must be typed locally. Release-grade auto-pairing needs a separate
  reviewed interface and migration plan.
- These test bundles are not yet Developer ID signed/notarized on macOS or
  production signed on Windows. Real OS, browser, Codex, and distribution
  smoke tests remain release gates; a successful CI build is insufficient.
