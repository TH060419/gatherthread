# ADR-0028: Separate test qualification from project invitations

**Date**: 2026-09-23
**Status**: proposed
**Deciders**: pending project-lead review

## Context

The original private Alpha used a project invitation for both first account creation and access to that project. After claiming it, every authenticated account could create its own project. That conflated permission to participate in a specific collaboration with permission to create new hosted workspaces. A project owner should be able to invite a guest into one project without issuing general Alpha testing qualification.

## Decision

Keep account identity and project membership separate. The deployment's first locally bootstrapped account and accounts activated with an operator-issued test qualification may create projects. Project creation still grants that creator the `owner` role only in the newly created project. A project invitation grants only its `participant` or `viewer` role in the named project and creates a project-scoped guest when claimed by a new person. An already qualified account retains its qualification when accepting a project invitation.

The operator issues a high-entropy, one-use `gtq_` test qualification in a private host terminal. It is stored only as a peppered digest, expires after a selected fixed TTL, can be revoked before claim, and is never used as a login credential after activation. Claiming it atomically creates an eligible account, one device credential and, when requested by a browser, an HttpOnly browser session. The new `gta_` device credential is shown once to its recipient and is used for subsequent login; the operator never receives that credential. Project invitations remain separately scoped, one-use `gti_` secrets. Neither type belongs in a URL, Git, logs, chat, or telemetry.

The account capability is checked in the SQLite write transaction for `POST /v1/projects` and the compatibility `POST /v1/sessions` path that could otherwise create a project implicitly. UI visibility is advisory. Display and device names are entered in a shared login area. They are required for either first-time claim and may be changed by an authenticated device during a later browser login.

For an existing database, migration marks the earliest bootstrap identity and users who already own projects as eligible; other pre-existing invitation-only identities become project-scoped guests. No project membership, device token, Cookie, canonical event or local Agent state is deleted or rewritten. A previously invited person who needs independent project creation should obtain a new test qualification account through the operator-approved onboarding flow; account merging is not part of this change.

## Alternatives considered

### Let project invitations grant general project creation

This preserves the old behavior but lets any project owner indirectly issue new site-wide creators, defeating the operator's invitation-only testing boundary.

### Reuse the operator-issued token as a permanent account password

A copied or forwarded enrollment token would remain a long-lived, non-device-bound login secret. Separate single-use qualification and revocable per-device credentials retain the existing attribution and recovery model.

### Give every guest an account-wide owner role

`owner` is a project membership, not a global account role. A guest can be a participant or viewer of each explicitly invited project without becoming its owner or gaining an unrelated project.

## Consequences and verification

The deployment operator must distribute test qualifications separately from project invitations, and a new guest cannot create projects even through older API routes. Test qualification issuance requires host database access and does not expose an Internet-facing administrator endpoint. Tests must cover one-use claim, expiry/revocation, digest-only storage, migration, full-versus-guest authorization, the compatibility route, browser login profile edits, Cookie/CSRF behavior, and the Web controls. The project lead must review this proposed contract and the filing implications before merge or deployment.
