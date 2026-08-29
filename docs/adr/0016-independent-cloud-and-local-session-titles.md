# ADR-0016: Keep cloud and local session titles independent

**Date**: 2026-08-28  
**Status**: accepted  
**Deciders**: Yuhan He  
**Builds on**: [ADR-0010](0010-explicit-session-lifecycle-and-synchronized-names.md), [ADR-0013](0013-single-writer-dual-codex-projections.md), and [ADR-0015](0015-create-personal-solos-from-first-local-prompt.md)  
**Partially supersedes**: ADR-0010's bidirectional title convergence and ADR-0007/ADR-0012's generated task-name format

## Context

Cloud sessions and local Agent conversations are the same collaboration stream but different user interfaces. Users may organize each side differently. Treating a mutable title as identity risks overwriting a user's chosen local label, creating a second native task after a cloud rename, or incorrectly treating an already-bound local task as a new personal Solo.

## Decision

A newly materialized visible Codex task receives the initial name `<cloud session title> · GatherThread`. The project name is omitted. Its implementation-private background projection receives `<cloud session title> · GatherThread background`. An adopted pre-existing local task keeps its existing title.

After the binding exists, cloud and local titles are independent. GatherThread does not push later cloud renames into the local task and does not upload later local renames to the cloud. The cloud permission rule remains authoritative: a Personal Solo may be renamed only by its Solo Creator while they retain a non-viewer project role, and a Multi may be renamed only by the Project Owner.

Titles are display metadata only. A binding is resolved by the cloud `project_id` and `session_id`, the persisted local native `thread_id`, and the verified workspace. Hook dispatch checks all existing managed bindings by those stable identifiers before first-prompt Solo discovery. Changing either title cannot create, adopt, rebuild, or replace a session or native task.

## Consequences

- Users can organize cloud sessions and local Agent tasks independently.
- The shorter initial local label puts the useful session title first.
- A rename cannot revive the duplicate-session bug because no matching path reads a title.
- Cross-interface title changes are not mirrored; users rename each side intentionally.
- Background and snapshot titles remain implementation labels and are not identity.

## Verification requirements

- A cloud rename with the same session ID preserves the existing managed binding.
- A Hook whose workspace and native thread ID match a managed state is handled even when its local title differs.
- Only an unregistered native thread's first trusted prompt may enter deterministic Personal Solo discovery.
- Idempotent Personal Solo creation remains keyed by device, project, and native thread identity, never by title.
