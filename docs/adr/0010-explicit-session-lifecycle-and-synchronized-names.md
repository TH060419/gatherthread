# ADR-0010: Start projects empty and synchronize session names

**Date**: 2026-08-25
**Status**: accepted
**Deciders**: Yuhan He
**Builds on**: [ADR-0006](0006-project-first-collaboration-boundary.md), [ADR-0008](0008-local-agent-conversations-as-rebuildable-projections.md), and [ADR-0009](0009-copyable-project-codex-connection-command.md)
**Partially supersedes**: ADR-0009's default `General` session decision
**Partially superseded by**: [ADR-0015](0015-create-personal-solos-from-first-local-prompt.md) for participant-created personal Solos and creator-authorized renames

## Context

A project and a conversation have different lifecycles. Automatically creating a `General` multi session made an empty project look immediately usable, but it also created unwanted canonical state before the owner had chosen whether the first conversation should be `solo` or `multi`. Once the project-level Codex connection could safely exist without a session, the default conversation was no longer necessary.

Session titles are also shared project metadata. Owners expect a rename in GatherThread to update the corresponding local Agent conversation without losing history, changing its native identity, or creating a duplicate task. When a supported local harness exposes a reliable mutable title, an owner also expects an intentional local rename to converge back to GatherThread.

## Decision

Creating a project inserts only the project and its owner membership. The new project has zero sessions until its owner explicitly creates a `solo` or `multi` session. Existing sessions named `General` remain ordinary sessions; no migration deletes them or adds one to another project.

Only the project owner may rename a session. Creation and rename share the same trimmed Unicode title contract of one to 200 characters. A rename updates the mutable session record and monotonically advances project activity in one transaction, then appends a metadata-only `session_state_change` event. Realtime clients use that event to refresh titles and session lists; canonical conversation events are not rewritten.

The project connector keeps the same per-session native conversation and updates its display name idempotently. It does not rebuild context merely because the title changed. For harnesses that can reliably read a user-edited native title, an owner-local rename may be submitted through the same idempotent server operation. If cloud and local titles change concurrently, the latest authoritative cloud metadata wins; non-owners never acquire rename authority through a local harness.

An empty connected project is valid. The connector stays active, discovers sessions created later, and materializes each eligible session then. It must not execute a placeholder Agent turn merely to make an empty native conversation visible.

## Alternatives considered

### Keep the automatic `General` session

- **Pros**: Every project has an immediate conversation target.
- **Cons**: Creates unwanted history, assumes `multi`, and leaves cleanup to the user.
- **Why not**: Project connection no longer depends on a pre-existing session.

### Rename only in the Web interface

- **Pros**: The server remains the only title editor.
- **Cons**: Local Agent task labels drift and become difficult to match to shared sessions.
- **Why not**: A stable per-session binding can change display metadata without changing conversation identity.

### Rebuild the native conversation after every rename

- **Pros**: A fresh task would certainly have the new name.
- **Cons**: Needlessly duplicates local threads and creates migration risk for a metadata-only change.
- **Why not**: Supported harnesses already provide a native rename operation.

## Consequences

### Positive

- Owners choose the first session's mode and title intentionally.
- Empty projects and projects connected before their first session are first-class states.
- Shared and local names converge without duplicating Agent work or canonical history.
- Existing `General` sessions remain intact.

### Negative

- A new project requires one additional explicit action before conversation begins.
- Completely empty native threads may remain hidden until the harness records visible content.
- Local-to-cloud rename depends on a harness exposing a reliable current title; adapters without that capability remain cloud-to-local only.

### Risks

- Concurrent renames could oscillate. Compare authoritative refresh generations, make writes idempotent, and use cloud-wins conflict resolution.
- A local participant could try to rename a shared session. Recheck owner authorization on the server and restore the authoritative title locally.
- Metadata events could be mistaken for conversation content. Keep rename payloads bounded and explicitly metadata-only, and omit them from visible message rendering.
