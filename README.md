# GatherThread

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**One room, many minds.**

**GatherThread** is where people collaborate in one shared workspace, each with their own local Agent, while context stays ordered, attributable, and live. It remains harness-neutral, so every collaborator can keep the local Agent and workflow they already use.

- `solo`: its creator publishes a complete canonical session stream; every other project member, including the project owner when someone else created it, follows it read-only.
- `multi`: people share one ordered project conversation. A human chat message is shared without invoking an agent. An agent request is claimed only by the sender's local runtime, and the response is labelled with username, harness, provider, model, and capture fidelity; local device and native-session identifiers are not exposed to non-owner collaborators reading another user's activity.

The server persists an append-only canonical event log in SQLite WAL, assigns authoritative per-session sequence numbers, enforces role-based access, and provides durable replay plus WebSocket live delivery. For each writable Codex session, the local bridge keeps a Desktop-owned interactive task and a separate background execution projection. Trusted hooks publish Desktop turns through a durable idempotent outbox, while Web requests and canonical-history hydration run only on the background projection, so two processes never compete for one native writer.

The bilingual Web workspace is responsive and resizable. Project-scoped settings control the default Agent model, reasoning effort, and context-injection ceiling; accessible custom controls, default high contrast, and theme-aware ambient lighting keep the interface legible without competing with the conversation.

## Project and role model

A project is the collaboration and invitation boundary. The project owner creates `multi` sessions and may change any other member between `participant` and `viewer` later. Owners and participants may each create personal `solo` sessions; only that Solo's creator may write or rename it, while every other project member reads it. A participant can also write and run their own agent in every `multi` session. A viewer is read-only across the entire project, and local tasks created by a viewer never create cloud sessions. One project invitation therefore grants the selected project role for current and future sessions, while Solo creator ownership supplies the single intentional per-session write boundary.

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
| `apps/web` | Bilingual, resizable solo/multi workspace with Agent settings, chat/request controls, and gap recovery |
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

Project Agent settings seed the model, reasoning effort, and context-injection ceiling used by new connection commands and Web Agent requests.

The copied command contains no token. The connector prompts for the user's device token without echoing it, safely creates or reuses a same-name workspace under `~/GatherThread Projects/`, and opens that local project in Codex Desktop. A newly materialized editable session starts with a Desktop task named `<session> · GatherThread` plus an implementation-private `exec` projection named `<session> · GatherThread background`. The local and cloud titles are independent after that first materialization; changing either title never changes the stable session/thread binding and never creates a second session. Codex Desktop is the sole writer of the visible task; Web **Request my agent** turns execute in the background projection and converge through canonical history. Do not use a background-labelled task for direct work if the current Desktop version lists it. If Desktop nevertheless claims that implementation detail, the next Web request replaces it from authoritative canonical history instead of retrying the locked writer forever. Later sessions are discovered automatically. Keep the connector terminal running. To bind an existing source checkout instead, omit `--create-workspace` and pass `--workspace "/absolute/path/to/project"` explicitly.

Canonical events are imported into the background projection in order with frozen, type-specific visible prefixes: `username · Human Chat：`, `username · Agent Request：`, and `username · Agent Response · harness · model：`. With reviewed project hooks installed and trusted, `UserPromptSubmit` supplies an acknowledged, context-bounded capsule to the Desktop Agent. The visible response begins with `Loaded N cloud updates / 已加载 N 条云端更新` and at most three short previews; exact ordered bodies remain in the model-only context block. Oversized events are split on UTF-8 boundaries and continue on later completed Desktop turns. A cancelled turn acknowledges nothing, and a persisted delivery cursor never advances past an omitted chunk. Relayed content is untrusted shared history and is not executed as a new request. `Stop` uploads that exact prompt and final response once. Public Codex hooks do not expose the completed structured tool stream, so Desktop-originated tool events are omitted rather than recovered by opening a competing writer. Current public Codex APIs cannot insert remote events as historical bubbles into a Desktop-owned task. Background imports compact locally, and local source files are never rolled back.

With trusted Hooks enabled, the first prompt submitted in a previously unbound Codex Desktop task is also the creation boundary. For a project owner or participant, the connector creates one deterministic personal Solo, binds that existing Desktop task, and uploads the same completed turn exactly once. Merely opening an empty task creates nothing. For a viewer the task stays entirely local. Connector-owned background and snapshot tasks are explicitly excluded from this discovery path.

Read-only sessions show **Download to Codex** instead of a composer. Every click freezes a new `through_sequence` and creates an independent local snapshot task that never uploads later changes. Owners and participants synchronize `multi` plus their own personal Solos, and download other members' Solos; viewers download every session. To publish prompts typed directly in Codex Desktop, open Desktop Settings and enable Hooks, then inspect the generated workspace's `.codex/hooks.json`; this trust-sensitive capability is never enabled implicitly. Unrelated Codex tasks and immutable snapshot tasks are excluded by a private thread registry. GatherThread credentials are stripped from the Codex child environment, automatic privilege escalation is disabled, and `danger-full-access` is unsupported. See the current [Codex connector guide](docs/CODEX_CONNECT.md), [ADR-0013](docs/adr/0013-single-writer-dual-codex-projections.md), [ADR-0014](docs/adr/0014-acknowledged-bounded-desktop-relay-capsules.md), and [ADR-0015](docs/adr/0015-create-personal-solos-from-first-local-prompt.md).

## Security and current limits

The first release includes peppered device credentials, HMAC-protected and revocable browser sessions, strict Cookie-write Origin checks, single-use invitations and device authorization, device-bound runtime provenance, immediate session/socket/authorization invalidation on device or membership revocation, solo/multi ACL, event redaction, session-scoped idempotency validation, single-runtime request serialization, one-use realtime tickets, strict production WebSocket Origin checks, bounded JSON complexity and byte-paged replay, per-device rate limits, per-user/project/deployment session-count limits, event and snapshot-job storage quotas, reconnect replay, and SQLite backup/restore scripts. A newly invited user sees the new device credential once and must save it before dismissing the dialog.

The supported zero-cost alpha topology is one participant-owned host bound to loopback and shared privately through Tailscale Serve. See the [owner-hosting guide](docs/SELF_HOSTING.md). Do not expose the current service through router port forwarding, Tailscale Funnel, or an unauthenticated public tunnel.

Not yet implemented: automatic host failover, multi-process WebSocket fan-out, abandoned agent-claim recovery, token-by-token agent streaming, attachment blob storage, retention workers, offline Web outbox, reply/search UI, and packaged native installers.

See [product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [architecture decisions](docs/adr/README.md), [owner hosting](docs/SELF_HOSTING.md), [security model](docs/SECURITY.md), [operations](docs/OPERATIONS.md), and [related work and attribution](docs/REFERENCES.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Yuhan He and contributors.
