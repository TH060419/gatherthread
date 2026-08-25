# ADR-0012: Activate synchronized Codex Desktop tasks with registered links

**Date**: 2026-08-25  
**Status**: accepted  
**Deciders**: Yuhan He  
**Builds on**: [ADR-0007](0007-project-harness-adapter-and-codex-app-server.md), [ADR-0009](0009-copyable-project-codex-connection-command.md), and [ADR-0010](0010-explicit-session-lifecycle-and-synchronized-names.md)  
**Supersedes**: [ADR-0011](0011-manual-codex-desktop-project-assignment.md)

## Context

GatherThread already creates one persistent native Codex task per writable shared session. A completed Web Agent request was present in the native task but could remain absent from the Desktop task list until that exact task was opened. Observed Desktop state changed from an unassigned task to the project backed by the same working directory immediately after exact task navigation. The installed application registers the validated `codex://threads/<UUID>` URL form for that navigation.

App Server itself still exposes no project identifier on `thread/start`. GatherThread therefore must not write Codex Desktop's private database or call private IPC. It must also avoid opening a task while the connector's App Server child still owns that task, and it must not manufacture an Agent turn merely to make an empty session visible.

## Decision

The connector opens the verified project workspace first. Each session continues to use one persistent App Server task with the exact name `GatherThread · <project> · <session>` and the verified workspace as `cwd`.

After a real synchronized Agent turn is durable and the operation-scoped App Server child has fully exited, the connector launches `codex://threads/<validated UUID>`. Current Codex Desktop builds have been observed to reveal that exact task and associate its working directory with the matching project. The operating-system launcher only confirms that it accepted the deep link; App Server exposes no resulting Desktop project identifier, so GatherThread does not claim a verified project-assignment receipt. A task that already contains native turns is activated once when the connector restarts. Successful launch is remembered only for the current connector process so ordinary polling and later turns do not repeatedly steal focus; a restart may safely activate the same task again.

The launcher is platform-specific and shell-safe: macOS uses `open`, Windows uses `cmd.exe /d /s /c start` with a UUID-only URL, and Linux uses `xdg-open`. GatherThread credentials are removed from the launcher environment. Invalid task identifiers are rejected before process creation. Launcher errors and timeouts do not stop synchronization and remain eligible for a later idempotent retry.

Canonical history projection remains independent from Desktop visibility. Context-only or empty sessions are not given synthetic user/Agent turns. Their first real synchronized Agent turn performs activation.

## Consequences

### Positive

- Current Codex Desktop builds reveal a completed cloud Agent conversation in the expected project without a manual move.
- The activation uses an application-registered route and files GatherThread owns, not Codex private storage.
- The App Server writer is released before Desktop is asked to open the task.
- Retries cannot execute the Agent request twice and successful activation does not repeat every polling cycle.

### Negative

- A session without a native turn may remain absent from the Desktop task list until its first real synchronized Agent turn.
- The operating system URL launcher can fail independently of canonical synchronization and cannot confirm the final Desktop project assignment.
- Opening the first completed task can change Desktop focus once.

### Safety checks

- Accept only canonical UUID task identifiers.
- Spawn launchers with `shell: false` and a credential-stripped environment.
- Call the launcher only after the state journal is durable and the App Server child has exited.
- Treat activation failure as fail-soft and never roll back canonical state.
