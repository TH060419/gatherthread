# Architecture v0.1

Significant architectural choices and their rationale are recorded in the [ADR index](adr/README.md). The server trust boundary is defined by [ADR-0001](adr/0001-trusted-self-hosted-collaboration-server.md).

## Components

```text
Collaborator browser / CLI ── private HTTPS + WSS over Tailscale Serve ─┐
                                                                       │
Host loopback ── Collaboration server ── SQLite WAL                    │
                       │                                               │
                       ├── same-origin Web client                      │
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
packages/protocol shared schemas and event contracts
packages/mcp      MCP tools/resources over the collaboration API
packages/bridge   project connector, native thread projection, outbox/reconciliation, request execution
packages/adapters harness-specific Codex and Claude Code parsers
tests/e2e          multi-client and bridge end-to-end tests
```

## Data model

`projects` and `project_memberships` define the collaboration and authorization boundary. Every session has exactly one `project_id` and one immutable `owner_user_id`. Project creation inserts only the project and owner membership in one SQLite write transaction. The project owner may create `multi`; both owners and participants may create personal `solo` sessions. A Solo's `owner_user_id` is its creator and is the only non-viewer actor allowed to write or rename it, so even the project owner reads another member's Solo. Project invitations grant one project role across current and future sessions. A permitted session rename updates the mutable record and publishes a metadata-only `session_state_change` event so Web clients converge without rewriting canonical conversation content. Session deletion is authorized to either the immutable session creator or project owner; project deletion is owner-only. SQLite foreign-key cascades atomically remove dependent cloud records, after which realtime scopes close and local connectors deactivate publishing without deleting native tasks or workspaces. Local harness titles remain independent display metadata.

The durable conversation core is an append-only `events` table keyed by `(session_id, sequence)` with a unique `(session_id, idempotency_key)` constraint. Each accepted event freezes `actor_display_name` so later profile changes cannot rewrite historical attribution. Mutable read models such as projects, sessions, memberships, runtime presence, cursors, invitations, and snapshot jobs are transactionally updated around the relevant operation.

`local_turn_commits` binds one stable local harness turn to its canonical request, optional tool events, and response. The local-turn endpoint rechecks the authenticated actor, device, runtime purpose, project role, and session mode inside one SQLite write transaction; it then appends the complete turn atomically. The connector's occurrence time is retained only as payload metadata, while canonical timestamps and monotonically advancing project/session activity use the server clock. An exact retry returns the original IDs, while a mismatched retry conflicts. The returned server head indicates whether local projection reconciliation is required.

`snapshot_requests` is a private, requester-scoped control plane rather than canonical conversation content. A request freezes `through_sequence`; only a same-user runtime with purpose `snapshot_connector` can claim and finish it. Every row receives a conservative 1 KiB metadata charge and result bytes are added through `snapshot_storage_usage`, without adding an event to the session history. Active jobs are also bounded per user, session, and deployment.

SQLite runs in WAL mode with foreign keys enabled. A write transaction allocates the next per-session sequence and inserts the event. WebSocket fan-out happens only after commit.

During a claimed Web Agent turn, the bridge first appends an idempotent lifecycle `agent_progress` marker. Completed Codex App Server `agentMessage` items with `phase: commentary` are then redacted and appended as further progress before the final `agent_response`. The claim remains active until that final response commits. Reasoning items are ignored. Browser replay groups progress by the response's request link and renders both progress and final text through a bundled safe Markdown pipeline with GFM and bounded, untrusted KaTeX math rendering.

## Realtime protocol

Clients authenticate over HTTP, obtain a 30-second one-use session-scoped ticket, and carry it in `Sec-WebSocket-Protocol`. They subscribe with `session_id` and `after_sequence`, receive count-and-byte-bounded replay pages sequentially under socket backpressure, then transition to live events. Heartbeats revalidate the device and detect dead connections. Gaps trigger an authenticated replay rather than trusting best-effort socket delivery.

## Local bridge

Each project connector authenticates one device and registers a session-scoped runtime only where the effective project-plus-session permission can write. For an `agent_request`, only the initiating user's eligible execution runtime can claim the turn. Owners and participants have live runtimes for every `multi` plus the personal Solos they created; viewers have none. Readable but non-writable sessions remain eligible for explicit snapshot jobs.

