# Architecture v0.1

Significant architectural choices and their rationale are recorded in the [ADR index](adr/README.md). The server trust boundary is defined by [ADR-0001](adr/0001-trusted-self-hosted-collaboration-server.md). Public and internal integration boundaries, canonical contract owners, and compatibility rules are mapped in [Interface contracts](INTERFACE_CONTRACTS.md).

## Components

```text
Same-device client ── loopback HTTP (local mode) ──────────────────────┐
LAN client ── Caddy private HTTPS + WSS (LAN mode) ────────────────────┤
Tailnet client ── Tailscale Serve HTTPS + WSS (tailnet mode) ──────────┤
                                                                       │
Host loopback ── Collaboration server ── SQLite WAL                    │
                       │                                               │
                       ├── same-origin product home at `/`            │
                       ├── same-origin Web application at `/app/`     │
                       └── MCP collaboration surface                   │
                                                                       │
Local project connector ── ProjectHarnessAdapter ── local harness ─────┘
         │                         │
         ├── private cursor/outbox/registry/spool
         └── one Desktop projection plus one background execution projection per writable Codex session
```

One deployment has one active authoritative host as defined by [ADR-0003](adr/0003-single-owner-hosted-deployment.md). Different collaborators keep their harnesses and credentials local; they do not share or replicate the SQLite file.

## Repository layout

```text
apps/server       HTTP, WebSocket, authentication, ACL, persistence
apps/web          collaboration UI
site              product home source and application entry links
packages/protocol shared schemas and event contracts
packages/mcp      MCP tools/resources over the collaboration API
packages/bridge   project connector, native thread projection, outbox/reconciliation, request execution
packages/adapters harness-specific Codex and Claude Code parsers
tests/e2e          multi-client and bridge end-to-end tests
```

## Web entry architecture

The owner host publishes one browser origin. `/` is the public product home; its primary actions open the authenticated application at `/app/`. Both surfaces are assembled by the `apps/web` build, so the product page does not introduce another network service, cookie scope, API origin, or WebSocket origin. The product page and application keep independent CSS and JavaScript entry points to prevent global marketing styles from changing workspace behavior.

Operational links created before the product home remain valid. A request to the root containing `?api=...`, `?mock=1`, or a `#project`, `#session`, `#dsh-pair`, `#settings-*`, or `#main-content` fragment is redirected client-side to `/app/` with its query and fragment unchanged. API and WebSocket paths remain rooted at `/v1`; browser session cookies retain path `/`. [ADR-0022](adr/0022-place-the-product-home-above-the-same-origin-application.md) records this boundary.

## Data model

`projects` and `project_memberships` define the collaboration and authorization boundary. Every session has exactly one `project_id` and one immutable `owner_user_id`. Project creation inserts only the project and owner membership in one SQLite write transaction. The project owner may rename the project and create `multi`; both owners and participants may create personal `solo` sessions. A Solo's `owner_user_id` is its creator and is the only non-viewer actor allowed to write or rename it, so even the project owner reads another member's Solo. The project owner may switch a session they created between `solo` and `multi`; participant-created Solos cannot be converted to bypass the project role boundary. Project invitations grant one project role across current and future sessions. A permitted session title or mode change updates the mutable record and publishes a metadata-only `session_state_change` event so Web clients converge without rewriting canonical conversation content. Project renames use an owner-only, idempotent project metadata mutation and do not rename local harness workspaces. Session deletion is authorized to either the immutable session creator or project owner; project deletion is owner-only. SQLite foreign-key cascades atomically remove dependent cloud records, after which realtime scopes close and local connectors deactivate publishing without deleting native tasks or workspaces. Local harness titles remain independent display metadata.

The durable conversation core is an append-only `events` table keyed by `(session_id, sequence)` with a unique `(session_id, idempotency_key)` constraint. Each accepted event freezes `actor_display_name` so later profile changes cannot rewrite historical attribution. Mutable read models such as projects, sessions, memberships, runtime presence, cursors, invitations, and snapshot jobs are transactionally updated around the relevant operation.

`local_turn_commits` binds one stable local harness turn to its canonical request, optional tool events, and response. The local-turn endpoint rechecks the authenticated actor, device, runtime purpose, project role, and session mode inside one SQLite write transaction; it then appends the complete turn atomically. The connector's occurrence time is retained only as payload metadata, while canonical timestamps and monotonically advancing project/session activity use the server clock. An exact retry returns the original IDs, while a mismatched retry conflicts. The returned server head indicates whether local projection reconciliation is required.

