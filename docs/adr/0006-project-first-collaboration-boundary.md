# ADR-0006: Use projects as the collaboration and local-agent binding boundary

**Date**: 2026-08-25
**Status**: accepted
**Deciders**: Yuhan He
**Supersedes**: ADR-0002 session-scoped invitation decision; ADR-0005 single-session connector mapping
**Partially superseded by**: [ADR-0015](0015-create-personal-solos-from-first-local-prompt.md) for creator-owned Solos and participant Solo creation

## Context

The original model treated each session as an independent membership and invitation boundary, and connected one local Codex process to one session. That made a real collaborative codebase fragment into repeated invitations, drifting roles, and multiple connector processes. It also failed to express the user's actual intent: one human collaboration project maps to one local agent project, while its solo and multi conversations retain separate histories and local agent threads.

Moving access from sessions to projects is difficult to reverse because it changes authorization, invitation scope, migration behavior, navigation, and local-runtime lifecycle. Existing data must not accidentally merge unrelated sessions or broaden access during migration.

## Decision

Make `Project` the top-level collaboration and authorization boundary. Every session belongs to exactly one project. A project has one owner and any number of participant or viewer members.

Project invitations are single-use and role-bound. A successful claim grants access to every current and future session in that project. The fixed expiry choices remain one hour, 24 hours, and seven days, with 24 hours as the default. The owner may later change any non-owner member between participant and viewer or remove that member.

Effective permissions are:

| Project role | Multi session | Solo session | Project/session administration |
|---|---|---|---|
| Owner | read/write and own agent | read/write and own agent | create/manage sessions, invitations, and member roles |
| Participant | read/write and own agent | read only | none |
| Viewer | read only | read only | none |

The first release has no session-specific membership override. Only the project owner creates and manages sessions. A role downgrade or removal takes effect across all sessions and revokes runtimes that are no longer eligible.

Bind one local agent project to one GatherThread project, authenticated device, workspace path, harness, and model. The connector discovers eligible sessions automatically. Each session keeps its own canonical cursor, runtime registration, local Codex thread, and local compaction state. Agent executions sharing one workspace run serially in the first release to avoid concurrent file edits.

Migrate every legacy session into its own generated project, copying exactly that session's owner and membership. Do not group legacy sessions automatically, because identical owners do not prove that access should be combined. Historical session endpoints may remain temporarily for compatibility, but their invitations grant the containing project and are not part of the documented user flow.

## Alternatives considered

### Keep session memberships and add an optional project label

- **Pros**: Small schema and API change.
- **Cons**: Roles still drift, invitations must be repeated, and a project connector cannot infer a stable authorization boundary.
- **Why not**: It preserves the exact mismatch this change is intended to fix.

### Project defaults with per-session ACL overrides

- **Pros**: Supports private sub-conversations and exceptional contributors.
- **Cons**: Makes effective access harder to explain, audit, cache, and revoke safely; a project invitation would no longer have a simple meaning.
- **Why not now**: The first release prioritizes a clear, fail-closed permission model. Private sub-projects can be separate projects.

### One project-wide Codex thread

- **Pros**: Every session automatically shares one native harness context.
- **Cons**: Unrelated conversations contaminate one another, sequence boundaries become ambiguous, and per-session compaction/resume cannot remain independent.
- **Why not**: The project is the local workspace binding, while the session remains the conversation-context boundary.

## Consequences

### Positive

- One invitation and one role govern the whole collaborative project.
- Participants automatically see new sessions and can contribute to multi sessions without repeated setup.
- Solo sessions stay owner-authored while remaining visible to every project member.
- One local connector follows the project and automatically attaches eligible per-session runtimes.
- Role changes have one authoritative source and apply consistently.

### Negative

- Members cannot be hidden from one session inside a project in the first release.
- Legacy sessions initially appear as separate migrated projects until an explicit future move/merge workflow exists.
- The connector maintains multiple cursors, runtimes, and Codex thread-state files.
- Serial agent execution can delay one session while a long request runs in another.

### Risks

- A mistaken project invitation exposes all current and future session history. Mitigate with explicit role copy, one-time secrets, fixed expiry, owner-only invitation creation, revocation, and a project name shown before administration.
- Incorrect migration could broaden access. Mitigate by generating one project per legacy session and copying only that session's memberships.
- A downgraded member could retain an already registered runtime. Mitigate by rechecking project role on writes and revoking affected runtimes transactionally with the role change.
