# ADR-0059: Right file workspace with provider-scoped personal-branch editing

- Date: 2026-10-18
- Status: proposed / local implementation
- Deciders: pending project-lead review

## Context

The conversation workspace needs a practical place to inspect and edit project files while retaining member and invitation controls. GT Cloud and GitHub have different storage and authorization boundaries. A browser editor must preserve unsaved work without granting authority to shared main, another member's branch, a historical version or a new account/project selection.

## Decision

Use one flush right sidebar with an ordered, browser-style tab strip. Files, Members, and each open file can be closed independently and reopened from the new-tab picker or Members entry. Keep only New tab and More above the content; put the open-tab list, expand/restore and collapse actions in More. A compact persistent app-header toggle shows/hides the panel without closing tabs, changing the active file, or discarding drafts. Keep file buffers separate from tab order; batch-close operations confirm all unsaved work before removing any tab. Move the original member controls into the Members pane without cloning them. Reuse the workspace on mobile as a full-screen page, and allow desktop expansion for editing. CodeMirror provides source editing and diff views; Markdown has editable source and sanitized rendered preview, while images and PDF use bounded previews with bundled dependencies.

Add strict project-scoped file endpoints with an explicit `gt-cloud|github` provider. Return tree metadata before fetching selected content. GT Cloud reuses its bare Git repository, SQLite heads, quotas and receipts. GitHub uses the requester's existing App authorization and explicit repository binding, serves selected source through the authenticated server, and publishes only the stable personal branch. Shared main/base and other members remain read-only. Existing local-device sync, hosted Agent execution, branch review/merge and PR publication retain their separate controls.

Keep editor drafts in page memory, preserve them across tabs and source/preview switches, and confirm before discarding them. Account/project changes invalidate pending reads, dialogs, imports and editor callbacks. Saves pin each buffer's loaded head and connection revision and use a stable idempotency key; a refreshed explorer cannot rebase another open draft. A repository revision change clears the clipboard and blocks the old buffers until explicit reload. Conflicts retain drafts for review; unknown acceptance offers an explicit retry of the exact original request. GitHub uses non-force ref updates, local serialization and result verification, with a durable receipt for uncertain publication. External writers still require conflict handling.

## Alternatives considered

- Reuse the existing file-sync dialog as the editor: its connection and native-device actions do not provide persistent file tabs or room for source review.
- Add a separate mobile editor and duplicate member controls: duplicate IDs, state and event handlers would diverge from the desktop workflow.
- Read and edit arbitrary GitHub refs: this would expand authority beyond project member branches and bypass the stable personal-branch review model.
- Persist draft source in browser storage: this introduces durable source retention and account-switch cleanup beyond the transient workspace requirement.

## Consequences

The browser can inspect current project branches and make bounded changes to its own branch without requiring an online local Agent. Source visibility remains project-wide and GitHub access still requires each requester's own repository permission. File tabs preserve drafts but do not provide a cross-Agent filesystem lock or execute project code. Browser safety limits can require GitHub or native Git for larger or protected content.

The additive GitHub receipt table records identity/revision fingerprints and prepared commit IDs, not source snapshots or credentials. Ref publication cannot recall an already-dispatched remote request; generation checks and same-key reconciliation bound that uncertainty. Server and Web must deploy compatible file schemas together. This ADR describes local source changes, not a release, merge or deployment authorization.

[Interface contracts](../INTERFACE_CONTRACTS.md#browser-file-workspace-local-implementation) own endpoint shapes, limits, permission rules and errors. [Code collaboration](../CODE_SYNC.md#browser-file-workspace--网页文件工作区) owns the user workflow.
