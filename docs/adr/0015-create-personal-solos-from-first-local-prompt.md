# ADR-0015: Create creator-owned Solo sessions from the first local prompt

**Date**: 2026-08-26  
**Status**: accepted  
**Deciders**: Yuhan He  
**Builds on**: [ADR-0006](0006-project-first-collaboration-boundary.md), [ADR-0010](0010-explicit-session-lifecycle-and-synchronized-names.md), [ADR-0013](0013-single-writer-dual-codex-projections.md), and [ADR-0014](0014-acknowledged-bounded-desktop-relay-capsules.md)  
**Partially supersedes**: ADR-0006's owner-only session creation and Solo ownership matrix, ADR-0010's owner-only creation and rename rule, and ADR-0014's requirement that every relayed Desktop task already be registered

## Context

A connected local Agent project should let each collaborator begin private authored work without first creating a cloud session in the Web UI. Creating a cloud session for every empty local task would produce abandoned shared state, while polling Codex private databases or native histories would cross unsupported ownership and consent boundaries. The first trusted `UserPromptSubmit` Hook is the earliest supported point that proves both user intent and the exact local task identity. The design must preserve project roles, prevent connector-owned tasks from recursively creating sessions, and make retries safe across Hook timeouts or network loss.

## Decision

An owner or participant may create a personal `solo` session. Its immutable `owner_user_id` is the Solo creator, not necessarily the project owner. Only that creator may write, register an execution runtime, archive, or rename the Solo while retaining a non-viewer project role; every other project member, including the project owner, is read-only. Only the project owner may create or manage `multi` sessions, invitations, and project roles.

For a previously unbound Codex Desktop task, the first trusted `UserPromptSubmit` performs authoritative discovery. The connector rechecks the actor's current project role, derives a stable idempotency key from a one-way hash of device, project, and native task identity, creates a creator-owned Solo titled from a bounded sanitized prompt summary, adopts the existing Desktop task without opening a competing writer, and processes that same turn through the normal durable Hook outbox. Opening an empty task creates nothing. A viewer's task remains local-only.

The private Hook registry distinguishes `execution`, `background_execution`, and `snapshot_connector` tasks. Known background and snapshot tasks are never discoverable. Unknown tasks are eligible only while an authoritative project refresh says the actor is an owner or participant. The raw native task identity is never sent to the server. Session creation is bounded by per-user, per-project, and deployment row-count quotas, while exact idempotent retries continue to return the original session at the limit.

## Alternatives Considered

### Create a cloud Solo when an empty local task appears

- **Pros**: The Web UI reflects local task creation immediately.
- **Cons**: Codex exposes no reliable public empty-task creation Hook, and abandoned tasks would create unwanted shared state.
- **Why not**: A submitted first prompt is the first supported and intentional publication boundary.

### Keep all participant-created work local until a manual Web import

- **Pros**: Simple authorization and no automatic cloud mutations.
- **Cons**: Breaks project-level synchronization and adds a manual handoff for every new personal task.
- **Why not**: Trusted Hooks already provide an explicit, attributable creation signal.

### Give the project owner write access to every Solo

- **Pros**: Preserves one administrative writer model.
- **Cons**: Makes a participant's personal authored conversation editable by another user and contradicts the intended Solo boundary.
- **Why not**: Project administration and conversation authorship are separate capabilities.

### Discover local tasks by polling Desktop state or App Server history

- **Pros**: Could observe tasks without requiring Hooks.
- **Cons**: Relies on private or incomplete state, risks active-writer conflicts, and cannot prove publication consent.
- **Why not**: GatherThread uses only supported Hook boundaries and the canonical server API.

## Consequences

### Positive

- Owners and participants can begin a personal Solo directly in their normal local Agent workflow.
- Empty and viewer-owned tasks have no cloud side effect.
- Project owners cannot silently mutate another collaborator's Solo.
- Stable creation and local-turn keys make Hook timeout, replay, and reconnect safe without duplicate sessions or Agent turns.
- Explicit task purposes prevent background execution and snapshots from recursively creating Solos.

### Negative

- A participant-created Solo remains visible to every project member even though only its creator can write it.
- Downgrading or removing the creator makes the Solo read-only to everyone; the first release does not transfer ownership.
- The first local prompt may complete before a slow or offline connector has created the cloud Solo, so publication can appear later after spool recovery.
- Session count limits can require an operator to raise capacity deliberately for unusually large projects.

### Risks

- A stale local role could briefly permit an unknown Hook event to reach the connector. Recheck current project membership before creation and enforce creator ACL again inside the server transaction.
- A Hook timeout could replay the first prompt. Use deterministic session creation, durable Hook drafts, and stable local-turn IDs so the retry binds existing records rather than executing twice.
- A connector-owned task could look unknown before its first operation. Register background and snapshot purposes as soon as their state is persisted and reject those purposes even while discovery is enabled.
