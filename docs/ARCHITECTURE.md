# Architecture v0.1

Significant architectural choices and their rationale are recorded in the [ADR index](adr/README.md). The server trust boundary is defined by [ADR-0001](adr/0001-trusted-self-hosted-collaboration-server.md).

## Components

```text
Browser / CLI ── HTTPS + WebSocket ── Collaboration server ── SQLite WAL
                                           │
                                           │ MCP over Streamable HTTP
                                           │
Local bridge ── transcript adapter ── local Codex / Claude Code session
```

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

Clients authenticate, subscribe with `session_id` and `after_sequence`, receive replay pages, then transition to live events. Heartbeats detect dead connections. Gaps trigger an HTTP replay rather than trusting best-effort socket delivery.

## Local bridge

Each bridge registers a device and runtime. It maintains a server cursor and a local transcript cursor. For an `agent_request`, only the initiating user's eligible runtime can claim the turn. The bridge hydrates the canonical history, invokes the configured local harness, captures structured output, and appends events with runtime provenance.

Transcript access is opt-in and path-scoped. Secrets are redacted before upload. Raw thinking and private system/developer instructions are excluded by default unless the owner explicitly changes the session policy.

## MCP boundary

MCP exposes collaboration capabilities but is not assumed to see a host's full conversation. Exact transcript or provider-context capture belongs in the local bridge, hook, or authorized provider proxy. MCP resources and tools expose canonical history, cursors, runtime registration, event append, and agent-request claim/complete operations.

## Security baseline

- Private-by-default sessions and revocable invitations.
- Server-derived actor identity; clients cannot forge usernames.
- Hashed bearer credentials and per-device revocation.
- Strict schema validation and payload size limits.
- Secret redaction before persistence plus configurable content policy.
- No remote transfer of local tool approval authority.
- Audit events for membership, visibility, and retention changes.
