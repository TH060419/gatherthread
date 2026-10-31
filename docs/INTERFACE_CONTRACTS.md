# Interface contracts

This document identifies GatherThread's integration boundaries, their canonical implementation sources, and the rules for changing them. It is a map, not a generated API reference. The schemas and tests named below remain the executable source of truth.

## Stability labels

- **Public prerelease:** exposed to Web clients, published packages, plugins, or self-hosted operators. It may evolve during Beta, but changes require compatibility analysis, tests, documentation, and release notes.
- **Internal versioned:** used between repository modules or persisted locally. It may change only with all consumers and stored-state migration or rejection logic updated together.
- **Implementation detail:** not promised to outside consumers. Security and data-integrity guarantees still apply.

Prerelease status never permits silent reinterpretation of persisted data, identity, authorization, event fidelity, or idempotency semantics.

## Canonical owners

| Contract | Stability | Canonical source | Main consumers |
|---|---|---|---|
| Domain values, input validation, events, replay, runtime, invitation, local-turn, and snapshot schemas | Public prerelease | `packages/protocol/src/index.ts` | Server, Web normalization, bridge, MCP, DSH |
| HTTP and WebSocket route behavior | Public prerelease | `apps/server/src/server.ts` plus `apps/server/src/service.ts` | Web, bridge, DSH, MCP transport |
| Authorization and persistence invariants | Public prerelease | `apps/server/src/service.ts`, `apps/server/src/database.ts`, `docs/SECURITY.md` | Every client and operator |
| Harness-neutral connector API | Internal versioned | `packages/bridge/src/types.ts` | Codex connector, adapters, local MCP relay |
| Browser API mapping | Internal versioned | `apps/web/src/api.js`, `apps/web/src/domain.js` | Web workspace |
| Realtime recovery state machine | Internal versioned | `apps/web/src/realtime.js` | Web workspace |
| User-facing MCP tools and resources | Public prerelease | `packages/mcp/src/service.ts`, `packages/mcp/README.md` | GatherThread Codex plugin and user Agents |
| Capability-protected local connector relay | Internal versioned | `packages/bridge/src/local-api-relay.ts` | GatherThread Codex plugin MCP only |
| Codex App Server adapter and persisted projection state | Internal versioned | `packages/bridge/src/codex-app-server.ts`, `packages/bridge/src/project-harness.ts` | Codex connector |
| DSH native plugin RPC and persisted state | Public prerelease package / internal versioned state | `packages/dsh-host/src/native-plugin.ts`, `connector.ts`, `state-store.ts`, `types.ts` | DSH Host and bundled settings client |
| Browser entry routes and legacy deep-link forwarding | Public prerelease | `site/index.html`, `site/boot.js`, `apps/web/scripts/build.mjs`, `apps/server/src/server.ts` | Browsers, invitations, DSH pairing, shared project/session links |
| Stable Web control IDs and accessible names | Internal versioned | `apps/web/index.html`, `apps/web/test/static-accessibility.test.js` | Web event bindings, accessibility, browser tests |
| Independent page recovery and startup readiness | Internal versioned | `apps/web/src/page-recovery.js`, `apps/web/src/bootstrap.js`, `apps/web/test/page-recovery.test.js`, `apps/web/test/bootstrap.test.js` | Browser shell, HTTP acknowledgment deadlines, isolated example |
| Codex Launcher URI (Windows/macOS) | Internal versioned | `apps/web/src/domain.js`, `prototypes/codex-launcher/launcher.py`, `prototypes/codex-launcher/macos/Launcher.swift`, shared `contract-vectors.json` | GatherThread Web, per-user Windows and macOS URL Scheme handlers |
| Opt-in code repository snapshots, review and merge | Public prerelease, Beta 2 | `packages/protocol/src/code-sync.ts`, `apps/server/src/code-repository.ts` | Web, shared local code-sync module, Codex, DSH |
| Shared manual history summaries and derived context | Public prerelease, Beta 2 | `packages/protocol/src/history-summary.ts`, `apps/server/src/database.ts` | Web, bridge, MCP, Codex, DSH |

When this document conflicts with the schemas or tested implementation, stop and resolve the discrepancy in the same PR. Do not silently choose whichever behavior is more convenient.

## Domain boundary

- A project is the membership, invitation, and local-Agent binding boundary.
- A session belongs to exactly one project and has one immutable creator. `solo` and `multi` permissions are defined in `docs/PRODUCT_SPEC.md` and enforced by the server.
- The canonical event envelope is identified by `id` and ordered by a positive per-session `sequence`. Explicit author erasure replaces content with a safe tombstone without removing its envelope or sequence; see [ADR-0050](adr/0050-author-message-erasure-and-context-revisions.md).
- `current_sequence` is the public session-head field. Consumers must not substitute timestamps, list order, or native task titles for the canonical cursor.
- Event actor identity is derived from authentication. Clients cannot supply a trusted display identity or impersonate another member.
- Runtime provenance is server-bound to the authenticated device and registered runtime. Local native-session identifiers are not a cross-user public identifier.
- Capture fidelity is explicit: `canonical_history`, `harness_transcript`, and `provider_request` are not interchangeable.

Adding a domain enum value or event type is an interface change. Update the Zod schema, storage and presentation paths, all producers and consumers, negative tests, and release notes together.

## HTTP JSON boundary

The same-origin API is rooted at `/v1`.

- Request and response wire fields use `snake_case`.
- Successful JSON responses use `{ "data": ... }`; `204` responses have no body.
- Errors use `{ "error": { "code": string, "message": string, "details"?: JSON } }` with an appropriate HTTP status.
- JSON responses are `no-store`. Bodies and JSON structure are bounded before reaching business logic.
- Browser authentication is exchanged into an opaque `HttpOnly; SameSite=Strict` cookie. HTTPS adds `Secure` and the `__Host-` prefix.
- Account identity responses include `can_create_projects`, separate from project roles. All new email accounts have the current project-creation capability. Password login does not edit the display name or change roles.
- Connectors use an HTTP bearer credential kept in the connector process. Credentials never belong in URLs, WebSocket query strings, page storage, MCP arguments, logs, or canonical events.
- Cookie-authenticated writes require an allowed `Origin`. Bearer-authenticated connectors remain device- and role-scoped.
- Retryable mutations carry a stable `idempotency_key`. An exact same-actor retry returns the original result; a changed actor, operation, target, or canonical payload conflicts.

The Web API client bounds one HTTP acknowledgment, including response-body JSON
decoding, to 45 seconds while retaining shorter explicit caller deadlines. It
aborts the transport and rejects with client-side `ApiError` status `0`, code
`request_timeout`, even if that transport does not honor abort. A timeout is an
unknown receipt, not a server failure or execution cancellation; no mutation is
automatically retried. Caller abort reasons propagate without a timeout notice.
All timers and caller-signal listeners are released after settlement. The
independent recovery layer receives only the fixed `request_timeout` category,
never a route, request body or exception. Stable recovery controls use
`page-recovery-help`, `page-recovery-dialog`, `page-recovery-dismiss` and
`page-recovery-reload`; modal-local help uses `data-page-recovery-help` without
duplicate IDs. Startup readiness follows `data-boot-state` through asynchronous
session restoration and back/forward cache restoration, not module import alone.

### Session member visibility

`POST /v1/sessions/:session/discard-empty` accepts strict `{}` and returns `{data:{session_id,discarded}}`. It requires an active device and the non-viewer session creator. In one SQLite transaction it discards only a Solo whose sole canonical event is its creation. Multi or used sessions return `discarded:false`; missing sessions return 404. A client may reconcile a lost receipt with an authenticated read, never an unconditional delete.

`CreateSessionInputSchema` retains optional `visibility: "project" | "private"` as the initial audience for compatibility; both modes support the same subsequent per-member controls. Omission preserves project visibility, and existing private rows are not broadened. `PATCH` rejects direct base-audience assignment; mode changes preserve the existing readers. The Web creation form now contains only name and mode. Session list metadata adds optional `visibility_revision` for older consumers.

`GET /v1/sessions/:id/members` includes all current project members for the conversation creator. When that creator has a non-viewer project role, each member additionally has `session_visible: boolean` and `visibility_revision: nonnegative integer`. Other readers receive ordinary visible-session members without management metadata. Web shows per-member switches only when this authoritative metadata exists, not solely because the current UI thinks it owns a session. The creator's own switch is omitted. Desktop Members and mobile Manage member reuse the same controls.

`PUT /v1/sessions/:id/members/:user_id/visibility` accepts strict `{visible:boolean,expected_revision:nonnegative integer,idempotency_key}` (2 KiB limit). Current authenticated device, creator identity, readable session, non-viewer project role and current target project membership are rechecked in one write transaction. Self-denial is forbidden. Returns `{data:{user_id,visible,revision,replayed}}`; a new mutation requires matching revision or returns `409 session_visibility_conflict`. Receipts bind actor, session, target, expected revision and exact choice. Exact retries return current authorization metadata without reapplying a former grant; changed retries conflict. Web bounds the full exchange, retains an uncertain request/body/key for explicit retry, prevents another change until it is resolved, and fences late results by account/project/session. This is authorization metadata, not a new canonical content event.

`session_member_visibility`, `session_visibility_receipts` and `sessions.visibility_revision` migrate additively. The `session_readers` view is authoritative for membership, HTTP/MCP/native discovery, visible counts and mentions. Hiding invalidates live sockets and unused tickets immediately, revokes runtime access, fails unfinished snapshot jobs, pauses claimed requests and records a monotonic blocked-through sequence. All request-current checks reject those older requests even after access is granted again; active runner capacity stays occupied until confirmed exit. Role, Solo/Multi write rules, event-level visibility, source files and retained local copies remain independent. Rollback to servers ignoring these controls is unsafe. The older project capability and private-creation preflight remain supported for compatibility, but the new browser no longer chooses an audience at creation. Tests: `apps/server/test/session-visibility.test.ts`, `apps/web/test/session-member-visibility.test.js`.

### Message quotes and mentions

`human_chat` and ordinary `agent_request` events may quote an existing event in the same session using `reply_to_event_id`. This does not change Agent-response linkage or claim fencing. Shared messages cannot quote owner-only history. A quote is a reference, not a new copy of the source event; its original content remains authoritative.

An optional `payload.mentions` array uses `MessageMentionsSchema`: at most 32 strict `{ user_id, start, end }` records, ordered and non-overlapping. Offsets are JavaScript UTF-16 indices in the exact submitted `payload.content`; each range must equal `@` plus the recipient's current display name and the recipient must be a current session member. Plain typed `@name` without a selected member is ordinary text. Changed names or removed members can cause a stale draft to be rejected instead of notifying the wrong person. Mention metadata is additive; older consumers still read the content normally.

`GET /v1/projects/:id/mentions?before_event_id=...` returns `{ data: { mentions, next_before_id } }`, newest first, at most 50 entries. Each entry contains `id`, `session_id`, `sequence`, `created_at`, `actor_display_name`, `session_title`, and a 180-character `excerpt`. It is an authenticated inbox for only the caller, filtered by current project/session membership and event visibility. It grants no new access and does not send third-party push notifications. Pagination reads canonical storage; WebSocket remains advisory.

### Author message deletion and execution revision

Browser-only `POST /v1/sessions/:id/events/:eventId/delete` takes strict `{idempotency_key}` with a 1 KiB body limit. It requires current Cookie authentication, allowed Origin, test admission if enabled, an active writable session and the message's exact author. Owners cannot delete another member's message; native bearer credentials are refused. Only `human_chat`, `agent_request` and `agent_response` are direct targets. Generic append and atomic local-turn upload cannot create `message_deleted`.

The `{data}` response follows strict `DeleteMessageResultSchema`: `{event,target_event_id,content_revision,affected_event_ids,affected_truncated}`. `event` is a server-created `message_deleted` event with payload `{target_event_id,content_revision}` and no original body. The affected-ID list is capped at 256; every receipt/notification requires fresh authoritative replay from zero even when `affected_truncated` is false. An exact same-actor/target/key retry returns its existing control event; a different binding conflicts. A new deletion key for an already deleted target returns `409 message_deleted`.

Erased rows retain ID, sequence, actor, timestamp, type and reply reference. Their payload is only `{content:"[Message deleted]"}`, runtime provenance is null, and top-level `deleted` is `{deleted_at,reason:author|request|summary_invalidated}`. UI must localize the marker instead of rendering the literal placeholder. Linked request work, recursive summary dependencies, old context snapshots and later generated answers/work are invalidated as defined in ADR-0050. Independent human messages are retained. Mentions omit erased content and quotes resolve against current tombstones.

Session summaries, HTTP/WS replay pages and derived context carry `content_revision`; an omitted value from a pre-deletion peer means zero, not permission to reuse older content. An outbound presented event is refreshed from SQLite and stamped with the current revision. Consumers scope caches to account/session/revision, refuse late lower-revision responses and refetch on deletion controls. A historical `through_sequence` is still subject to the latest erasure index. Native `contentRevision` is the camel-case equivalent; replay cursor and content revision are different quantities.

Requests, claims and snapshot jobs pin content revision. Completion/progress and new local uploads carry optional `content_revision`, checked against the authoritative request or current session; a mismatched or invalidated pin fails with `409 context_changed`. Deletion automatically fences active work and appends a safe linked failure containing `status:failed,error:{code:context_changed}`. Retry/resume/source selection cannot revive erased work. Cloud checkpoint and private task-result/publication persistence recheck inside their mutation transactions. Capacity and accepted-use accounting are not cleared merely because a cancellation was requested.

New ordinary `agent_request` appends from browsers, native relays and MCP carry the revision captured when preparing their body. The accepting transaction rejects an explicit stale pin before allocating an event or allowing its claim; after any deletion an omitted pin also fails with `409 context_changed` and a refresh instruction. Pristine revision-zero omission stays compatible. Exact same-key canonical retries may return a safe tombstone without reintroducing its body. Ordinary `human_chat` is not subject to this execution-pin requirement. See the cloud/GitHub acceptance contract below for their independent quota and private API fences.

A fully adapted runtime advertises `context_deletion_version:1`; legacy capability is zero. After any session erasure an old connector receives `409 connector_update_required` on execution/new uploads rather than an offline queue. A clean rebuilt and verified GT-owned native projection is required before publishing at the new revision; old Hooks, journals/outboxes and tasks remain local-only. This is independent of device, exact runtime/profile, repository and private API configuration revision fences.

