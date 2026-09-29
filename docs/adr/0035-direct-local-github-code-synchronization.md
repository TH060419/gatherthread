# ADR-0035: Synchronize GitHub source directly from authorized local devices

**Date**: 2026-09-30
**Status**: proposed / unreleased source preview; pending project-lead review

## Context

The existing GatherThread cloud checkpoint store is bounded for small projects and trial use. Longer-lived collaboration benefits from a separately administered GitHub repository and its normal review workflow. Extending server storage limits alone would leave the collaboration host responsible for more source and credentials. This decision adds a storage option without migrating existing cloud checkpoints or changing conversation synchronization.

## Decision

Keep GitHub source transport on each explicitly authorized local device. A shared local code-sync engine uses an isolated private Git repository and HTTPS transport to `github.com`, with the device's local GitHub CLI credential helper. GatherThread's server stores only strict repository/base/enablement/revision metadata and requester-private bounded control-job results. It never acts as a GitHub source proxy or receives the GitHub credential.

Only the active GatherThread project owner may configure its GitHub connection. Updates use expected-revision comparison; exact repeated content returns the existing revision. Effective changes receive a new revision, including pause/resume, and atomically fail outstanding GitHub jobs so an old request cannot execute against a new target after renewed consent. Local consent is bound to the configuration and existing server/project/user/workspace identity. It must be renewed after a changed configuration. A browser job cannot grant that consent or silently redirect an authorized device.

Use one stable personal branch per GatherThread project/user: `gatherthread/<first 24 hex of SHA-256(project ID)>/<first 24 hex of SHA-256(user ID)>`. Normal pushes advance only that branch and do not force-update it or write the shared base/default branch. Users review and merge through their regular GitHub workflow. Updating from the base creates a merge on the personal branch; conflicts and stale heads fail closed. GitHub repository rights remain independent from GatherThread roles and are enforced by GitHub with the local user's identity.

Reuse exact same-user execution-runtime jobs for Codex and DSH while keeping cloud and GitHub request kinds separate. Both paths retain explicit file-access consent, idle/stability checks, clean-baseline downloads and new-directory recovery. Cloud automatic upload starts off; a newly authorized local GitHub binding starts it on, and a user's off choice survives reconnects. They do not change the workspace's original Git index/branch or native conversation binding. GitHub source does not count against GatherThread storage quotas. The local GitHub preview safely handles up to 10,000 eligible regular files, 20 MiB each and 128 MiB total snapshot content; use native Git for larger or unsupported repositories. Symlinks, submodules, LFS pointers, private/unsafe paths and tracked generated trees are refused.

## Consequences

The existing cloud backend remains useful for small trials and keeps its independent quotas, consent, cleanup and pause behavior. GitHub is the recommended source-storage option for longer-term or larger projects within the preview limits. No connection change implicitly copies between backends.

A GatherThread project invitation does not grant GitHub access; a private project does not make a public repository private. GatherThread member removal, project deletion and pause do not revoke GitHub permissions or delete any remote branch, repository, clone or backup. A push already in flight may complete. Repository administrators must manage GitHub access, visibility, branch rules and retention separately. Pushes, including automatic uploads, may trigger GitHub Actions; the user must review that repository's workflows before enabling automation.

This preview adds no automatic PR creation/merge, remote repository creation/deletion, force push, historical-version picker, LFS support, arbitrary host/SSH transport or native Agent/editor filesystem lock. Synchronization operations share a local workspace lock; other tools may still write files. GitHub history and ordinary clones remain available through native tools independently of GatherThread, subject to GitHub authorization.

## Alternatives

- Increase only the GatherThread server quota: insufficient separation of collaboration metadata and long-term source storage.
- Proxy GitHub source or tokens through the server: unnecessarily expands the server trust boundary.
- Reuse the current workspace repository: risks changing user remotes, index, branch or executable Git configuration.
- Share one writable remote branch: makes independent device or user work harder to reconcile and bypasses personal review branches.

## Validation and release boundary

Required checks cover strict metadata schemas, project-owner CAS, current membership and device checks, migration, exact runtime jobs, independent pause gates, local consent revision changes, fake/offline Git transport, fast-forward races, unsupported trees, dirty downloads and recovery. A passing local suite is not evidence of live GitHub, browser, Windows or macOS acceptance. No published version or deployment is asserted by this record; release notes must identify completed platform and live-service checks before publication.

The operator workflow is in [CODE_SYNC.md](../CODE_SYNC.md), wire contracts in [INTERFACE_CONTRACTS.md](../INTERFACE_CONTRACTS.md), and trust boundaries in [SECURITY.md](../SECURITY.md). Upstream behavior: [Git push](https://git-scm.com/docs/git-push), [GitHub CLI login](https://cli.github.com/manual/gh_auth_login), [Actions push events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).
