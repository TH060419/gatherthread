# ADR-0031: In-session quote references and member mentions

**Date**: 2026-09-27
**Status**: proposed; pending project-lead review
**Deciders**: pending project-lead review

## Context

Collaborators need to refer to a particular shared message and notify a particular person without copying canonical history or confusing a human Chat with an Agent request. The existing event envelope already supports reply references; flexible payloads need a strict validated mention shape.

## Decision

Reuse `reply_to_event_id` for user-authored quotes without reinterpreting Agent-response linkage. Resolve sources only within the same session and prevent public quotes of owner-only events. Preserve the source event rather than adding a client-authored quotation snapshot.

Store bounded, membership-validated mention identity and UTF-16 text ranges in the user-message payload. An authenticated project inbox derives the caller's mentions from canonical storage with current ACL and visibility checks. Picking a member is explicit; `@` text alone is not a notification. This release uses temporary per-tab read markers, not a separate durable notification database.

## Consequences and validation

Older clients still display message text. No migration or new event type is required. Quotes and mentions do not change runtime routing, Solo/Multi write permissions or claim handling. Tests cover cross-session/private references, member/text mismatch, idempotency, HTTP authorization, keyboard selection, jump navigation and body-only copying. Cross-device unread synchronization and external push are outside this change.
