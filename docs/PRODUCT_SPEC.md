# Product specification v0.1

## Goal

Enable multiple people to collaborate on an agent-assisted project while each person keeps using their own local harness, model, credentials, filesystem, and context-management policy.

## Browser entry flow

Opening a GatherThread deployment at `/` presents the bilingual product home. Its primary action opens the existing login and collaboration application at same-origin `/app/`; authenticated users continue into their workspace and signed-out users see the established device-token or invitation flow. Existing root links carrying `?api=...`, `?mock=1`, `#project`, `#session`, `#dsh-pair`, `#settings-*`, or `#main-content` are forwarded to `/app/` without changing their query or fragment. The product home does not read credentials or replace the application's authentication, invitation, Cookie, API, realtime, accessibility, or responsive behavior.

## Project collaboration boundary

A project groups related sessions and is the stable membership, invitation, and local-agent binding boundary. Creating a project atomically creates only its owner membership; an owner or participant then creates an eligible first session explicitly. Existing sessions named `General` are preserved, but new and historical projects are never backfilled with one. A project invitation grants access to the project's current and future sessions. The project owner can rename the project, creates and renames `multi` sessions, switches their own sessions between `solo` and `multi`, and can change every other member between `participant` and `viewer`. Owners and participants create and rename only their own personal `solo` sessions. A session creator or project owner may permanently delete that session's cloud copy; only the project owner may delete the whole cloud project. Neither operation deletes local workspaces or Agent conversations.

One collaborator maps the project to one local working directory and harness configuration. Sessions inside that project keep independent canonical histories, cursors, native agent conversations, and local compaction.

## Session modes

### Solo

The Solo creator is the only member allowed to write or submit agent requests while that creator still has a non-viewer project role. Every other member, including the project owner for a participant-created Solo, can read the complete shared event history and approved context snapshots but cannot mutate it.

### Multi

Project owners and participants can append human chat and agent requests. A human chat event is shared and included in future context hydration but does not trigger a local agent. An agent request is assigned to the initiating user's registered local runtime. The resulting response is appended to the same canonical history. Viewers remain read only.

## Canonical event types

- `human_chat`
- `agent_request`
- `agent_progress`
- `agent_response`
- `tool_call`
- `tool_result`
- `attachment`
- `context_snapshot`
- `membership_change`
- `session_state_change`

Every event has a server-assigned monotonic sequence, stable event ID, idempotency key, actor identity, frozen actor display name, timestamp, visibility, reply target, and optional runtime provenance.

`agent_progress` records a bounded execution lifecycle marker and any public harness commentary emitted during a claimed Web Agent request. It remains pending state rather than request completion. The Web client shows it live while work is active, then places all linked progress under a closed-by-default work log beside the final Markdown-rendered `agent_response`. GFM tables and bundled KaTeX inline/display formulas are supported. Hidden model reasoning and chain-of-thought are never canonical events.

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

One connector binds an accessible GatherThread project to one local working directory. The Web project page generates separate credential-free macOS/Linux and Windows commands. Every live-writable Codex session has a Desktop-facing interactive task and a distinctly labelled background execution projection. Web Agent requests run only in the background. A compatible Codex 0.151 client briefly rejoins an idle Desktop task and persists queued canonical events with `thread/inject_items`; an active turn delays the pass. The public protocol guarantees model-visible persistence but not immediate visible-bubble redraw in every Desktop build, which is not claimed as real-device verified. A separate verified native-history import creates readable Desktop bubbles without Agent execution. It defaults to once when each session is first created locally; Settings may disable this initial import, and a manual import remains available at any time. Empty sessions receive a local-only visibility marker and long histories are compacted to the configured budget. Every manual import creates and verifies a new local task, durably switches the binding and Hook allowlist, and leaves the previous task untouched for the user to archive. The previous task is explicitly local-only, so continuing it cannot create another GatherThread task or cloud session. Visible-history import never blocks or disables realtime context delivery. Older or incompatible clients use the reviewed Hook capsule path: exact bodies stay within bounded model context, oversized events resume from a durable UTF-8 checkpoint, and cancellation never advances delivery. Trusted Hooks upload direct Desktop turns only while that native conversation's persisted automatic-upload preference is enabled. The Web workspace and user-only plugin tools can disable or re-enable it and can explicitly scan completed, identifiable, not-yet-bound native turns for manual upload, including a turn the Hook did not capture. Manual upload uses the existing durable idempotent outbox, does not change the preference, and remains separate from cloud-to-local projection and Web Agent execution. A completed background projection that is externally claimed or belongs to a previous configured model is replaceable from canonical history, while unresolved execution remains fail-closed. Changing the connector model never replaces the Desktop-facing task. Human chat becomes context without triggering the local Agent. [ADR-0013](adr/0013-single-writer-dual-codex-projections.md) records the dual-projection boundary, [ADR-0014](adr/0014-acknowledged-bounded-desktop-relay-capsules.md) records the fallback relay contract, [ADR-0019](adr/0019-native-history-projection-across-harness-switches.md) records native history and harness switching, [ADR-0020](adr/0020-per-conversation-upload-consent-and-manual-recovery.md) records per-conversation consent and manual recovery, and [ADR-0021](adr/0021-import-visible-codex-history-as-a-new-task.md) records the visible-history import boundary.

