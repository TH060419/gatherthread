# ADR-0002: Use device-bound identity and single-use session invitations

**Date**: 2026-08-25
**Status**: superseded by [ADR-0006](0006-project-first-collaboration-boundary.md)
**Deciders**: Yuhan He

## Context

An inviter must be able to grant access to a session without creating credentials for another person or retaining the ability to impersonate them. Server identity, session membership, and device authorization have different lifecycles and must be independently attributable and revocable.

## Decision

Disable public registration. The deployment operator creates the first identity through a local-only bootstrap. A session owner may create a single-use invitation bound to that session and to the `participant` or `viewer` role. The fixed expiry choices are one hour, 24 hours, and seven days; 24 hours is the default.

The recipient claims the invitation and receives a credential for their own device. An inviter never receives or reads the recipient's device credential. Existing users authenticate before claiming; a new user creates an identity and first device as part of the same atomic claim transaction. Invitations are stored as digests, can be revoked before use, expire automatically, and produce content-free audit metadata.

Every device has a distinct, revocable credential with issuance, last-use, expiry, rotation, and revocation state. Adding another device uses a separate short-lived, single-use device authorization flow rather than copying an existing long-lived credential. Deployment administration remains separate from the session `owner` role.

## Alternatives Considered

### Inviter creates the recipient identity and credential

- **Pros**: Minimal onboarding implementation.
- **Cons**: The inviter can permanently impersonate the recipient.
- **Why not**: It defeats trustworthy user and agent attribution.

### Public account registration

- **Pros**: No operator or inviter is required to create an account.
- **Cons**: Expands abuse, enumeration, rate-limit, and recovery requirements before the private collaboration flow is mature.
- **Why not**: The first release is private and invitation-only.

### Mandatory OIDC or SSO

- **Pros**: Delegates identity recovery and multi-factor authentication to a mature provider.
- **Cons**: Adds provider configuration, callbacks, availability dependencies, and privacy concerns to small self-hosted deployments.
- **Why not**: It is excessive for the zero-cost first-release deployment, but remains a future option.

## Consequences

### Positive

- Session owners can onboard collaborators without handling their credentials.
- User, membership, and device access can be revoked independently.
- Server-derived user, device, harness, and model attribution has a defensible identity chain.

### Negative

- Losing every authorized device requires an explicit operator-assisted recovery path in the first release.
- Invitation and device authorization flows add state, expiry, audit, and concurrency requirements.

### Risks

- Invitation links can be forwarded or stolen before use; mitigate with high-entropy secrets, short expiry, one-time consumption, digest-only storage, revocation, rate limits, and no URL logging.
- Device credentials can be stolen; mitigate with per-device tokens, peppered digests, rotation, last-use tracking, secure local storage, and rapid revocation.
