# Agent Cooperation Project

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Agent Cooperation Project, working UI name **Relayroom**, is a harness-neutral collaboration layer for people who each work with their own local AI agent.

- `solo`: one owner publishes a complete canonical session stream; collaborators follow it read-only.
- `multi`: people share one ordered project conversation. A human chat message is shared without invoking an agent. An agent request is claimed only by the sender's local runtime, and the response is labelled with username, device, harness, provider, model, local session, and capture fidelity.

The server persists an append-only canonical event log in SQLite WAL, assigns authoritative per-session sequence numbers, enforces role-based access, and provides durable replay plus WebSocket live delivery. The local bridge imports Codex and Claude Code JSONL incrementally, redacts common secrets, maintains separate server/local cursors, and exposes collaboration through MCP tools and resources.

## What “complete context” means

The project records three explicit fidelity levels:

1. `canonical_history`: the complete shared event history visible to that member.
2. `harness_transcript`: content observed in an authorized local harness transcript.
3. `provider_request`: the exact request observed by an explicit harness hook or authorized provider proxy.

An MCP server cannot independently read an entire host conversation. Therefore reconstructed history is never labelled `provider_request`, and exact provider request uploads are disabled unless the local bridge is explicitly authorized and confirms an exact observation. Compaction remains local; the shared canonical log stays durable.

## Repository layout

| Path | Responsibility |
|---|---|
| `apps/server` | Authenticated HTTP/WebSocket service, SQLite WAL, ACL, replay, runtime claims |
| `apps/web` | Responsive solo/multi collaboration UI with chat/request controls and gap recovery |
| `packages/protocol` | Canonical event and API schemas |
| `packages/adapters` | Authorized Codex and Claude Code transcript discovery, parsing, and redaction |
| `packages/bridge` | Local runtime registration, cursoring, context upload, claim/complete workflow |
| `packages/mcp` | MCP tools, resources, and stateless Streamable HTTP JSON-RPC handler |
| `tests` | Contract, security, backup, and real server-to-bridge integration tests |

## Requirements and verification

Node.js 24 or newer is required because the server uses `node:sqlite`.

```bash
npm install
npm run verify
```

`verify` runs strict TypeScript checks, server/protocol/adapter/bridge/MCP tests, Web tests and build, a real server-to-bridge agent turn, collaboration contract tests, reference/license checks, and a secret scan.

## Local end-to-end run

Build and start the API, allowing the separate local Web preview origin:

```bash
npm run build
ACP_ALLOWED_ORIGINS=http://127.0.0.1:4173 npm start
```

In another terminal, start the Web client:

```bash
npm --workspace apps/web run dev
```

Bootstrap the first user once:

```bash
curl -sS http://127.0.0.1:8787/v1/bootstrap \
  -H 'content-type: application/json' \
  -d '{"user_id":"alice","display_name":"Alice","device_id":"alice-laptop","device_name":"Alice laptop"}'
```

Copy the returned token into `http://127.0.0.1:4173/?api=http://127.0.0.1:8787`. The browser obtains a 30-second, one-use, session-scoped ticket for WebSocket authentication; it does not place the long-lived bearer token in the socket URL.

The mock product preview remains available at `http://127.0.0.1:4173` with `demo-token`.

## Security and current limits

The first release includes hashed bearer tokens, device revocation, server-derived actors, solo/multi ACL, event redaction, session-scoped idempotency validation, single-runtime request serialization, one-use realtime tickets, Origin allowlists, reconnect replay, and SQLite backup/restore scripts. For non-local deployment, place the server behind an HTTPS reverse proxy.

Not yet implemented: invitation proofs and UI, bearer token expiry/rotation, rate limiting, multi-process WebSocket fan-out, attachment blob storage, retention workers, offline Web outbox, reply/search UI, and a packaged daemon installer for local harness hooks.

See [product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [architecture decisions](docs/adr/README.md), [security model](docs/SECURITY.md), [operations](docs/OPERATIONS.md), and [related work and attribution](docs/REFERENCES.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Yuhan He and contributors.
