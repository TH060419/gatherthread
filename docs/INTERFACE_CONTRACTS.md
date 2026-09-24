# Interface contracts

This document identifies GatherThread's integration boundaries, their canonical implementation sources, and the rules for changing them. It is a map, not a generated API reference. The schemas and tests named below remain the executable source of truth.

## Stability labels

- **Public Alpha:** exposed to Web clients, published packages, plugins, or self-hosted operators. It may evolve before Beta, but changes require compatibility analysis, tests, documentation, and release notes.
- **Internal versioned:** used between repository modules or persisted locally. It may change only with all consumers and stored-state migration or rejection logic updated together.
- **Implementation detail:** not promised to outside consumers. Security and data-integrity guarantees still apply.

Alpha status never permits silent reinterpretation of persisted data, identity, authorization, event fidelity, or idempotency semantics.

## Canonical owners

| Contract | Stability | Canonical source | Main consumers |
|---|---|---|---|
| Domain values, input validation, events, replay, runtime, invitation, local-turn, and snapshot schemas | Public Alpha | `packages/protocol/src/index.ts` | Server, Web normalization, bridge, MCP, DSH |
| HTTP and WebSocket route behavior | Public Alpha | `apps/server/src/server.ts` plus `apps/server/src/service.ts` | Web, bridge, DSH, MCP transport |
| Authorization and persistence invariants | Public Alpha | `apps/server/src/service.ts`, `apps/server/src/database.ts`, `docs/SECURITY.md` | Every client and operator |
| Harness-neutral connector API | Internal versioned | `packages/bridge/src/types.ts` | Codex connector, adapters, local MCP relay |
| Browser API mapping | Internal versioned | `apps/web/src/api.js`, `apps/web/src/domain.js` | Web workspace |
| Realtime recovery state machine | Internal versioned | `apps/web/src/realtime.js` | Web workspace |
| User-facing MCP tools and resources | Public Alpha | `packages/mcp/src/service.ts`, `packages/mcp/README.md` | GatherThread Codex plugin and user Agents |
| Capability-protected local connector relay | Internal versioned | `packages/bridge/src/local-api-relay.ts` | GatherThread Codex plugin MCP only |
| Codex App Server adapter and persisted projection state | Internal versioned | `packages/bridge/src/codex-app-server.ts`, `packages/bridge/src/project-harness.ts` | Codex connector |
| DSH native plugin RPC and persisted state | Public Alpha package / internal versioned state | `packages/dsh-host/src/native-plugin.ts`, `connector.ts`, `state-store.ts`, `types.ts` | DSH Host and bundled settings client |
| Browser entry routes and legacy deep-link forwarding | Public Alpha | `site/index.html`, `site/boot.js`, `apps/web/scripts/build.mjs`, `apps/server/src/server.ts` | Browsers, invitations, DSH pairing, shared project/session links |
| Stable Web control IDs and accessible names | Internal versioned | `apps/web/index.html`, `apps/web/test/static-accessibility.test.js` | Web event bindings, accessibility, browser tests |
| Opt-in code repository snapshots, review and merge | Public Alpha, Alpha 7 | `packages/protocol/src/code-sync.ts`, `apps/server/src/code-repository.ts` | Web, shared local code-sync module, Codex, DSH |
| Shared manual history summaries and derived context | Public Alpha, Alpha 7 | `packages/protocol/src/history-summary.ts`, `apps/server/src/database.ts` | Web, bridge, MCP, Codex, DSH |

When this document conflicts with the schemas or tested implementation, stop and resolve the discrepancy in the same PR. Do not silently choose whichever behavior is more convenient.

## Domain boundary

- A project is the membership, invitation, and local-Agent binding boundary.
- A session belongs to exactly one project and has one immutable creator. `solo` and `multi` permissions are defined in `docs/PRODUCT_SPEC.md` and enforced by the server.
- The append-only canonical event record is identified by `id` and ordered by a positive per-session `sequence`.
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
- Account identity responses include `can_create_projects`, an account-wide capability distinct from each project's `owner`/`participant`/`viewer` membership. Existing device-token login may optionally change that authenticated user's display name and current device label; it never changes the capability.
- Connectors use an HTTP bearer credential kept in the connector process. Credentials never belong in URLs, WebSocket query strings, page storage, MCP arguments, logs, or canonical events.
- Cookie-authenticated writes require an allowed `Origin`. Bearer-authenticated connectors remain device- and role-scoped.
- Retryable mutations carry a stable `idempotency_key`. An exact same-actor retry returns the original result; a changed actor, operation, target, or canonical payload conflicts.

