# ADR-0025: Separate Git-backed code checkpoints from conversation synchronization

**Date**: 2026-09-22
**Status**: proposed, implemented for local validation; pending project-lead review

## Context

Conversation synchronization shares context but does not transport project files. Collaborators need a durable source version, separate working copies, a review boundary, manual/automatic uploads and a recovery path independent of a model run. Existing Codex and DSH native tasks must keep their bound directory and must not silently inherit permission to upload files.

## Decision

Add an opt-in project code repository backed by standard bare Git objects. One branch belongs to each authenticated member/project, not an Agent or device. SQLite records authoritative heads, ACL and idempotent operation receipts; derived Git refs are repairable. Snapshot transport uses strict bounded authenticated JSON, not arbitrary Git URLs, shell commands or smart HTTP. Main integration uses three-way Git merges with expected-head checks and explicit project-owner review.

The owner can pause cloud code synchronization without deleting existing Git objects, branch heads or mutation receipts. An additive SQLite `enabled` column defaults to on for pre-existing repositories, and a paused repository can be resumed with the existing heads. The gate applies to source reads and writes as well as code jobs, except status and the user-controlled action that turns off local automatic upload. This does not cancel side effects of an already-running local process; operators should stop local work before pausing or resuming.

Reuse requester-private, exact-execution-runtime snapshot jobs for local code controls. Code jobs never grant local access: Codex requires `--code-sync` and reviewed Hooks, while the native DSH plugin requires separate project consent. Automatic source upload defaults off and is independent of conversation upload. A shared local module inventories eligible files, checks the acknowledged base, serializes sync operations, refuses dirty/unsafe downloads and supports new-directory recovery. It never changes the user's original Git index, branch, remote or native chat binding. The same APIs work on local-only, LAN HTTPS and self-hosted deployments.

## Alternatives and tradeoffs

- **Host Gitea immediately:** richer standard Git/PR hosting but additional deployment, account and credential infrastructure. Keep as a future backend/provider integration, not an implicit external dependency.
- **Git smart HTTP now:** native clone/push interoperability, but adds receive-pack policy, credential and object-validation attack surfaces before preview workflows are proven.
- **One shared writable branch/directory:** superficially simple but stale devices and concurrent Agents can overwrite one another. Use member branches and explicit merge instead.
- **Task-specific worktrees from day one:** better concurrent isolation, but silently relocating existing native tasks would break current bindings and tools. This first implementation keeps project-wide working copies. Automatic task worktrees and cross-harness file locking remain future work; users must not run simultaneous writers in one local directory.

## Invariants and consequences

- Existing event replay, chat upload, Agent routing, visible-history imports and context injection are unchanged.
- Every project reader can inspect every code branch; a personal branch or Solo session is not private code storage.
- Owner-only enable/merge, non-viewer member upload, revoked-device rejection and expected-head CAS are enforced server-side.
- Local code is never evaluated by the server. Keys/private state/unsafe paths are excluded or rejected; users still review upload scope.
- Restoring source creates a new directory and never deletes or rebinds existing work. Only uploaded eligible files are recoverable.
- Explicit snapshot/file/branch/mutation/storage caps bound the preview. Backups require both SQLite and Git object storage.
- This does not promise byte-by-byte realtime editing, automatic conflict resolution, cross-harness tool exclusion, arbitrary Git remote interoperability or preservation of an existing repository's entire history.

Validation includes strict protocol/ACL tests, stale-device and retry tests, real Git merge conflicts, dirty download and file-loss recovery, exact runtime jobs, DSH local consent, Web stale-review gates and existing regression suites. Upstream semantics: [Git merge-tree](https://git-scm.com/docs/git-merge-tree), [update-ref](https://git-scm.com/docs/git-update-ref), [ls-files](https://git-scm.com/docs/git-ls-files).