With reviewed project hooks installed and trusted, a completed prompt typed directly into a managed local conversation is an Agent request. The connector persists the request, allowed redacted tool events, and final response in an idempotent outbox before uploading the complete turn atomically. The server assigns its canonical position and returns the event bindings; retries cannot create another request or Agent run for the same local turn. Without trusted hooks, direct desktop turns remain local and are not inferred from native history.

Server order wins after an offline period. When no cloud event followed the local base cursor, the connector binds the accepted IDs without rebuilding. When the cloud advanced, the local turn is appended after the server head and the connector creates a new local conversation from canonical history, compacting as necessary for that harness and model. It verifies the target sequence before switching, preserves the prior local conversation as an `offline fork`, and never rolls back local source files.

Read-only access is download rather than synchronization. Each **Download to Codex** action freezes the session at the current `through_sequence` and creates a fresh immutable native conversation for that requester. It never receives future cloud events or publishes local activity; another click creates another independent snapshot.

The project scheduling contract is harness-neutral through `ProjectHarnessAdapter`. Codex App Server remains the default implementation. The optional DeepSeek Harness package reuses the same project/session permission checks, runtime provenance, claim, canonical cursor, idempotency, replay, redaction, and durable outbox rules while executing inside DSH's native Host lifecycle. It maps each writable GatherThread Session to a distinct editable DSH Session, writes external canonical events through public `Session.append` with `surfaceOp: "append"` plus flush, suppresses replay by projected event ID, and uploads native DSH turns through a durable outbox and atomic `commitLocalTurn`. Its native GatherThread settings surface exposes the same per-conversation automatic-upload preference and an explicit manual upload action; disabled conversations stay local until that action or re-enabling, while cloud-to-local projection continues. An owner or participant's newly created DSH conversation becomes a creator-owned cloud Solo only after its first successfully completed human/assistant turn; empty, failed, and viewer conversations remain local-only. The plugin borrows an already-live DSH Agent without acquiring its disposal capability. Installation and short-code pairing are explicit; the browser never probes localhost. The Web client selects an exact online device/provider/model without silent Codex fallback. Claude Code and later harnesses can supply their own descriptor, preflight, native-session identity, execution, projection, compaction, and snapshot behavior without changing project authorization or server ordering.

Harness switching does not change cloud session identity. A user may use Codex, then DSH, then Codex again in one server session; each harness connects or pairs once per device and project, owns a separate native binding, and catches up from canonical history. A connected but unselected runtime may continue passive projection and must not execute another runtime's `agent_request`. Ambiguous multiple Codex runtimes fail closed. The feature synchronizes conversation state only and does not provide a global lock for cross-harness edits to one working directory.

ZCode joins as a third harness through the standalone `@gatherthread/zcode-connect` connector (see [ADR-0023](adr/0023-add-zcode-as-a-third-harness-through-a-standalone-headless-connector.md)). The user selects it per project like Codex, copies a credential-free connector command, and keeps the terminal process running; every writable session registers one exact ZCode runtime, and a claimed Web Agent request runs once in a headless ZCode child inside the workspace, sharing public commentary, allowed redacted tool events, and the final answer while hidden reasoning never leaves the child. The connector quotes shared canonical history into each request as untrusted data, resumes the same native session across turns, and never reads ZCode's private session store. Direct local ZCode turns stay local until the reviewed-hooks upload path ships; ambiguous or offline ZCode runtimes never fall back to another harness. Claude Code and later harnesses can supply their own descriptor, preflight, native-session identity, execution, projection, compaction, and snapshot behavior without changing project authorization or server ordering.

## Identity, invitations, and devices

Public registration is disabled. The deployment operator creates the first identity locally. A project owner may create a single-use project invitation for `participant` or `viewer`. Expiry choices are one hour, 24 hours, and seven days, with 24 hours as the default.

