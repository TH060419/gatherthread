# GatherThread

[English](README.md) | [简体中文](README.zh-CN.md)

[![Alpha](https://img.shields.io/badge/alpha-0.1.0--alpha.8-0f766e.svg)](docs/releases/0.1.0-alpha.8.md) [![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**One room, many minds.**

**GatherThread** is an open-source, self-hostable workspace for real-time online collaboration among people using their own local AI coding agents. Codex Desktop and DeepSeek Harness connect to the same ordered project history and shared context: conversations are attributable, replayable, and delivered live across role-based Solo and Multi sessions. Each person keeps their local Agent and credentials; Git-backed code checkpoints are a separate, opt-in feature. The collaboration layer remains harness-neutral rather than requiring everyone to use one Agent or model.

**Alpha 8** adds a bilingual first-use guide and isolated practice project, quotes and member mentions, clearer conversation navigation, runtime-advertised model choices, optional Windows/macOS Codex Launcher prototypes, self-service account deletion. See the [Alpha 8 notes](docs/releases/0.1.0-alpha.8.md) for limits and verification gates.

**Cloud trial Agent source preview:** an optional, isolated [OpenCode](https://github.com/anomalyco/opencode) runner is being prepared for first-time users. It can edit files and run terminal commands in a temporary container, with an explicit choice before reading project cloud code or saving changes to a member's branch. Once enabled, select Cloud Agent beside Codex and DSH in the workspace or Settings; operators can configure multiple API accounts for parallel capacity. It is disabled until an operator configures a model API and validates the container; it is not a claim that gatherthread.cn currently offers this feature. See the [user guide](docs/HOSTED_AGENT_GUIDE.md) and [operator guide](docs/HOSTED_AGENT.md). The separate [Cloud GitHub preview](docs/HOSTED_GITHUB.md) adds account authorization, npm dependency preparation, private saved source, change review and explicit draft PR creation for Node.js/TypeScript projects; its real App/provider and Linux container activation gates remain pending.

> **Unreleased account update.** The hosted Alpha has not switched to this branch or opened public registration. The source flow below requires operator preflight before enablement.

Git tag, npm package, and GitHub Release details are recorded in the [release index](docs/releases/README.md).

## Registration and sign-in

Register with a verified email address and choose a password, then sign in with email and password. Create projects or accept project invitations after signing in. Connect your Agents with independent device authorization. If you forget your password, request an email code on the sign-in page and choose a new password; this signs out every device and revokes Agent access while keeping your projects.

The same account can stay signed in on a computer, phone and tablet together. Each browser has its own session; signing out affects only that browser. Settings → This device → Your account devices lets you inspect and revoke individual devices. To request an already-connected computer Agent from your phone, keep its connector running and select that Agent device; authorizing a new Agent remains a separate action.

Registration and password recovery are closed by default until their [operator setup](docs/OPERATIONS.md) is complete. This source preview is not deployed to the official Alpha. See [ADR-0036](docs/adr/0036-verified-email-registration-and-password-login.md) for account and device behavior.

For questions, bug reports, and non-sensitive feedback, [open a GitHub Issue](https://github.com/TH060419/gatherthread/issues). Send security reports privately to [coolhezi@sjtu.edu.cn](mailto:coolhezi@sjtu.edu.cn), without including credentials or raw private transcripts.

- `solo`: its creator publishes a complete canonical session stream; every other project member, including the project owner when someone else created it, follows it read-only.
- `multi`: people share one ordered project conversation. A human chat message is shared without invoking an agent. Requests to a connected local Agent are claimed only by the sender's local runtime. When enabled, a separate cloud trial request runs in an isolated server-side container. Responses are labelled with username, harness, provider, model, and capture fidelity; local device and native-session identifiers are not exposed to non-owner collaborators reading another user's activity.

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

On first initialization, a missing `.env` or blank pepper is filled automatically with a stable random value in a private `0600` file. Prepare configuration without creating an account, then start the same-origin Web/API/WebSocket service:

```bash
npm run connection:local
npm run owner-host:init
npm run owner-host
```

To customize ports or paths, copy `.env.example` before initialization. `owner-host:init` fills only a blank pepper and preserves every other setting. `owner-host` builds the current source automatically on every start.

Open `http://127.0.0.1:18787`, then enter `/app/` to register with verified email and sign in with a self-set password. Signup stays closed until the [operator preflight](docs/OPERATIONS.md) is complete. Password recovery requires its separate operator switch and configured mail/security providers. The browser holds only an HttpOnly session Cookie, for 24 hours by default or 30 days with Remember this device; logout revokes it. Agent devices exchange a separate authorization in their connector without reusing the password.

For UI-only development, `npm --workspace apps/web run dev` starts the loopback preview and proxies the local API. The product home is at `http://127.0.0.1:4173/`; explicit workspace mock mode is available only at `http://127.0.0.1:4173/app/?mock=1` with email `demo@example.invalid` and password `isolated demo password`.

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

If Terminal reports `command not found: codex`, a Mac with ChatGPT Desktop installed may already have the CLI but lack its directory in `PATH`. Check the bundled executable, add its directory to `PATH`, and only then save the change to `~/.zshrc`; see the [Codex connection guide](docs/CODEX_CONNECT.md#1-install-the-codex-plugin-once) for the exact commands. On other systems, follow the [official Codex CLI installation guide](https://learn.chatgpt.com/docs/codex/cli). Confirm `codex plugin --help` works before continuing.

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.8 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

Create a one-time device authorization in the signed-in Connect Codex dialog, then paste it into the connector's hidden prompt within ten minutes. The connector exchanges it for its own independently revocable device credential, creates or reuses the local project, opens Codex Desktop, and discovers later sessions automatically. Editable GatherThread sessions become Codex tasks; Web Agent requests run in an isolated background projection, while trusted Hooks return direct Desktop turns to the same canonical history. The workspace provides a per-conversation **Auto-upload local turns to cloud** switch and **Upload local turns to cloud now** recovery action; the Codex plugin exposes the same controls. Manual upload scans completed turns when a Hook was missed or failed without turning automation back on. By default, each session imports one verified, readable native-history snapshot the first time it is established locally; Settings can disable that initial import. **Import Codex history** always creates a new verified local task, retains public text within a separate snapshot resource limit and uses Codex's native compaction when needed, and switches future Hook and context delivery to it. GatherThread neither overwrites nor archives the previous local task; review and archive it yourself. Continuing that previous task stays local and cannot create a replacement binding or cloud session. Realtime context injection remains active regardless of the visible-history setting or manual imports. A genuinely new local task creates a personal Solo only after its first completed turn; viewer tasks remain local.

The fixed Alpha commands are documented in the [Codex connection guide](docs/CODEX_CONNECT.md). Verify the matching `v0.1.0-alpha.8` Git ref and npm package before installing; the source-checkout path is also documented there.

## Connect DeepSeek Harness

DeepSeek Harness uses the same four-step shape:

1. Install `@gatherthread/dsh-host` into the verified DSH Web profile.
2. Start `@deepseek-ai/dsh@0.1.2-rc.1 web` and keep it running.
3. Open **Settings → GatherThread / 共序**, enter the current server, and approve the one-use pairing code in the already signed-in browser.
4. In the same panel, choose a DSH provider and model and connect the projects this identity can access. Pairing alone registers no runtime, so the GatherThread workspace cannot discover this DSH before this step.

One explicit pairing connects every active Project visible to that identity and discovers new access later. Writable GatherThread sessions appear as editable native DSH conversations; completed DSH turns upload once, and canonical server history projects back in order. DSH Settings exposes a per-conversation automatic-upload switch and manual upload action. A successful first turn in a new DSH conversation creates a creator-owned cloud Solo; empty, failed, and viewer conversations remain local. When the connected DSH route exposes DeepSeek model metadata, the GatherThread workspace can choose any advertised model and reasoning effort for each Agent request. The temporary choice applies only to that GatherThread-driven turn, so model selection inside DSH remains independent. Older or non-advertising routes keep their fixed model. Only the explicitly selected runtime handles an Agent request, with no Codex fallback.

Enter the current server URL in DSH Settings. Approved testers can use `https://gatherthread.cn`; local, LAN, and Tailscale origins also work. See the [DSH connection guide](docs/DSH_CONNECT.md) for package and source-checkout paths.

## Security and current limits

### Optional code collaboration and shared summaries

**Unreleased source preview: direct GitHub synchronization.** For real development, prefer GitHub, especially for larger or long-term projects within the preview limits. GatherThread's limited-quota cloud checkpoints are suitable for lightweight trials. Each authorized device connects directly to GitHub using its own local GitHub CLI login, uploads only to its stable personal branch, and keeps GitHub source and credentials off the GatherThread server. GitHub permissions, Actions and remote deletion remain separately managed. This does not claim availability in published packages or the hosted service. See the bilingual [GitHub setup and limits](docs/CODE_SYNC.md) and [ADR-0035](docs/adr/0035-direct-local-github-code-synchronization.md).

Alpha 7 introduced opt-in Git-backed project code checkpoints: a separate branch per member, manual/idle automatic upload, clean download, new-directory recovery, change review and owner-only merge. Codex requires explicit `--code-sync` authorization; DSH exposes project code consent and controls in its plugin settings. Existing conversation uploads and context injection remain independent. Cloud Git is used only to synchronize code with members of the same project, never for GatherThread product development or unrelated purposes. This does not alter your original Git branch/index or provide a public `git push` endpoint. All project readers can read code branches, including branches associated with Solo work. Project members can disable cloud code synchronization, at the cost of cloud code-collaboration features. See the bilingual [setup, limitations and acceptance checklist](docs/CODE_SYNC.md).

The **Alpha 7** source added a 128 MiB per-user active cloud-code quota and Settings cleanup. Members may clear their own cloud branch; project owners may clear their own branch or the entire project's cloud Git data. A branch cleanup does not undo changes already merged into shared `main`. These operations do not touch anyone's local Git or Agent files. They revoke cloud access and release logical quota, but physical Git objects and backup copies remain until separate operator retention cleanup. See [the current code-sync guide](docs/CODE_SYNC.md) before using deletion.

Native context accounting no longer applies application-side clipping to accepted incoming history. Codex prioritizes its reported model capacity; DSH keeps native model/compaction settings. Native summaries are not lossless or unlimited, and exceptional recovery limits still apply; see [Codex context management](docs/CODEX_CONNECT.md#native-context-management) and [DSH guidance](docs/DSH_CONNECT.md).

Alpha 7 also lets a session **writer** select completed public messages and ask their **own connected local Agent** for a shared manual summary. The new version is attributed and visible to project members; no original event is deleted. Summaries can be selected again as source text for a later summary, and the Web UI can switch between the compact view, original messages, and earlier versions. A per-user project setting chooses summarized context by default or original text for future Web-triggered Agent requests and explicit derived-context reads; it does not retroactively rewrite a native Codex/DSH conversation. Writers can customize/reset the summary instructions. Viewers can read and switch views but cannot generate summaries. This is separate from each harness's native compaction and from local-turn upload consent. See [ADR-0027](docs/adr/0027-shared-manual-history-summaries.md).

The first release includes peppered device credentials, HMAC-protected and revocable browser sessions, strict Cookie-write Origin checks, single-use invitations and device authorization, device-bound runtime provenance, immediate session/socket/authorization invalidation on device or membership revocation, solo/multi ACL, event redaction, session-scoped idempotency validation, single-runtime request serialization, one-use realtime tickets, strict production WebSocket Origin checks, bounded JSON complexity and byte-paged replay, per-device rate limits, per-user/project/deployment session-count limits, event and snapshot-job storage quotas, reconnect replay, and SQLite backup/restore scripts. Users sign in with email and password; independent Agent device credentials stay in their connectors.

The hosted [gatherthread.cn](https://gatherthread.cn/) Alpha is open only to approved testers; public registration and public Beta remain closed. Local-only, private LAN HTTPS, and private Tailscale Serve are also available. The [Alibaba Cloud ECS profile](docs/ALIYUN_ECS.md) documents the live deployment pattern. Every mode keeps the application on loopback; only the documented Caddy edge may accept public traffic.

Not yet implemented: automatic host failover, multi-process WebSocket fan-out, token-by-token agent streaming, attachment blob storage, general conversation-retention workers, offline Web outbox, conversation search and production-signed native installers. Alpha 8 adds account deletion and ECS backup, cloud-Git, and journal retention jobs; those guarantees apply to a host only after the updated units and every off-host copy policy are deployed and verified. See the [privacy notice](site/privacy/) and [operations guide](docs/OPERATIONS.md). Current progress delivery is item-level public commentary rather than token streaming.

See the [documentation index](docs/README.md), [`0.1.0-alpha.8` notes](docs/releases/0.1.0-alpha.8.md), [product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [connection modes](docs/CONNECTION_MODES.md), [Codex guide](docs/CODEX_CONNECT.md), [DSH guide](docs/DSH_CONNECT.md), [owner hosting](docs/SELF_HOSTING.md), [security model](docs/SECURITY.md), and [operations](docs/OPERATIONS.md).

## Contributing and release governance

Human contributors and development Agents should start with [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). Public and internal integration boundaries are mapped in [`docs/INTERFACE_CONTRACTS.md`](docs/INTERFACE_CONTRACTS.md).

Every version update is reviewed through a pull request by the project lead / designated release maintainer, currently `@TH060419`, before it is merged or released. Contributors and Agents must not publish npm packages, create or move release tags, create GitHub Releases, deploy servers, or delete another contributor's branch without explicit project-lead authorization. `CODEOWNERS` requests this review; repository administrators must also enable the documented `main` branch-protection settings to enforce it on GitHub.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Yuhan He and contributors.

#