The connector depends on a harness-neutral `ProjectHarnessAdapter`: project authorization, session discovery, canonical cursors, scheduling, and snapshot dispatch stay independent of the local harness protocol. For Codex, each writable session is a deep module with two native capabilities. The `vscode`-source Desktop projection is owned only by Desktop and publishes through trusted Hooks. One project-scoped background App Server process hosts independent `exec`-source threads for the project's sessions; each thread imports canonical history, compacts, and runs Web Agent requests. It has a distinct `<session> · GatherThread background` initial title. If Desktop externally claims a completed background projection, the connector replaces it and replays canonical history; durable prepared or started work remains fail-closed. Separate state files and one canonical server log join both directions without a shared native writer. Cloud project/session IDs and the persisted native thread ID are the binding keys; titles never participate in matching. Claude Code and DeepSeek Harness can implement the same adapter boundary with different native processes. [ADR-0013](adr/0013-single-writer-dual-codex-projections.md) records this boundary.

### Native projection and offline reconciliation

The connector stores two private atomic sidecars per writable Codex session. The Desktop sidecar contains the native task identity, canonical observation cursor, independently acknowledged delivery cursor, resumable UTF-8 relay checkpoint, Hook draft, and durable local-turn outbox. A Hook draft freezes both the exact capsule and its proposed cursor transition; only a completed `Stop` applies that transition. The background sidecar contains canonical cursor, projection and compaction generations, structured attribution, execution journal, and rebuild checkpoint. A matching retry binds returned canonical IDs without re-execution or duplicate injection. When the configured connector model changes, the Desktop sidecar adopts the new default without replacing its Desktop-owned task, while a completed private background projection is replaced and replayed from canonical history; unresolved work still fails closed. [ADR-0014](adr/0014-acknowledged-bounded-desktop-relay-capsules.md) records the bounded relay contract.

For an unbound user-owned Desktop task, the first trusted prompt is the publication boundary. An owner or participant creates one deterministic creator-owned Solo and adopts that same task; viewers and empty tasks remain local-only, while registered background and snapshot purposes are excluded. [ADR-0015](adr/0015-create-personal-solos-from-first-local-prompt.md) records the discovery, authorization, and idempotency boundary.

The server's event sequence is authoritative. If no canonical event appeared after a local turn's base cursor, acknowledgement advances the binding in place. If cloud history advanced, the server orders the local turn after its current head. The connector then builds a new native thread from the complete canonical log off to the side, compacts against the observed model context window or a conservative fallback, verifies coverage through the target sequence, and atomically switches its sidecar. The former native thread is preserved as an archived `offline fork`. This process reconciles conversation state only and never rewrites working-tree files.

### Hooks and read-only snapshots

Codex project Hook installation is explicit and required for publishing direct Desktop turns. `UserPromptSubmit` and `Stop` are merged into `.codex/hooks.json` and require trust review. `UserPromptSubmit` returns a bounded capsule with a concise visible preview and an exact model-only block. Large bodies resume from a persisted byte-safe checkpoint; `Stop` both acknowledges that relay plan and supplies the final text for a durable idempotent upload. The connector does not poll or open the Desktop-owned task, and Web execution remains available independently in the background projection.

For an unregistered native task, the first `UserPromptSubmit` also performs fail-closed discovery. The connector rechecks the actor's current project role, derives an idempotency key from a one-way hash of device, project, and native task identity, creates a creator-owned Solo for an owner or participant, adopts that existing Desktop task, then handles the same prompt through the normal durable Hook state machine. Viewers receive no cloud mutation. Connector-owned background and snapshot tasks are registered with non-discoverable purposes so this path cannot recurse.

Each **Download to Codex** click creates a new immutable snapshot job frozen through one server sequence. A `snapshot_connector` builds a fresh native thread, verifies that boundary, and returns bounded metadata. It cannot claim Agent requests or publish local turns, and the snapshot never starts following later canonical events.

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
- Loopback-only owner host behind tailnet-only HTTPS; no default public ingress.
