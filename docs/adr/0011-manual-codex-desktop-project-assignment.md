# ADR-0011: Require manual Codex Desktop project assignment for managed tasks

**Date**: 2026-08-25  
**Status**: superseded by [ADR-0012](0012-activate-codex-desktop-tasks-with-registered-links.md)  
**Deciders**: Yuhan He  
**Builds on**: [ADR-0007](0007-project-harness-adapter-and-codex-app-server.md), [ADR-0009](0009-copyable-project-codex-connection-command.md), and [ADR-0010](0010-explicit-session-lifecycle-and-synchronized-names.md)  
**Partially supersedes**: ADR-0009's assumption that opening the generated working directory is sufficient to group App Server-created tasks in the corresponding Codex Desktop project

## Context

The connector can create or reuse a safe same-name local directory, open it in Codex Desktop, and use Codex App Server to create a persistent task named `GatherThread · <project> · <session>` for each eligible session. These capabilities are distinct from Codex Desktop project membership.

Codex 0.148 exposes no public API that assigns an App Server-created task to a Codex Desktop project. Opening the task's working directory does not perform that assignment. Treating directory equality or a successful Desktop reveal as proof of grouping caused the product and documentation to promise behavior the supported API cannot provide.

GatherThread must keep the existing credential-free macOS/Linux and Windows connection commands, per-session task isolation, automatic session discovery, and canonical synchronization while describing the Desktop limitation honestly.

## Decision

The connection command continues to create or exactly reuse the same-name local directory, open that local project in Codex Desktop, and create or synchronize one App Server task per eligible GatherThread session. The connector does not modify Codex Desktop's private project database and does not claim that these tasks were automatically grouped.

After the first synchronization, the user opens **Chats** in Codex Desktop, finds each exact `GatherThread · <project> · <session>` task, and selects **Move to project** → `<project>`. The user repeats this step for every task created when a new GatherThread session is discovered. Moving a task changes only its Desktop organization; the connector keeps the same native task identity, cursor, runtime, and canonical projection.

The Web **Connect Codex** dialog dynamically lists only the current project's live-writable session tasks for that user. It displays their exact expected names, the exact target project name, and the manual first-sync/new-session procedure next to both operating-system commands. An empty or snapshot-only project remains connectable and states that no editable task exists yet.

Documentation distinguishes these states:

1. the local project directory was created or reused;
2. the directory was opened in Codex Desktop;
3. App Server tasks were created and synchronized;
4. the user manually assigned each task to the Desktop project.

Only the fourth state establishes Desktop project grouping. A future supported public project-assignment API may supersede the manual step, but private database mutation is not an acceptable substitute.

## Alternatives Considered

### Infer grouping from the working directory

- **Pros**: No manual user action.
- **Cons**: Contradicts observed Codex 0.148 behavior and cannot be verified through the public API.
- **Why not**: It would preserve a false product claim and leave tasks under **Chats** instead of the intended project.

### Modify Codex Desktop's private project database

- **Pros**: Could appear to automate grouping.
- **Cons**: Unsupported, version-fragile, and risks corrupting user-owned Desktop state.
- **Why not**: GatherThread uses only supported public interfaces and local files it owns.

### Use one App Server task for the whole GatherThread project

- **Pros**: Only one manual move.
- **Cons**: Mixes sibling session histories, cursors, permissions, and offline reconciliation.
- **Why not**: Per-session native task isolation is a core synchronization and authorization boundary.

## Consequences

### Positive

- The UI and documentation match the supported Codex 0.148 behavior.
- Users receive exact task names and a deterministic recovery step instead of searching by approximation.
- Connection, synchronization, task identity, and Desktop organization remain clearly separated.
- No unsupported mutation of Codex Desktop state is introduced.

### Negative

- First connection requires one manual move per live-writable session.
- Every newly discovered session requires the same additional Desktop action.
- The connector cannot confirm through the public API that the user completed the move.

### Risks

- Users may continue in the ungrouped task under **Chats**. Keep the task fully functional there and repeat the instruction in the Web dialog and troubleshooting guide.
- Renamed sessions may be harder to match during a pending manual move. Always show the current exact authoritative task name in the dialog.
- A future Codex release may add a supported assignment API. Gate any automation on an explicit capability and supersede this ADR rather than inferring support from a version number.
