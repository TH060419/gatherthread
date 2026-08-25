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
Collaborator local bridge ── transcript adapter ── local harness ──────┘
```

One deployment has one active authoritative host as defined by [ADR-0003](adr/0003-single-owner-hosted-deployment.md). Different collaborators keep their harnesses and credentials local; they do not share or replicate the SQLite file.

## Repository layout

```text
apps/server       HTTP, WebSocket, authentication, ACL, persistence
apps/web          collaboration UI
packages/protocol shared schemas and event contracts
packages/mcp      MCP tools/resources over the collaboration API
packages/bridge   local runtime registration, transcript tailing, request execution
packages/adapters harness-specific Codex and Claude Code parsers
tests/e2e          multi-client and bridge end-to-end tests
```

## Data model

The durable core is an append-only `events` table keyed by `(session_id, sequence)` with a unique `(session_id, idempotency_key)` constraint. Mutable read models such as sessions, memberships, runtime presence, cursors, and invitations are derived or transactionally updated with the event append.

SQLite runs in WAL mode with foreign keys enabled. A write transaction allocates the next per-session sequence and inserts the event. WebSocket fan-out happens only after commit.

## Realtime protocol

Clients authenticate over HTTP, obtain a 30-second one-use session-scoped ticket, and carry it in `Sec-WebSocket-Protocol`. They subscribe with `session_id` and `after_sequence`, receive count-and-byte-bounded replay pages sequentially under socket backpressure, then transition to live events. Heartbeats revalidate the device and detect dead connections. Gaps trigger an authenticated replay rather than trusting best-effort socket delivery.

## Local bridge

Each bridge registers a device and runtime. It maintains a server cursor and a local transcript cursor. For an `agent_request`, only the initiating user's eligible runtime can claim the turn. The bridge hydrates the canonical history, invokes the configured local harness, captures structured output, and appends events with runtime provenance.

The built-in Codex connector binds one shared session and local workspace to one persisted Codex thread. Its first turn receives full visible canonical history; resumed turns receive the canonical delta after the last covered sequence. The current server-verified local request is separated from prior untrusted shared context. Codex runs with an explicit local sandbox and no automatic privilege escalation. See [ADR-0005](adr/0005-managed-codex-thread-bridge.md).

Transcript access is opt-in and path-scoped. Secrets are redacted before upload. Raw thinking and private system/developer instructions are excluded by default unless the owner explicitly changes the session policy.

## MCP boundary

MCP exposes collaboration capabilities but is not assumed to see a host's full conversation. Exact transcript or provider-context capture belongs in the local bridge, hook, or authorized provider proxy. MCP resources and tools expose canonical history, cursors, runtime registration, event append, and agent-request claim/complete operations.

## Security baseline

- Private-by-default sessions and revocable invitations.
- Local-only first-owner bootstrap; no public registration.
- One-use session invitations with fixed 1h, 24h, or 7d expiry.
- One-use ten-minute authorization for each additional device.
- Server-derived actor identity; clients cannot forge usernames.
- Peppered HMAC device credentials with use tracking, rotation, and per-device revocation.
- Strict schema validation and payload size limits.
- Bounded JSON depth/nodes, byte-paged replay, slow-client cutoff, per-device rate limits, and per-user/session/deployment event quotas.
- Secret redaction before persistence plus configurable content policy.
- No remote transfer of local tool approval authority.
- Audit events for membership, visibility, and retention changes.
- Loopback-only owner host behind tailnet-only HTTPS; no default public ingress.
