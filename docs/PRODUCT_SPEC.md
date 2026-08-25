# Product specification v0.1

## Goal

Enable multiple people to collaborate on an agent-assisted project while each person keeps using their own local harness, model, credentials, filesystem, and context-management policy.

## Session modes

### Solo

The owner is the only participant allowed to submit agent requests or append local agent output. Invited viewers can read the complete shared event history and approved context snapshots in real time. Ownership and viewer access are revocable.

### Multi

Members can append human chat and agent requests. A human chat event is shared and included in future context hydration but does not trigger a local agent. An agent request is assigned to the initiating user's registered local runtime. The resulting response is appended to the same canonical history.

## Canonical event types

- `human_chat`
- `agent_request`
- `agent_response`
- `tool_call`
- `tool_result`
- `attachment`
- `context_snapshot`
- `membership_change`
- `session_state_change`

Every event has a server-assigned monotonic sequence, stable event ID, idempotency key, actor identity, timestamp, visibility, reply target, and optional runtime provenance.

Runtime provenance contains `user_id`, `device_id`, `harness`, `provider`, `model`, `local_session_id`, and capture fidelity.

## Context fidelity

The product distinguishes three claims:

1. `canonical_history`: all accepted shared events through a server sequence.
2. `harness_transcript`: all events captured from a supported local harness transcript.
3. `provider_request`: the exact request context submitted to an LLM provider, available only when a harness hook or authorized proxy can observe it.

An upload must state its fidelity. A reconstructed transcript must never be labelled as an exact provider request.

## Compaction

The server retains canonical events. Each local harness may build a private projection or compacted summary for its own context window. Compactions are not canonical shared history. A client may record only metadata such as `covers_through_seq` and the local projection ID.

## Permissions

- `owner`: manage session, membership, retention, and all messages.
- `participant`: read and append allowed multi-session events.
- `viewer`: read only.

Solo sessions reject participant writes except from the owner. Multi sessions serialize agent turns per local runtime while allowing concurrent human chat.

## Identity, invitations, and devices

Public registration is disabled. The deployment operator creates the first owner locally. A session owner may create a single-use invitation for `participant` or `viewer`; solo sessions allow viewer invitations only. Expiry choices are one hour, 24 hours, and seven days, with 24 hours as the default.

A new collaborator claims an invitation to create their own server identity and first device credential atomically. An existing authenticated user can accept an invitation without receiving a new credential. An inviter never handles another user's device credential. Each additional device uses its own ten-minute, single-use authorization and receives an independently revocable token.

## First-release deployment

One participating user runs the only active authoritative server for a deployment. The service and SQLite bind to the host loopback interface and are shared with named collaborators through private Tailscale Serve HTTPS. Other users run only their local Web client, MCP process, bridge, and harness. Public Funnel, router port forwarding, multi-primary replication, and automatic failover are outside the first release.

## Realtime guarantees

- Server assigns total order per session.
- Clients resume from a cursor after reconnect.
- Repeated writes with the same idempotency key return the original event.
- WebSocket delivery is advisory; the durable event log is authoritative.
- Slow or disconnected clients recover through paginated replay.

## First release acceptance criteria

1. Two authenticated users can join a multi session from separate clients and see ordered live updates.
2. `human_chat` never triggers an agent but is included in the next hydration payload.
3. `agent_request` is claimed by the initiating user's registered bridge and produces a provenance-labelled response.
4. A solo viewer can follow the owner but cannot append any event.
5. Codex and Claude Code transcript import/tail preserve visible user, assistant, tool-call, and tool-result events.
6. Reconnect replay, idempotent append, role enforcement, redaction, and concurrent writes have automated tests.
7. A new user can claim a one-use role-bound invitation without exposing their device credential to the inviter.
8. A second device requires a separate expiring authorization and can be revoked without revoking the user's other devices.
9. One loopback owner host serves Web, API, and WebSocket on a private HTTPS origin without a public application port.