### Route families

| Family | Purpose | Contract notes |
|---|---|---|
| `/health/live`, `/health/ready` | Process liveness and dependency readiness | Keep liveness independent from readiness; never disclose secrets or database contents. |
| `/v1/bootstrap`, `/v1/browser-sessions`, `/v1/me` | First-owner bootstrap and browser session exchange | Bootstrap remains explicitly configured and loopback-bound; browser credentials are cleared from page memory after exchange. |
| `/v1/remembered-accounts`, `/v1/remembered-accounts/:id/activate` | Alpha 7 remembered-browser account chooser | A separate 30-day `HttpOnly; SameSite=Strict` vault Cookie contains an opaque server-issued credential, never a JavaScript-visible device token. `GET` lists only choices for that browser profile; activation requires an allowed Origin plus editable `display_name` and `device_name`, rotates the vault credential and issues a new browser session. `POST /v1/remembered-accounts/adopt-current-session` optionally migrates a legacy remembered session under the same Origin/CSRF gate; `/v1/me` never rotates or sets the vault. `DELETE /:id` forgets only that choice; logout revokes the active session but preserves the vault. Revocation or rotation of a device removes its choice. Do not use on a shared browser profile. |
| `/v1/test-access/claim` | Single-use operator-issued test qualification | Unauthenticated but origin/rate-limited; atomically creates an account with project-creation capability and a separate device token. An opt-in browser-session header issues a Cookie in the same transaction. Tokens are issued/revoked only by local host commands and are never reusable login credentials. |
| `/v1/devices`, `/v1/device-authorizations` | Device naming, authorization, rotation, and revocation | Revocation invalidates related runtimes, tickets, and sessions immediately. |
| `/v1/projects`, `/v1/projects/:id/*` | Projects, project sessions, members, invitations, and audit | Account qualification gates new project creation; project ownership and membership are rechecked server-side. A project invitation alone does not grant account qualification. `DELETE /v1/projects/:id/members/:userId` lets a participant/viewer remove only themselves, while the owner may remove another non-owner member but cannot leave their own project. A branch requires explicit `branch_resolution: delete|merged_to_main` and `expected_branch_head_commit`; the same guard applies to legacy session-member DELETE. Both routes use strict protocol request schemas and reject unknown fields. An unmerged branch cannot be declared merged, and stale heads fail with 409. |
| `/v1/sessions`, `/v1/sessions/:id/*` | Session metadata, members, events, local turns, snapshots, and Agent requests | Session ACL, mode, creator, visibility, quotas, and current head are authoritative. The legacy create-without-project path cannot create a project for a guest. |
| `/v1/runtimes` | Runtime registration and heartbeat | Purpose, device, user, project/session access, harness, provider, and model are bound and validated. |
| `/v1/dsh-pairings` | Browser-approved DSH pairing | Pairing is short-lived, one-use, origin-bound, and does not expose the long-lived credential to the browser URL or logs. |
| `/v1/realtime-ticket`, `/v1/ws` | One-use session-scoped realtime subscription | The socket is transport, not durable truth; clients replay from their last contiguous cursor. |
| `/v1/snapshot-requests` | Requester-private immutable snapshots and visible-history imports | Jobs are bounded control-plane records, not canonical events; runtime purpose controls claim authority. |
| `/v1/sessions/:id/history-summaries`, `/v1/sessions/:id/context`, `/v1/projects/:id/context-policy` | Explicit local-Agent summary generation, derived context reads and per-user project preference | History remains append-only; source IDs, exact initiating-user execution runtime, current write permission, source size and claim completion are server-validated. Context reads are not canonical replay cursors. |

The exact request and response schemas are in `packages/protocol/src/index.ts`; route tests in `apps/server/test/server.test.ts` are the executable compatibility suite.

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
- A runtime may advertise a bounded set of exact provider/model profiles and adapter-owned reasoning efforts. The server accepts a targeted DSH request only when the complete requested profile appears in that declaration. A legacy runtime without the declaration retains fixed-provider/model matching.
- Claims and completions are idempotent and bound to the request and runtime.
- Public commentary may be uploaded; hidden reasoning is excluded.
- The final response does not close the claim until it is durably committed.
- Other connected harnesses may passively project the result but cannot execute the same request.
- A claim carries a server-assigned lease and is renewed only by accepted `agent_progress` from its holder. Runtime presence never extends a lease.
- A lapsed exact-runtime claim may be reclaimed only by the runtime recorded in the request profile. Reclaim never changes device, harness, provider, model, or runtime implicitly. Legacy requests without a runtime target retain their existing fail-closed selection rules. Only a live claim occupies a runtime's single active slot.
- Claim success includes `attempt_count`. Progress and completion may send it as `claim_attempt`; current connectors always do. The server rejects an expired lease or a superseded attempt. For compatibility with Alpha connectors, omission is accepted only on attempt 1.
- Reclaim is bounded. A request past the attempt budget terminates as `failed`: claiming it returns `agent_request_failed`, the server commits and publishes exactly one canonical `agent_response` with `status: "failed"` and no capture-fidelity or runtime-provenance claim, and a connector treats that conflict as terminal rather than retrying it.

