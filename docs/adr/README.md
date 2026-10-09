# Architecture Decision Records

Architecture Decision Records document significant technical choices, their rationale, and their consequences. Accepted records remain in this index even when a later ADR supersedes them.

Current account guidance (2026-10-08): `main` uses verified-email registration and password sign-in, with independent native-device authorization. Public Beta accounts are not invitation-only; project invitations and isolated test admission are separate. Earlier qualification/token/vault decisions below are historical, not current signup instructions. See [PRODUCT_SPEC](../PRODUCT_SPEC.md#browser-entry-flow) and the default-closed [operator preflight](../OPERATIONS.md#public-beta-registration-preflight); original ADR statuses and release decisions are preserved.

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
| [0010](0010-explicit-session-lifecycle-and-synchronized-names.md) | Start projects empty and synchronize session names | partially superseded by 0015 and 0016 | 2026-08-25 |
| [0011](0011-manual-codex-desktop-project-assignment.md) | Require manual Codex Desktop project assignment for managed tasks | superseded by 0012 | 2026-08-25 |
| [0012](0012-activate-codex-desktop-tasks-with-registered-links.md) | Activate synchronized Codex Desktop tasks with registered links | partially superseded by 0013 | 2026-08-25 |
| [0013](0013-single-writer-dual-codex-projections.md) | Use single-writer dual projections for Codex Desktop | partially superseded by 0019 | 2026-08-26 |
| [0014](0014-acknowledged-bounded-desktop-relay-capsules.md) | Use acknowledged bounded capsules for Desktop cloud relay | partially superseded by 0015 and 0019 | 2026-08-26 |
| [0015](0015-create-personal-solos-from-first-local-prompt.md) | Create creator-owned Solo sessions from the first local prompt | accepted | 2026-08-26 |
| [0016](0016-independent-cloud-and-local-session-titles.md) | Keep cloud and local session titles independent | accepted | 2026-08-28 |
| [0017](0017-private-connection-profiles.md) | Support local, private LAN, and tailnet connection profiles | accepted | 2026-08-30 |
| [0018](0018-unified-codex-plugin-and-connector.md) | Pair a Codex plugin with the persistent npm connector | partially superseded by 0034 | 2026-09-06 |
| [0019](0019-native-history-projection-across-harness-switches.md) | Project canonical history into native sessions across harness switches | accepted | 2026-09-06 |
| [0020](0020-per-conversation-upload-consent-and-manual-recovery.md) | Add per-conversation upload consent and manual recovery | accepted | 2026-09-15 |
| [0021](0021-import-visible-codex-history-as-a-new-task.md) | Import visible Codex history as a new task | compact policy clarified by 0026 | 2026-09-16 |
| [0022](0022-place-the-product-home-above-the-same-origin-application.md) | Place the product home above the same-origin application | accepted | 2026-09-17 |
| [0023](0023-lease-and-bounded-redispatch-agent-claims.md) | Lease exact-runtime agent claims and fence recovery attempts | accepted | 2026-09-20 |
| [0024](0024-runtime-advertised-dsh-model-selection.md) | Use runtime-advertised profiles for DSH model selection | accepted | 2026-09-22 |
| [0025](0025-opt-in-git-backed-code-checkpoints.md) | Separate Git-backed code checkpoints from conversation synchronization | proposed / source preview | 2026-09-22 |
| [0026](0026-native-first-context-management.md) | Separate native context management from synchronization transport bounds | proposed / source preview | 2026-09-22 |
| [0027](0027-shared-manual-history-summaries.md) | Add shared manual summaries and derived Agent context | proposed / source preview | 2026-09-23 |
| [0028](0028-separate-test-qualification-from-project-invitations.md) | Separate test qualification from project invitations | superseded for user onboarding by proposed 0036 | 2026-09-23 |
| [0029](0029-separate-remembered-browser-vault-from-active-sessions.md) | Separate remembered-browser choices from active sessions | superseded for user login by proposed 0036 | 2026-09-24 |
| [0030](0030-resolve-cloud-branches-before-project-member-removal.md) | Resolve cloud branches before project-member removal | proposed | 2026-09-24 |
| [0031](0031-in-session-quotes-and-member-mentions.md) | In-session quote references and member mentions | proposed | 2026-09-27 |
| [0032](0032-harness-advertised-model-catalogs.md) | Discover offered models from each connected harness | proposed | 2026-09-27 |
| [0034](0034-optional-local-codex-launchers.md) | Use optional local Codex Launchers on Windows and macOS | proposed / source preview | 2026-09-28 |
| [0033](0033-isolated-onboarding-example.md) | Isolate onboarding in a disposable example project | proposed | 2026-09-28 |
| [0035](0035-direct-local-github-code-synchronization.md) | Synchronize GitHub source directly from authorized local devices | proposed / unreleased source preview | 2026-09-30 |
| [0036](0036-verified-email-registration-and-password-login.md) | Verified-email-only user accounts and independent device authorization | proposed / unreleased source preview | 2026-09-30 |
| [0037](0037-isolated-test-environment-admission.md) | Separate test admission from accounts and native authorization | proposed | 2026-10-03 |
| [0038](0038-isolated-hosted-trial-agent.md) | Run the hosted trial Agent with OpenCode in an isolated container | proposed / source preview | 2026-09-30 |
| [0039](0039-cloud-github-repository-tasks.md) | Private cloud GitHub tasks with explicit PR publication | proposed / source preview | 2026-09-30 |
| [0040](0040-explicit-single-cpu-hosted-compatibility.md) | Explicit single-CPU hosted compatibility | accepted for implementation; deployment-host activation gated | 2026-10-09 |