Runtime presence runs independently of the execution loop every ten seconds. Only exact owned execution may publish throttled `agent_progress`. Live output adds `phase: stream`, opaque UUID `stream_id`, `stream_mode: snapshot`, `stream_kind: answer|reasoning|tool|plan`, increasing `stream_revision` (1–1200) and `stream_state: running|completed|failed`. Content is capped at 24 KiB UTF-8; optional titles at 256 bytes. Only plan snapshots carry a `plan` array (up to 64 `{step, status: pending|in_progress|completed}` entries of 512 bytes; empty clears a previous plan). New payloads are strictly validated; legacy progress stays compatible. Readers replace by request/stream/highest revision, keep the first visual anchor and reference the actual latest canonical event. Publishers redact cumulative snapshots, coalesce on one 1.5-second cadence, and retry identical IDs/payloads until acknowledgement. The older `phase: activity` with `status: thinking|running` remains for actual silent work; presence alone does not renew a claim. Existing claim attempts and five-minute work-based lease expiry remain unchanged. See [ADR-0045](adr/0045-streamed-public-agent-output.md).

Codex selects only the authoritative owned thread/turn's public answer, native reasoning summary, allowed tool fields and plan; raw reasoning text remains excluded. Hosted OpenCode uses the same fresh Session's loopback SSE in the existing executor process. Its internal progress callback requires current running/unpaused job, device and write access, plus current task/repository authorization for GitHub work, in the publication transaction. This is not a new public append or execution authority. Progress is ordinary charged history; final success still requires the existing strict completion and cleanup checks.

DSH retains its independent ten-second heartbeat. A transient heartbeat failure recovers idle/running state on the next successful heartbeat without waiting for prompt settlement. Live frames require the exact claimed prompt and selected Agent/Session; the supported npm fallback additionally verifies DSH's genuine Agent-loop request marker and turn/step, not just model names. Native-exposed answer, thinking, selected tool fields and plans may become bounded snapshots; raw request bodies, headers, private instructions and unrelated local streams remain excluded. The native completed-turn automatic-upload allowlist is unchanged. Activity idempotency keys include the claim attempt, and neither idle presence nor a persistent busy label fabricates work. A completely silent five-minute request may still lose its claim lease; this is distinct from runtime presence.

### Route families

Project invitation links use `/app/#invite=<project invitation capability>` on the current server; root `#invite` entries forward unchanged to `/app/`. The capability is held through authentication and removed on explicit completion/decline. This is an invitation-specific fragment contract, not a general credential URL or arbitrary redirect contract.

Additive browser-only `POST /v1/invitations/preview` accepts strict `{invite_token}` under `PreviewProjectInvitationInputSchema` with a 1 KiB body limit and current Origin/admission/session checks. `{data}` validates against strict `ProjectInvitationPreviewSchema`: `{project:{id,title},inviter_display_name,role,created_at,expires_at,already_member}`. Preview is read-only. Invalid/expired/revoked/foreign-consumed/archived/deleted invitations return `410 invitation_unavailable`; missing or revoked authentication keeps the existing `401`, and native credentials return `403 browser_session_required`. The response contains no capability, digest, member roster or conversation content.

`POST /v1/invitations/accept` keeps its existing input and transactional one-use semantics. New Web confirmations preview again before accepting. An uncertain accept response can be recovered by a same-user, current-member preview while the invite remains valid; this does not reinterpret a repeated accept as success or grant removed membership. Existing manual-key clients need no changes. Deploy the Web and server together for the confirmation page: an older server refuses the new preview route, and the page directs the user to the existing manual-key entry. No database migration is required. See [ADR-0046](adr/0046-project-invitation-links.md).

| Family | Purpose | Contract notes |
|---|---|---|
| `/health/live`, `/health/ready` | Process liveness and dependency readiness | Keep liveness independent from readiness; never disclose secrets or database contents. |
| `/v1/registration`, `/v1/registration/send`, `/v1/registration/verify`, `/v1/email-login`, `/v1/me` | Verified-email registration, password sign-in and eligible Cookie restoration | No user Bearer exchange; strict token-free actor metadata and independent browser devices. |
| `/v1/account/deletion-preview`, `/v1/account` | Self-service account deletion | Browser session only, never bearer device authorization. `GET` previews owned projects, Solo sessions, shared event count, personal code branches, and devices. `DELETE` requires allowed Origin and strict `{ "confirmation": "DELETE" }`; it rejects owned projects or unresolved personal code branches, deletes Solo cloud sessions, detaches retained Multi attribution, revokes devices and sessions, and clears browser/remembered Cookies. Local harness data is untouched. |
| `/v1/projects/:id/transfer-ownership` | Owner handoff before account deletion | Browser session plus allowed Origin, strict target participant ID and idempotency key. Target must already be a participant, have reconciled cloud-code quota, and accept owner role in one SQLite transaction; former owner becomes a participant. A failed or stale handoff leaves ownership unchanged. |
| `/v1/devices`, `/v1/device-authorizations` | Device naming, authorization, rotation, and revocation | The signed-in Connect Codex dialog creates a ten-minute gtd grant. The local connector claims a gta device credential once; the Web never receives it. Closing the dialog clears/revokes the unclaimed grant. Revocation invalidates related runtimes, tickets, and sessions immediately. |
| `/v1/projects`, `/v1/projects/:id/*` | Projects, project sessions, members, invitations, and audit | Authenticated email accounts can create projects under the resource limits; project ownership and membership are rechecked server-side. A project invitation grants only its project membership after sign-in, not account identity or extra privileges. `DELETE /v1/projects/:id/members/:userId` lets a participant/viewer remove only themselves, while the owner may remove another non-owner member but cannot leave their own project. A branch requires explicit `branch_resolution: delete|merged_to_main` and `expected_branch_head_commit`; the same guard applies to legacy session-member DELETE. Both routes use strict protocol request schemas and reject unknown fields. An unmerged branch cannot be declared merged, and stale heads fail with 409. |
| `/v1/sessions`, `/v1/sessions/:id/*` | Session metadata, members, events, local turns, snapshots, and Agent requests | Session ACL, mode, creator, visibility, quotas, and current head are authoritative. The legacy create-without-project path cannot create a project for a guest. |
| `/v1/sessions/:id/events/:eventId/delete` | Author-only shared message erasure | Browser-only, Origin/admission/current-write/author checked in one transaction; strict idempotent receipt, contiguous tombstones and content-revision fencing as above. |
| `/v1/runtimes` | Runtime registration and heartbeat | Purpose, device, user, project/session access, harness, provider, and model are bound and validated. |
| `/v1/dsh-pairings` | Browser-approved DSH pairing | Pairing is short-lived, one-use, origin-bound, and does not expose the long-lived credential to the browser URL or logs. The synchronous internal issuer receives the full approving actor and must recheck its active device before creating a credential. Revoked/expired approval cannot mint another device. |
| `/v1/realtime-ticket`, `/v1/ws` | One-use session-scoped realtime subscription | The socket is transport, not durable truth; clients replay from their last contiguous cursor. |
| `/v1/snapshot-requests` | Requester-private immutable snapshots and visible-history imports | Jobs are bounded control-plane records, not canonical events; runtime purpose controls claim authority. |
| `/v1/sessions/:id/history-summaries`, `/v1/sessions/:id/context`, `/v1/projects/:id/context-policy` | Explicit Agent summary generation, derived context reads and per-user project preference | Ordered history envelopes remain; deleted/invalidated sources are excluded. Source IDs, exact initiating-user execution runtime, current write permission, source size and claim completion are server-validated. Context reads are not canonical replay cursors. |

The exact request and response schemas are in `packages/protocol/src/index.ts`; route tests in `apps/server/test/server.test.ts` are the executable compatibility suite.

## Test admission contract

Optional `GET /v1/test-gate` returns `{data:{enabled,admitted,environment}}`; POST accepts only `{admission_code}` under `TestGateExchangeInputSchema` and returns the same public status while setting a separate HttpOnly Cookie. DELETE revokes admission and expires that Cookie. State changes require the exact test Origin; query credentials are rejected. Missing admission returns `403 test_admission_required`; invalid/expired/revoked codes share `403 test_admission_invalid`; durable admission attempt limits return `429 rate_limited`. Production does not add this route. Existing account/native protocols remain owned by their modules. Native exemptions and account integration placement are specified in [TEST_ENVIRONMENT.md](TEST_ENVIRONMENT.md).

## Realtime boundary

1. An authenticated client requests a short-lived, one-use ticket from `POST /v1/realtime-ticket` for one session.
2. It opens `/v1/ws` with subprotocols `gatherthread-v1` and `gatherthread-ticket.<ticket>`.
3. It sends `{ "type": "subscribe", "session_id": "...", "after_sequence": N }`.
4. The server emits bounded `replay` pages until caught up, then `subscribed`, followed by `event` or visibility-only `cursor` messages.
5. Any gap, reconnect, or uncertain socket delivery is resolved through authenticated HTTP replay. A client advances only through a contiguous authoritative sequence.

Tickets are deleted when presented, even if a later check fails. They must never be reused, logged, persisted as a general credential, or widened to another session.

## Canonical writes and local turns

- `POST /v1/sessions/:id/events` appends one validated event.
- `POST /v1/sessions/:id/local-turns` commits one local request, optional allowlisted tool events, and final response atomically.
- The local-turn path rechecks actor, device, runtime purpose, project role, session mode, idempotency, and server head inside the write transaction.
- Canonical sequence allocation, quota charging, and accepted writes are one transaction. Fan-out happens only after commit.
- A client stores returned canonical IDs before advancing its durable outbox. Retries must not rerun the Agent or duplicate the shared turn.
- If canonical history advanced after a local turn's observed base, the server remains authoritative and the connector reconciles instead of overwriting either history.

Automatic upload, manual upload, realtime projection, and Web-triggered Agent execution are separate controls. Changing one must not silently enable another.

## Agent request lifecycle

An `agent_request` names an exact harness/model profile and eligible runtime. The selected same-user execution runtime may claim it once, append public `agent_progress`, and complete it with one final `agent_response`.

- Runtime selection never falls back silently.
- A runtime may advertise a bounded set of exact provider/model profiles and adapter-owned reasoning efforts. The server accepts a targeted request only when the complete requested profile appears in that declaration — for every harness that publishes one, so a direct API caller cannot bypass it. A model declared without efforts accepts only a request that omits the effort. A legacy runtime without the declaration retains fixed-provider/model matching. See [ADR-0032](adr/0032-harness-advertised-model-catalogs.md).
- Claims and completions are idempotent and bound to the request and runtime.
- Public commentary may be uploaded; hidden reasoning is excluded.
- The final response does not close the claim until it is durably committed.
- Other connected harnesses may passively project the result but cannot execute the same request.
- A claim carries a server-assigned lease and is renewed only by accepted `agent_progress` from its holder. Runtime presence never extends a lease.
- A lapsed exact-runtime claim may be reclaimed only by the runtime recorded in the request profile. Reclaim never changes device, harness, provider, model, or runtime implicitly. Legacy requests without a runtime target retain their existing fail-closed selection rules. Ordinary claims occupy the runtime slot only while live; native Team execution additionally retains the exit-confirmation hold described below.
- Claim success includes `attempt_count`. Progress and completion may send it as `claim_attempt`; current connectors always do. The server rejects an expired lease or a superseded attempt. For compatibility with Alpha connectors, omission is accepted only on attempt 1.
- Reclaim is bounded. A request past the attempt budget terminates as `failed`: claiming it returns `agent_request_failed`, the server commits and publishes exactly one canonical `agent_response` with `status: "failed"` and no capture-fidelity or runtime-provenance claim, and a connector treats that conflict as terminal rather than retrying it.
- The author of a request may **pause** it. Pausing is authorized to that author alone — a project owner who did not ask has no more right to stop it than to have asked it — and it is idempotent. A paused request is never handed to a runtime: claiming it returns `status: "paused"`, which is neither an execution nor a failure. A connector skips it, and no later lease lapse re-opens it.
- A pause is announced as one canonical `agent_progress` lifecycle marker (`phase: "lifecycle"`, `status: "paused"`) linked to the request, so every member reads it in the ordered log rather than only the pausing client learning it from a control-plane response.
- The fixed server pause marker remains quota-charged but can use a bounded 1 KiB control allowance per paused accepted request in each storage scope; ordinary writes cannot use it. DSH retains the owned native-turn fence across lost completion acknowledgement so automatic and manual local upload cannot republish a paused answer. See [ADR-0023](adr/0023-lease-and-bounded-redispatch-agent-claims.md).
- A paused request is a record, not a queue entry. Continuing is a **new** `agent_request`, exactly as retrying a failed one is: the new request's position in the log is what lets the resumed run see anything said while it was stopped.

The Web composer reuses `send-agent-button` for its author's latest ordinary request, with `data-agent-action=request|wait|pause|resume`, bilingual accessible names and `aria-busy` during control writes. `POST /v1/sessions/:id/agent-requests/:eventId/pause` retains its strict empty JSON body and existing author/write checks. Resume uses the existing event append route with the original execution profile and message references and one stable retry key; it does not reopen a claim or change native connector contracts. `add-agent-button` opens the existing Agents settings section without changing the project/session URL or granting permissions. The new `manage-agents-button` opens `agent-management-dialog` beside the composer selector. The existing `connect-codex-button`, `connect-dsh-button`, `connect-claude-button`, `add-agent-button`, `agent-sharing-button` and `agent-teams-button` keep their IDs and owners inside this menu; mobile presentation does not move them into a separate tools dialog. Shared/Team Back returns one page, while Close exits to the workspace through the same draft and pending-action guards. No HTTP, persistence or execution contract changes.