A new collaborator claims an invitation to create their own server identity and first device credential atomically. An existing authenticated user can accept an invitation without receiving a new credential. An inviter never handles another user's device credential. Each additional device uses its own ten-minute, single-use authorization and receives an independently revocable token.

## First-release deployment

One creator runs the only active authoritative server for a deployment. The service and SQLite stay on host loopback. The operator chooses local-only access, private LAN HTTPS through Caddy, private tailnet HTTPS through Tailscale Serve, or the invitation-only Alibaba Cloud ECS Caddy profile. Other users run only their local Web client, MCP process, bridge, and harness. Public Funnel, router port forwarding, arbitrary public tunnels, multi-primary replication, and automatic failover are outside the beta. See [ADR-0017](adr/0017-private-connection-profiles.md).

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
9. One loopback owner host serves Web, API, and WebSocket locally or through one exact private HTTPS origin without a public application port.
10. One Codex connector binds a local project to a GatherThread project, discovers eligible sessions, preserves one Desktop-facing task and one distinctly labelled background execution projection per writable session, injects canonical history only after an idle-state check on compatible Codex 0.151 clients, queues active-turn updates, retains the Hook capsule fallback, and replaces an externally claimed completed background projection without duplicating unresolved work.
11. An unanswered agent request has an accessible answering indicator; it changes to queued when the local runtime is offline and disappears after the linked canonical response.
12. With the reviewed project hooks installed and trusted, a completed prompt in a managed Codex desktop thread is uploaded atomically and exactly once as one canonical Agent turn, including allowed redacted tool events; without trusted hooks it remains local.
13. Offline local work is durable; after reconnect, a divergent turn is ordered by the server and a verified replacement thread becomes active while the former thread remains an `offline fork`.
14. Owners and participants can download another member's `solo`, while viewers can download every visible session as independent immutable Codex snapshots; snapshot runtimes cannot execute or publish.
15. Long projection and snapshot imports compact locally against an observed model context window or a conservative fallback without deleting canonical events.
16. Hook installation is explicit and reviewable; only privately allowlisted managed execution threads can reach the hook relay or offline spool.
17. A new project starts with no sessions, lets an owner create `solo` or `multi` and a participant create only a personal `solo`, and produces credential-free project connection commands for macOS/Linux and Windows.
18. A project owner can rename the project and can rename or switch their own sessions between `solo` and `multi`; a participant can rename their own Solo but cannot convert it to Multi. Subscribed Web clients converge on session title and mode changes without rebuilding history. New managed Codex tasks use an initial `<session> · MULTI|SOLO · GatherThread` label, after which local Agent titles remain independently editable; neither title may participate in session/thread identity or duplicate creation.
19. With trusted Hooks enabled, the first prompt in an unbound local Codex task creates one idempotent creator-owned Solo for an owner or participant and binds the same task. Empty tasks create nothing; viewer tasks remain local-only; connector-owned background and snapshot tasks cannot trigger discovery.
20. A session creator or project owner can delete a session's cloud copy, and only the project owner can delete the cloud project. The server removes dependent cloud history atomically, closes affected realtime scopes, and leaves every local workspace, file, Codex task, and Agent conversation untouched.
21. Every claimed Web Agent turn exposes a lifecycle progress marker and any public Codex commentary as ordered `agent_progress`; the linked final answer renders GFM plus bounded KaTeX formulas and folds earlier progress closed by default, while private reasoning never reaches the server.
22. A bound DSH Session persists external canonical events through public append/flush, deduplicates them by projected event ID, and uploads each completed native local turn from a durable outbox through one idempotent atomic commit.
23. One cloud session survives Codex to DSH to Codex switching without duplication; only the selected runtime executes a request, unselected connectors may passively catch up, ambiguous Codex selection fails closed, and no filesystem-lock guarantee is implied.
24. A GatherThread-origin DSH conversation is editable. The first successful local turn in a new owner/participant DSH conversation creates exactly one creator-owned cloud Solo with the same native identity and uploads that turn atomically; empty, failed, and viewer conversations never create cloud state. Canonical human messages retain user role in DSH, while canonical Agent responses retain assistant role inside valid DSH turn/step boundaries.
25. Every bound Codex or DSH native conversation stores an independent automatic-upload preference that defaults on. When off, neither Hooks nor DSH polling uploads local turns. An explicit manual action discovers and idempotently uploads completed eligible turns without changing that preference; Codex recovery also works when no Hook draft exists.
