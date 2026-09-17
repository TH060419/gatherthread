# GatherThread

[English](README.md) | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/badge/release-0.1.0--alpha.5-0f766e.svg)](docs/releases/0.1.0-alpha.5.md) [![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**One room, many minds.**

**GatherThread** is where people collaborate in one shared workspace, each with their own local Agent, while context stays ordered, attributable, and live. It remains harness-neutral, so every collaborator can keep the local Agent and workflow they already use.

> **Alpha preview.** The repository remains private and the hosted GatherThread service is not open. A collaborator with repository access can run the full local, LAN, or Tailscale experience, including Codex and DeepSeek Harness; only the future public-server path is unavailable.

- `solo`: its creator publishes a complete canonical session stream; every other project member, including the project owner when someone else created it, follows it read-only.
- `multi`: people share one ordered project conversation. A human chat message is shared without invoking an agent. An agent request is claimed only by the sender's local runtime, and the response is labelled with username, harness, provider, model, and capture fidelity; local device and native-session identifiers are not exposed to non-owner collaborators reading another user's activity.

The server persists an append-only canonical event log in SQLite WAL, assigns authoritative per-session sequence numbers, enforces role-based access, and provides durable replay plus WebSocket live delivery. Codex and DeepSeek Harness keep separate native projections of that same history, recover from durable cursors and outboxes, and route each Agent request only to the runtime the user selected.

The bilingual Web workspace is responsive and resizable. Project-scoped settings control the default Agent model, reasoning effort, and context-injection ceiling; accessible custom controls, default high contrast, and theme-aware ambient lighting keep the interface legible without competing with the conversation.

Web Agent turns mirror Codex Desktop's reading hierarchy: public work updates arrive live, then collapse into an optional work log when the final response appears. Final responses and work updates render safe GitHub-flavored Markdown with bundled KaTeX for inline and display math, while hidden reasoning is never uploaded or displayed.

## Project and role model

A project is the collaboration and invitation boundary. The project owner can rename the project, creates `multi` sessions, can switch their own sessions between `solo` and `multi`, and may change any other member between `participant` and `viewer` later. Owners and participants may each create personal `solo` sessions; only that Solo's creator may write or rename it, while every other project member reads it. A participant can also write and run their own agent in every `multi` session. A viewer is read-only across the entire project, and local tasks created by a viewer never create cloud sessions. A session creator or the project owner may permanently delete that session's cloud copy; only the project owner may delete the whole cloud project. Cloud deletion stops synchronization and removes shared server history, but never deletes local workspaces, files, Codex tasks, or Agent conversations.

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
| `packages/dsh-host` | Opt-in DeepSeek Harness Host/Client plugin, pairing, project binding, recovery, and redaction |
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
npm run connection:local
npm run owner-host:init -- --display-name "Alice" --device-name "Alice laptop"
npm run owner-host
```

To customize ports or paths, copy `.env.example` before initialization. `owner-host:init` fills only a blank pepper and preserves every other setting. `owner-host` builds the current source automatically on every start.

Enter the one-time displayed device credential at `http://127.0.0.1:18787`. The page exchanges it for an opaque `HttpOnly; SameSite=Strict` browser session cookie and immediately clears the credential from JavaScript memory. Reloading restores the signed-in workspace without `localStorage` or `sessionStorage`. The default session has a 24-hour absolute server-side lifetime and a non-persistent Cookie. Choosing **Remember this device** instead creates a 30-day persistent Cookie; explicit logout, device revocation, or device-token rotation still revokes it immediately. HTTPS deployments add `Secure` and the `__Host-` cookie prefix. WebSockets still use a separate 30-second, one-use, session-scoped ticket, and no credential is placed in a URL. The higher default reduces collisions with commonly occupied low ports on Windows. Existing installations that explicitly set `GATHERTHREAD_SERVER_PORT=8787` continue to use that value; `18787` is only the new default.

For UI-only development, `npm --workspace apps/web run dev` starts the loopback preview and proxies the local API. Explicit mock mode is available only at `http://127.0.0.1:4173/?mock=1` with `demo-token`.

## Choose a connection mode

Three connection modes work without a cloud account and preserve the same private `.env`, database, credential pepper, users, and history:

| Mode | Command | Use case |
|---|---|---|
| Local-only | `npm run connection:local` | One computer; no network exposure |
| LAN HTTPS | `npm run lan:start` | Known devices on one trusted LAN; address selection and both services are automatic |
| Tailscale Serve | `npm run connection:tailscale -- --url https://host.tailnet.ts.net` | A small known group across networks |

LAN mode keeps the application on loopback and runs a dedicated Caddy HTTPS proxy bound only to the selected private interface. Client devices must explicitly trust the dedicated local CA; never bypass a certificate warning or expose the port through the router. A campus network is usually institution-managed LAN infrastructure, but peer access is not guaranteed: use LAN mode only when school policy permits it and the devices can reach each other. If client isolation or VLAN separation blocks direct access, use the deployment's configured remote entry point; Tailscale is available now, while a unified hosted server should be preferred once deployed. See the bilingual [connection-mode guide](docs/CONNECTION_MODES.md) and the detailed [owner-hosting guide](docs/SELF_HOSTING.md).

## Connect a local Codex agent

The Web dialog uses one short, three-step flow:

1. Install the fixed **共序 / GatherThread** Codex plugin once.
2. Copy the generated macOS/Linux or PowerShell connector command. The command includes `--plugin-hooks`, but no credential.
3. Restart Codex Desktop, review and enable the plugin Hooks, then keep the connector terminal open.

One-time plugin install:

If `codex --version` is unavailable or Terminal reports `codex: command not found`, first install or update the official Codex CLI with `npm install -g @openai/codex`. Reopen Terminal and confirm `codex plugin --help` works before continuing.

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.5 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

The connector asks for the device token in a hidden terminal prompt, creates or reuses the local project, opens Codex Desktop, and discovers later sessions automatically. Editable GatherThread sessions become Codex tasks; Web Agent requests run in an isolated background projection, while trusted Hooks return direct Desktop turns to the same canonical history. The workspace provides a per-conversation **Auto-upload local turns to cloud** switch and **Upload local turns to cloud now** recovery action; the Codex plugin exposes the same controls. Manual upload scans completed turns when a Hook was missed or failed without turning automation back on. By default, each session imports one verified, readable native-history snapshot the first time it is established locally; Settings can disable that initial import. **Import Codex history** always creates a new verified local task, compacts long history to the configured context budget, and switches future Hook and context delivery to it. GatherThread neither overwrites nor archives the previous local task; review and archive it yourself. Continuing that previous task stays local and cannot create a replacement binding or cloud session. Realtime context injection remains active regardless of the visible-history setting or manual imports. A genuinely new local task creates a personal Solo only after its first completed turn; viewer tasks remain local.

The fixed Alpha commands are documented in the [Codex connection guide](docs/CODEX_CONNECT.md). Registry commands become usable only after the packages and `v0.1.0-alpha.5` ref are published. Before that, collaborators with private repository access use the source-checkout path in the same guide.

## Connect DeepSeek Harness

DeepSeek Harness uses the same four-step shape:

1. Install `@gatherthread/dsh-host` into the verified DSH Web profile.
2. Start `@deepseek-ai/dsh@0.1.2-rc.1 web` and keep it running.
3. Open **Settings → GatherThread / 共序**, enter the current server, and approve the one-use pairing code in the already signed-in browser.
4. In the same panel, choose a DSH provider and model and connect the projects this identity can access. Pairing alone registers no runtime, so the GatherThread workspace cannot discover this DSH before this step.

One explicit pairing connects every active Project visible to that identity and discovers new access later. Writable GatherThread sessions appear as editable native DSH conversations; completed DSH turns upload once, and canonical server history projects back in order. DSH Settings exposes a per-conversation automatic-upload switch and manual upload action. A successful first turn in a new DSH conversation creates a creator-owned cloud Solo; empty, failed, and viewer conversations remain local. Only the explicitly selected runtime handles an Agent request, with no Codex fallback.

The official GatherThread service button is present but disabled in this Alpha. Local, LAN, self-hosted, and Tailscale origins work now. See the [DSH connection guide](docs/DSH_CONNECT.md) for the published-package and private-checkout paths.

## Security and current limits

The first release includes peppered device credentials, HMAC-protected and revocable browser sessions, strict Cookie-write Origin checks, single-use invitations and device authorization, device-bound runtime provenance, immediate session/socket/authorization invalidation on device or membership revocation, solo/multi ACL, event redaction, session-scoped idempotency validation, single-runtime request serialization, one-use realtime tickets, strict production WebSocket Origin checks, bounded JSON complexity and byte-paged replay, per-device rate limits, per-user/project/deployment session-count limits, event and snapshot-job storage quotas, reconnect replay, and SQLite backup/restore scripts. A newly invited user sees the new device credential once and must save it before dismissing the dialog.

The hosted GatherThread service and public Beta are not open in `0.1.0-alpha.5`. Local-only, private LAN HTTPS, and private Tailscale Serve are available. The [Alibaba Cloud ECS profile](docs/ALIYUN_ECS.md) is deployment-ready documentation for the next stage, not a claim that the service is online. Every mode keeps the application on loopback; only the documented Caddy edge may accept public traffic.

Not yet implemented: automatic host failover, multi-process WebSocket fan-out, abandoned agent-claim recovery, token-by-token agent streaming, attachment blob storage, retention workers, offline Web outbox, reply/search UI, and packaged native installers. Current progress delivery is item-level public commentary rather than token streaming.

See the [`0.1.0-alpha.5` notes](docs/releases/0.1.0-alpha.5.md), [product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [connection modes](docs/CONNECTION_MODES.md), [Codex guide](docs/CODEX_CONNECT.md), [DSH guide](docs/DSH_CONNECT.md), [owner hosting](docs/SELF_HOSTING.md), [security model](docs/SECURITY.md), and [operations](docs/OPERATIONS.md).

## Contributing and release governance

Human contributors and development Agents should start with [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). Public and internal integration boundaries are mapped in [`docs/INTERFACE_CONTRACTS.md`](docs/INTERFACE_CONTRACTS.md).

Every version update is reviewed through a pull request by the project lead / designated release maintainer, currently `@TH060419`, before it is merged or released. Contributors and Agents must not publish npm packages, create or move release tags, create GitHub Releases, deploy servers, or delete another contributor's branch without explicit project-lead authorization. `CODEOWNERS` requests this review; repository administrators must also enable the documented `main` branch-protection settings to enforce it on GitHub.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Yuhan He and contributors.
