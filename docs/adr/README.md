# Architecture Decision Records

Architecture Decision Records document significant technical choices, their rationale, and their consequences. Accepted records remain in this index even when a later ADR supersedes them.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-trusted-self-hosted-collaboration-server.md) | Trust the self-hosted collaboration server with canonical plaintext | accepted | 2026-08-25 |
| [0002](0002-device-bound-identity-and-session-invitations.md) | Use device-bound identity and single-use session invitations | superseded by 0006 | 2026-08-25 |
| [0003](0003-single-owner-hosted-deployment.md) | Use one owner-hosted authoritative server per deployment | accepted | 2026-08-25 |
| [0004](0004-adopt-gatherthread-project-name.md) | Adopt GatherThread as the project name | accepted | 2026-08-25 |
| [0005](0005-managed-codex-thread-bridge.md) | Manage one local Codex thread per GatherThread session mapping | superseded by 0006 and 0007 | 2026-08-25 |
| [0006](0006-project-first-collaboration-boundary.md) | Use projects as the collaboration and local-agent binding boundary | partially superseded by 0015 | 2026-08-25 |
| [0007](0007-project-harness-adapter-and-codex-app-server.md) | Use a project harness adapter and Codex App Server | partially superseded by 0008 | 2026-08-25 |
| [0008](0008-local-agent-conversations-as-rebuildable-projections.md) | Treat local agent conversations as rebuildable projections of canonical history | partially superseded by 0013 | 2026-08-25 |
| [0009](0009-copyable-project-codex-connection-command.md) | Use a copyable project command for the first Codex connection | partially superseded by 0010 and 0012 | 2026-08-25 |
| [0010](0010-explicit-session-lifecycle-and-synchronized-names.md) | Start projects empty and synchronize session names | partially superseded by 0015 | 2026-08-25 |
| [0011](0011-manual-codex-desktop-project-assignment.md) | Require manual Codex Desktop project assignment for managed tasks | superseded by 0012 | 2026-08-25 |
| [0012](0012-activate-codex-desktop-tasks-with-registered-links.md) | Activate synchronized Codex Desktop tasks with registered links | partially superseded by 0013 | 2026-08-25 |
| [0013](0013-single-writer-dual-codex-projections.md) | Use single-writer dual projections for Codex Desktop | accepted | 2026-08-26 |
| [0014](0014-acknowledged-bounded-desktop-relay-capsules.md) | Use acknowledged bounded capsules for Desktop cloud relay | partially superseded by 0015 | 2026-08-26 |
| [0015](0015-create-personal-solos-from-first-local-prompt.md) | Create creator-owned Solo sessions from the first local prompt | accepted | 2026-08-26 |
