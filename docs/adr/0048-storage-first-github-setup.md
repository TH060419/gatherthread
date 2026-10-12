# ADR-0048: Storage-first GitHub setup and same-project authorization return

**Date**: 2026-10-12
**Status**: proposed / implementation review
**Deciders**: pending project-lead review

## Context

An initial Cloud Agent / computer-sync mode choice asks beginners to choose execution machinery before connecting their project files. GitHub authorization also leaves the page, so normal workspace startup can select the first project before the callback completes.

## Decision

Keep GitHub and GT Cloud in the existing file-collaboration panel, recommend GitHub first, and guide account connection, repository selection and file use on separate pages. Keep optional computer synchronization and advanced controls available after the account flow. The provider/view switches remain presentation-only. A bound repository may prefill a blank computer form; saving and exact-device upload consent remain separate operations.

Complete the existing OAuth callback before workspace project selection. Before leaving for GitHub, save only the current user, project and session IDs plus a timestamp in same-origin sessionStorage. Consume the hint once, require the same authenticated account and a ten-minute lifetime, and let normal membership checks resolve the destination. Never store OAuth code/state, passwords, keys or tokens in this hint. Clear callback fields from the URL before completing authorization; success and failure both return to useful settings, with a generic localized failure message.

## Alternatives

- Keeping a top-level execution-mode selector preserves the machinery-first problem.
- An arbitrary return URL would introduce redirect and validation risks. Bounded project/session IDs use the existing same-origin routing contract instead.
- Persisting the OAuth capability or copying it into return storage would add unnecessary secret exposure. The existing server authorization remains authoritative.

## Consequences and compatibility

This is a Web presentation and navigation change, with no server route, migration, repository permission or upload-policy change. Blocked storage, expired hints, different accounts and inaccessible projects safely fall back to normal workspace selection. Creating a repository still opens GitHub's own form for explicit confirmation. GT Cloud data and existing local bindings are not migrated or overwritten.

Tests cover callback ordering, account/expiry validation, single-use cleanup, absent storage, generic errors, default provider and native draft prefill. Isolated ordinary-pointer checks cover desktop, phone and tablet through synthetic GitHub responses; they do not assert a real OAuth installation or native Safari result.
