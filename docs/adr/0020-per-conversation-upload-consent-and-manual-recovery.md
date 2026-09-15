# ADR-0020: Per-conversation upload consent and manual recovery

**Date**: 2026-09-15  
**Status**: accepted  
**Deciders**: GatherThread maintainers

## Context

Trusted Hooks and native DSH events provide fast automatic publication, but either mechanism can be disabled, miss a completion, or fail while the local conversation remains intact. Users also need a privacy control that keeps one local conversation from uploading without disconnecting the whole project.

## Decision

Automatic upload is enabled by default and stored independently for every bound native conversation. When disabled, automatic Hook or DSH capture must not commit local turns to canonical history. Cloud-to-local projection and explicitly requested Web Agent work remain separate concerns.

Manual upload is an explicit user action. It scans the bound native conversation for completed, identifiable, not-yet-bound turns, stages them through the existing durable idempotent outbox, and sends them through the existing authenticated `commitLocalTurn` operation. It must work when the automatic Hook path did not produce a draft. Manual upload never changes the automatic-upload preference.

Codex exposes these controls through the user-only plugin MCP over the connector's private capability-protected local relay. DeepSeek Harness exposes them directly in its native GatherThread settings surface. The canonical server protocol and event schema do not change.

## Alternatives Considered

### Retry only the existing outbox

- **Pros**: Minimal implementation.
- **Cons**: Cannot recover a turn that the Hook never observed.
- **Why not**: It does not satisfy the required Hook-failure fallback.

### One global upload switch

- **Pros**: Simpler UI.
- **Cons**: Prevents different privacy choices for separate conversations and projects.
- **Why not**: Consent is scoped to the native conversation being shared.

### Upload every native history item on reconnect

- **Pros**: High apparent recovery rate.
- **Cons**: Violates explicit consent and risks importing connector-authored or ambiguous turns.
- **Why not**: Recovery must be user initiated and conservative.

## Consequences

### Positive

- A user can keep selected local conversations private without stopping collaboration elsewhere.
- Hook failures are recoverable from the native completed-turn record.
- Existing canonical idempotency and reconciliation remain the only cloud write path.

### Negative

- Upload preference and pending counts add local state and UI complexity.
- A Hook-missed Codex turn cannot prove its historical canonical base, so it uses the conservative unknown base and may require reconciliation.

### Risks

- Native history could contain ambiguous turns. Discovery therefore requires a completed turn, one identifiable user message, a final assistant answer, and exclusion from connector IDs and durable local bindings.
- A disabled preference could be bypassed accidentally. Automatic paths test the persisted preference immediately before outbox commit, and regression tests cover both Hook-captured and Hook-missed recovery.
