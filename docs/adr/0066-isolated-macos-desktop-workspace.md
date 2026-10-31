# ADR-0066: Isolated macOS desktop workspace and local connection management

**Date**: 2026-10-31

**Status**: proposed / local prototype, not released

**Deciders**: pending project maintainer review

## Context

The desktop prototype must preserve the latest Web presentation and same-origin account behavior while managing local Agent connections. Launcher handoffs and harness connectors already own authorization and execution contracts. The independent DSH workspace proposal remains separate work.

## Decision

Use pinned Electron for this macOS prototype. The collaboration window loads the exact production/test origin with sandboxing and context isolation, without Node integration or a preload. A separate packaged local window exposes strict IPC from `packages/protocol/src/desktop.ts`; the host checks its exact main frame and URL on every action.

Reuse v2/v3 Launcher handoffs and native authorization, then start the matching connector with private Node 24. The browser receives no shell, arbitrary file access or device credentials. Explicitly selected executable/directory handles are opaque to IPC and revalidated before and after authorization. Start reserves a bounded owner slot before claiming; cancellation fences late success. Ambiguous claims are never retried automatically.

Intercept handoffs only inside the workspace; do not register the existing system scheme. Connections continue while the workspace is hidden. Explicit Quit and sleep request graceful shutdown; ownership remains active until the parent and owned process group exit. Uncertain shutdown keeps the app and slot alive. Restart/resume never automatically reruns work.

Shared Agent, Team, file/Git and permission behavior remains in the existing Web/server. DSH keeps its own plugin/profile and process ownership. Local-demo mode uses real server/Web with fictional identities, transient credentials, in-memory state and a fake connector; its renderer egress is restricted to the exact loopback service.

## Alternatives considered

- Privileged preload on the remote page: simpler integration, but expands the local execution boundary to remote content; rejected.
- Bundled Web and API proxy: complicates Cookie/Origin/uploads/WebSocket semantics and drifts from deployed presentation; rejected for this prototype.
- Swift/WebKit shell: smaller runtime, but requires a second implementation for future platforms. Reassess Electron size, upgrades and distribution before release.
- Embed the proposed DSH workspace: creates a dependency on separate, unmerged work; deferred.

## Consequences

The official workspace stays current without a second UI. Costs include a larger application, two windows, an Electron security-update obligation and network dependence for real collaboration. No server schema migration or Web credential policy changes occur. Desktop IPC v1 is new and local only. Signing/notarization, updates, Intel builds, live provider compatibility and offline recovery remain release gates. See [build and acceptance steps](../../apps/desktop/README.md).
