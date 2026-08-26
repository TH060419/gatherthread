# Product specification v0.1

## Goal

Enable multiple people to collaborate on an agent-assisted project while each person keeps using their own local harness, model, credentials, filesystem, and context-management policy.

## Project collaboration boundary

A project groups related sessions and is the stable membership, invitation, and local-agent binding boundary. Creating a project atomically creates only its owner membership; an owner or participant then creates an eligible first session explicitly. Existing sessions named `General` are preserved, but new and historical projects are never backfilled with one. A project invitation grants access to the project's current and future sessions. The project owner creates and renames `multi` sessions and can change every other member between `participant` and `viewer`. Owners and participants create and rename only their own personal `solo` sessions.

One collaborator maps the project to one local working directory and harness configuration. Sessions inside that project keep independent canonical histories, cursors, native agent conversations, and local compaction.

## Session modes

### Solo

The Solo creator is the only member allowed to write or submit agent requests while that creator still has a non-viewer project role. Every other member, including the project owner for a participant-created Solo, can read the complete shared event history and approved context snapshots but cannot mutate it.

### Multi

Project owners and participants can append human chat and agent requests. A human chat event is shared and included in future context hydration but does not trigger a local agent. An agent request is assigned to the initiating user's registered local runtime. The resulting response is appended to the same canonical history. Viewers remain read only.

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

Every event has a server-assigned monotonic sequence, stable event ID, idempotency key, actor identity, frozen actor display name, timestamp, visibility, reply target, and optional runtime provenance.

Internal runtime provenance binds `user_id`, `device_id`, runtime identity, `harness`, `provider`, `model`, native-session identity, and capture fidelity. Shared attribution exposes the username, harness, provider, model, and fidelity while replacing local device, runtime, and native-session identifiers outside the owning user or authorized owner view.

## Context fidelity

The product distinguishes three claims:

1. `canonical_history`: all accepted shared events through a server sequence.
2. `harness_transcript`: all events captured from a supported local harness transcript.
3. `provider_request`: the exact request context submitted to an LLM provider, available only when a harness hook or authorized proxy can observe it.

An upload must state its fidelity. A reconstructed transcript must never be labelled as an exact provider request.

## Compaction

The server retains canonical events. Each local harness may build a private projection or compacted summary for its own context window. Compactions are not canonical shared history. A client may record only metadata such as `covers_through_seq` and the local projection ID.

## Permissions

| Project role | `multi` | `solo` | Project administration |
|---|---|---|---|
| `owner` | read, chat, request/live-sync Agent | write own Solo; read/download other Solos | multi sessions, invitations, roles, retention |
| `participant` | read, chat, request/live-sync Agent | write own Solo; read/download other Solos | create personal Solo only |
| `viewer` | read and download immutable local snapshots | read and download immutable local snapshots | none |

Solo sessions reject every writer except their immutable creator, and a viewer downgrade also disables that creator. Viewer sessions reject every conversation write and execution-runtime registration. Multi sessions serialize agent turns per local runtime while allowing concurrent human chat. Apart from creator ownership on Solo, session-specific membership overrides are outside the first release.

## Local project synchronization

One connector binds an accessible GatherThread project to one local working directory. The Web project page generates separate credential-free macOS/Linux and Windows commands. Every live-writable Codex session has a Desktop-owned interactive task and a distinctly labelled background execution projection. Web Agent requests run only in the background; trusted Hooks upload Desktop turns and provide the next acknowledged canonical capsule at the following local prompt. The visible response shows no more than three short previews, while exact bodies remain bounded model context. Oversized events resume across completed turns from a durable UTF-8 checkpoint, and cancellation never advances delivery. A completed background projection that is externally claimed is replaceable from canonical history, while unresolved execution remains fail-closed. Human chat is authored only in GatherThread and becomes context without triggering the local Agent. [ADR-0013](adr/0013-single-writer-dual-codex-projections.md) records the single-writer boundary, and [ADR-0014](adr/0014-acknowledged-bounded-desktop-relay-capsules.md) records the relay contract.

With reviewed project hooks installed and trusted, a completed prompt typed directly into a managed local conversation is an Agent request. The connector persists the request, allowed redacted tool events, and final response in an idempotent outbox before uploading the complete turn atomically. The server assigns its canonical position and returns the event bindings; retries cannot create another request or Agent run for the same local turn. Without trusted hooks, direct desktop turns remain local and are not inferred from native history.

Server order wins after an offline period. When no cloud event followed the local base cursor, the connector binds the accepted IDs without rebuilding. When the cloud advanced, the local turn is appended after the server head and the connector creates a new local conversation from canonical history, compacting as necessary for that harness and model. It verifies the target sequence before switching, preserves the prior local conversation as an `offline fork`, and never rolls back local source files.

