# ADR-0030: Resolve cloud branches before project-member removal

**Date**: 2026-09-24
**Status**: proposed; pending project-lead review
**Deciders**: pending project-lead review

## Context

The early cloud Git implementation kept a personal branch after its author lost project membership. The former member could no longer reach the project code API, while the branch remained charged to their account. Silently discarding a branch during removal would risk losing reviewed or unreviewed collaboration work.

## Decision

Both project-member and legacy session-member removal routes require an explicit decision if the target member has a current cloud branch. The remover may delete the branch with an exact-head comparison. Alternatively, the member may request review, the project owner may merge that exact head into the existing project `main`, and the remover may then select the merged resolution. The owner may reject a merge; no branch is automatically merged or deleted. A member leaving voluntarily may delete their own branch and exit or wait for owner review before exiting. No other member's personal branch is a merge target.

The server checks membership, disposition, branch head and merged review state in the same SQLite write transaction that removes the membership and branch. It invalidates the departing user's old code-mutation receipts, revokes runtime access, then repairs derived Git refs after commit. A changed branch head yields a conflict requiring fresh review. Merging charges the resulting main snapshot to the owner under the existing quota check; removing the personal branch releases the departing member's logical charge. Local Git and Agent conversations are never changed.

Pre-upgrade orphan branches are not deleted by migration. They remain charged and appear only in their original user's cloud-storage settings, where the user may explicitly clear their own exact head under the normal Origin, device and idempotency checks. Physical Git objects and backups follow separate retention and operator-cleanup procedures.

## Alternatives considered

- Merge into another member's personal branch: rejected because it would change that member's code and quota without their decision.
- Automatically merge to main: rejected because main requires owner review and conflicts may exist.
- Automatically delete a branch on removal: rejected because it could lose unmerged work without a conscious choice.
- Keep inaccessible orphan branches indefinitely: rejected because they consume quota without a supported user action.

## Consequences and validation

The removal dialog must identify a branch and require a choice before enabling confirmation. For unmerged work it should offer deletion or explain how to request owner review and return later. API tests cover both removal routes, exact-head conflicts, owner-reviewed main transfer, legacy orphan visibility and self-cleanup. Retained Git objects and backups are not an immediate physical-space reduction.
