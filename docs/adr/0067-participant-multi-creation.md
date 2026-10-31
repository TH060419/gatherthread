# ADR-0067: Participants may create Multi sessions

**Date**: 2026-11-01

**Status**: accepted

## Decision

Project participants may create Multi sessions as well as personal Solo sessions.
This supersedes the owner-only Multi creation restriction. The create dialog,
demonstration API and canonical server creation path use the same permission.
HTTP, MCP and native Agent integrations inherit the server decision.

Creation does not promote the participant to project owner. Invitations, role
changes and existing session management rules are unchanged. Viewers cannot
create sessions; removed members and revoked devices remain denied. Creation
retries recheck current authorization and retain existing idempotency semantics.
Empty Multi sessions are retained; automatic draft cleanup applies only to Solo.

The current permissions are maintained in [Product Spec](../PRODUCT_SPEC.md#permissions)
and [Security](../SECURITY.md), with regression coverage at database, HTTP,
native workspace and Web boundaries.