`snapshot_requests` is a private, requester-scoped control plane rather than canonical conversation content. A request freezes `through_sequence`; only a same-user runtime with purpose `snapshot_connector` can claim and finish it. Every row receives a conservative 1 KiB metadata charge and result bytes are added through `snapshot_storage_usage`, without adding an event to the session history. Active jobs are also bounded per user, session, and deployment.

SQLite runs in WAL mode with foreign keys enabled. A write transaction allocates the next per-session sequence and inserts the event. WebSocket fan-out happens only after commit.

`agent_request_claims` is the single-writer lock over one Agent request, and it is a lease rather than a plain mutex. A claim carries an attempt count and a server-assigned lease, and accepted `agent_progress` from its holder is what renews it: device presence alone cannot keep a dead execution alive. A lapsed claim no longer occupies the runtime's single active slot, but only the exact runtime recorded by the request may reclaim it; GatherThread never rewrites the selected device, harness, provider, model, or runtime silently. The claim response exposes a positive `attempt_count`. Progress, completion, and request-linked tool events echo it as `claim_attempt`, so an expired or superseded execution cannot publish any part of a recovered turn. A request-linked `agent_response` is accepted only through the dedicated completion endpoint; the generic event route cannot bypass claim fencing. Legacy omission is accepted only for attempt 1. Recovery is bounded; past the attempt budget the request terminates as `failed` and the server commits and broadcasts one canonical `agent_response` with `status: "failed"`, carrying no capture fidelity and no runtime provenance because no harness produced it. [ADR-0023](adr/0023-lease-and-bounded-redispatch-agent-claims.md) records the lease, fencing, and budget.

During a claimed Web Agent turn, the bridge first appends an idempotent lifecycle `agent_progress` marker. Completed Codex App Server `agentMessage` items with `phase: commentary` are then redacted and appended as further progress before the final `agent_response`. The claim remains active until that final response commits. Reasoning items are ignored. Browser replay groups progress by the response's request link and renders both progress and final text through a bundled safe Markdown pipeline with GFM and bounded, untrusted KaTeX math rendering.

## Realtime protocol

Clients authenticate over HTTP, obtain a 30-second one-use session-scoped ticket, and carry it in `Sec-WebSocket-Protocol`. They subscribe with `session_id` and `after_sequence`, receive count-and-byte-bounded replay pages sequentially under socket backpressure, then transition to live events. Heartbeats revalidate the device and detect dead connections. Gaps trigger an authenticated replay rather than trusting best-effort socket delivery.

## Local bridge

Each project connector authenticates one device and registers a session-scoped runtime only where the effective project-plus-session permission can write. For an `agent_request`, only the initiating user's eligible execution runtime can claim the turn. Owners and participants have live runtimes for every `multi` plus the personal Solos they created; viewers have none. Readable but non-writable sessions remain eligible for explicit snapshot jobs.

The connector depends on a harness-neutral `ProjectHarnessAdapter`: project authorization, session discovery, canonical cursors, scheduling, and snapshot dispatch stay independent of the local harness protocol. For Codex, each writable session is a deep module with two native capabilities. The `vscode`-source Desktop projection publishes direct local turns through trusted Hooks only when that conversation's persisted automatic-upload gate is open. The user MCP reaches the gate through the connector's capability-protected local relay; it never receives the device credential. Its manual action reads the completed native thread, rejects an active or ambiguous turn, excludes connector-authored and already-bound turns, stages missed turns with an unknown historical base, and reuses the durable local-turn outbox. On compatible Codex App Server 0.151 builds, the connector may also check that task is idle, briefly rejoin it, and persist queued canonical events into model-visible history through `thread/inject_items`; an active local turn postpones that injection. One project-scoped background App Server process hosts independent `exec`-source threads for the project's sessions; each thread imports canonical history, compacts, and is the only Codex projection allowed to execute Web Agent requests. Desktop, background, and immutable snapshot titles include the uppercase cloud session type, for example `<session> · MULTI · GatherThread background`, while preserving that suffix when a long session name is truncated. If Desktop externally claims a completed background projection, the connector replaces it and replays canonical history; durable prepared or started work remains fail-closed. Separate state files and one canonical server log join both directions without concurrent mutation of an active Desktop turn. Cloud project/session IDs and the persisted native thread ID are the binding keys; titles never participate in matching. [ADR-0013](adr/0013-single-writer-dual-codex-projections.md) records the dual-projection boundary, [ADR-0019](adr/0019-native-history-projection-across-harness-switches.md) records idle native injection and cross-harness switching, and [ADR-0020](adr/0020-per-conversation-upload-consent-and-manual-recovery.md) records the local publication gate.

