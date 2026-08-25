# Agent Cooperation Project

[English](README.md) | [简体中文](README.zh-CN.md)

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

`verify` runs strict TypeScript checks, server/protocol/adapter/bridge/MCP tests, Web tests and build, a real server-to-bridge agent turn, collaboration contract tests, reference/license checks, a secret scan, and an npm vulnerability audit.

## Local end-to-end run

Create the ignored environment file and set a stable random `ACP_AUTH_TOKEN_PEPPER` of at least 32 bytes:

```bash
cp .env.example .env
chmod 600 .env
```

Create the first owner directly on the host, then start the same-origin Web/API/WebSocket service:

```bash
npm run owner-host:init -- --display-name "Alice" --device-name "Alice laptop"
npm run owner-host
```

Enter the one-time displayed device credential at `http://127.0.0.1:8787`. The Web client keeps it only in memory. It obtains a 30-second, one-use, session-scoped ticket for WebSocket authentication and never places the long-lived bearer token in a URL.

For UI-only development, `npm --workspace apps/web run dev` starts the loopback preview and proxies the local API. Explicit mock mode is available only at `http://127.0.0.1:4173/?mock=1` with `demo-token`.

## Security and current limits

The first release includes peppered device credentials, single-use invitations and device authorization, device-bound runtime provenance, immediate socket/authorization invalidation on device revocation, solo/multi ACL, event redaction, session-scoped idempotency validation, single-runtime request serialization, one-use realtime tickets, strict production WebSocket Origin checks, bounded JSON complexity and byte-paged replay, per-device rate limits, configurable event-storage quotas, reconnect replay, and SQLite backup/restore scripts.

The supported zero-cost alpha topology is one participant-owned host bound to loopback and shared privately through Tailscale Serve. See the [owner-hosting guide](docs/SELF_HOSTING.md). Do not expose the current service through router port forwarding, Tailscale Funnel, or an unauthenticated public tunnel.

Not yet implemented: automatic host failover, multi-process WebSocket fan-out, abandoned agent-claim recovery, browser HttpOnly-cookie sessions, attachment blob storage, retention workers, offline Web outbox, reply/search UI, and packaged native installers.

See [product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [architecture decisions](docs/adr/README.md), [owner hosting](docs/SELF_HOSTING.md), [security model](docs/SECURITY.md), [operations](docs/OPERATIONS.md), and [related work and attribution](docs/REFERENCES.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Yuhan He and contributors.