Native Team claims require `execution_control_version:1` in the claim input;
older native clients receive 409 `agent_execution_control_required` before work
is admitted. Ordinary non-Team claims retain their previous compatibility.
Updated bridges and DSH must be installed together with this preview server.
The bridge advertises this capability only when its selected executor explicitly
implements it. Official POSIX CLI/subprocess entries require a configured durable
execution journal and verify that the owned process group has exited; merely
observing the parent process close is insufficient. Their Windows process
fallback does not advertise Team execution control and refuses Team work before
claiming it; ordinary request compatibility is unchanged.
`GET /v1/sessions/:session_id/agent-requests/:request_id/execution` takes strict
`runtime_id,claim_attempt` query fields and returns `{ data:{ active:boolean } }`.
It observes current authority, context, lease and Team control without renewing
the lease or exposing content. The native executor requires an initial active
confirmation and watches it during execution; explicit invalidation aborts the
exact native turn. Unknown transport results are not exit confirmation.
After the native executor has actually settled, the same device posts strict
`{ runtime_id,claim_attempt }` to `/execution/stopped`, returning
`{ data:{ active:false } }`. Only that exact attempt's capacity hold is cleared;
an old acknowledgment cannot clear another attempt. Exact authenticated-device cleanup can acknowledge an archived/read-only
session or revoked runtime/membership without gaining read, execution or write permission.
Deletion of a session, project, runtime or claim preserves an outstanding native
hold in a separate content-free identity record. The original active device can
acknowledge that exact identity even after its history resources are gone.
Cleanup and pool scope use the original canonical request envelope. A runtime
with an unresolved hold cannot change session or purpose (409
`agent_team_native_exit_pending`); same-route metadata refresh remains allowed.
Detached holds carry additive `origin_verified` metadata. Existing rows are
repaired only from a surviving canonical request; if that origin is unavailable,
the original device/harness is conservatively held across projects. Exact
original-device acknowledgment of such an unverified legacy row does not treat
its old session URL as proof of origin; all other exact attempt fields still
match. Verified rows require the original session as well.
Missing and unauthorized identities receive the same content-free no-op reply,
without modifying another device's hold or revealing whether a claim exists.
A generic HTTP 404 is never interpreted as exit confirmation by a client.
After a client has observed the execution-control surface, a later 404 invalidates
the execution but does not downgrade that surface to an unsupported old server;
the client still records and retries its exact exit acknowledgment after stopping.
Team pause, deadline, lease expiry, private Forget and restart retain the hold
until confirmed native exit or accepted completion. Additive `execution_pending`
claim metadata survives restart; earlier claimed/paused/failed rows with a
surviving Team marker or an erased request are conservatively backfilled. A server-generated
failure answer after lease expiry is not native-exit evidence. A disconnected
client cannot imply process exit.
New Team native holds are bounded at 1,000 per account and 100,000 globally;
legacy holds are preserved even above these admission limits. Ordinary claims
do not acquire new Team holds, but all native and shared admission respects a
detached hold in the same device/project/harness pool. Live and detached copies
of one exact attempt count once. `agent_team_native_exit_pending` explains a
queued call blocked by a previous exit; `agent_team_native_hold_capacity`
explains the separate safety-record limit without exposing another account.
This is a coordinated preview upgrade: stop old connectors and confirm their
native turns have exited before replacing them. Conservative legacy holds with
no surviving local exit receipt cannot be cleared merely by reconnecting or
waiting; the owning exact device must confirm the old attempt's actual exit.
Content-free pending exit receipts are persisted locally and retried on reconnect
without rerunning a turn. These APIs remain connector-only, outside user MCP.
Official CLI entries use `${statePath}.execution.json`; subprocess adapter
entries use `${cursorPath}.execution.json`; App Server Team execution uses
`${statePath}.native-execution.json` alongside its existing projection journal.
These private bounded journals bind
the exact session/runtime/request/attempt and an input fingerprint, with prepared,
started and settled states for CLI/subprocess work; App Server retains native
turn-start tracking in its existing projection journal. Only settled native work
can produce cleanup receipts. For these bridge executors, receipt persistence
and retry precede a new runtime registration, so
deletion or rebinding cannot block old cleanup.
Project startup independently scans only the exact device/project/workspace's
known cursor and native-execution sidecars before project/session discovery and
native preflight, including deleted sessions. The scan is limited to 4,096 direct
entries and 64 MiB; regular-file/link/session-key checks and OS-supported
ownership/private-mode checks precede cleanup. It never searches native
conversations or interprets a missing process as exit. Current cursor updates
survive delayed acknowledgments. Lost completion acknowledgments replay the
settled outcome instead of launching another process. Prepared or
started ownership is never reclaimed merely because a PID is absent; unknown
exit requires operator verification. Evidence is not evicted to admit new work.
DSH likewise replays confirmed private exit receipts before session reads,
host startup or registration, after verifying its persisted project/session/native
binding. Unknown active requests and snapshots never supply exit proof.

## Snapshot and visible-history boundary

Snapshot requests are requester-private control-plane records with frozen `through_sequence` values and bounded result metadata.

Detail reads require the requester's current session read permission in every job state, including completed results; loss of visibility or project membership returns `404`. Lists apply the same `session_readers` boundary before ordering, limiting and byte bounds, with or without a session/status filter. Hidden records are omitted, so a filtered list may be empty. Revocation preserves terminal records and retry receipts; a later visibility grant restores access to retained results without restarting failed jobs.

- `snapshot_connector` jobs create immutable read-only local snapshots and cannot claim Agent requests or publish local turns.
- Each manual Codex history import creates and verifies a new writable local task. The `visible_history_replace` operation retains its Alpha wire name for compatibility, switches the binding and Hook allowlist after verification, and leaves the previous task untouched for the user to archive. The private registry marks that previous task `local_only`, so its later prompts cannot enter first-prompt discovery or create cloud state.
- Empty-session visibility markers and compact summaries are local-only. Realtime context injection remains independent from snapshot/import policy.
- Codex Desktop's app-generated next-message suggestions are not human turns. Hook admission, offline replay and completed-native-turn discovery exclude the recognized native request envelope; unknown Stop events cannot discover a session. Ordinary human prompts, including quoted explanations of that envelope, retain their normal synchronization policy.
- On upgrade, unsubmitted suggestion drafts/outbox entries are discarded before publishing. A prior `commit_unknown` suggestion is never retried, modified or falsely acknowledged: its exact private evidence and uncertainty barriers remain until explicitly reconciled. Suppressed suggestions are not counted as uploadable or successfully uploaded human turns.
- Visible Codex imports preserve public message bodies, subject to a separate bounded serialized snapshot size. An oversized resource is rejected before import, not shortened and marked complete. Native compaction, when required, must succeed before the new binding is committed. A summary is not a lossless copy or canonical history.
- New snapshot kinds or changed claim authority require protocol, ACL, quota, bridge, integration, and security tests.

## Project code boundary

### Direct GitHub metadata and controls

`packages/protocol/src/github-sync.ts` defines a separate strict metadata endpoint at `GET /v1/projects/:id/github`. Its `{ data }` payload is `{ connection: { repository, base_branch, enabled, revision } | null, branch, can_configure, can_write }`. `repository` is an `owner/repo` slug, never a URL or credential; `base_branch` is a bounded safe Git ref name. `branch` is `gatherthread/<24 hex project hash>/<24 hex user hash>`, computed from SHA-256 of the authenticated project/user IDs and stable across devices. `can_write` reports only GatherThread project eligibility, never GitHub permission. Project members may read this metadata; only an active project's owner may configure it.

`PUT /v1/projects/:id/github` accepts only `{ repository, base_branch, enabled, expected_revision: string | null }` and returns the same status shape. Initial creation compares against `null`; changes compare the current opaque UUID revision and conflict on stale input. Content-identical retries may return the existing revision without mutation. Every effective change, including enablement, generates a new revision; local consent must follow the current configuration. Additive SQLite table `project_github_connections` contains only that metadata, keyed by project with deletion cascade. Cookie Origin and active-device checks apply normally. This endpoint never accepts or proxies source files or GitHub credentials, creates a remote repository, changes GitHub collaborator rights, or edits cloud `/code` enablement.

The separate request kinds are `github_auth_connect`, `github_code_sync_status`, `github_code_upload`, `github_code_download`, `github_code_recover`, `github_code_auto_upload_enable`, `github_code_auto_upload_disable` and `github_code_update`. They use the existing private snapshot-job routes, exact same-user Codex/DSH execution runtime, authenticated device and current writable session/project checks. They never use snapshot-worker authority. The sign-in request invokes local GitHub CLI only on the exact Codex runtime and returns no credential; DSH exposes the same local action through `github/connect`. Creation, claim and completion/failure of transfer jobs require an enabled GitHub connection, except status and local auto-upload disable; archived projects reject GitHub controls. Every effective configuration change atomically fails that project's pending/claimed GitHub jobs with `code_sync_binding`; terminal jobs and cloud jobs are preserved, and a new request is required. The fixed failure marker is charged to the snapshot ledger once per invalidated active job but may exceed quota so storage exhaustion cannot prevent pausing or changing the target. Active-job caps bound that allowance. Other job quotas and bounded result metadata still apply. The SQLite CHECK migration preserves earlier job records and target runtimes. `isGitHubCodeSyncRequestKind` is intentionally separate from `isCodeSyncRequestKind` so cloud checkpoint behavior does not broaden.

Direct HTTPS Git transport and local GitHub CLI authentication live in `packages/bridge/src/github-code-sync.ts` and `packages/bridge/src/github-auth.ts`. Local consent binds the server/project/user/workspace and repository/base/configuration revision. DSH adds independent `github/connect`, `github/authorize` and `github/action` native controls; Web jobs cannot grant local file consent. Only the stable personal branch is pushed, with no force or shared-base/default-branch writes. A newly authorized GitHub binding defaults to idle automatic upload, which can be disabled persistently; the GT Cloud binding still defaults off. Native GitHub permissions, Actions triggers and remote retention remain independent. Preview file/tree limits are in `GITHUB_CODE_SYNC_LIMITS`; operational instructions and unsupported repository cases are in [CODE_SYNC.md](CODE_SYNC.md), with the design in [ADR-0035](adr/0035-direct-local-github-code-synchronization.md).

### GatherThread cloud checkpoints

`/v1/projects/:id/code` is independent from canonical conversation events. GET returns repository enablement/main commit, bounded member-branch metadata and the current actor's branch ID. Owner-only `POST /enable` explicitly creates or resumes storage; owner-only `POST /disable` pauses code transfers without deleting stored heads or branches. Existing database rows migrate with `enabled=1`. `POST /checkpoints` accepts a complete bounded portable file set, expected base commit and idempotency key; actor identity and branch ownership come from authentication. `GET /snapshot?branch_id=main|BRANCH_ID` reads a current branch tree only while enabled. `POST /review`, owner-only `POST /merge` and `POST /update` enforce expected heads and repository enablement. A mismatch or merge conflict never force-moves main or another member's branch. Normal cookie Origin, bearer device, project role and revoked-device checks remain.

Authoritative shapes and 1,000-file / 2-MiB-file / 8-MiB-snapshot limits are in `code-sync.ts`. Checkpoint uploads and the separate browser file-mutation route have increased bounded body budgets; event and authentication limits are not widened. SQLite owns atomic heads and retry receipts; immutable Git objects are stored before acknowledgement. Backups require both stores.

`GET /v1/code-storage` returns the current actor's logical 128 MiB limit, usage, visible-project breakdown and only their own pre-upgrade `detached_branches`. A project member may call `POST /v1/projects/:id/code/clear-branch` only for their own current branch, with `expected_head_commit` and `idempotency_key`. A former member may call `POST /v1/code-storage/detached-branches/:projectId/clear` with the same CAS and idempotency fields only for their own orphan; its strict response is `{released_bytes}`. The project owner may additionally call `POST /v1/projects/:id/code/clear-project` with `expected_main_commit`, the complete `expected_branches` set and an idempotency key. These cleanup routes are available while paused or archived; normal cookie Origin and active-device checks still apply. Clearing invalidates old mutation receipts, removes the selected cloud refs and releases logical current-head usage without changing local Git. Clearing one branch cannot erase content already merged into main. Append-only Git objects and existing backups remain until separate operator-approved physical cleanup, so project/deployment disk limits do not immediately fall.

The private snapshot-job protocol adds `code_sync_status`, `code_upload`, `code_download`, `code_recover`, `code_auto_upload_enable` and `code_auto_upload_disable`. These target one exact same-user execution runtime (Codex or DSH), never a snapshot worker, arbitrary directory or fallback device. New transfers, mutation jobs and their completion fail while the cloud repository is paused; status and the request to turn off an existing local auto-upload preference remain available. Local code authorization is separately required and cannot be granted by these jobs. Results contain only bounded status/commit/count metadata and a recovery directory basename, never absolute paths or credentials.

DSH native RPC adds `code/authorize {projectId,enabled}` and `code/action {projectId,action}`. Optional `codeSync` public-state entries are project-scoped. Consent is private, versioned and bound to the exact user/project/server/workspace. Packaged native controller and client upgrade together; existing conversation `sync/*` semantics do not change.

`status/get` reports `compatibility {package, version, profile, targets}`. `version` and `profile` name the active verified target, with the profile read from DSH's `profileContext`; they do not always name the npm Web profile or imply runtime-version introspection. `targets` lists this build's verified `{version, profile}` pairs. A client accepts the pair only when it appears in `targets`, and continues to accept the scalar-only `0.1.7-rc.2`/`web` form sent by older Host builds. The block is descriptive: it grants no capability beyond structural service checks. The default `cordis.patch.yml` targets `0.2.1-rc.2` Web/Desktop and injects Connection's `webStartup`; the frozen `cordis.patch.dsh-0.1.yml` injects `webRuntime` and is a reference for the immutable published Beta 2 artifact, never an automatic fallback. The current manifest declares both `engines.dsh` and an optional `@deepseek-ai/dsh` peer as `>=0.2.1-rc.2 <0.3.0`. Newer DSH checks the engine; older `0.1.7-rc.2` checks the peer before composing the bundle's patches, refusing the incompatible bundle without installing a runtime. See [ADR-0058](adr/0058-dsh-desktop-profile-and-version-gated-plugin-layer.md).

Source visibility is project-wide, not Solo-scoped. A member branch is not a privacy boundary or per-Agent lock. Native conversation bindings, realtime context injection and the original local Git repository remain untouched. See [CODE_SYNC.md](CODE_SYNC.md) and [ADR-0025](adr/0025-opt-in-git-backed-code-checkpoints.md).

### Browser file workspace (local implementation)

`packages/protocol/src/file-workspace.ts` owns strict additive schemas for `/v1/projects/:id/files`. All responses retain `{data}` or `{error:{code,message,details?}}`; unknown or duplicate query fields fail validation. `provider` is required and is exactly `gt-cloud` or `github`. Branch/content requests never choose a provider implicitly. Active-device and current project membership checks apply to every route; browser writes also use the normal allowed-Origin/JSON checks.

| Route | Input | Success data |
| --- | --- | --- |
| `GET /branches` | `provider`, optional `connection_revision` | `{provider,branches:[{id,name,user_id,head_commit,can_write}],default_branch_id,connection_revision?}` |
| `GET /tree` | `provider`, `branch_id`, optional `commit`, `connection_revision` | Selection metadata, `{commit,head_commit,can_write,entries:[{path,size,executable?}]}`; no content bytes |
| `GET /content` | Tree selection plus `path` | Selection metadata, `{commit,path,content_base64,size,executable?}` for one selected file |
| `GET /history` | Tree selection plus optional `path`, `cursor`, `limit` | Selection metadata, `{commits:[{id,parent_ids,message,author_name,created_at}],next_cursor?}` |
| `GET /changes` | Tree selection plus optional `base_commit` | Selection metadata, `{base_commit,commit,files:[{path,status,previous_path?}]}`; status is `added`, `modified` or `deleted` |
| `POST /mutations` | `{provider,branch_id,base_commit,connection_revision?,operations,message,idempotency_key}` | Selection metadata, `{commit,replayed?}`; `branch_id` identifies the resulting personal branch |

