# ADR-0037: Separate test admission from accounts and native authorization

**Date**: 2026-10-03
**Status**: proposed
**Deciders**: Yuhan He

## Context

The lead needs a private testing service at `test.gatherthread.cn` before production promotion, including the independently reviewed PR62 email-account replacement. A testing code must grant environment admission without becoming another account, password, qualification activation or native-device credential.

## Decision

Use the same build with a default-disabled production admission boundary, separate deployment configuration and separate writable stores. Test mode requires its admission gate and isolated HTTPS Origin. Admission grants and browser sessions live in a separate SQLite store using independent peppered, Origin-scoped digests and Host-only HttpOnly Secure SameSite Cookies. The boundary runs before all account routes and checks existing authenticated browser APIs too. Production behavior stays unchanged.

Native connectors retain their own independently revocable device credentials. Exact one-use pairing/authorization routes retain their original validators. A valid native device bearer permits only an explicit connector API set; no admission code appears in a connector command. Realtime tickets remain session-scoped and distinguish browser admission from native device authorization. Existing project permissions remain authoritative.

The test branch uses the PR62 account implementation already merged into main. It does not rewrite account logic. A direct library configuration without account options displays a pending page. Test mail uses a presentation-only transport seam in the existing provider. Two-stage deployment uses a fixed commit and identical build artifact, separate backups and explicit human promotion, with no automatic change to production.

## Alternatives

Replacing account login with the testing code would merge environment access with account identity and break independent account/device revocation. UI-only hiding would leave direct API bypasses. Sharing production SQLite, Git storage, peppers or parent-domain Cookies would defeat environment separation. A long-lived source fork would make the tested artifact differ from production.

## Consequences

Same-email test and production accounts can have independent passwords and data. The gate is additional access control, not protection against a malicious authorized tester or a resource-isolation guarantee by itself. Deployment must enforce Unix permissions, storage quotas and provider configuration. Revoking admission intentionally leaves an already authorized native device active until account-device revocation. The branch remains source preparation until its own review and deployment checks are complete. See [test operations](../TEST_ENVIRONMENT.md) for the normative deployment and verification procedure.