## Snapshot and visible-history boundary

Snapshot requests are requester-private control-plane records with frozen `through_sequence` values and bounded result metadata.

- `snapshot_connector` jobs create immutable read-only local snapshots and cannot claim Agent requests or publish local turns.
- Each manual Codex history import creates and verifies a new writable local task. The `visible_history_replace` operation retains its Alpha wire name for compatibility, switches the binding and Hook allowlist after verification, and leaves the previous task untouched for the user to archive. The private registry marks that previous task `local_only`, so its later prompts cannot enter first-prompt discovery or create cloud state.
- Empty-session visibility markers and compact summaries are local-only. Realtime context injection remains independent from snapshot/import policy.
- Visible Codex imports preserve public message bodies, subject to a separate bounded serialized snapshot size. An oversized resource is rejected before import, not shortened and marked complete. Native compaction, when required, must succeed before the new binding is committed. A summary is not a lossless copy or canonical history.
- New snapshot kinds or changed claim authority require protocol, ACL, quota, bridge, integration, and security tests.

## Project code boundary

`/v1/projects/:id/code` is independent from canonical conversation events. GET returns repository enablement/main commit, bounded member-branch metadata and the current actor's branch ID. Owner-only `POST /enable` explicitly creates or resumes storage; owner-only `POST /disable` pauses code transfers without deleting stored heads or branches. Existing database rows migrate with `enabled=1`. `POST /checkpoints` accepts a complete bounded portable file set, expected base commit and idempotency key; actor identity and branch ownership come from authentication. `GET /snapshot?branch_id=main|BRANCH_ID` reads a current branch tree only while enabled. `POST /review`, owner-only `POST /merge` and `POST /update` enforce expected heads and repository enablement. A mismatch or merge conflict never force-moves main or another member's branch. Normal cookie Origin, bearer device, project role and revoked-device checks remain.

Authoritative shapes and 1,000-file / 2-MiB-file / 8-MiB-snapshot limits are in `code-sync.ts`. Only the checkpoint-upload route has an increased bounded body budget; event and authentication limits are not widened. SQLite owns atomic heads and retry receipts; immutable Git objects are stored before acknowledgement. Backups require both stores.

Alpha 7 `GET /v1/code-storage` returns the current actor's logical 128 MiB limit, usage, visible-project breakdown and only their own pre-upgrade `detached_branches`. A project member may call `POST /v1/projects/:id/code/clear-branch` only for their own current branch, with `expected_head_commit` and `idempotency_key`. A former member may call `POST /v1/code-storage/detached-branches/:projectId/clear` with the same CAS and idempotency fields only for their own orphan; its strict response is `{released_bytes}`. The project owner may additionally call `POST /v1/projects/:id/code/clear-project` with `expected_main_commit`, the complete `expected_branches` set and an idempotency key. These cleanup routes are available while paused or archived; normal cookie Origin and active-device checks still apply. Clearing invalidates old mutation receipts, removes the selected cloud refs and releases logical current-head usage without changing local Git. Clearing one branch cannot erase content already merged into main. Append-only Git objects and existing backups remain until separate operator-approved physical cleanup, so project/deployment disk limits do not immediately fall.

The private snapshot-job protocol adds `code_sync_status`, `code_upload`, `code_download`, `code_recover`, `code_auto_upload_enable` and `code_auto_upload_disable`. These target one exact same-user execution runtime (Codex or DSH), never a snapshot worker, arbitrary directory or fallback device. New transfers, mutation jobs and their completion fail while the cloud repository is paused; status and the request to turn off an existing local auto-upload preference remain available. Local code authorization is separately required and cannot be granted by these jobs. Results contain only bounded status/commit/count metadata and a recovery directory basename, never absolute paths or credentials.

DSH native RPC adds `code/authorize {projectId,enabled}` and `code/action {projectId,action}`. Optional `codeSync` public-state entries are project-scoped. Consent is private, versioned and bound to the exact user/project/server/workspace. Packaged native controller and client upgrade together; existing conversation `sync/*` semantics do not change.

