# ADR-0009: Use a copyable project command for the first Codex connection

**Date**: 2026-08-25
**Status**: partially superseded by [ADR-0010](0010-explicit-session-lifecycle-and-synchronized-names.md)
**Deciders**: Yuhan He
**Builds on**: [ADR-0006](0006-project-first-collaboration-boundary.md), [ADR-0007](0007-project-harness-adapter-and-codex-app-server.md), and [ADR-0008](0008-local-agent-conversations-as-rebuildable-projections.md)

## Context

GatherThread needs a project-level first connection instead of requiring users to understand per-session runtimes. A browser cannot safely start a local Codex process or choose a filesystem workspace, and a signed background Companion would add packaging, update, and operating-system trust work that is too large for the no-cost Alpha. Codex App Server also has no public `project/create` API; Codex Desktop groups tasks by their local working directory.

## Decision

Every newly created GatherThread project originally received an owner and one `multi` session named `General`. [ADR-0010](0010-explicit-session-lifecycle-and-synchronized-names.md) supersedes this part of the decision: new projects now start empty and the owner creates sessions explicitly. Historical and existing `General` sessions are not deleted or backfilled.

The project page exposes **Connect Codex**, which opens a dialog containing copyable macOS/Linux and Windows PowerShell commands. A command contains only the canonical server origin, project ID, model choice, and non-secret flags. It never contains a browser cookie, device token, invitation secret, local path, or Hook trust decision. The connector continues to request the user's device access token through hidden terminal input.

The command uses a new `--create-workspace` mode. After authenticating and reading the authoritative project title, the connector creates or exactly reuses a project-owned directory below `~/GatherThread Projects/`. It sanitizes the local directory name, rejects path escape and symbolic links, and never merges with or overwrites an unrelated existing directory. Binding metadata contains no credential.

The connector treats the first project refresh as a materialization operation. It immediately and idempotently creates a named native Codex thread for every session the current role may edit, then imports canonical history in server order. Partial materialization resumes only the missing sessions. Read-only sessions retain the independent snapshot workflow from ADR-0008. New sessions continue to be discovered automatically.

The local directory basename supplies the best available same-name Codex Desktop project grouping. GatherThread does not modify Codex Desktop's private project database. Native project grouping remains subject to the supported Codex Desktop version and may require the user to open the created directory once.

`--install-hooks` may be included in the copied command, but Hook trust remains an explicit action in Codex `/hooks`. Installing a definition never grants trust automatically.

## Alternatives considered

### Signed background Companion and custom URL scheme

- **Pros**: Subsequent connections can become a true single browser click.
- **Cons**: Requires signed packaging, notarization, secure updates, a protocol handler, keychain integration, and a larger local attack surface.
- **Why not now**: It is disproportionate for the no-cost Alpha and remains a future evolution path.

### Browser-to-loopback local service

- **Pros**: The Web page can contact a running local process directly.
- **Cons**: Introduces DNS rebinding, CSRF, Host/Origin validation, browser private-network, and local-port lifecycle risks.
- **Why not**: GatherThread does not open an inbound local HTTP control plane for convenience.

### Keep the existing manual per-project connector command

- **Pros**: Requires no product changes.
- **Cons**: Users must discover project IDs, choose paths, and wait for sessions to be lazily created; the Web UI cannot explain the actual project connection boundary.
- **Why not**: It caused incorrect task grouping and an incomplete first synchronization during Alpha testing.

## Consequences

### Positive

- The original default-session design gave a new collaboration a usable conversation immediately; ADR-0010 replaces it with explicit session creation.
- The project page becomes the documented connection entry point.
- Copied commands are cross-platform and contain no secret.
- The same command creates a safe local project directory and all editable session threads.
- No background daemon, custom protocol handler, loopback server, or Codex private-database mutation is required.

### Negative

- The user must run one terminal command and enter a device token.
- The GatherThread repository must already be cloned and dependencies installed.
- A newly created local project contains conversation context but no source files until the user adds or clones code there.
- Codex Desktop may require opening the generated directory once before showing its project grouping.

### Risks

- Shell quoting can differ across platforms. Generate separate commands from validated origin and project-ID primitives, and cover them with tests.
- A malicious project title could attempt path traversal or collision. Derive a bounded safe basename, verify the final real path remains under the fixed root, reject symbolic links, and never reuse an unrecognized non-empty directory.
- Bulk materialization can consume resources. Create threads sequentially, bound payloads and context compaction, expose progress in logs, and resume from per-session state.
- A copied command could be run for the wrong account. The server rechecks the authenticated user's current project membership and all session permissions before creating runtimes or accepting events.
