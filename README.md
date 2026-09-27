# GatherThread

[English](README.md) | [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/badge/release-0.1.0--alpha.7-0f766e.svg)](docs/releases/0.1.0-alpha.7.md) [![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**One room, many minds.**

**GatherThread** is an open-source, self-hostable workspace for real-time online collaboration among people using their own local AI coding agents. Codex Desktop and DeepSeek Harness connect to the same ordered project history and shared context: conversations are attributable, replayable, and delivered live across role-based Solo and Multi sessions. Each person keeps their local Agent and credentials; Git-backed code checkpoints are a separate, opt-in feature. The collaboration layer remains harness-neutral rather than requiring everyone to use one Agent or model.

> **Invitation-only Alpha.** [gatherthread.cn](https://gatherthread.cn/) is running a small hosted Alpha. Public registration and the public Beta are not open. Each tester needs a one-use test qualification to activate an account; a project invitation alone grants access only to that project. The local, LAN, and Tailscale self-hosting options remain available.

For the current hosted source and the separate Git tag, npm package, and GitHub Release status, see the [release record index](docs/releases/README.md). The repository's `main` branch may contain changes that have not been deployed.

## Request Alpha test access

**[Open an Alpha access Issue](https://github.com/TH060419/gatherthread/issues/new?template=test-access.yml)** to request a test qualification. The source repository is public, but hosted account activation still requires maintainer approval and a one-use qualification; the Issue is the only application channel, with no separate application form or server-side applicant profile. The public template lets applicants optionally describe why they want to join, what they want to test, and how they heard about GatherThread. Email is optional and recommended only if you are comfortable sharing it publicly for private code delivery. If you prefer not to publish your email, after approval you may privately email the Issue link to [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn). Issues are public; never post qualification codes, device access tokens, passwords, keys, or private source code.

A maintainer replies on the public Issue with the review result and next steps. Qualification codes are one-use secrets and must never be published in an Issue. On receiving a code, open the [hosted login page](https://gatherthread.cn/app/), enter your display and device names, and activate it under **First-time activation**. Save the separately issued device token privately for later sign-ins. Existing qualified users can invite guests into individual projects without granting them account-wide project creation.

For questions, bug reports, and non-sensitive feedback, [open a GitHub Issue](https://github.com/TH060419/gatherthread/issues). Send security reports privately to [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn), without including credentials or raw private transcripts.

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
| `site` | Bilingual product home that introduces GatherThread and opens the same-origin application |
| `packages/protocol` | Canonical event and API schemas |
| `packages/adapters` | Authorized Codex, Claude Code, and ZCode transcript discovery, parsing, and redaction |
| `packages/bridge` | Local runtime registration, cursoring, context upload, claim/complete workflow |
| `packages/dsh-host` | Opt-in DeepSeek Harness Host/Client plugin, pairing, project binding, recovery, and redaction |
| `packages/zcode-connect` | Standalone local ZCode headless connector: CLI discovery, preflight probe, and claimed Web Agent execution |
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

Open `http://127.0.0.1:18787` to see the product home, then choose **Get Started** to enter the same-origin application at `/app/`. Enter the one-time displayed device credential there. The application exchanges it for an opaque `HttpOnly; SameSite=Strict` browser session cookie and immediately clears the credential from JavaScript memory. Reloading restores the signed-in workspace without storing a device token in `localStorage` or `sessionStorage`. The default session has a 24-hour absolute server-side lifetime and a non-persistent Cookie. Choosing **Remember this device** creates a 30-day persistent session and a separate `HttpOnly` remembered-account credential. That account appears in the same browser profile's sign-in chooser with its last display and device names, both editable before sign-in. Signing out revokes the active session but leaves that account available for one-click sign-in until its 30-day expiry, **Forget this account**, or device revocation/rotation. Do not choose Remember on a shared browser profile. HTTPS deployments add `Secure` and the `__Host-` cookie prefix. WebSockets still use a separate 30-second, one-use, session-scoped ticket, and no credential is placed in a URL. The higher default reduces collisions with commonly occupied low ports on Windows. Existing installations that explicitly set `GATHERTHREAD_SERVER_PORT=8787` continue to use that value; `18787` is only the new default.

For UI-only development, `npm --workspace apps/web run dev` starts the loopback preview and proxies the local API. The product home is at `http://127.0.0.1:4173/`; explicit workspace mock mode is available only at `http://127.0.0.1:4173/app/?mock=1` with `demo-token`.

## Hosted Alpha and other connection modes

For the current hosted Alpha, use [https://gatherthread.cn](https://gatherthread.cn/) and enter the same-origin workspace at `/app/`. The owner-operated ECS service terminates HTTPS at Caddy while the application remains on loopback; it does not open anonymous account registration or public Git transport. Connect your own Codex or DeepSeek Harness from your device after joining a project. No server SSH account is needed for ordinary product testing.

For an independent self-hosted deployment, three modes work without an Alibaba Cloud account and preserve that deployment's own private `.env`, database, credential pepper, users, and history:

| Mode | Command | Use case |
|---|---|---|
| Local-only | `npm run connection:local` | One computer; no network exposure |
| LAN HTTPS | `npm run lan:start` | Known devices on one trusted LAN; address selection and both services are automatic |
| Tailscale Serve | `npm run connection:tailscale -- --url https://host.tailnet.ts.net` | A small known group across networks |

LAN mode keeps the application on loopback and runs a dedicated Caddy HTTPS proxy bound only to the selected private interface. Client devices must explicitly trust the dedicated local CA; never bypass a certificate warning or expose the port through the router. A campus network is usually institution-managed LAN infrastructure, but peer access is not guaranteed: use LAN mode only when school policy permits it and the devices can reach each other. If client isolation or VLAN separation blocks direct access, use the hosted Alpha if qualified, or a private Tailscale deployment. See the bilingual [connection-mode guide](docs/CONNECTION_MODES.md) and the detailed [owner-hosting guide](docs/SELF_HOSTING.md).

## Connect a local Codex agent

The Web dialog uses one short, three-step flow:

1. Install the fixed **共序 / GatherThread** Codex plugin once.
2. Copy the generated macOS/Linux or PowerShell connector command. The command includes `--plugin-hooks`, but no credential.
3. Restart Codex Desktop, review and enable the plugin Hooks, then keep the connector terminal open.

One-time plugin install:

If `codex --version` is unavailable or Terminal reports `codex: command not found`, first install or update the official Codex CLI with `npm install -g @openai/codex`. Reopen Terminal and confirm `codex plugin --help` works before continuing.

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.7 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

The connector asks for the device token in a hidden terminal prompt, creates or reuses the local project, opens Codex Desktop, and discovers later sessions automatically. Editable GatherThread sessions become Codex tasks; Web Agent requests run in an isolated background projection, while trusted Hooks return direct Desktop turns to the same canonical history. The workspace provides a per-conversation **Auto-upload local turns to cloud** switch and **Upload local turns to cloud now** recovery action; the Codex plugin exposes the same controls. Manual upload scans completed turns when a Hook was missed or failed without turning automation back on. By default, each session imports one verified, readable native-history snapshot the first time it is established locally; Settings can disable that initial import. **Import Codex history** always creates a new verified local task, retains public text within a separate snapshot resource limit and uses Codex's native compaction when needed, and switches future Hook and context delivery to it. GatherThread neither overwrites nor archives the previous local task; review and archive it yourself. Continuing that previous task stays local and cannot create a replacement binding or cloud session. Realtime context injection remains active regardless of the visible-history setting or manual imports. A genuinely new local task creates a personal Solo only after its first completed turn; viewer tasks remain local.

The fixed Alpha commands are documented in the [Codex connection guide](docs/CODEX_CONNECT.md). The matching `v0.1.0-alpha.7` Git ref exists; registry commands additionally require the corresponding package to be published. If the package is unavailable, use the source-checkout path in that guide.

## Connect DeepSeek Harness

DeepSeek Harness uses the same four-step shape:

1. Install `@gatherthread/dsh-host` into the verified DSH Web profile.
2. Start `@deepseek-ai/dsh@0.1.2-rc.1 web` and keep it running.
3. Open **Settings → GatherThread / 共序**, enter the current server, and approve the one-use pairing code in the already signed-in browser.
4. In the same panel, choose a DSH provider and model and connect the projects this identity can access. Pairing alone registers no runtime, so the GatherThread workspace cannot discover this DSH before this step.

One explicit pairing connects every active Project visible to that identity and discovers new access later. Writable GatherThread sessions appear as editable native DSH conversations; completed DSH turns upload once, and canonical server history projects back in order. DSH Settings exposes a per-conversation automatic-upload switch and manual upload action. A successful first turn in a new DSH conversation creates a creator-owned cloud Solo; empty, failed, and viewer conversations remain local. When the connected DSH route exposes DeepSeek model metadata, the GatherThread workspace can choose any advertised model and reasoning effort for each Agent request. The temporary choice applies only to that GatherThread-driven turn, so model selection inside DSH remains independent. Older or non-advertising routes keep their fixed model. Only the explicitly selected runtime handles an Agent request, with no Codex fallback.

In the current DSH plugin build, the **official service** shortcut is disabled unless an official URL is configured. The invitation-only hosted Alpha is nevertheless reachable by entering `https://gatherthread.cn` manually; local, LAN, and Tailscale origins also work. See the [DSH connection guide](docs/DSH_CONNECT.md) for package and source-checkout paths.

## Connect ZCode

ZCode connects through the standalone `@gatherthread/zcode-connect` connector:

1. Choose ZCode in the workspace Agent settings and copy the generated macOS/Linux or PowerShell connector command. The command includes no credential; the CLI requests the device token with a hidden prompt.
2. Keep a local ZCode installation available. The connector discovers the `zcode` CLI on `PATH` or the desktop bundle, probes its headless capabilities, and refuses unsupported builds.
3. Keep the connector terminal open. Every writable session registers one exact ZCode runtime; a claimed Web Agent request runs once in a headless ZCode child inside the project workspace and shares public commentary, allowed redacted tool events, and the final answer. Hidden reasoning never leaves the child, and direct local ZCode turns stay local until the reviewed-hooks upload path ships.

## Security and current limits

### Optional code collaboration and shared summaries

Alpha 7 adds opt-in Git-backed project code checkpoints: a separate branch per member, manual/idle automatic upload, clean download, new-directory recovery, change review and owner-only merge. Codex requires explicit `--code-sync` authorization; DSH exposes project code consent and controls in its plugin settings. Existing conversation uploads and context injection remain independent. Cloud Git is used only to synchronize code with members of the same project, never for GatherThread product development or unrelated purposes. This does not alter your original Git branch/index or provide a public `git push` endpoint. All project readers can read code branches, including branches associated with Solo work. Project members can disable cloud code synchronization, at the cost of cloud code-collaboration features. See the bilingual [setup, limitations and acceptance checklist](docs/CODE_SYNC.md).

The **Alpha 7** source adds a 128 MiB per-user active cloud-code quota and Settings cleanup. Members may clear their own cloud branch; project owners may clear their own branch or the entire project's cloud Git data. A branch cleanup does not undo changes already merged into shared `main`. These operations do not touch anyone's local Git or Agent files. They revoke cloud access and release logical quota, but physical Git objects and backup copies remain until separate operator retention cleanup. See [the current code-sync guide](docs/CODE_SYNC.md) before using deletion.

Native context accounting no longer applies application-side clipping to accepted incoming history. Codex prioritizes its reported model capacity; DSH keeps native model/compaction settings. Native summaries are not lossless or unlimited, and exceptional recovery limits still apply; see [Codex context management](docs/CODEX_CONNECT.md#native-context-management) and [DSH guidance](docs/DSH_CONNECT.md).

Alpha 7 also lets a session **writer** select completed public messages and ask their **own connected local Agent** for a shared manual summary. The new version is attributed and visible to project members; no original event is deleted. Summaries can be selected again as source text for a later summary, and the Web UI can switch between the compact view, original messages, and earlier versions. A per-user project setting chooses summarized context by default or original text for future Web-triggered Agent requests and explicit derived-context reads; it does not retroactively rewrite a native Codex/DSH conversation. Writers can customize/reset the summary instructions. Viewers can read and switch views but cannot generate summaries. This is separate from each harness's native compaction and from local-turn upload consent. See [ADR-0027](docs/adr/0027-shared-manual-history-summaries.md).

The first release includes peppered device credentials, HMAC-protected and revocable browser sessions, strict Cookie-write Origin checks, single-use invitations and device authorization, device-bound runtime provenance, immediate session/socket/authorization invalidation on device or membership revocation, solo/multi ACL, event redaction, session-scoped idempotency validation, single-runtime request serialization, one-use realtime tickets, strict production WebSocket Origin checks, bounded JSON complexity and byte-paged replay, per-device rate limits, per-user/project/deployment session-count limits, event and snapshot-job storage quotas, reconnect replay, and SQLite backup/restore scripts. A newly invited user sees the new device credential once and must save it before dismissing the dialog.

The hosted [gatherthread.cn](https://gatherthread.cn/) Alpha is open only to approved testers; public registration and public Beta remain closed. Local-only, private LAN HTTPS, and private Tailscale Serve are also available. The [Alibaba Cloud ECS profile](docs/ALIYUN_ECS.md) documents the live deployment pattern. Every mode keeps the application on loopback; only the documented Caddy edge may accept public traffic.

Not yet implemented: automatic host failover, multi-process WebSocket fan-out, token-by-token agent streaming, attachment blob storage, retention workers, offline Web outbox, reply/search UI, and packaged native installers. Current progress delivery is item-level public commentary rather than token streaming.

See the [documentation index](docs/README.md), [`0.1.0-alpha.7` notes](docs/releases/0.1.0-alpha.7.md), [product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [connection modes](docs/CONNECTION_MODES.md), [Codex guide](docs/CODEX_CONNECT.md), [DSH guide](docs/DSH_CONNECT.md), [owner hosting](docs/SELF_HOSTING.md), [security model](docs/SECURITY.md), and [operations](docs/OPERATIONS.md).

## Contributing and release governance

Human contributors and development Agents should start with [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). Public and internal integration boundaries are mapped in [`docs/INTERFACE_CONTRACTS.md`](docs/INTERFACE_CONTRACTS.md).

Every version update is reviewed through a pull request by the project lead / designated release maintainer, currently `@TH060419`, before it is merged or released. Contributors and Agents must not publish npm packages, create or move release tags, create GitHub Releases, deploy servers, or delete another contributor's branch without explicit project-lead authorization. `CODEOWNERS` requests this review; repository administrators must also enable the documented `main` branch-protection settings to enforce it on GitHub.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Yuhan He and contributors.
