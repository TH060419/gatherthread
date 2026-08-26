# ADR-0007: Use a project harness adapter and Codex App Server

**Date**: 2026-08-25
**Status**: partially superseded by [ADR-0008](0008-local-agent-conversations-as-rebuildable-projections.md)
**Deciders**: Yuhan He
**Builds on**: [ADR-0006](0006-project-first-collaboration-boundary.md)

## Context

The first Codex connector used `codex exec --json` and persisted one exec thread ID per GatherThread session. Those threads retained native Codex context but were classified as non-interactive `exec` sessions, had no project/session name, and were omitted from the Codex desktop application's normal project-task view. The connector also embedded project discovery and Codex process details in one loop, which would make future Claude Code or DeepSeek Harness support unnecessarily invasive.

GatherThread needs a project-level integration boundary while retaining one independent native harness conversation per shared session. It must continue to keep credentials local, prohibit automatic privilege escalation, serialize turns that share a workspace, and preserve the canonical server event log as the collaboration source of truth.

## Decision

Introduce a harness-neutral `ProjectHarnessAdapter`. The project connector owns authorization, eligible-session discovery, canonical cursors, runtime registration, and serialized scheduling. An adapter owns harness preflight, process protocol, runtime metadata, local session identity, and creation of one `HarnessExecutor` for each eligible shared session.

Use the local Codex App Server over stdio JSON-RPC as the first adapter. One App Server process serves the connected GatherThread project. Every eligible GatherThread session receives its own persistent Codex thread, named `GatherThread · <project> · <session>` and bound to the selected project working directory. Threads use the interactive `vscode` source classification used by the current Codex desktop application, while `serviceName=gatherthread` and the explicit name preserve origin attribution. The connector never exposes App Server over a network listener.

The first server-authorized request creates the native thread, hydrates that session's complete visible canonical history, and starts a turn. Later requests resume the same thread and hydrate only the canonical delta. An old version-1 `codex exec` mapping is deliberately migrated to a fresh App Server thread on its next request because resuming or renaming the old thread does not change its non-interactive source classification. The canonical history rebuilds context; the old native transcript is not deleted.

App Server requests run with `approvalPolicy=never` and the selected `read-only` or `workspace-write` sandbox. Unexpected bidirectional approval or interaction requests fail closed. GatherThread credentials are removed from the child environment, JSON messages and tool outputs are bounded, final responses exclude reasoning, and uploaded content passes through the shared redactor.

Codex desktop exposure does not change the collaboration authority boundary. In this release, turns initiated from the GatherThread Web interface are written to the canonical log and appear in the corresponding desktop thread. A prompt typed directly into that desktop thread remains local and is not automatically uploaded to collaborators. Native direct-turn import requires a separate origin-aware design so the connector cannot duplicate its own hydration turns or silently publish private local work.

ADR-0008 later supplies that origin-aware design through explicitly trusted project Hooks, durable idempotent local-turn commits, and canonical-first reconciliation. The App Server and harness-adapter decisions in this record remain in force.

## Alternatives considered

### Continue with `codex exec`

- **Pros**: Smaller one-shot process surface.
- **Cons**: Threads remain hidden from the normal desktop project view and cannot receive stable user-facing names through the exec interface.
- **Why not**: It does not satisfy the desktop project-continuity requirement.

### One App Server process per session

- **Pros**: Strong process isolation.
- **Cons**: Repeats startup work, multiplies local resource use, and does not match the project-level connection lifecycle.
- **Why not**: One local project process can safely serialize independent session threads.

### Upload every desktop transcript change automatically

- **Pros**: Direct desktop prompts would immediately become shared collaboration history.
- **Cons**: Hydration prompts and private local turns require reliable origin labelling; importing them incorrectly can duplicate canonical events or disclose work the user did not choose to share.
- **Why not now**: GatherThread keeps explicit `chat` versus `request_agent` intent and does not infer publication consent from an arbitrary native thread event.

## Consequences

### Positive

- GatherThread-created Codex work uses named, persistent native threads associated with the same local project directory.
- One connector still follows all eligible current and future sessions without mixing their histories.
- Claude Code, DeepSeek Harness, and other integrations can implement the same adapter boundary without changing project authorization or scheduling.
- Legacy exec mappings migrate without deleting canonical or native history.

### Negative

- App Server protocol compatibility must be tested against supported Codex versions.
- Empty native threads are not guaranteed to appear in the desktop task list until their first completed turn.
- Direct prompts entered in Codex desktop remain local in this release.

### Risks

- A future Codex release may change source classification or JSON-RPC fields. Keep contract tests, fail closed on malformed responses, and verify the bundled CLI during preflight.
- Two clients may try to drive the same native thread. The connector serializes its own turns; users should avoid sending a direct desktop prompt while the Web-triggered turn is running.