DeepSeek Harness uses the same server ordering, permission truth, request claim boundary, cursors, and durable outbox, but its execution core is an opt-in native DSH Host plugin. The plugin discovers writable project Sessions, keeps one independent editable DSH Session per GatherThread Session, resumes through DSH's public persistence/Agent services, and owns a bounded claim-to-settlement execution gate. A newly created native Session receives a ` · 共序 · MULTI|SOLO` title marker so the DSH session list separates it from plain local conversations; the cloud-name portion is clipped by UTF-8 bytes, not characters, so the marker survives DSH's 80-byte title cap. Adopted and resumed Sessions keep their existing local titles, including user edits. When a DSH-created conversation completes its first valid local turn, a global scoped event listener retains the live snapshot across the persistence-list race; the server then creates one same-identity creator-owned Solo, and the connector borrows the existing Agent through the public registry without acquiring its disposal capability. Empty, failed, and viewer conversations remain local-only. External canonical events are appended with DSH's public `Session.append` API and `surfaceOp: "append"`, then made durable by the public flush service. Human input remains a `user/message`; remote Agent output is preserved as an `assistant/message` inside a balanced synthetic turn/step, so shared Agent text is never reclassified as a new user instruction. Persisted projected-event IDs suppress replay and echo. Native DSH turns enter a durable outbox before one atomic, idempotent `commitLocalTurn`; only after the server returns the canonical bindings can the local state advance. A versioned state flag gates only this local-to-cloud capture and commit path. The native settings RPC reports bounded counts and accepts exact project/session routes for toggling or manual recovery; it carries no device credential to the browser. Only allowlisted assistant and redacted tool projections can leave DSH; reasoning, private streams, headers, and native metadata cannot enter canonical history. A short-lived browser-approved pairing grant is stored through DSH's credential service, and the plugin connects outbound to the selected GatherThread origin. The Web client selects one exact online device/provider/model/runtime and never falls back to Codex. Unlike Codex, DSH materializes no separate background-execution or immutable-snapshot Session: one native Session carries both the execution and projection roles, so the uppercase session-type label applies to that single title rather than to three. Claude Code remains a future adapter.

While a DSH prompt is active, newly durable Host events produce rate-limited generic `agent_progress` heartbeats carrying no event content. Bursts coalesce, renewing the exact claim without exposing reasoning, private streams, headers, or native metadata.

### Native projection and offline reconciliation

The connector stores two private atomic sidecars per writable Codex session. The Desktop sidecar contains the native task identity, canonical observation and native-projection cursors, projected event IDs, an idle-injection queue, the independently acknowledged Hook delivery cursor, resumable UTF-8 relay checkpoint, Hook draft, durable local-turn outbox, automatic-upload preference, and the digest and sequence of its last verified visible-history snapshot. A Hook draft freezes both the exact fallback capsule and its proposed cursor transition; only a completed `Stop` applies that transition. Disabling automatic upload can retain locally captured pending work but cannot commit it; re-enabling or manual upload drains it through the same idempotent path. The background sidecar contains canonical cursor, projection and compaction generations, structured attribution, execution journal, and rebuild checkpoint. A matching retry binds returned canonical IDs without re-execution or duplicate injection. When the configured connector model changes, the Desktop sidecar adopts the new default without replacing the Desktop-facing task, while a completed private background projection is replaced and replayed from canonical history; unresolved work still fails closed. [ADR-0014](adr/0014-acknowledged-bounded-desktop-relay-capsules.md) records the bounded fallback relay contract.

Runtime identity is separate from cloud session identity. A Codex to DSH to Codex switch keeps the same server project and session IDs while each harness owns its native binding, cursors, and compaction. A newly selected harness connects or pairs once per device and project and then backfills from the canonical server log. Connectors not selected for an `agent_request` may continue passive projection but cannot claim that request. Ambiguous multiple Codex runtime selection fails closed. This coordination does not lock files edited by different harnesses in one working directory.