Selection metadata is `{provider,branch_id,connection_revision?}`. Commits and history cursors are 40-character lowercase SHA-1 identifiers. History defaults to 30 entries and permits 1–100. Omitted `commit` selects the current branch head; explicit versions must be reachable from that project branch. Omitted `base_commit` for changes selects the first parent, or `null` for a root commit. Folder structure is derived from paths; empty folders use a `.gitkeep` file. Existing full-checkpoint, local transfer, review and merge endpoints remain separate.

Every current project member may read shared main and current member branches that the selected provider permits. Only an active project writer's own branch accepts mutations. Shared main/base, other members' branches, explicit historical versions and project viewers remain read-only in the browser. Virtual `branch_id:"own"` reads shared main before the actor's first personal commit; the first accepted mutation returns the real branch ID. A GitHub shared base literally named `own` uses the distinct read-only selection ID `base:own`; clients treat returned branch IDs as opaque. File visibility follows project membership, including when the selected conversation is Solo.

Operations are strict `{type:"write",path,content_base64,executable?}`, `{type:"copy"|"move",path,destination}` or `{type:"delete",path}`. Copy/move/delete apply recursively to a selected folder. The ordered batch is limited to 100 operations and 8 MiB of decoded write bytes; the authenticated mutation route accepts at most 12 MiB of HTTP JSON. Every intermediate tree must fit its provider's file and decoded-byte limits before expansion; later deletions cannot bypass these bounds. Portable relative-path validation rejects traversal, private state, credential paths and aliases, including each expanded copy/move descendant. A copy/move destination must be absent; file/folder overlap, case/Unicode aliases and copying into the source fail. Writes compare the acknowledged `base_commit` and preserve executable flags when omitted.

GT Cloud reuses the existing enabled bare repository, SQLite-authoritative heads, user/project/deployment quotas, secret checks and exact-request receipts. The final tree remains limited to 1,000 files, 2 MiB per file and 8 MiB total. `connection_revision` is invalid for this provider. GitHub instead requires the requester's existing GitHub App authorization and explicit project repository binding to match the enabled project GitHub connection. Repository identity, access, current authorization generation, connection/binding revisions and membership are rechecked across asynchronous requests. Credentials remain server-side. Browser source bytes pass through this authenticated server adapter on demand; this is distinct from the local computer-to-GitHub transport described above.

The GitHub browser adapter bounds repository metadata at 10,000 entries and 128 MiB total, with 8 MiB per file read/write, independently of the local synchronizer's 20 MiB file limit. It exposes eligible regular files and protects private, generated/dependency and `.github/workflows` paths. Symlinks/submodules remain outside browser edits; LFS content is refused. Unsupported or protected entries survive unrelated edits, while recursive operations touching them fail. Git Data writes target only the authenticated user's stable personal branch with `force:false`; this process serializes its own writes, rechecks the head and verifies the resulting commit. External Git writers remain concurrent. SQLite receipts retain request fingerprints and the exact prepared commit before ref publication, so an explicit same-body/key retry can reconcile an uncertain result; a changed request or authorization binding conflicts. These endpoints neither merge branches nor create pull requests.

Representative refusals are `code_not_enabled` (409), `code_stale_head` (409), `code_storage_quota_exceeded` (507), `code_secret_detected` (400), `file_provider_unavailable` (503), `file_provider_mismatch` (400), `github_connection_required` (403), `github_binding_changed` (409), `github_access` (403/503), `file_read_only` (403), `file_head_changed` / `file_path_conflict` (409), `file_unsupported` (422), `file_secret` (403/422), `github_source_limit` / `file_history_limit` (413), and unavailable file/branch/commit errors (404). Normal authentication, membership and validation errors still apply. Clients pin each buffer's loaded commit and connection revision; refreshing the explorer cannot silently rebase an older buffer. A connection-revision change clears the clipboard and blocks old buffers until explicit reload. Clients retain unsaved buffers on conflict or uncertain acceptance, never force-push or automatically retry with a fresh key, and clear buffers across account/project scope changes. CodeMirror editing, sanitized Markdown preview, image preview and bundled PDF rendering are browser presentation only; text editing is bounded at 2 MiB. See [ADR-0059](adr/0059-right-file-workspace.md) and [file-workspace guide](CODE_SYNC.md#browser-file-workspace--网页文件工作区).

GitHub file-write receipts are small metadata, not source snapshots. A per-user/project security cap of 10,000 receipts rejects new operations with `file_receipt_limit` (429) before any GitHub write. Existing accepted keys remain retryable at the cap; receipts are not expired in a way that could repeat a move/delete. They are removed with account/project deletion. This is not a GitHub account storage quota.

## MCP and local relay boundaries

Portable configuration uses `kind` and `version:1` with strict protocol validators and a 128 KiB JSON limit. Preferences are partial patches; Team files contain editable drafts and budgets, never saved revisions, test results or enable state. `collaboration_get_configuration_schema` accepts `kind:preferences|agent-team` and returns static JSON Schema. `collaboration_validate_configuration` accepts a JSON string and returns validity/field issues. Both are read-only user tools, perform no network/file reads and cannot change settings or authorize execution. See [configuration guide](CONFIGURATION.md) and [ADR-0064](adr/0064-portable-configuration-and-empty-solo.md).

Claude adds an optional validated `claude-code` local relay namespace; omitting it retains the legacy Codex endpoint. Its plugin MCP discovers only the selected workspace/harness, not an arbitrary matching global registration. This changes no bearer, ACL, canonical event or claim authority. Claude's native Hook envelope is distinct from Codex's `turn_id`/model contract and must never be interpreted as a Codex Hook. [ADR-0060](adr/0060-claude-code-plugin-and-local-connector.md) owns these integration decisions.

The Claude connector's default `--permission-mode native` leaves local Claude settings and tools intact, replacing the unreleased file/plan-only execution policy. Existing explicit manual/plan options remain valid. Required `--permission-prompts none` support keeps new approvals local; a native `permission_denials` result produces fixed `claude_permission_required` guidance without its input bodies. Own-execution Hook suppression is keyed by the fresh private native UUID, never a title or model; it cannot enable another user's execution or publication. The execution journal fingerprints the chosen permission mode, so an older or changed configuration cannot silently replay an uncertain task. No HTTP, Launcher URI, account, shared-Agent or persisted state schema changes are required.

The published MCP surface is intentionally narrower than the internal collaboration API.

- User-facing tools/resources expose authorized project/session discovery, canonical event reads/writes, and explicit local sync controls.
- `collaboration_request_agent` forwards an optional strict non-negative integer `content_revision` captured from the context/history used to prepare its request. The server requires it after deletion; neither MCP nor the relay fetches a newer pin to resubmit old text. Chat tools are unchanged.
- Internal runtime registration, claim, progress, completion, and credential handling are not exposed to an arbitrary model through the user MCP.
- The local connector relay is protected by a per-run capability and current-user filesystem permissions. Its endpoint or named pipe is not authorization by itself.
- Ambiguous routing across multiple connector registrations fails closed.
- HTTP/stdio MCP messages default to 1 MiB, with at most 128 requests per batch and bounded JSON depth/node count; oversized inputs are rejected before any batch member executes. Valid batches and silent notifications remain supported. Manual visible-history import creates a new native task and is explicitly non-idempotent.
- Renaming or removing an MCP tool/resource, parameter, URI, or result field is a Public prerelease interface change.

## Codex and DSH native boundaries

- Codex and DSH model selection both use exact metadata advertised by the connected runtime. The Codex connector reads its installation's own catalog through the App Server's documented `model/list` method; DSH re-reads its native LLM metadata on a bounded interval. A request may name only an advertised model and, for that model, only an advertised reasoning effort. A harness that cannot be queried advertises nothing and keeps fixed-model routing; a harness or provider that configures models elsewhere keeps its own catalog as the source of truth.
- Codex Hooks are limited to reviewed `UserPromptSubmit` and `Stop` definitions. Hook payloads, output limits, registry purpose, and workspace path checks are security contracts.
- Codex Desktop projection, background execution, and snapshot tasks have separate purposes and single-writer rules. Never mutate an active or ambiguously owned native task.
- Native context capacity and transport bounds are separate. Codex context accounting uses fresh last-request usage, not cumulative lifetime billing; a reported model window takes precedence over a fallback estimate. Ordinary native automatic compaction remains enabled according to the user's harness configuration. GatherThread must not overwrite that configuration or label local truncation as native compaction. See [ADR-0026](adr/0026-native-first-context-management.md).
- DSH uses public session append/flush and Agent services, durable projected-event IDs, echo suppression, and an outgoing outbox. Only allowlisted assistant output and redacted tool data may leave DSH.
- DSH model selection uses exact metadata advertised by the connected runtime. A GatherThread request may temporarily select one declared model and effort for its own DSH turn; it must not persistently rewrite DSH-native selection for later local turns.
- Native DSH pairing/configuration is single-flight. Disconnect drains canceled configuration writes before clearing its credential, and a project-role change refreshes only that project's native owner and permissions.
- Persistent connector and DSH state must carry a version. A state change needs atomic migration or a safe, actionable refusal; never guess at an old structure.
- Upstream version support is explicit. An unsupported Codex App Server or DSH Host API must fail safely and preserve local/cloud data.

### DSH workspace RPC (prototype)

`/gatherthread` adds `workspace/action`. Its strict request and response contracts
are `DshWorkspaceInputSchema` / `DshWorkspaceResponseSchemas` in
`packages/protocol/src/dsh-workspace.ts`; this native envelope uses camelCase,
while the unchanged `/v1` HTTP layer keeps snake_case.

- `list` returns the paired actor, active projects, an opaque connection identity
  and the paired server's public `/app/` URL (no token or query). Web-only management
  links use that server plus explicit project/session IDs, never a fixed production URL.
  `sessions` returns visible active sessions in the selected project.
- `read` takes `afterSequence` and optional `contentRevision`; it reads 20 canonical
  events per page and advances across filtered events. A changed content revision
  resets replay. The panel retains at most 500 recent visible messages and clears
  inaccessible content on revoked access or a changed account. Visible content
  previews remain capped at 4,000 characters. The optional session avatar endpoint
  supplies only reviewed catalog IDs; a 404 falls back to initials, while authorization
  failures still clear inaccessible content. Shared reply attribution uses server-owned
  `sharedExecution`, never a payload claim.
- `message` expands one exact canonical event ID/sequence at the current content
  revision, rechecking the same actor/project/session scope. It returns at most
  32,000 characters and an explicit truncation flag, never tools or erased payloads.
  A revision mismatch requires replay before retry. Expansion stays local UI state,
  cleared on navigation, deletion revision or loss of access.
- `context` reads the effective server context, never a raw-history fallback. The
  preview returns at most 30 items / 2,000 characters each, with explicit
  truncation. It is invalidated when canonical history advances. These display
  limits do not replace the connector's execution context policy.
- `send` explicitly chooses `chat` or `agent`, caps text at 8,000 characters and
  requires a stable idempotency key. Agent requests must identify the current
  selected session's local DSH runtime. An optional provider/model/reasoning
  selection must exactly match the Host's advertised native execution catalog;
  it does not change the saved default. Quotes use canonical `replyTo` IDs and
  the composer includes `contentRevision`. Foreign runtimes, arbitrary models,
  browser-supplied URLs and raw payload overrides are refused.
- `createSession` uses a stable key and explicitly creates private Solo or
  project-visible Multi; `renameSession` requires the server's session-management
  role. Both reuse the existing canonical session APIs.
- `discardEmptySolo` uses Beta 6's conditional `/discard-empty` endpoint. The
  Host requires an owned Solo in the current project; the server atomically
  verifies emptiness. Only this Client's newly created, unused Solo candidates
  are checked on explicit navigation. Drafts and unknown send outcomes retain
  them. Unsupported or failed cleanup never falls back to a normal DELETE.
- `pause` resolves an exact canonical request by ID/sequence and requires its
  author, current local runtime and content revision. The existing server pause
  API controls the claim. `resume` re-reads at most 1,000 following events, requires
  a paused nonterminal ordinary request, and appends the original content and
  exact execution selection under a stable retry key. Shared, Team, summary and
  cloud requests are excluded. Like Web, resumption is a new request using current
  shared context, not restoration of interrupted internal reasoning.
- Every action rechecks the current device, project/session access and grant
  lifetime. Writes require owner/participant roles and, for Solo, ownership. The
  server rechecks authorization again when accepting the mutation.
- Responses are allowlisted, schema-checked and capped at 256 KiB. User text is
  rendered as text, not HTML. Requests have an 18-second Host deadline; the Client
  applies a 22-second receipt deadline. Timeout does not prove non-delivery.
- Leaving a scope aborts reads and ignores late responses. Pending sends keep
  their original body/identity for explicit retry. Panel state is memory-only;
  reload does not claim durable recovery. `workspace_*` errors use fixed UI copy
  and never forward private exception text, credential values or native paths.

See [ADR-0065](adr/0065-dsh-native-collaboration-workspace.md).

## Web presentation boundary

`session-toolbar.js` groups the existing summary action IDs under `history-summary-menu-button` and session metadata/status actions under `session-options-button`. Presentation changes preserve their authorization, selection and exact execution paths. The existing `mentions-button` is now a hidden-by-default timeline jump control, not a persistent inbox-dialog trigger; its accessible name reports unread count and intent. `message-actions.js` derives tab-local read state from actually visible, current, undeleted mention messages and fences delayed navigation by authenticated account/project and navigation generation. Bounded non-content read IDs use account/project-scoped session storage with a memory fallback, not a server read-receipt mutation; the authenticated mentions GET contract is unchanged.

`interface-mode.js` owns the non-secret `gatherthread.interface-mode.v1` browser preference and explicit detection confirmation. `html[data-interface-mode]`, `html[data-mobile-workspace]` and `#workspace[data-mobile-ui]` describe presentation; `data-mobile-device` remains a separate physical-device capability hint. Mobile/Desktop changes preserve original control IDs, handlers, drafts, form values and exact execution targets without authentication or business writes. The isolated example inherits the existing presentation hint. See [ADR-0057](adr/0057-explicit-browser-interface-and-mobile-navigation.md).

