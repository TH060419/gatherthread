# ADR-0019: Project canonical history into native sessions across harness switches

**Date**: 2026-09-06
**Status**: accepted
**Deciders**: Yuhan He
**Builds on**: [ADR-0008](0008-local-agent-conversations-as-rebuildable-projections.md) and [ADR-0018](0018-unified-codex-plugin-and-connector.md)
**Partially supersedes**: [ADR-0013](0013-single-writer-dual-codex-projections.md)'s prohibition on every Desktop-task resume/injection and [ADR-0014](0014-acknowledged-bounded-desktop-relay-capsules.md)'s use of Hook capsules as the only Desktop cloud-history path

## Context

One GatherThread cloud session may be used through Codex, DeepSeek Harness (DSH), and later harnesses over time. Creating a new cloud session on every switch would split the collaboration record, while treating every native transcript as authoritative would allow local ordering and private harness state to overwrite accepted shared history.

Codex App Server 0.151 adds a narrower capability than the permanent second-writer model rejected by ADR-0013: an idle Desktop task can be briefly rejoined and receive persisted `thread/inject_items` entries in its model-visible native history. DSH exposes public Session append and persistence services. Neither capability removes the need for server ordering, explicit runtime routing, retry-safe cursors, or safe degradation.

## Decision

The append-only canonical server event log remains the sole authority for shared content and order. Every connector maintains a per-runtime native projection with a durable server cursor, projected-event identifiers, and idempotent local-turn state. Projection changes never rewrite the cloud log or the local source working tree.

For Codex App Server 0.151 or a compatible implementation, the connector checks that the Desktop task is idle, briefly rejoins it, and persists canonical events through `thread/inject_items`. Events arriving during an active Desktop turn remain queued until a later idle synchronization pass. The background execution projection remains separate and is still the only Codex task that executes Web Agent requests. Connector versions or Desktop/App Server builds that cannot safely rejoin and inject retain the acknowledged Hook capsule path from ADR-0014 and fail closed rather than competing for a writer.

`thread/inject_items` makes the projected entries part of the loaded task's model-visible history. The public protocol does not promise that every Codex Desktop build immediately redraws those entries as visible chat bubbles, and this release does not claim that UI behavior as verified on a real Desktop build.

For DSH, the plugin projects external canonical events into the bound persisted DSH Session through the public `Session.append` API with `surfaceOp: "append"`, then calls the public flush service. Projected event IDs suppress replay and echo. Native DSH user/assistant turns are written to a durable local outbox before an atomic, idempotent `commitLocalTurn`; successful server bindings then advance local state. Private reasoning and unapproved harness metadata remain local.

An `agent_request` is executable only by its explicitly selected online runtime. Other connected runtimes continue replaying and projecting the resulting canonical events but do not execute a request addressed to another harness, device, provider, or model.

Switching Codex to DSH and back therefore keeps the same cloud project and session IDs. A newly selected harness needs one connection or pairing for that device and project, creates or reuses its own local native binding, and catches up from canonical history. The previous connector may stay online as a passive projection. Multiple simultaneous Codex runtimes for the same selection remain ambiguous and fail closed.

This decision coordinates conversation history only. It does not introduce a global lock for filesystem edits made by different harnesses in the same working directory; users must avoid or separately coordinate concurrent source edits.

## Alternatives Considered

### Create a new cloud session for each harness

- **Pros**: Native ownership is simple.
- **Cons**: Collaboration history fragments and links shared in one harness disappear after switching.
- **Why not**: Harness choice is an execution detail, not the identity of the shared conversation.

### Execute every request on every connected harness

- **Pros**: All native sessions would produce a response.
- **Cons**: One request would run multiple times with different tools, credentials, and side effects.
- **Why not**: Runtime provenance and user selection must be authoritative.

### Continue using only next-prompt capsules for Codex

- **Pros**: Never attempts an App Server rejoin.
- **Cons**: An idle task cannot receive persisted model-visible history until another user prompt.
- **Why not**: Compatible 0.151 clients now support a bounded idle rejoin/injection path, while capsules remain the necessary fallback.

### Claim immediate Desktop bubble redraw

- **Pros**: Presents the simplest product story.
- **Cons**: The public App Server contract promises persisted model-visible history, not an immediate UI refresh in every Desktop build.
- **Why not**: Release claims must stop at behavior that can be verified from the public protocol and tests.

## Consequences

### Positive

- One canonical session survives Codex to DSH to Codex switching without duplication.
- Both harnesses can catch up native model-visible history after reconnecting.
- Durable cursors, outboxes, event IDs, and atomic local-turn commits prevent replay loops and duplicate shared turns.
- A selected runtime executes exactly one Web Agent request while other connectors remain useful passive replicas.

### Negative

- Codex needs both an idle native-injection path and a Hook capsule compatibility path.
- DSH projection must emit valid native Session events and flush them explicitly.
- Each harness keeps separate local compaction, native IDs, and projection state.
- Switching to a new harness still requires a one-time per-device/project connection or pairing.

### Risks

- A Codex Desktop build may persist injected history without immediately redrawing bubbles; model-visible persistence and UI presentation must be tested separately.
- A stale cursor or missing projected-event ID could create echo; exact event IDs and idempotency keys are mandatory.
- Two harnesses editing the same files can still conflict because conversation synchronization is not a filesystem lock.
- App Server or DSH API changes must fail closed behind version and contract checks rather than falling back to private transcript mutation.
