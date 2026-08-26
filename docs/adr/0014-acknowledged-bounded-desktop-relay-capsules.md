# ADR-0014: Use acknowledged bounded capsules for Desktop cloud relay

**Date**: 2026-08-26  
**Status**: accepted  
**Deciders**: Yuhan He  
**Partially superseded by**: [ADR-0015](0015-create-personal-solos-from-first-local-prompt.md) for first-prompt discovery of previously unregistered user tasks
**Builds on**: [ADR-0013](0013-single-writer-dual-codex-projections.md)

## Context

Codex Desktop is the sole writer of its visible task, so GatherThread can provide remote history only at trusted Hook prompt boundaries. A fixed-size Hook context prevents a model-window overflow, but simply truncating that context can both produce an excessively long visible reply and falsely advance past content the model never received. One canonical event can itself exceed the Hook budget, and cancelled turns must not acknowledge delivery.

## Decision

The Desktop projection keeps an acknowledged delivery cursor separate from its server observation cursor. `UserPromptSubmit` freezes a bounded relay capsule and proposed cursor transition in the Hook draft. Exact event bodies are split on UTF-8 boundaries with event ID, sequence, digest, and chunk checkpoint; only a completed `Stop` applies the transition. The Agent displays at most three extractive previews while the exact bounded block remains model-only context. The background execution projection continues to import and compact the complete canonical history independently.

Existing Desktop state without a delivery cursor starts from sequence zero. This one-time conservative replay is preferable to permanently losing content that an older fixed-size relay may have omitted.

## Alternatives Considered

### Advance the server cursor after fixed-size truncation

- **Pros**: Minimal state and no repeated history.
- **Cons**: Omitted events can disappear from Desktop context permanently.
- **Why not**: It makes delivery claims that the connector cannot prove.

### Generate one LLM summary for every oversized backlog

- **Pros**: Can compress more semantics into one prompt.
- **Cons**: Adds cost, latency, prompt-injection exposure, and a non-canonical potentially lossy artifact.
- **Why not**: The first release needs deterministic delivery and exact recovery before optional semantic summaries.

### Open and compact the Desktop task from the connector

- **Pros**: Could reuse the native task's full context window.
- **Cons**: Violates the single-writer boundary and recreates `already has an active writer` failures.
- **Why not**: Public Codex APIs do not provide safe shared-writer ownership.

## Consequences

### Positive

- No omitted event is silently acknowledged.
- Very large UTF-8 content resumes deterministically after cancellation, restart, or network recovery.
- Desktop replies remain concise while the current capsule still contains exact ordered context.
- Canonical history and background compaction remain independent of Desktop model limits.

### Negative

- A very large backlog may require several completed Desktop turns to drain fully.
- Upgraded Desktop bindings replay canonical history once from sequence zero.
- Private sidecar state gains another cursor and resumable checkpoint.

### Risks

- A model could still quote the exact block despite the display instruction; bounded size and short extractive previews limit the impact.
- A changed or missing checkpoint event fails closed and requires explicit state repair rather than guessing.
- The exact capsule is still untrusted collaborator content and must remain data, not executable instruction.