For an unbound user-owned Desktop task, the first trusted prompt is the publication boundary. An owner or participant creates one deterministic creator-owned Solo and adopts that same task; viewers and empty tasks remain local-only, while registered background and snapshot purposes are excluded. [ADR-0015](adr/0015-create-personal-solos-from-first-local-prompt.md) records the discovery, authorization, and idempotency boundary.

The server's event sequence is authoritative. If no canonical event appeared after a local turn's base cursor, acknowledgement advances the binding in place. If cloud history advanced, the server orders the local turn after its current head. The connector then builds a new native thread from the complete canonical log off to the side, compacts against the observed model context window or a conservative fallback, verifies coverage through the target sequence, and atomically switches its sidecar. The former native thread is preserved as an archived `offline fork`. This process reconciles conversation state only and never rewrites working-tree files.

### Hooks and read-only snapshots

Codex Hook installation is explicit and required for publishing direct Desktop turns. `UserPromptSubmit` and `Stop` require trust review, whether supplied by the plugin or merged into `.codex/hooks.json`. On clients that cannot safely perform the Codex 0.151 idle rejoin/injection path, `UserPromptSubmit` returns a bounded capsule with a concise visible preview and an exact model-only block. Large bodies resume from a persisted byte-safe checkpoint; `Stop` both acknowledges that relay plan and supplies the final text for a durable idempotent upload. On compatible clients, a separate synchronization pass may briefly rejoin only an idle Desktop task and persist canonical items. App Server's public contract establishes model-visible persistence, not immediate bubble redraw in every Desktop build; that presentation behavior remains an explicit browser/Desktop smoke test rather than a documented guarantee. Web execution remains isolated in the background projection.

For an unregistered native task, the first `UserPromptSubmit` also performs fail-closed discovery. The connector rechecks the actor's current project role, derives an idempotency key from a one-way hash of device, project, and native task identity, creates a creator-owned Solo for an owner or participant, adopts that existing Desktop task, then handles the same prompt through the normal durable Hook state machine. Viewers receive no cloud mutation. Connector-owned background and snapshot tasks are registered with non-discoverable purposes so this path cannot recurse.

Each **Download to Codex** click creates a new immutable snapshot job frozen through one server sequence. A `snapshot_connector` builds a fresh native thread, verifies that boundary, and returns bounded metadata. It cannot claim Agent requests or publish local turns, and the snapshot never starts following later canonical events.

**Import Codex history** uses a distinct requester-private `visible_history_replace` job and is allowed only for a writable session. The wire kind keeps its Alpha name for compatibility. The connector builds an external native history source from canonical events, inserts a local-only marker for an empty session, summarizes oversized history below the configured context high-water mark, and verifies a newly created task before changing the binding. The connector persists the prior task ID as a local-only tombstone, restores that classification when rebuilding the Hook registry, and authorizes only the verified replacement. The prior native task itself remains untouched for the user to review and archive; continuing it cannot re-enter first-prompt discovery or create cloud state. Automatic invocation is either once when each session is first created locally, which is the default, or disabled. Every manual request creates a new local task. Realtime delta injection remains a separate path in both modes and after a manual import. [ADR-0021](adr/0021-import-visible-codex-history-as-a-new-task.md) records this boundary.

Transcript access is opt-in and path-scoped. Secrets are redacted before upload. Raw thinking and private system/developer instructions are excluded by default unless the owner explicitly changes the session policy.

## MCP boundary

MCP exposes collaboration capabilities but is not assumed to see a host's full conversation. Exact transcript or provider-context capture belongs in the local bridge, hook, or authorized provider proxy. MCP resources and tools expose canonical history, cursors, runtime registration, event append, and agent-request claim/complete operations.

## Security baseline

- Private-by-default projects and revocable project invitations.
- Local-only first-owner bootstrap; no public registration.
- One-use project invitations with fixed 1h, 24h, or 7d expiry.
- One-use ten-minute authorization for each additional device.
- Server-derived actor identity; clients cannot forge usernames.
- Peppered HMAC device credentials with use tracking, rotation, and per-device revocation.
- Strict schema validation and payload size limits.
- Bounded JSON depth/nodes, byte-paged replay, slow-client cutoff, per-device rate limits, and per-user/session/deployment event and complete snapshot-job quotas.
- Secret redaction before persistence plus configurable content policy.
- No remote transfer of local tool approval authority.
- Project role enforcement on every session write and runtime registration.
- Content-free invitation audit metadata plus canonical session event history.
- Loopback-only application host behind an approved HTTPS edge; no direct application-port ingress and no anonymous registration.