Read-only access is download rather than synchronization. Each **Download to Codex** action freezes the session at the current `through_sequence` and creates a fresh immutable native conversation for that requester. It never receives future cloud events or publishes local activity; another click creates another independent snapshot.

The project scheduling contract is harness-neutral through `ProjectHarnessAdapter`. The built-in first implementation targets Codex App Server. Claude Code and DeepSeek Harness integrations can supply their own descriptor, preflight, native-session identity, execution, projection, compaction, and snapshot behavior without changing project authorization or server ordering.

## Identity, invitations, and devices

Public registration is disabled. The deployment operator creates the first identity locally. A project owner may create a single-use project invitation for `participant` or `viewer`. Expiry choices are one hour, 24 hours, and seven days, with 24 hours as the default.

A new collaborator claims an invitation to create their own server identity and first device credential atomically. An existing authenticated user can accept an invitation without receiving a new credential. An inviter never handles another user's device credential. Each additional device uses its own ten-minute, single-use authorization and receives an independently revocable token.

## First-release deployment

One participating user runs the only active authoritative server for a deployment. The service and SQLite bind to the host loopback interface and are shared with named collaborators through private Tailscale Serve HTTPS. Other users run only their local Web client, MCP process, bridge, and harness. Public Funnel, router port forwarding, multi-primary replication, and automatic failover are outside the first release.

## Realtime guarantees

- Server assigns total order per session.
- Clients resume from a cursor after reconnect.
- Repeated writes with the same idempotency key return the original event.
- A completed local native turn commits its request, bounded tool events, and response in one server transaction; an exact retry returns the original event set.
- WebSocket delivery is advisory; the durable event log is authoritative.
- Slow or disconnected clients recover through paginated replay.
- Local outboxes retry after reconnect; canonical divergence is resolved by a verified replacement projection rather than by rewriting the server log.

## First release acceptance criteria

1. Two authenticated users can join one project from separate clients and see ordered live updates in its multi sessions.
2. `human_chat` never triggers an agent but is included in the next hydration payload.
3. `agent_request` is claimed by the initiating user's registered bridge and produces a provenance-labelled response.
4. A Solo creator with a non-viewer role can append; every other project member follows it read-only.
5. Codex and Claude Code transcript import/tail preserve visible user, assistant, tool-call, and tool-result events.
6. Reconnect replay, idempotent append, role enforcement, redaction, and concurrent writes have automated tests.
7. A new user can claim a one-use project-role invitation without exposing their device credential to the inviter, and the owner can later change that role.
8. A second device requires a separate expiring authorization and can be revoked without revoking the user's other devices.
9. One loopback owner host serves Web, API, and WebSocket on a private HTTPS origin without a public application port.
10. One Codex connector binds a local project to a GatherThread project, discovers eligible sessions, preserves one Desktop-owned task and one distinctly labelled background execution projection per writable session, never opens the Desktop task through a competing App Server writer, and replaces an externally claimed completed background projection from canonical history without duplicating unresolved work.
11. An unanswered agent request has an accessible answering indicator; it changes to queued when the local runtime is offline and disappears after the linked canonical response.
12. With the reviewed project hooks installed and trusted, a completed prompt in a managed Codex desktop thread is uploaded atomically and exactly once as one canonical Agent turn, including allowed redacted tool events; without trusted hooks it remains local.
13. Offline local work is durable; after reconnect, a divergent turn is ordered by the server and a verified replacement thread becomes active while the former thread remains an `offline fork`.
14. Owners and participants can download another member's `solo`, while viewers can download every visible session as independent immutable Codex snapshots; snapshot runtimes cannot execute or publish.
15. Long projection and snapshot imports compact locally against an observed model context window or a conservative fallback without deleting canonical events.
16. Hook installation is explicit and reviewable; only privately allowlisted managed execution threads can reach the hook relay or offline spool.
17. A new project starts with no sessions, lets an owner create `solo` or `multi` and a participant create only a personal `solo`, and produces credential-free project connection commands for macOS/Linux and Windows.
18. A project owner can rename `multi`; a Solo creator can rename that Solo. Subscribed Web clients and background harness projections converge without rebuilding history. A connector must not force-rename a Codex Desktop-owned task while the public protocol provides no safe single-writer rename channel.
19. With trusted Hooks enabled, the first prompt in an unbound local Codex task creates one idempotent creator-owned Solo for an owner or participant and binds the same task. Empty tasks create nothing; viewer tasks remain local-only; connector-owned background and snapshot tasks cannot trigger discovery.
