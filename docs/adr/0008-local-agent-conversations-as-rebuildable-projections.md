# ADR-0008: Treat local agent conversations as rebuildable projections of canonical history

**Date**: 2026-08-25
**Status**: accepted
**Deciders**: Yuhan He
**Builds on**: [ADR-0006](0006-project-first-collaboration-boundary.md) and [ADR-0007](0007-project-harness-adapter-and-codex-app-server.md)
**Partially supersedes**: ADR-0007's decision to keep prompts typed directly in Codex desktop local-only

## Context

GatherThread collaborators use different local harnesses, models, context windows, and compaction strategies while sharing one ordered project history. A native harness conversation is therefore not a portable canonical format: it may contain private system instructions, hidden reasoning, harness-specific tool records, local compaction state, and content that the user never intended to publish.

At the same time, collaborators expect an editable GatherThread session to feel native in Codex desktop. Cloud events must appear in the corresponding local thread, a prompt typed into that managed thread should become a shared Agent request, and its final response should return to the server exactly once. Offline work, network uncertainty, role changes, and context-window limits must not let one device overwrite or reorder another collaborator's accepted history.

Read-only access has a different meaning. A viewer, or a participant reading a solo session, may download a point-in-time local conversation for reference, but later local work must never mutate the shared session.

## Decision

The append-only, per-session server event log is the sole authority for collaborative ordering and accepted content. Every native local Agent conversation is a projection of the events visible to that user, not a second source of truth.

For a session the user may edit, the project connector maintains one persistent native harness thread and synchronizes in both directions. Canonical events are imported in server sequence order with frozen human and Agent attribution. A completed prompt typed directly into a managed Codex desktop thread is published only when the user has explicitly installed, reviewed, and trusted the project Hook. Without that Hook, direct desktop turns remain local while Web-triggered execution and cloud-to-local projection continue to work.

Local turns use a durable write-ahead outbox and journals before any network mutation. The server accepts one atomic, idempotent local-turn commit containing the Agent request, bounded allowed tool events, and final response. Stable local turn and runtime identifiers make exact retries return the original canonical events instead of executing or appending twice. A transport-uncertain commit remains unresolved and fail-closed until the connector can retry or reconcile it.

The server sequence always wins during divergence. If cloud history advanced while a local turn was offline, the server appends the accepted local turn after the current cloud head. The connector then builds a new side thread from the complete visible canonical sequence, compacts locally when required by that harness's observed context window, verifies coverage, and only then switches the managed binding. The previous native thread is retained and archived as an `offline fork`; it is not deleted or used to overwrite the server.

Compaction summaries, token accounting, hidden reasoning, private prompts, and harness-specific internal state remain local. They are never required to be identical across models and do not become canonical collaboration events. Shared payloads are bounded and redacted before persistence.

For a read-only session, every **Download to Codex** action creates an independent snapshot request with an atomically frozen `through_sequence`. A `snapshot_connector` imports only through that sequence into a new immutable local thread. Snapshot threads are not registered for execution Hooks and never upload later local changes.

Authorization is checked continuously rather than only at connector startup. A confirmed role downgrade, session archival, or project removal deactivates execution and removes the affected thread from the trusted Hook registry. Work created while read-only stays local even if write access is later restored. A mutation whose commit outcome is genuinely unknown is retained only for an exact idempotent resolution, not treated as permission to create new shared work.

The synchronization state machine lives behind the harness-neutral `ProjectHarnessAdapter`. Codex App Server is the first implementation; future Claude Code, DeepSeek Harness, and other adapters must preserve the same canonical-order, idempotency, snapshot, authorization, and privacy invariants even when their native transcript formats differ.

Conversation reconciliation never resets, checks out, or overwrites local project source files. It changes only private connector state and native Agent conversation bindings.

## Alternatives considered

### Share one native transcript format

- **Pros**: A single file could appear to preserve every harness detail.
- **Cons**: Native formats are incompatible and include private or unstable implementation data.
- **Why not**: It cannot provide a trustworthy cross-harness collaboration boundary.

### Let the local transcript win after a conflict

- **Pros**: Preserves one user's exact offline ordering.
- **Cons**: Reorders or discards events already accepted from other collaborators.
- **Why not**: One device must not overwrite the shared project history.

### Infer desktop changes by polling transcripts without a trusted Hook

- **Pros**: Requires no explicit project setup.
- **Cons**: Cannot reliably distinguish a user's new turn from hydration, replay, private work, or another connector process.
- **Why not**: Publication consent, provenance, and exactly-once execution would be ambiguous.

### Use one server-side Agent for every collaborator

- **Pros**: Centralizes execution and context management.
- **Cons**: Removes the defining requirement that each person keeps their own local harness, model, credentials, tools, and workspace.
- **Why not**: GatherThread is a human collaboration layer, not a centralized Agent replacement.

## Consequences

### Positive

- Codex desktop and GatherThread Web present one attributable, ordered collaboration history for editable sessions.
- Offline retries and concurrent collaborators cannot silently duplicate a local turn or let one device replace canonical history.
- Every model may use its full native context window and compact independently.
- Read-only downloads remain useful without creating a hidden write path.
- Future harness adapters have explicit behavioral invariants instead of depending on Codex transcript details.

### Negative

- The connector needs durable private journals, outboxes, thread registries, reconciliation, and migration logic.
- A divergent thread may be replaced by a newly built managed thread, so users can see an archived offline fork in Codex desktop.
- Direct desktop publishing requires an explicit Hook installation and trust review.
- Some native content, including hidden reasoning and private harness prompts, deliberately cannot be shared verbatim.

### Risks

- A connector crash after a server claim but before terminal reporting leaves an abandoned claim until its lease lapses; [ADR-0023](0023-lease-and-bounded-redispatch-agent-claims.md) defines exact-runtime reclaim, attempt fencing, and bounded recovery.
- Codex desktop and a connector may be separate processes; all supported App Server mutations must remain fail-closed when exclusive ownership cannot be proven.
- Harness protocol changes can invalidate thread or turn assumptions. Contract tests, strict schema validation, bounded payloads, and version preflight remain release gates.
- Local private state and Hook spools may contain sensitive conversation content. They require OS-account protection, restrictive permissions or ACLs, redaction, bounded storage, and explicit project trust.
