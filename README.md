# GatherThread

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**GatherThread** is a harness-neutral collaboration layer for people who each work with their own local AI agent.

- `solo`: one owner publishes a complete canonical session stream; collaborators follow it read-only.
- `multi`: people share one ordered project conversation. A human chat message is shared without invoking an agent. An agent request is claimed only by the sender's local runtime, and the response is labelled with username, harness, provider, model, and capture fidelity; local device and native-session identifiers are not exposed to non-owner collaborators reading another user's activity.

The server persists an append-only canonical event log in SQLite WAL, assigns authoritative per-session sequence numbers, enforces role-based access, and provides durable replay plus WebSocket live delivery. For each writable Codex session, the local bridge keeps a Desktop-owned interactive task and a separate background execution projection. Trusted hooks publish Desktop turns through a durable idempotent outbox, while Web requests and canonical-history hydration run only on the background projection, so two processes never compete for one native writer.

## Project and role model

A project is the collaboration and invitation boundary. The project owner creates both `solo` and `multi` sessions and may change any other member between `participant` and `viewer` later. A participant can write and run their own agent in every `multi` session, but follows every `solo` session read-only. A viewer is read-only across the entire project. One project invitation therefore grants the selected role for existing and future sessions in that project; there are no per-session permission overrides in the first release.

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

`verify` runs strict TypeScript checks, server/protocol/adapter/bridge/MCP tests, Web tests and build, a real server-to-bridge agent turn, collaboration contract tests, reference/license checks, a secret scan, and an npm vulnerability audit. The secret scan covers every Git-visible file while excluding the ignored local `.env`; a force-tracked `.env` is still scanned and rejected.

## Local end-to-end run

On first initialization, a missing `.env` or blank pepper is filled automatically with a stable random value in a private `0600` file. Create the first owner directly on the host, then start the same-origin Web/API/WebSocket service:

```bash
npm run owner-host:init -- --display-name "Alice" --device-name "Alice laptop"
npm run owner-host
```

To customize ports or paths, copy `.env.example` before initialization. `owner-host:init` fills only a blank pepper and preserves every other setting. `owner-host` builds the current source automatically on every start.

Enter the one-time displayed device credential at `http://127.0.0.1:8787`. The page exchanges it for an opaque `HttpOnly; SameSite=Strict` browser session cookie and immediately clears the credential from JavaScript memory. Reloading restores the signed-in workspace without `localStorage` or `sessionStorage`. The browser session has a 24-hour absolute server-side lifetime and uses a non-persistent session cookie; explicit logout, device revocation, or device-token rotation revokes it. HTTPS deployments add `Secure` and the `__Host-` cookie prefix. WebSockets still use a separate 30-second, one-use, session-scoped ticket, and no credential is placed in a URL.

For UI-only development, `npm --workspace apps/web run dev` starts the loopback preview and proxies the local API. Explicit mock mode is available only at `http://127.0.0.1:4173/?mock=1` with `demo-token`.

## Connect a local Codex agent

Each collaborator selects a project in the GatherThread Web UI, opens **Connect Codex**, copies the command for their operating system, and runs it from the local GatherThread checkout. It resembles:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --project PROJECT_ID \
  --create-workspace \
  --model gpt-5.6-sol \
  --install-hooks
```

The copied command contains no token. The connector prompts for the user's device token without echoing it, safely creates or reuses a same-name workspace under `~/GatherThread Projects/`, and opens that local project in Codex Desktop. Each editable session gets a Desktop task named `GatherThread · <project> · <session>` plus an implementation-private `exec` projection. Codex Desktop is the sole writer of the visible task; Web **Request my agent** turns execute in the background projection and converge through canonical history. Later sessions are discovered automatically. Keep the connector terminal running. To bind an existing source checkout instead, omit `--create-workspace` and pass `--workspace "/absolute/path/to/project"` explicitly.

Canonical events are imported into the background projection in order with frozen, type-specific visible prefixes: `username · Human Chat：`, `username · Agent Request：`, and `username · Agent Response · harness · model：`. With reviewed project hooks installed and trusted, `UserPromptSubmit` supplies the bounded canonical delta to the Desktop Agent as context, and `Stop` uploads that exact prompt and final response once. Public Codex hooks do not expose the completed structured tool stream, so Desktop-originated tool events are omitted rather than recovered by opening a competing writer. Remote canonical events remain visible in GatherThread Web and enter Desktop context at the next prompt boundary; current public Codex APIs cannot insert them as historical bubbles into a Desktop-owned task. Background imports compact locally, and local source files are never rolled back.

Read-only sessions show **Download to Codex** instead of a composer. Every click freezes a new `through_sequence` and creates an independent local snapshot task that never uploads later changes. Owners synchronize all sessions; participants synchronize `multi` and download `solo`; viewers download every session. To publish prompts typed directly in Codex desktop, inspect the generated workspace's `.codex/hooks.json` and approve the exact project hook with Codex `/hooks`; this trust-sensitive capability is never enabled implicitly. Unrelated Codex tasks and immutable snapshot tasks are excluded by a private thread registry. GatherThread credentials are stripped from the Codex child environment, automatic privilege escalation is disabled, and `danger-full-access` is unsupported. See the current [Codex connector guide](docs/CODEX_CONNECT.md) and [ADR-0013](docs/adr/0013-single-writer-dual-codex-projections.md).

## Security and current limits

The first release includes peppered device credentials, HMAC-protected and revocable browser sessions, strict Cookie-write Origin checks, single-use invitations and device authorization, device-bound runtime provenance, immediate session/socket/authorization invalidation on device or membership revocation, solo/multi ACL, event redaction, session-scoped idempotency validation, single-runtime request serialization, one-use realtime tickets, strict production WebSocket Origin checks, bounded JSON complexity and byte-paged replay, per-device rate limits, event and snapshot-job storage quotas, reconnect replay, and SQLite backup/restore scripts. A newly invited user sees the new device credential once and must save it before dismissing the dialog.

The supported zero-cost alpha topology is one participant-owned host bound to loopback and shared privately through Tailscale Serve. See the [owner-hosting guide](docs/SELF_HOSTING.md). Do not expose the current service through router port forwarding, Tailscale Funnel, or an unauthenticated public tunnel.

Not yet implemented: automatic host failover, multi-process WebSocket fan-out, abandoned agent-claim recovery, token-by-token agent streaming, attachment blob storage, retention workers, offline Web outbox, reply/search UI, and packaged native installers.

See [product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [architecture decisions](docs/adr/README.md), [owner hosting](docs/SELF_HOSTING.md), [security model](docs/SECURITY.md), [operations](docs/OPERATIONS.md), and [related work and attribution](docs/REFERENCES.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Yuhan He and contributors.
