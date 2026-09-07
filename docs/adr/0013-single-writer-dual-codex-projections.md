# ADR-0013: Use single-writer dual projections for Codex Desktop

**Date**: 2026-08-26  
**Status**: partially superseded by [ADR-0019](0019-native-history-projection-across-harness-switches.md)
**Deciders**: Yuhan He  
**Builds on**: [ADR-0008](0008-local-agent-conversations-as-rebuildable-projections.md)  
**Partially supersedes**: ADR-0008's single native thread design and [ADR-0012](0012-activate-codex-desktop-tasks-with-registered-links.md)
**Partially superseded by**: [ADR-0019](0019-native-history-projection-across-harness-switches.md) for compatible Codex 0.151 idle rejoin and native history injection; the separate execution projection and Hook fallback remain in force

## Context

Codex Desktop and a separate App Server process cannot safely write the same native task. Codex Desktop may retain the task's exclusive writer lock even while its UI reports the task as idle. Public Codex App Server 0.148 has no attach-to-current-writer, release-other-writer, or Desktop-project assignment API. Repeatedly resuming that task from the connector therefore produces `already has an active writer`, blocks synchronization, and can flood the terminal.

## Decision

> Supersession note: the following prohibition records the Codex App Server 0.148 boundary. ADR-0019 replaces only that absolute prohibition for compatible 0.151 clients with an idle-state check, brief rejoin, and `thread/inject_items`. It does not permit mutation during an active Desktop turn or move Web execution into the visible task.

Each writable GatherThread session has two local Codex projections behind one `ProjectHarnessSessionBinding`:

1. A **Desktop projection** uses a `vscode`-source task and is owned exclusively by Codex Desktop. The connector never reads, resumes, injects into, compacts, executes on, renames, archives, or replaces this task after Desktop may own it. Trusted `UserPromptSubmit` and `Stop` hooks are the only publication path. `UserPromptSubmit` receives the bounded canonical delta as additional context; `Stop` durably queues the exact prompt and final assistant text for one idempotent local-turn commit. The public Stop payload does not include structured tools, so Desktop-originated tool events are omitted rather than recovered by opening a competing writer.
2. A **background execution projection** uses an `exec`-source task. It imports canonical history in server order, compacts locally, and executes Web **Request my agent** turns. It is never deep-linked or presented as the Desktop conversation. Its private state is stored separately from the Desktop Hook state.

The canonical server event log remains the convergence point. Web responses become canonical events and are supplied to the Desktop Agent at the next prompt boundary. Desktop turns are atomically uploaded and then projected into the background execution context. A repeated Hook receives the same persisted canonical delta, and network retries reuse the same local-turn identifier. Legacy `*-session.json` files remain the Desktop projection; the new background projection starts from canonical sequence zero in `*-execution.json`, so old Desktop tasks are preserved and never taken over.

Stable retry errors are coalesced and re-emitted at most once per minute, followed by one recovery notice.

## Consequences

### Positive

- Codex Desktop and GatherThread never compete for the same native task writer.
- Web execution, direct Desktop turns, offline outbox retries, and server-authoritative ordering remain available.
- Existing Desktop tasks are preserved without private database edits, forced archival, or destructive migration.
- The harness-neutral binding can later implement the same two-capability split for Claude Code or another harness when its UI and headless runtime have different ownership rules.

### Negative

- Canonical Web history is synchronized into Desktop Agent context at Hook turn boundaries; public Codex APIs cannot render those remote events as historical Desktop bubbles while Desktop exclusively owns the task.
- Cloud title changes are retained as canonical metadata and applied to the background projection, but the connector cannot force-rename a Desktop-owned task.
- Desktop-originated structured tool events are not uploaded with the current public Stop Hook payload.
- The background execution task is an implementation detail and has a separate native compaction state.

## Rejected alternatives

- **Retry the same task until Desktop releases it**: Desktop can retain the lock indefinitely while idle.
- **Kill or modify Desktop/private state**: unsafe, unsupported, and destructive.
- **Use one visible App Server task for Web execution**: the first Desktop open recreates the same ownership conflict.
- **Poll Desktop transcripts from another App Server**: still requires the conflicting writer and cannot provide reliable publication consent.