Hosted memory, explicit single-CPU cpuset and Docker-client settings are private operator controls, not browser or public API fields. Their defaults, tightening bounds, local-daemon isolation and test-host acceptance are owned by [the hosted operator guide](HOSTED_AGENT.md#operator-setup). Cpuset opt-in retains the CFS default when absent, requires concurrency one and a guarded image, and never silently discards unsupported CPU quota arguments. It changes neither wire shapes nor persisted task/account quotas. A secondary private-resource cleanup failure must not hide an unconfirmed executor exit or release its reserved capacity.

The Cloud Git dialog keeps `project-code-button` and `project-code-dialog` as its single entry/container. `code-provider-gt-cloud` and `code-provider-github` select peer views with `aria-pressed` and `aria-controls`; switching views has no repository mutation. Existing `github-code-*` local controls are retained. Private `cloud-github-*` account/task controls are inline in the GitHub view; the preview's separate `cloud-github-dialog`, `cloud-github-open`, `settings-cloud-github-open` and close button are removed with their bindings. The current release opens the shared Cloud Agent Web entry for trial and eligible repository tasks without changing their separately configured server enablement, exact profile routing or default local Codex selection, as specified in [Product specification](PRODUCT_SPEC.md).

### Windows/macOS Codex Launcher URI v1/v2

The Claude-compatible source Launcher additionally accepts v3: exactly the v2 fields plus `harness=codex|claude-code`. Web continues emitting v2 for the unchanged Codex flow and emits v3 for Claude. Unsupported/duplicate/unknown harness fields fail closed. v3 routes locally to the separately bundled connector/plugin; it reuses the same password-protected account/project handoff and does not claim the existing grant is harness-bound. Old installed Launchers will reject v3 and must be updated using matching reviewed artifacts. No old Release asset is silently overwritten. Shared contract vectors cover all three versions.

Windows and macOS Launchers use `gatherthread-connect://connect`. The primary Web flow emits v2 with the six original settings plus `email` and `authorization_id`. It is offered only on the exact HTTPS production/test origins for desktop Windows/macOS, never phones/tablets. Terminal instructions are collapsed on supported desktops and remain available for Linux/self-hosted instances. The Windows handler and branded shortcut are per-user; macOS uses its `.app` URL Scheme. The browser cannot assume installation.

v1 retains exactly the original six fields and accepts production only; old links continue to use the compatible hidden authorization input. v2 requires exactly eight fields and permits only `https://gatherthread.cn` or `https://test.gatherthread.cn`. `email` is a normalized conventional ASCII mailbox (the registration bounds); `authorization_id` is a public UUID, not a bearer capability. `project` is 1–128 ASCII letters/digits/`.`, `_`, `:`, `-`, beginning with a letter/digit; `model` is nonempty, at most 120 characters, without controls or leading `-`; `context_window_tokens` is decimal 4096–2000000; `visible_history_sync` is `first-connect|never`. URI size is at most 2048 UTF-8 bytes. Unknown/duplicate/missing fields, fragments, userinfo, ports, paths, unsupported versions and other origins fail closed. Both handlers retain the validated origin and pass it unchanged to `--url`. Shared producer/consumer vectors are in `prototypes/codex-launcher/contract-vectors.json`.

v2 pre-fills email and environment, then asks for the account password only in the native form. No password, `gta_`, `gtd_`, Cookie or local path enters a link, argv or log. Creation is an authenticated `POST /v1/codex-launcher-authorizations` with `{project_id,email}` and returns `{data:{authorization,email}}`, verifying the mailbox digest belongs to the current actor. The native-only `POST /v1/codex-launcher-authorizations/claim` takes `{authorization_id,project_id,email,password,device_name}` in strict bounded JSON and returns HTTP 201 `{data:{actor,device,token,authorization}}`. The public request ID alone cannot issue a device: password, same account/project, active authorizer/membership and the ten-minute unclaimed grant must all validate after hashing inside the claim transaction. It creates an independent native device without touching browser sessions. Claim rejects browser Origin/fetch headers, Cookies, bearer headers and queries; clients allow no redirects, use a 15-second deadline, cap responses at 16 KiB, validate coherent identity and never automatically retry ambiguous delivery. Test admission still protects creation; only this exact password-protected native capability route is exempt. Existing gtd/DSH interfaces remain unchanged.

Opening the new Launcher directly guides users back to the signed-in Web project; legacy v1 manual settings remain compatible. Workspace selection stays local, with mutually exclusive `--create-workspace` or `--workspace <existing absolute path>` flags, revalidated by the connector. An old v1 app intentionally rejects v2, so publication must include updated native archives rather than replacing Web alone. Windows bundles multiresolution ICO/PNG for window, taskbar, protocol and shortcut; macOS bundles an ICNS declared in Info.plist and used at runtime. Build verification refuses missing icons. Signing/notarization and actual Windows smoke remain separate release gates. See [ADR-0044](adr/0044-email-password-codex-launchers.md).

Mac distribution adds `GatherThreadLauncher-macOS-<architecture>.dmg`, `*.dmg.sha256` and `*.dmg.provenance.json`; the ZIP remains compatible. The image shows only Applications on the left and the expected app on the right, joined by a leftward background arrow. Bilingual installation/safety/Hook text appears on the approved static background; detailed `READ ME FIRST.html`, `BUILD_PROVENANCE.json`, background and layout assets remain in the hidden `.gatherthread` directory. Build-only hash-pinned tools write a strictly verified `.DS_Store` on a private intermediate; the published image remains read-only. Schema 1 provenance stays unchanged: clean source commit, connector/release-source and Node versions, architecture, minimum macOS, explicit ad-hoc/non-notarized status and app-file hashes. Launcher 0.1.6/build 16 is the required numeric app version, covered by those same hashes; its product release and bundled connector/plugin versions are `0.1.0-beta.6`. The publisher verifies the actual mounted bytes, Finder view/icon placement/background target and signature against the pre-build record and detaches before promoting the local artifact. Only Git-reviewed plugin paths are packaged. This changes neither the v1/v2 URI nor authorization/API/connector boundaries. `codex-launcher-macos-install` is a presentation-only, Mac-only guide; all prior control IDs remain. See [ADR-0047](adr/0047-macos-launcher-dmg-installation.md).

Web HTML IDs, form names, accessible labels, dialog relationships, and the separate chat/Agent actions are integration points between static markup, JavaScript, tests, assistive technology, and browser automation.

- `/` is the product home and `/app/` is the authenticated application. Root operational links containing `?api=...`, `?mock=1`, `#project`, `#session`, `#dsh-pair`, `#settings-*`, or `#main-content` must preserve their query and fragment when forwarded to `/app/`.
- The product home and application must share one origin while retaining separate style and script entry points. Do not move authentication, API, WebSocket, Cookie, or invitation behavior into the product home.
- A browser API override must remain on that same origin and cannot contain URL credentials. Reject an invalid override before sending login/device credentials; development uses a same-origin proxy. Explicit Node/connector server selection is separate.
- Preserve them during visual-only changes or update every consumer and accessibility test in the same PR.
- All user and Agent Markdown is untrusted. Keep URL filtering, escaped raw HTML, code-fence protection, bounded parsing, and bundled KaTeX limits intact.
- Bilingual copy must be updated in English and Simplified Chinese without translating product names, user content, provider/model identifiers, or opaque IDs.
- Layout changes must retain Safari and Chromium behavior, keyboard focus, reduced motion/transparency, high contrast, and responsive fallbacks.

## Desktop native management preview

`discover` accepts optional `harness` and `force` fields; status includes bounded per-harness detection state and whether a program location was remembered. Only native selection or verified discovery writes the private, versioned `agent-programs.json`; malformed/oversized preferences are ignored and write failure remains visible. Discovery coalesces concurrent requests, bounds filesystem candidates and version probes, fences late environment results, and cannot authorize a connector. The native picker resolves known CLI locations within a selected app or installation folder. These changes belong to the unreleased desktop preview and require no Web/server migration.

Executable inspection reports `executable_signature_invalid` only after a positive native signature diagnostic, `executable_terminated` for other signal exits, `executable_probe_timeout` for the bounded version probe, and `executable_probe_failed` for other probe failures. A missing/changed/wrong-harness file remains `invalid_executable`. Native diagnostic output is never returned over IPC. These are additive codes in the unreleased local v1 contract.

`packages/protocol/src/desktop.ts` owns strict local IPC v1. The packaged management main frame alone can call `gt-desktop:action`; `gt-desktop:status` returns schema-checked public connection metadata. The remote Web has no preload. Actions cover status, install discovery, native executable/directory selection, explicit start/stop, opening the selected directory/DSH and returning to the workspace. The fictional demo action exists only in demo mode. Requests accept host-issued opaque UUIDs, never arbitrary commands, paths or endpoints. Unknown fields fail closed; errors return stable codes without provider bodies or credentials.

Start consumes an explicitly reviewed v2/v3 handoff and reserves an origin/project/harness slot before claim. Native authorization retains the existing deadline, response bound, identity checks and no-retry semantics. Exact executable/directory identity is rechecked after asynchronous claim. Device credentials reach only the spawned connector environment; passwords are not persisted. A cancelled or consumed start cannot later launch. Capacity remains held until parent and owned process group exit; timeouts only report uncertainty. There is no automatic reconnect, fallback or restart replay.

No HTTP/SQLite migration is required. Production/test Cookie partitions are distinct. DSH/native plugin contracts are unchanged. [ADR-0066](adr/0066-isolated-macos-desktop-workspace.md) and [desktop acceptance instructions](../apps/desktop/README.md) delimit prototype and release claims.

## Changing a contract

An interface-changing PR must answer:

1. What is the current contract and why is it insufficient?
2. Which producers, consumers, persisted records, published packages, browser surfaces, and supported upstream versions are affected?
3. Is the change additive, compatible, migrated, versioned, or intentionally breaking?
4. What are the authorization, privacy, idempotency, quota, replay, and failure semantics?
5. Which contract and negative tests prove both sides agree?
6. Which canonical docs, release notes, and ADRs must change?

The project lead must review the PR before a version containing the contract change is merged, tagged, published, or deployed.

## Hosted Agent source-preview contract

### Personal Cloud API configuration

Strict schemas/types are owned by `packages/protocol/src/cloud-api.ts`. Browser-session authentication is required, with normal Origin/admission/device checks after reading writes. `GET /v1/cloud-api` returns `CloudApiStatusSchema` (enablement, fixed provider catalog, own metadata). `PUT /v1/cloud-api/:uuid` accepts `CloudApiPutInputSchema` (`expected_revision`, `provider_id`, `label`, `model`, `enabled`, optional write-only `api_key`; 8 KiB); returns `{data:{configuration}}` via `CloudApiSavedSchema`. `DELETE` accepts `CloudApiDeleteInputSchema` with exact `expected_revision` (1 KiB), returns 204. New configs and changed providers require a newly submitted key; otherwise omitted keys retain the current key. Reads never return key/digest/ciphertext/suffix. Metadata contains UUID `id`/`revision`, `profile_id: api-<uuid>`, provider/label/model/enablement, `has_key: true`, timestamp. Limit: eight own configs.

Personal `HostedAgentRequestInputSchema`, `HostedHistorySummaryInputSchema` and `HostedGithubTaskInputSchema` require exact `api_config_revision` alongside `profile_id`; service profiles reject that field. It remains private control-plane input, absent from shared history. Status adds only enabled own profiles with `source: personal` and revision; existing service meanings stay compatible.

All new cloud and GitHub requests, including automatic retries/resumes, send the originally captured non-negative integer `content_revision` in `HostedAgentRequestInputSchema` or `HostedGithubTaskInputSchema`. The accepting `BEGIN IMMEDIATE` transaction compares it with the authoritative session revision before creating any event, task, budget entry, active slot or start interval. A stale pin returns `409 context_changed`; clients must not update that pin and silently resubmit the old body. The field is private control input, not shared payload or a substitute for `api_config_revision`. Omission remains compatible only for pristine revision-zero sessions. After any deletion, an unpinned request returns `409 context_changed` with an instruction to refresh, so a still-open older page cannot automatically resubmit erased content. The Web client additionally rechecks the captured account/session/revision and current undeleted source after asynchronous selection/confirmation and before sending; this does not replace the server transaction check. Summary requests contain source IDs, not cached source text: the server captures its revision and the acceptance transaction independently validates/rebuilds those sources and their digest.

`GET /v1/sessions/:sessionId/hosted-agent-requests/:requestId/selection` returns requester-private `HostedAgentSelectionSchema` `{data:{profile_id,api_config_revision?}}`. It requires browser session, active device, current session write access, original request author, current history revision and exact job/config binding. Foreign/mismatched requests return 404; erased requests or stale history return `409 context_changed`, and changed/disabled/deleted configs return 409 instead of their latest revision. Original service profile/provider/model must still match. Web retry/resume use this selection. Hosted same-key retries also reject an erased or stale request without reserving or charging another run; canonical append retries may still return the safe tombstone. New hosted requests cannot quote a deleted source (`409 message_deleted`). Private GitHub task views retain the original API revision and continuations enforce it server-side; a completed task can still be reviewed/published after its API config changes because that action invokes no model, but history deletion invalidates its private source/result and blocks viewing, continuation and publication.

Safe codes are `cloud_api_invalid` (400), `cloud_api_unavailable` (400; missing/foreign/disabled/tampered key), `cloud_api_changed` (409), `cloud_api_limit` (429), `hosted_request_unavailable` (404), `hosted_access_changed` (403), `hosted_profile_changed` (409), plus normal browser/admission/CSRF and reservation errors. No error includes credential/input/provider bodies. See [ADR-0049](adr/0049-account-owned-cloud-api-configuration.md).

### Existing service and hosted execution

`GET /v1/hosted-agent` is authenticated and returns `{ data: { enabled: false } }` when disabled. When enabled, `HostedAgentStatusSchema` defines the exact public profile IDs, labels, providers, models, availability/capacity, UTC-day run usage/limits, capabilities and privacy copy. Daily limits may be `null` for the confirmed free-model setup. Optional `rate_limits` reports `user_min_interval_seconds`, `user_max_concurrent`, `user_active_runs` and `retry_after_seconds`; profile availability can be `user_busy` or `rate_limit`. It never returns endpoint IDs, account grouping, URLs or API credentials. Preview server and Web upgrades must be coordinated for these new status values.

`POST /v1/sessions/:sessionId/hosted-agent-requests` uses strict `HostedAgentRequestInputSchema`: `profile_id` (legacy default `default`), `content`, `include_code`, `idempotency_key`, and optional `reply_to_event_id` and `continue_from_event_id`. Continuation linkage is server-owned: generic event/local-turn append paths reject it. It enforces live project/session write permissions and reserves user cooldown, user/account/global concurrency and any daily allowance atomically with the canonical request. It immediately returns HTTP 202 `{data:{request_event,replayed}}`, validated by `HostedAgentAcceptedSchema`; completion arrives through canonical replay, not this HTTP exchange. A profile identifies one exact provider/model. Only account capacity within that profile is interchangeable. Empty/unknown profiles, quota exhaustion, busy capacity and unavailable providers fail explicitly. New error codes `hosted_user_busy` and `hosted_user_rate_limit` return 429; the latter includes `error.details.retry_after_seconds`. Accepted failures consume their start interval and any daily allowance; rejected reservations roll back, and same-key retries never double-execute. User limits aggregate trial and repository tasks across models, projects, sessions and devices.

The Web's visible GT Cloud code choice starts on and remembers explicit on/off by account and project without changing on send or re-render. It sends `include_code:true` only while GT Cloud is enabled and write access permits it; the existing shared-version fallback before a first personal branch is preserved. This boolean browser preference grants no permission and changes no local upload or GitHub setting. Retry/Continue preserve the original request choice. See [ADR-0053](adr/0053-persistent-project-cloud-code-choice.md).

`continue_from_event_id` identifies an ordinary timed-out request in the same session. Only its author/current writer may continue, and content, exact profile/provider/model, code choice and quote must match the recorded request. A timeout accepts at most one child, while its exact same-key retry returns the existing child. All ordinary quota/cooldown/capacity gates apply to the new execution. The same additive field on `HostedHistorySummaryInputSchema` instead requires the original selected source IDs/digest, forbids replacement instructions and reuses the canonical original summary prompt. Summary file/tool isolation remains unchanged.

`POST /v1/sessions/:sessionId/hosted-agent-requests/:requestId/pause` accepts strict empty JSON and returns `HostedAgentPausedSchema` `{data:{request_event_id,status:"paused"}}`. Only an active device, current writer and the original author may pause an ordinary cloud trial request. A private transactional pause fence commits one fixed canonical lifecycle marker, aborts execution and prevents subsequent model calls, answers and checkpoints. Repeated pause adds no event. The executor slot is held until confirmed exit; no quota refund or lossless continuation is promised. Summary requests, repository tasks and local runtime claims are not controlled by this endpoint; rejecting summary pause preserves its terminal generation workflow.

`POST /v1/sessions/:sessionId/hosted-history-summaries` accepts strict `HostedHistorySummaryInputSchema`: required exact `profile_id`, `source_event_ids`, `idempotency_key` and optional `instructions`. It accepts no client content, code, execution runtime or summary metadata. The reservation transaction validates the same complete public sources, ancestry, size and digest as the local summary route, reserves normal hosted quotas, and creates a server-owned `history_summary` request. It returns the same HTTP 202 receipt. Only selected sources are supplied, file/terminal tools are denied, and the existing linked successful answer activates the derived summary/context view. Failures retain originals. Client and server validate strict cloud receipt/pause schemas. See [ADR-0042](adr/0042-cloud-request-lifecycle-and-selected-summaries.md) for additive persistence and coordinated rollback.

Server/Web must upgrade together from the earlier single-provider preview. Persistence migration, old environment aliases and rollback limits are in [HOSTED_AGENT.md](HOSTED_AGENT.md). This surface remains disabled until provider and deployment validation; it does not advertise a currently running public service.

Hosted completion generates its terminal idempotency key privately inside the transaction; public chat cannot preempt a predictable key derived from the request ID. The running job transition deduplicates completion and restart recovery. After confirmed executor exit, a storage quota failure discards the full answer and commits a fixed failed `agent_response` with `error.code=storage_quota_exceeded`, the job's terminal state and slot release atomically. Authorization changes retain `access_changed`. Canonical terminal failures retain `status:"failed"` and add the strict `HostedAgentFailurePayloadSchema` classification `outcome:"timed_out"|"failed"`. Timeouts are persisted additively and old timeout codes remain readable; no event or accounting rewrite occurs. Execution failures use only the allowlist in `apps/server/src/hosted-agent-errors.ts` (including `container_timeout`, container final-response `agent_timeout` and safe `provider_*` categories), otherwise `model_unavailable`. An execution failure may include `error.provider_attempts`, a safe integer 0–64, never exception text, response bodies or credentials. Internal terminal validation permits only the exact fixed copy/code/count shape, within 1 KiB; quota/access markers are unchanged. The bounded, charged server control allowance is owned by [Security](SECURITY.md#persistence-and-redaction-requirements); it never permits arbitrary model or client payloads beyond ordinary quotas.

The pinned container runner obtains its result from one loopback OpenCode session's completed prompt response, not partial CLI events. It requires the exact assistant/session message, a completed timestamp, a final finish without an error, and session idle. Only public text parts are returned, and process closure precedes file collection. Trial and repository tasks share that completion boundary while retaining their separate resource and proxy limits. See [ADR-0041](adr/0041-guided-settings-and-ephemeral-hosted-startup.md); this internal change requires a matching rebuilt runner image but does not alter the HTTP request contract.

## Cloud GitHub task preview

Hosted trial and repository RAM/swap policy is an administrator-only setting, not an HTTP input field. `limited` remains the default; explicit `shared-host` requires host concurrency one, an explicitly configured single-CPU cpuset and a matching guarded image. An absent cpuset refuses shared mode rather than using an unchecked CFS entrypoint. Request identity, model routing, authorization, timeouts and confirmed-exit capacity settlement are unchanged. See [the operator memory policy](HOSTED_AGENT.md#shared-host-memory).

Strict input and response schemas with inferred types are owned by `packages/protocol/src/hosted-github.ts`; server routing is in `apps/server/src/server.ts` and private persistence in `hosted-github-schema.ts`. Both server responses and the Web HTTP client validate these schemas. Additive routes are:

- `POST /v1/hosted-github/authorize`, `GET /v1/hosted-github/callback`, `POST /v1/hosted-github/complete`, `DELETE /v1/hosted-github/account`.
- `GET /v1/projects/:id/hosted-github`, `POST /v1/projects/:id/hosted-github/repository`, `GET /v1/projects/:id/hosted-github/tasks`.
- `POST /v1/sessions/:id/hosted-github-tasks` returns 202 with a private task.
- `GET|DELETE /v1/hosted-github/tasks/:id`, `POST /v1/hosted-github/tasks/:id/pull-request`.

Status, authorization URL, connection/disconnection, binding, task summary/detail and publication responses have separate strict public shapes. A project list contains at most ten metadata summaries; answers and before/after source appear only in the selected private task detail. Unknown fields, private storage fields, invalid URLs/identifiers, unsafe source paths, malformed base64 and oversized source are rejected. Detail limits match the per-file/per-side source limits in [HOSTED_GITHUB.md](HOSTED_GITHUB.md#supported-environment); a diff may include at most 2000 distinct paths when before and after contain different files. The Web reports a generic invalid-response error without echoing payloads. This change requires a coordinated server/Web upgrade.

Each user has a durable OAuth authorization generation. Issuing another authorization, successfully replacing the connection or disconnecting increments it across devices and cancels older pending/in-flight operations. A one-use device-bound state captures that generation; completion rechecks it after token exchange, after the user lookup and inside the transaction that advances the generation, writes encrypted credentials and invalidates prior bindings and binding attempts. Test admission and browser/device authorization are also rechecked at these request boundaries. Legacy-state migration is specified in [the upgrade guide](HOSTED_GITHUB.md#task-input-and-source-migration).

Repository selection reserves a private durable attempt revision per user/project before remote validation, capturing the current account generation and committed binding revision. A newer selection cancels an older in-flight attempt regardless of response order; a failed selection preserves the last committed consent. After each awaited lookup and inside the final SQLite write transaction, binding rechecks current account/generation, latest attempt, unchanged consent, device, membership and request admission. Disconnect and connection replacement clear attempts along with consent. Attempt revisions never enter public responses; retries require an explicit new selection.

Tasks use the existing canonical Agent request/result plane with optional `github_task_id`; old trial requests remain unchanged and cannot impersonate a repository task via that field. Canonical events carry task identity and bounded public assistant text, not private source/tool logs. Task queries and PR publication are requester-private and enforce current write eligibility. Request content is redacted once at the task boundary for persistence and execution, with a final prompt redaction. A private keyed original-input receipt preserves exact retry conflict semantics even when two inputs redact identically; it is never returned by task/status APIs. PR writes require `expected_revision`. Disabled project status returns `{enabled:false}`. Existing local GitHub routes are preserved. Resource limits, atomic input migration, credential storage and failure/retry behavior are documented in [HOSTED_GITHUB.md](HOSTED_GITHUB.md); current-day consumption survives cloud deletion under [HOSTED_AGENT.md](HOSTED_AGENT.md#upgrade-compatibility).
Executor slots survive session, project and account deletion until container exit is confirmed. Account deletion nulls their user link; no source or prompt enters the slot. Atomic migration preserves extant slots. Runtime cleanup failure retains capacity; single-process startup verifies Docker cleanup before releasing interrupted reservations. Every GitHub source acquisition and publication operation rechecks task access and binding after awaited token acquisition/refresh and immediately before dispatch; publication also rechecks request authorization. Source acquisition checks cancellation and running state at these boundaries and after each completed response before accepting it. Refresh also checks authorization before storing its result. Source downloads use the task cancellation signal and timeout together; cancellation never persists a newly acquired snapshot. Already dispatched GitHub requests cannot be recalled. Model calls recheck current job/task, device and write permission after the untrusted body is read, before dispatch; an authorization refusal consumes no model-call budget or provider cooldown. Admission behavior for accepted runs is owned by [Security](SECURITY.md#test-admission-boundary).

Private task source keeps the cumulative repository baseline (`initial_files`) separate from the actual source passed into this run (`starting_files`). Continuation uses the saved result or, for a failed/interrupted run, that run's starting source; diff review and explicit PR publication continue to compare against the original repository baseline. Upgrade reconstruction and refusal when legacy source is unknown are specified in [the task migration guide](HOSTED_GITHUB.md#task-input-and-source-migration).

## Verified-email account registration and password login

`packages/protocol/src/registration.ts` owns strict snake_case bodies and responses. GET `/v1/registration` returns `{enabled,site_key,challenge_binding}` under `{data}`; disabled values are false/null/null. Enabled status sets a 30-day HttpOnly browser marker, which is not authentication. POST `/v1/registration/send` accepts `{email,challenge_token,idempotency_key:UUID,locale:en|zh-CN}` and returns HTTP 202 `{registration_id,expires_in_seconds:600,resend_after_seconds:60}`. Within that pending record's ten-minute lifetime an exact browser/key/email/locale retry returns the same ID without sending again; mismatched payload conflicts, failed/uncertain/superseded/consumed retries fail, after expiry/cleanup the same UUID starts a new attempt with a fresh challenge under all normal cooldown/mail budgets. Resend invalidates earlier codes and IDs. OTP/challenge never appear in response or URL. Challenge verification checks configured hostname/action/cdata and local replay budget. The configured edge IP must supply only a validated, overwritten client-IP header; arbitrary forwarded headers are ignored.

POST `/v1/registration/verify` accepts `{registration_id,code:8 digits,display_name,device_name,password,remember_device,privacy_acknowledged:true}`. It returns HTTP 201 `{actor:{user_id,display_name,device_id,can_create_projects:true},expires_at}` and an HttpOnly session Cookie. No device token or password/hash is returned. The code is browser-bound, attempt/expiry/replay-limited and one-use; asynchronous password hashing is fenced with a private reservation and identity/email/device/session creation commits together. Registration creates no project or runtime.

GET `/v1/email-login` initializes the same browser marker and returns `{enabled:true}` when a persistent pepper exists. POST accepts `{email,password,device_name,remember_device}` and returns the same account/session shape. It remains available when signup is disabled or paused. Each browser gets an independent device; repeated password login in that browser rotates only its session. Password login does not edit the account display name, recover a password, inherit an old account or alter roles. Invalid mailbox/password errors are identical and hash work/attempt budgets are enforced for absent mailboxes too. All writes require exact configured allowed Origin, JSON, the browser marker and an 8 KiB maximum body. Bodies reject identity/role overrides and unknown fields.

Email normalization trims/lowercases conventional ASCII mailboxes, preserving dots and plus suffixes; no provider alias canonicalization occurs. Passwords are 8–128 characters, at most 512 UTF-8 bytes; no normalization or truncation. Errors use stable `registration_unavailable`, `registration_delivery`, `registration_invalid`, `registration_limited`, `registration_challenge`, `registration_browser`, `email_login_invalid`, `password_busy`, normal schema/Origin errors and idempotency conflict envelopes. User bootstrap, token-to-Cookie exchange, qualification activation, guest invitation claim and remembered-account routes return `410 account_flow_retired` for all methods. Device authorization/claim, DSH pairing, native Bearer authentication, Cookie logout/realtime and independent revocation remain supported. Project invitation acceptance requires an existing authenticated account; it creates no identity. The additive schema is described in [ADR-0036](adr/0036-verified-email-registration-and-password-login.md); default closure, retention and operator pause are owned by [SECURITY](SECURITY.md) / [OPERATIONS](OPERATIONS.md).


## Email password recovery

The 8-character minimum is a compatible expansion of the previous 12-character policy. Deploy matching Web/server validation together; existing password hashes, account records and native-device authorization need no migration.

All success values below use the `{data}` envelope; request/response fields are snake_case and request schemas reject unknown fields and identity/role overrides. `packages/protocol/src/registration.ts` owns the strict schemas. Recovery requires its independent default-false `GATHERTHREAD_PASSWORD_RECOVERY` switch and configured providers; it can work with signup disabled. The durable mail pause closes both code flows while password login stays available.

| Route | Strict request | Success |
| --- | --- | --- |
| `GET /v1/password-reset` | No query parameters or credentials | 200 `{enabled,site_key,challenge_binding}`; disabled values are false/null/null. Enabled status sets the same 30-day HttpOnly browser marker. |
| `POST /v1/password-reset/send` | `{email,challenge_token,idempotency_key:UUID,locale:en\|zh-CN}` | 202 `{reset_id:UUID,expires_in_seconds:600,resend_after_seconds:60}`. Known/unknown mailboxes use the same mail/receipt path. |
| `POST /v1/password-reset/verify` | `{reset_id:UUID,email,code:8 digits,password,password_confirmation,locale:en\|zh-CN}` | 200 `{reset:true}`; no session Cookie, account identity or device credential is issued. Both passwords must match and satisfy the same 8–128-character/512-byte policy as registration. |

POSTs require the exact configured allowed Origin, JSON, the browser marker and an 8 KiB body bound; cross-site requests and query parameters fail closed. Recovery has separate OTP HMAC/challenge-binding domains and Turnstile action `gt_password_reset`, ten-minute expiry, five verification attempts, single-use proof reservations and an issuance password-version fence. Exact browser/key/email/locale send retries within the pending lifetime return the same receipt without redelivery; changed payload is 409 `idempotency_conflict`. Expired keys need a fresh challenge and consume normal budgets. Resend invalidates earlier recovery codes.

Invalid/expired/wrong-browser/unknown-account/version-changed/replayed proofs return 400 `registration_invalid`. Missing browser marker is 400 `registration_browser`, failed security check is 400 `registration_challenge`, malformed/unknown fields or mismatched passwords are 400 `validation_error`, missing/wrong Origin is 403 `csrf_origin_required` or `origin_forbidden`, and non-JSON content is 415 `invalid_content_type`. Durable rate/cap limits return 429 `registration_limited`; disabled recovery is 503 `password_reset_unavailable`, changed/missing code-flow dependencies or pause during work is 503 `registration_unavailable`, uncertain delivery is 503 `registration_delivery`, and hash capacity is 503 `password_busy`. Code sends and one attempted success notice share the existing global mail caps; failed/uncertain reservations are not retried or refunded.

A verified reset retains account/project/membership IDs, roles and quotas and atomically changes the password plus revokes all database devices, sessions and pending device grants. Database completion returns without awaiting mail. The service synchronously removes DSH pairings/realtime tickets and closes old sockets before any notification wait. Pairing issuance independently revalidates the approving device. Notification success, delay or failure cannot restore old authorization or undo the commit; the response may wait for the bounded one-time notification attempt. Users then sign in normally and authorize new Agent devices. No wire shape, Launcher URI or connector protocol changes as part of this safety correction.

### Account avatar presentation metadata

- `GET /v1/me` includes nullable `avatar_id` with the existing account identity. Project/session member records add nullable `avatar_id`; consumers may ignore this additive output field.
- `PUT /v1/me/avatar` accepts only strict `{ "avatar_id": "cat" | "fox" | "bear" | "rabbit" | "penguin" | "owl" | null }` and returns `{ data: { user_id, avatar_id } }`. Requires an active email-account browser session, allowed write Origin and the existing admission/rate gates. No target user, image URL or upload is accepted. The database rechecks the active device in the write transaction. Absolute assignment is idempotent; retrying the same PUT has no extra side effects or canonical event. Concurrent assignments use last accepted write.
- `GET /v1/sessions/:session_id/avatar-profiles` returns `{ data: { profiles: [{ user_id, avatar_id }] } }` after current session membership/device authorization. Profiles cover current project members and historical authors whose events the caller can read, including departed members. No global user lookup is exposed. Unknown catalog IDs fall back to null for presentation.
- Avatars are a mutable read model; no avatar field or profile-change event is added to the canonical event log. Sequence, replay payloads, frozen `actor_display_name`, history injection and native transcript projection remain unchanged. Web refresh is best-effort on session selection and existing member polling, with account/selection/save fences for late responses. Avatar reads run independently of project/session loading, membership and permission refresh, and realtime connection. HTTP avatar reads have a four-second deadline; one in-flight profile read per active selection prevents overlapping polls. Failed reads retain confirmed presentation and may retry without delaying authoritative access changes.
- Persistence adds nullable `users.avatar_id`; existing databases migrate additively and default to initials. Account deletion removes the original user's profile; the existing shared-history deletion identity has no avatar. Rollback clients ignore avatar metadata; replacing an image retains its stable ID. The catalog/schema consistency test guards newly added IDs.

## Native Agent sharing preview contract

Strict additive schemas are in `packages/protocol/src/agent-sharing.ts`. All
routes retain the normal `{data}`/`{error}` envelope, active-device/ACL gates and
strict snake_case inputs. Browser mutations also require the existing allowed
Origin/JSON checks. This preview is included in the Beta 3 source release;
publication and deployment status remain separate release evidence.

| Route | Authority and shape |
| --- | --- |
| `GET /v1/projects/:project/agent-sharing-sources` | Current project writer; returns only their native execution source metadata, advertised profiles, capability and separate `sharing_availability`. No local session/path/credential is returned. |
| `GET /v1/projects/:project/agent-shares` | Current member; owner configurations plus grants explicitly allowing this writer. Borrower rows omit `source_runtime_id`, `owner_device_id`, `allowed_user_ids` and `total_usage`. |
| `POST /v1/projects/:project/agent-shares` | Owner browser only. `{share_id?,source_runtime_id,execution_profile?,enabled?,allowed_user_ids,limits,expected_revision,idempotency_key}`; create uses null revision, update uses the exact positive revision. Omitted enabled retains legacy save-as-disabled behavior; explicit true atomically saves and enables. Empty allowlists require disabled. Web changes autosave with explicit enabled state. |
| `POST /v1/projects/:project/agent-shares/:share/control` | Owner browser only. `{action:enable\|disable,expected_revision?,idempotency_key}`; enable requires revision. Emergency disable may omit it. |
| `POST /v1/sessions/:session/shared-agent-requests` | Current writer; 202 `{event,job,replayed}`. `{share_id,share_revision,execution_profile?,content,content_revision,solo_transfer_ack?,reply_to_event_id?,mentions?,idempotency_key}`. Solo defaults to false and must explicitly acknowledge transfer. |
| `POST /v1/sessions/:session/shared-agent-requests/:request/cancel` | Original requester with current write access; `{idempotency_key}` returns `{job,replayed}`. |
| `POST /v1/agent-sharing-sources/availability` | Exact independently authorized native device; `{project_id,source_runtime_id,state,idempotency_key}`. States are ready/locked/offline/unsupported. |
| `POST /v1/agent-shares/:share/availability` | Exact owner native device; `{state,idempotency_key}` applies the same source availability operation. |
| `GET /v1/agent-share-jobs?project_id=:project` | Owner native device; bounded content-free queued/running/cleanup summaries. No browser Origin or Fetch Metadata is accepted on native controls. |
| `POST /v1/agent-share-jobs/:job/{claim,lease,progress,complete,abort-ack}` | Exact owner native device/source only. Claim takes a stable key and returns a validated private capsule. Later operations require exact positive `claim_attempt` and a key; output adds observed model/effort. Completion/abort acknowledgment requires literal `executor_stopped:true`. |

`sharing_capability` on runtime registration is strict version 1 with literal
true `isolated`, `project_only`, `cancellation` and `liveness_watchdog`, plus ordinary
`context_deletion_version:1`. Native capability registration initially records
offline; explicit source READY is separate and does not enable a saved grant.
LOCKED fences all sources on that owner's native device; other non-ready reports
are source-scoped. Same-key availability retries return current state without
reapplying an old READY. New enable/save/calls never substitute an unavailable
source or profile. Limits/defaults and UTC behavior are owned by
[Product specification](PRODUCT_SPEC.md#share-my-native-agent-local-implementation-preview).

Grants share one exact native source, not a fixed model. Discovery includes its
current public `execution_profiles` catalog; the legacy `execution_profile` is
only a default. Borrowers pass their exact selected profile per request, including
MCP requests. An omitted request profile retains the saved exact legacy default and fails if
it is no longer advertised; new clients always send their selected profile. Admission and every native lease revalidate the frozen job profile.
A removed model cancels affected work without disabling other advertised models;
harness/device/source identity cannot change silently. Explicit disabled saves
may persist configuration while the source is offline. Stop remains an independent
control mutation; revision CAS prevents an older autosave from re-enabling it.

Grant and request receipts bind exact input digests. A changed retry conflicts;
same-key accepted requests do not reserve another call. The capsule pins source,
device, project, context digest/revision/head, deadline and lease; context and the
whole capsule are bounded at 256 KiB and 288 KiB respectively. Claims use a
15-second renewable lease capped by the original deadline. Native shutdown or
revocation cannot free an unconfirmed execution slot. The browser bounds reads
and mutation acknowledgments independently; unknown acceptance retains the same
body/key for explicit recovery before another request. Emergency disable remains
available during an uncertain enable.
Confirmed shared-stop outboxes also drain independently of current source
availability or registration. Startup recovery reads only the bounded private
control directory for the exact project/device, validates original source and
attempt identities, and removes a receipt only after a verified terminal cleanup
acknowledgment. Codex may locate an existing managed workspace by its exact
server/project marker before project discovery; it does not guess a deleted
project's workspace or inspect unrelated native conversations.

Web sharing reads, sends, recovery and cancel operations each bound the whole
HTTP exchange (including the response body) to eight seconds and abort their
own transport. Uncertain retries preserve the original body/key. An uncertain
enable is displayed as stoppable in both owner switches. Closing or returning
from the sharing panel after an explicit warning does not cancel an in-flight
write or retire its frozen receipt; reopening within the same authenticated
context retains exact-body/key recovery. Only a draft for which no request was
sent can be explicitly discarded. Current write authorization still gates every
recovery mutation, and account/project scope changes fence delayed navigation.
The view owns `agent-sharing-leave-confirmation` and its `leave-stay`,
`leave-discard` and `leave-pending` controls (all with the `agent-sharing-`
prefix), implemented as ordinary buttons rather than native modals or form
submission. Their current navigation/pending identities fence stale actions.
Before a first-create
receipt supplies a grant ID, Stop independently discovers the owner's exact
source grant and disables it; it never resends enable to discover the ID. If
acceptance is not yet discoverable, Stop remains explicitly unconfirmed and
retryable. A newer Stop fences late enable responses. A verified canonical
request matching the borrower's scope/key/share settles its send intent; Stop
is available from that request identity without awaiting the send/recovery
response, and cancel retries retain their independent key.

`CanonicalEvent.shared_execution` is optional readonly broker-origin proof;
generic event inputs cannot supply it. Request and native-result payloads retain
server-owned `shared_agent` metadata, but legacy payload text alone is untrusted.
Shared results keep the requester as canonical actor and expose the owner only
through verified execution identity. Public provenance omits the ordinary source
runtime ID; server cancellation/failure markers make no native fidelity claim.
User MCP exposes only `collaboration_list_shared_agents`,
`collaboration_request_shared_agent` and `collaboration_cancel_shared_agent_request`,
through the project-scoped borrower API; it exposes no sharing management or
native claim/availability controls.

The owner list groups unconfigured conversation runtimes by exact device and
harness. Every saved grant retains its exact source runtime and Stop control;
grouping never migrates permissions. Independently authorized devices remain
separate even when their default names match, with distinct connection labels
and online/offline state. An open editor keeps its selected source until the
user leaves it.

Persistence adds separate grants, allowlists, usage, jobs, receipts, capabilities
and source barriers, plus an additive canonical origin marker. Existing ordinary
requests and older events have no shared execution proof. Rollback clients may
ignore additive output but must not execute broker-owned requests through normal
claims. All participating server/Web/native clients need the strict shared
schemas; unsupported native platforms refuse sharing rather than broadening tools.
Retention, erasure and native permission requirements are owned by
[Security](SECURITY.md#native-agent-sharing-preview-boundary); the decision is in
[ADR-0056](adr/0056-project-scoped-native-agent-sharing.md).

## Saved Agent Team preview contract

`packages/protocol/src/agent-team-library.ts` owns the strict account-library
schemas; `agent-team.ts` owns frozen plans, targets, runs, steps, control actions
and server-reserved request metadata. New library, test, enable and start routes
require a browser session, with the normal active-device and mutation
Origin/admission/JSON gates. All JSON fields use snake_case and the existing
`{data}` / `{error:{code,message,details?}}` envelopes.

| Route | Authority and shape |
| --- | --- |
| `GET /v1/agent-teams` | Current account only; `{teams,modules,team_limit:5,module_limit:5}`. Definitions and favorites are account-wide, not project-owned. |
| `PUT /v1/agent-teams/:team` | Owner only; `{draft,max_calls?,max_duration_minutes?,expected_revision,idempotency_key}` returns `{team,replayed}`. Creation requires null revision; edits require the exact saved revision. |
| `PUT /v1/agent-team-modules/:module` | Owner only; creates an immutable `{module,idempotency_key}` favorite and returns `{favorite,replayed}`. The module snapshot has `label,role,prompt?,target` without graph identity or position. |
| `DELETE /v1/agent-teams/:team` / `DELETE /v1/agent-team-modules/:module` | Owner only; strict `{idempotency_key}` returns `{deleted:true,replayed}` and releases the library slot. Team deletion cancels its pending connectivity test, not accepted task snapshots. |
| `POST /v1/sessions/:session/agent-teams/:team/test` | Saved owner/current session writer; `{expected_revision,content_revision,solo_transfer_ack?,idempotency_key}`. 202 `{run,replayed}` with `purpose:test`. |
| `POST /v1/sessions/:session/agent-teams/:team/control` | Saved owner; `{enabled,expected_revision?,idempotency_key}` returns `{team,replayed}`. Enable requires exact passed revision plus current writable session and exact available targets. Disable may omit revision and does not require a new execution authorization. |
| `POST /v1/sessions/:session/agent-teams/:team/start` | Saved owner/current session writer; test input plus nonblank `content` (at most 3,000 characters), optional `reply_to_event_id` (ID or null) and `mentions`. 202 `{run,replayed}`. The server supplies the saved plan and limits; client plans cannot override them. |
| `GET /v1/sessions/:session/agent-team-runs` / `GET .../:run` | Authenticated requester with current session access; at most 50 own-run summaries, active runs first, ordinary tasks before hidden connectivity probes within each group, then newest first, or `{run}` detail. Another member's private run is not exposed. |
| `POST /v1/sessions/:session/agent-team-runs/:run/control` | Original requester with current write access; `{action:pause\|resume\|stop\|continue,idempotency_key}` returns `{run}`. Resume/continue recheck the frozen original device and original deadline; any new execution also requires remaining calls and an available exact target. |
| `DELETE /v1/sessions/:session/agent-team-runs/:run` | Original requester/current writer; strict `{}` forgets only a terminal private record and returns 204. Canonical events remain. |

A draft contains `name,team_prompt,entry_node_id?,nodes,edges`, at most 16 modules,
32 edges and 64 KiB serialized JSON. Module `target:null` supports saving an
unbound draft; executable plans require every target and directional
reachability from the entry module. Targets are an exact own local runtime,
provider/model/effort; an exact shared grant/revision and advertised profile; or
a cloud profile/provider/model with its private API configuration revision and
explicit `include_code` flag. Missing or removed selections fail closed. A cloud
target has no independently writable native reasoning-effort field. Edges use
`source,target,direction:one_way|bidirectional`, with unique IDs/routes, existing
endpoints and no self-loop. They are permission to call, not a mandatory task
schedule or an extra tool grant; the subordinate's return follows the recorded
caller stack without implicitly authorizing arbitrary reverse delegation.
Bounds/defaults and library/editor behavior are owned
by [Product specification](PRODUCT_SPEC.md#my-agent-teams-local-implementation-preview).

Definition output adds `id,revision,enabled,tested_revision,test_run_id,
test_session_id,test_status,updated_at` to the saved draft/limits. Test status is
`not_tested|running|passed|failed`; enabling/disabling advances the revision and
preserves a valid test stamp only while configuration is unchanged. A saved edit
invalidates the stamp and disables future starts. Revisions are opaque positive
integers allocated by a durable account clock, not consecutive per-Team counters.
Deleting and recreating an ID cannot reuse an older revision or accept another
device's stale save, enable or start. Migration reserves the new revision namespace
at or above `2^40`; surviving legacy definitions keep their existing revisions
until changed, while recreations cannot recycle the earlier preview's counters
even when every old definition was already deleted. Test completion persists its successful
stamp on the server without requiring a library read; forgetting or pruning the
private test record does not erase that stamp. Replacing or deleting a definition
atomically fences its old connectivity test before acknowledging the library
mutation; exact receipt recovery can retry physical cleanup. A replacement test
must pass admission in that same transaction: a rejected replacement preserves
the old probe, claims, canonical head and allowances. Physical cancellation runs
only after the replacement transaction commits. Accepted task runs
remain independent. A favorite inserted into a
graph receives a new node identity and position. At the atomic five-item limit,
new entries return 409 `agent_team_limit` or `agent_team_favorite_limit`; unbound
or disconnected test/start inputs return 422 `agent_team_incomplete` or
`agent_team_disconnected`. Stale revisions and changed idempotent retries conflict.

Before reporting private run-storage exhaustion, start admission may reclaim
the same account's terminal connectivity caches no longer referenced by a saved
definition. Current probes, task records and consumed-key receipts are excluded;
the reclamation rolls back if replacement admission fails. Web run records expose
the existing terminal-only DELETE route. After a lost 204, an authenticated
`not_found` for that exact private record is treated as already cleared only
after the current session list remains readable and does not contain it;
membership-hidden 404s, revoked authority and active-run conflicts remain failures.

The Team editor's local leave controls (`team-leave-save`, `team-leave-stay`,
`team-leave-discard`) do not change the save wire contract. Save and leave must
use the existing Save operation and validate its current editor/draft identity
before navigating. Closing while a Save is pending or unconfirmed is not
cancellation and retains the original request/body/key for explicit recovery;
late acknowledgments cannot navigate a replacement view. Save recovery is also
bound to an editor session: settling an older Save cannot automatically turn a
reopened stale cached draft into a new write or lend that draft the receipt's
revision/test stamp. It must load the confirmed configuration or stop for an
explicit reopen before another Save.

Run acknowledgments are acceptance receipts, not versioned status updates. A
client must not replace a later observed run status with a delayed Start or
control response; it still settles the original intent and refreshes current
state. A confirmed removal also fences outstanding run/favorite creation
responses so reconnect cannot restore an already cleared private record or
deleted favorite. Access denial and content-revision invalidation also fence
pending Start/control cache writes, including runs never previously listed.
Receipt acceptance may still settle the original composer intent without
restoring invalid private data. Reauthorization requires a fresh authorized read.
The same authority/content-revision fences apply to delayed failures and already
displayed diagnostics, including later locale rerenders. A stale failure cannot
restore an old module label or overwrite a newer validation message or draft;
an unknown transport result still retains its original retry body and key.
At equal definition revision, delayed Save/Test acknowledgments cannot replace
newer observed test metadata; a new exact recovery may read current state.
A new exact-key recovery attempt can read the current receipt.
Pause/Stop fence execution before acknowledging. If native cancellation fails
after that durable transition, same-state receipt recovery, startup and bounded
coordinator retries repair the outstanding claim; they do not reopen the run,
consume another call or let an old Pause receipt cancel resumed work.
Web Pause and Stop use current control authority independently of WebSocket
replay readiness; Resume, Continue and new work still require normal writable
state. A pending Pause transport cannot block the independent Stop path.

Run summaries may add a strict `issue` object containing `code`, nullable
`node_id`, `node_label`, `target_kind:local|shared|cloud` and `retry_at` (ISO
timestamp or null). Current clients can still read older summaries without it;
earlier preview Web builds using a strict schema do not accept the new field and
must be refreshed together with the server update. Module
identity comes from the immutable run plan, not a later library edit. Global
authorization, context and total-budget issues have no blamed module. Diagnostic
codes are allowlisted; raw provider messages, native exceptions, headers and
tool output are never diagnostic fields. Unknown retained error codes are
returned as a generic safe category. Existing `error_code:agent_timeout`
continues to control explicit Continue; `issue.code` may explain the more
specific trusted timeout cause.

Cloud cooldowns expose a running issue and earliest retry time without accepting
another call. Accepted native work may expose queued, offline or expired-claim
observations while its result is pending; these observations do not themselves
authorize a retry or declare the work failed. A nullable private `wait_reason`
column migrates in place and clears on acceptance or state transition. Rejected
Team controls may preserve `error.code:conflict` while adding an allowlisted
`error.details.issue_code` so clients can distinguish expired budgets, ended
runs, cleared receipts and an inappropriate recovery action. Preflight errors
may include the owning configuration's bounded module label and target kind.

Test/start acceptance binds its exact input digest, definition ID/revision,
session content revision and caller's stable key. While the private run exists,
an exact retry recovers that original accepted run without reserving another task,
including after the saved definition changes, is disabled or is deleted; current
caller/session authority still applies. A different action/body with that key
conflicts. A content-free consumed-key receipt is committed in the same
transaction as acceptance and survives private-run Forget, expiry pruning and
author-erasure cache cleanup. Once the private run is gone, the old key returns
409 `conflict`, or `idempotency_conflict` for a known changed input; it cannot
start another task, publish another canonical request or consume another call,
provider allowance or shared reservation. This also applies when the original
run stopped before publishing its first canonical step. The receipt does not
restore cleared run details. Browser requests
must bound response headers and bodies, preserve unknown acceptance and retain
an independent Stop/recovery path. Saved-plan edits never rewrite a frozen run.
While a start acknowledgment is unknown, composer recovery and Stop bind only
to the same authenticated scope/current user, original start idempotency key
and its verified run identity. Equal task text is not an identity match and
cannot authorize stopping another device's run. Before a matching canonical
request confirms that binding, recovery repeats the exact original body/key
rather than guessing a run from conversation content.

A paused run may consume its already completed canonical result without another
call or an online executor; this does not permit a new delegation or parent
return past its call limit. A human-paused shared step's verified broker
cancellation retires that interrupted attempt on Resume, which creates a new
counted step subject to shared cleanup and concurrency fences. Native online
preflight uses effective heartbeat presence, not a stale persisted online flag.
The saved-Team action routes accept at most 64 KiB of JSON so valid multilingual
tasks and mention ranges fit; task text remains bounded to 3,000 UTF-16 units.

Saved-Team and internal formal-run start schemas accept the existing in-session
quote and mention shapes. `mentions` uses `MessageMentionsSchema` (at most 32
UTF-16 ranges in the exact submitted task `content`, not in the generated Team
prompt). The browser omits empty quote/mention metadata. Parsed start input,
including explicit null or empty arrays, participates in the original digest;
omitted, null and empty values are not silently coalesced for same-key retries.
A changed quote or mention list with the same key conflicts. New acceptance and
first canonical publication enforce the existing quote visibility and current
member/text-range checks from
[Message quotes and mentions](#message-quotes-and-mentions). Receipt recovery
retains the original metadata while rechecking caller/session authority and
current deletion/context fences; it does not send another mention notification.

Only the first formal canonical step carries the original quote and mentions,
through own-native, cloud or shared execution. Its assembled prompt retains one
server-owned step boundary before the assigned task. Redaction processes the
whole assembled prompt, preserving cross-fragment credential detection. Only
the final safe result may locate that unique boundary, verify the exact original
task is unchanged and translate UTF-16 mention ranges; searching repeated task
text or redacting fragments separately is not sufficient. Safe content must be
a redaction fixed point before dispatch. Native, cloud and shared acceptance
validate the actual final safe payload, including its mention ranges. Missing or
ambiguous boundaries, changed task text, unstable redaction or invalid ranges
fail closed before canonical step acceptance and call charging. Generated-prompt
mapping failures use `agent_team_sensitive_input`; invalid reservation payloads
retain the existing validation/authorization errors. This does not change the
original parsed-start digest, wire fields or database schema.
The mentions inbox uses the original `agent_team.task_content` for
its excerpt. Later automatic steps do not re-notify the original mentions or
repeat the quote. Connectivity-probe input rejects both fields, and probes do
not publish them. This adds no new quote visibility or notification authority.

Task dispatch derives its instruction brief from the frozen run and trusted
step state. Each module's first invocation in that run includes an allowlisted
public overview: overall task/Team rules, all module names and identities, the
full directed relationships and entry, and run limits. Another module's private
`prompt`, exact native runtime routing and credentials are not overview fields.
Every invocation includes the current module, actual caller, allowed targets,
return recipient, phase and remaining call/time allowance. A module's first-call
status is scoped to its node in the run, not to a reused Agent connection.
The brief marks `first_contact` on the first invocation and safely refreshes the
same frozen public overview on later invocations; it does not assume persistent
model memory across native, cloud or shared executions. This is instruction
content, not permission to expose another module's prompt or serialize a private
definition into the overview.
Retries retain the accepted step identity; neither relationship nor budget is
accepted from model assertions. Identity/prompt interpretation follows
[Product specification](PRODUCT_SPEC.md#my-agent-teams-local-implementation-preview).

Run summaries add optional `purpose:task|test` and `definition_id`; detail adds
the frozen `plan,content,steps`. Canonical step requests use trusted `agent_team`
metadata (`run_id,step_id,node_id,node_label,task_content,purpose?,clarification_event_id?,start_idempotency_key?`); generic
client payloads cannot create it. Native/shared/cloud result provenance remains
independently validated. `start_idempotency_key` is optional only for reading
older canonical records; fresh engine dispatches always supply it, and a fresh
Team reservation must match its run's original start key. It is an execution
identity binding, not an authorization credential. The terminal version-1 directive is one final fenced
`gatherthread-team` JSON block with `step_id` and `action:complete`,
`action:delegate,target_node_id,task`, or strict
`{"version":1,"step_id":"<current step>","action":"clarify"}`. Graph permission is checked server-side.
Successful leaves may return plain final text. Clarify requires a current-step
final response with verified provenance and a nonblank public explanation outside
the directive. It pauses a task with `error_code:agent_team_instruction_conflict`;
probe runs retain their exact marker protocol and do not accept Clarify.

The existing `action:resume` control has no new input field. For a paused conflict,
its first acceptance transaction selects and freezes the latest non-deleted,
nonblank `human_chat` by the run's original requester in the same session after
the conflict response, plus that response reference. Without such a message the
run remains paused. Resume clears the current step and schedules a new counted
call to the same module under the original plan, model, limits and deadline.
The resumed request's optional server-owned `clarification_event_id` identifies
the frozen human message; retries with the same control key neither replace that
choice nor add another call. Both references remain canonical erasure
dependencies after private-run Forget. Identity/rules/prompt/graph edits require
a new saved/tested run rather than mutation of this snapshot. The server gates
references and authorization, not semantic contradiction detection or proof of
resolution.

A test's first phase requires the exact `GT_TEAM_OK:<node_id>:<step_id>` marker.
Its second calls each destination
with incoming edges once, retains its current-step OK marker and requires one
`GT_TEAM_ROUTE:<edge_id>:<source_id>:<target_id>:<source_first_phase_step_id>` line
per incoming direction, including reverse directions for bidirectional edges.
The prompt supplies the complete expected reply as literal newline-separated
plain text after `Respond exactly with these lines:`, without a JSON array,
quotes, code fences or attribution labels. The server checks that exact reply
(allowing outer whitespace and CRLF line endings) and source provenance rather
than accepting a model-declared success or delegation. Existing canonical probe
requests and failed results are not rewritten; a fresh explicit Test uses the
corrected prompt. Total probe calls are module count plus distinct incoming
destinations, at most 32.
For cloud/shared test dispatch, the server supplies metadata-only context with
`items:[]` and the currently authorized head/content revision; cloud test requests
force `include_code:false`. Task dispatch retains its ordinary context/code contract.

Persistence is additive: account definitions/favorites/metadata receipts plus
private session runs/steps/controls, consumed-key receipts and migration columns
for purpose and library binding. Existing private runs seed consumed-key receipts
on database open. Earlier canonical Team requests with a start key also fence
reuse after their private run was already removed; when their original input
digest is unavailable, every retry fails closed rather than replaying cleared
content. A previously removed pre-upgrade run that published no canonical step
has no recoverable key record. Existing ordinary/shared requests retain their
current contracts.
Earlier unreleased session-plan schemas remain internal compatibility data;
there is no public raw-plan save/start route or automatic enabled-Team migration.
Startup retires legacy connectivity runs that have lost their current saved
definition/test binding; accepted task snapshots are not invalidated by deletion
of their definition.
The server and Web preview must be updated together; older strict-schema pages
require a reload rather than silently ignoring new response fields. No client
can start a saved Team through ordinary request/continuation paths. No new user-facing MCP execution authority,
package version, publication or deployment is introduced by this preview. See
[ADR-0061](adr/0061-account-private-saved-agent-teams.md) for the durable boundary.

`files` requires connection/project/session scope and a strict operation union.
Local operations (`localTree`, `localRead`, `localChanges`, `localDiff`, `baseline`,
`native`) resolve the active owner's workspace; the caller cannot supply a root
or native identity. Read-only session actors cannot use the local capability.
Cloud operations (`branches`, `tree`, `content`, `history`, `changes`, `save`)
reuse the existing file-workspace input/result schemas, including their nested
HTTP snake_case fields. The native `save` subset permits one write of up to
64 KiB; saves keep the same base commit and idempotency key on retry. No server
migration is involved. File lists cap at 300 entries, individual text at 64 KiB,
and private baseline content at 2 MiB; truncation/incomplete comparisons are
explicit. No baseline persists across owner shutdown. `native` returns only the
exact bound local Session ID; public DSH navigation is optional and fails with
manual-open guidance when unavailable.