Source visibility is project-wide, not Solo-scoped. A member branch is not a privacy boundary or per-Agent lock. Native conversation bindings, realtime context injection and the original local Git repository remain untouched. See [CODE_SYNC.md](CODE_SYNC.md) and [ADR-0025](adr/0025-opt-in-git-backed-code-checkpoints.md).

## MCP and local relay boundaries

The published MCP surface is intentionally narrower than the internal collaboration API.

- User-facing tools/resources expose authorized project/session discovery, canonical event reads/writes, and explicit local sync controls.
- Internal runtime registration, claim, progress, completion, and credential handling are not exposed to an arbitrary model through the user MCP.
- The local connector relay is protected by a per-run capability and current-user filesystem permissions. Its endpoint or named pipe is not authorization by itself.
- Ambiguous routing across multiple connector registrations fails closed.
- HTTP/stdio MCP messages default to 1 MiB, with at most 128 requests per batch and bounded JSON depth/node count; oversized inputs are rejected before any batch member executes. Valid batches and silent notifications remain supported. Manual visible-history import creates a new native task and is explicitly non-idempotent.
- Renaming or removing an MCP tool/resource, parameter, URI, or result field is a Public Alpha interface change.

## Codex and DSH native boundaries

- Codex Hooks are limited to reviewed `UserPromptSubmit` and `Stop` definitions. Hook payloads, output limits, registry purpose, and workspace path checks are security contracts.
- Codex Desktop projection, background execution, and snapshot tasks have separate purposes and single-writer rules. Never mutate an active or ambiguously owned native task.
- Native context capacity and transport bounds are separate. Codex context accounting uses fresh last-request usage, not cumulative lifetime billing; a reported model window takes precedence over a fallback estimate. Ordinary native automatic compaction remains enabled according to the user's harness configuration. GatherThread must not overwrite that configuration or label local truncation as native compaction. See [ADR-0026](adr/0026-native-first-context-management.md).
- DSH uses public session append/flush and Agent services, durable projected-event IDs, echo suppression, and an outgoing outbox. Only allowlisted assistant output and redacted tool data may leave DSH.
- DSH model selection uses exact metadata advertised by the connected runtime. A GatherThread request may temporarily select one declared model and effort for its own DSH turn; it must not persistently rewrite DSH-native selection for later local turns.
- Native DSH pairing/configuration is single-flight. Disconnect drains canceled configuration writes before clearing its credential, and a project-role change refreshes only that project's native owner and permissions.
- Persistent connector and DSH state must carry a version. A state change needs atomic migration or a safe, actionable refusal; never guess at an old structure.
- Upstream version support is explicit. An unsupported Codex App Server or DSH Host API must fail safely and preserve local/cloud data.

## Web presentation boundary

Web HTML IDs, form names, accessible labels, dialog relationships, and the separate chat/Agent actions are integration points between static markup, JavaScript, tests, assistive technology, and browser automation.

- `/` is the product home and `/app/` is the authenticated application. Root operational links containing `?api=...`, `?mock=1`, `#project`, `#session`, `#dsh-pair`, `#settings-*`, or `#main-content` must preserve their query and fragment when forwarded to `/app/`.
- The product home and application must share one origin while retaining separate style and script entry points. Do not move authentication, API, WebSocket, Cookie, or invitation behavior into the product home.
- A browser API override must remain on that same origin and cannot contain URL credentials. Reject an invalid override before sending login/device credentials; development uses a same-origin proxy. Explicit Node/connector server selection is separate.
- Preserve them during visual-only changes or update every consumer and accessibility test in the same PR.
- All user and Agent Markdown is untrusted. Keep URL filtering, escaped raw HTML, code-fence protection, bounded parsing, and bundled KaTeX limits intact.
- Bilingual copy must be updated in English and Simplified Chinese without translating product names, user content, provider/model identifiers, or opaque IDs.
- Layout changes must retain Safari and Chromium behavior, keyboard focus, reduced motion/transparency, high contrast, and responsive fallbacks.

## Changing a contract

An interface-changing PR must answer:

1. What is the current contract and why is it insufficient?
2. Which producers, consumers, persisted records, published packages, browser surfaces, and supported upstream versions are affected?
3. Is the change additive, compatible, migrated, versioned, or intentionally breaking?
4. What are the authorization, privacy, idempotency, quota, replay, and failure semantics?
5. Which contract and negative tests prove both sides agree?
6. Which canonical docs, release notes, and ADRs must change?

The project lead must review the PR before a version containing the contract change is merged, tagged, published, or deployed.
