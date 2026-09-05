# Connect a local Codex runtime

The built-in connector binds one GatherThread project to one local agent project directory. It automatically discovers visible sessions. A new live-writable session initially receives a Desktop-owned task named `<session> · GatherThread` and a separate `exec`-source background projection named `<session> · GatherThread background`. These are initial labels only: cloud and local titles remain independently editable and are never used as binding identity. The Desktop task accepts local interactive turns through trusted hooks; the background projection imports canonical history and runs Web **Request my agent** turns. The canonical server log joins both directions without two processes writing one native task.

Project roles determine the connector mode:

| Project role | `multi` session | `solo` session |
|---|---|---|
| `owner` | live bidirectional synchronization | live only for Solos created by this user; other Solos are read-only snapshots |
| `participant` | live bidirectional synchronization | live only for Solos created by this user; other Solos are read-only snapshots |
| `viewer` | read-only **Download to Codex** snapshot | read-only **Download to Codex** snapshot |

The connector may therefore run for a viewer, but it registers only isolated `snapshot_connector` runtimes and never an execution runtime.

## Prerequisites

- Node.js 24 or newer.
- An authenticated Codex installation. The connector checks PATH and, on macOS, the CLI bundled with the ChatGPT/Codex desktop app.
- Network access to the owner host, normally through the accepted Tailscale machine share.
- Your own GatherThread device access token. Do not use another collaborator's token.
- Permission to create `~/GatherThread Projects/`, or an existing local source directory that Codex may access.

## Start the connector

In the GatherThread Web UI, select the project and open **Connect Codex**. Copy the fixed-version command for the local operating system and run it in a terminal. No GatherThread checkout or local dependency installation is required:

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 --url 'https://your-host.your-tailnet.ts.net/v1' --project 'PROJECT_ID' --create-workspace
```

The copied command contains no browser cookie, invitation secret, or device token. On PowerShell it uses `npx.cmd` with the same quoted data. The connector requests the GatherThread device token through a hidden terminal prompt, validates current access to the selected project, and creates or exactly reuses `~/GatherThread Projects/<safe project name>`. A private credential-free marker prevents that directory from being reused for a different server or project. It then materializes every live-writable session sequentially and resumes per-session state after a partial failure. The token stays only in the connector process and is removed from the Codex child environment.

With `--create-workspace`, the connector creates or reuses a same-name local Desktop project directory and opens the verified directory before synchronization begins. It creates Desktop tasks without synthetic Agent turns and keeps Web execution in private background tasks that are never deep-linked. Codex exposes no public project-assignment receipt, so the connector does not edit Desktop private state. The generated directory initially contains connector state but no source checkout. To bind an existing source directory instead, use the advanced form and omit `--create-workspace`:

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --project PROJECT_ID \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol
```

## Unified Codex plugin and the two real modes

The repo-local, publishable **共序 / GatherThread** plugin adds user MCP tools to list projects and sessions, read history, send a reviewed message or Agent request, and inspect sanitized connector presence. The ordinary Beta path does not put `GATHERTHREAD_TOKEN` into its MCP configuration. Finder-launched Desktop may not inherit terminal variables, and the connector intentionally strips GatherThread credentials from Codex children. Instead, the plugin's fixed-version stdio MCP process talks to running connectors through private Unix sockets or Windows named pipes. Each connector publishes a leased, non-secret local registration containing only its instance, endpoint, and project route; a separate random per-run capability authorizes calls. The MCP client collapses overlapping crash/restart registrations for one endpoint to the newest lease, aggregates every distinct active connector, and routes by unique project/session ID. Duplicate IDs across distinct endpoints are ambiguous and fail closed rather than selecting a first or newest connector. Expired registrations are ignored and their lease records are removed during discovery; the possibly reused endpoint and capability are left untouched.

- **Basic mode:** keep the fixed-version connector running and install/review the plugin. The MCP tools and Web **Request my agent** work; direct Desktop turns remain local.
- **Full mode:** start the same connector with `--plugin-hooks`, then enable Codex Hooks and review the plugin's `UserPromptSubmit` and `Stop` definitions before trusting them. The plugin's built-in, dependency-free script forwards Hook JSON directly to the running connector and never runs `npx` per turn. A Hook `cwd` may be the workspace root or a descendant; the forwarder walks to the connector's authoritative root registry and the relay rejects paths outside it. The connector must remain online: plugin Hooks fail open and do not create an offline spool. Hooks cannot wake idle Codex or start a new turn.

After the `v0.1.0-beta.1` release ref exists, add its fixed repository plugin source and install the plugin without cloning the full repository:

```bash
codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-beta.1 --sparse .agents/plugins --sparse plugins/gatherthread
codex plugin add gatherthread@gatherthread
```

The repeated sparse paths fetch the repository plugin source and bundle at one fixed release ref; the second command installs **共序 / GatherThread** from that configured source. Restart Codex Desktop, then review its MCP server and Hooks before enabling them. The browser only shows and copies these commands; it cannot run them or modify global Codex configuration.

`--install-hooks` remains a compatibility path for users who explicitly prefer a generated `<workspace>/.codex/hooks.json`. It merges the same events without replacing other arrays. Never combine it with `--plugin-hooks`. Neither option is implicit, neither edits `~/.codex/config.toml`, and neither installs a plugin globally.

If that generated project Hook file remains after switching to `--plugin-hooks`, the connector does not delete it. The private registry authorizes exactly one Hook source at runtime, and the relay validates the same source envelope. Stale project Hook invocations therefore return no context and cannot enter the compatibility spool while plugin mode is active. Only project Hook mode drains that spool.

Until a public Codex plugin directory entry exists, installing the repository plugin is an explicit local review step. Safari, Chrome, and Edge only copy the connector command; browser security intentionally prevents the Web page from launching or controlling local Codex. The `@gatherthread` npm organization and package-name ownership must also be confirmed before publication.

The internal `collaboration_register_runtime`, claim/complete, and snapshot-upload tools use a separate runtime profile and are never listed by the user plugin. Direct `server-env` MCP transport exists only for developer preview. Future remote Streamable HTTP MCP requires a real account system plus OAuth 2.1/PKCE; it is not implemented or simulated with a long-lived token. Even then MCP complements rather than replaces the online connector's request claiming, per-session projections, reliable outbox, reconnect loop, and App Server lifecycle.

`--model` selects the isolated background model used for Web-triggered Agent requests; it does not lock the model selected inside a Desktop task. Trusted Hooks freeze the actual Desktop-reported model on each uploaded local turn, so changing models between turns is supported. Codex 0.148 does not include reasoning effort in the observed Hook payload; GatherThread records that optional per-turn field when a Hook provides it and otherwise leaves it unset rather than guessing.

Keep the terminal open. The Web member panel refreshes runtime presence every five seconds. When it shows `codex · openai · <model>` as online, enter a message and select **Request my agent**.

## Synchronization behavior

- Canonical events are projected in server sequence order into the background execution task. The first synchronization imports all visible history; later synchronizations inject only the canonical delta.
- Each visible message is prefixed with its frozen `actor_display_name` and explicit canonical type: `Human Chat`, `Agent Request`, `Agent Response`, or the specific tool/other event type. Only `Agent Response` adds harness and model from that canonical event's runtime; missing runtime uses the explicit `GatherThread · shared` placeholders and never borrows the local connector runtime. Structured attribution stays in private connector state.
- Human chat and other collaborators' agent responses become context but do not trigger Codex. Human chat can be authored only in GatherThread.
- Only an unbound `agent_request` authored by the same authenticated user is eligible for that user's execution runtime.
- With reviewed project hooks installed and trusted, `UserPromptSubmit` supplies a canonical relay capsule under the Hook's 2,500-token additional-context ceiling and records the exact prompt. The Agent is asked to display only `Loaded N cloud updates / 已加载 N 条云端更新` plus at most three short previews; exact ordered bodies are marked as untrusted model-only context. Oversized UTF-8 content is checkpointed and resumed over later completed Desktop turns. The separate delivery cursor advances only after `Stop`; cancellation repeats the same capsule, and an omitted chunk is never silently acknowledged. `Stop` durably queues the final assistant text for one atomic local-turn commit. Current public Hook payloads omit the completed structured tool stream, so Desktop-originated tool events are not uploaded.
- In an unbound Desktop task, that first `UserPromptSubmit` is also the discovery trigger. An owner or participant creates one deterministic creator-owned Solo, adopts the current native task without opening a competing writer, and uploads the same completed turn through the normal outbox. Opening an empty task creates nothing. A viewer's unbound task remains local-only. Background execution and snapshot tasks carry explicit non-discoverable purposes, so they cannot recursively create Solos.
- Output already produced by the same Codex thread is bound to the returned canonical event IDs rather than injected or executed again.
- Local completed turns are persisted to a private idempotent outbox before upload. A disconnected connector retries that outbox after network recovery.
- If the server has not advanced beyond the local turn's base sequence, acknowledgement only advances the binding and cursor. If it has advanced, the server appends the local turn after its authoritative head and asks the connector to reconcile.
- Background reconciliation builds a new execution projection off to the side from the complete canonical sequence, compacts as needed, verifies coverage, and only then switches that private binding. The Desktop-owned task is never renamed, archived, or replaced by the connector.
- Conversation reconciliation changes Codex thread state only. It never resets, checks out, or overwrites local project source files.
- Codex compaction remains local. The connector uses App Server token-usage and model-context-window updates when available, with a conservative configured estimate as fallback. GatherThread keeps the full canonical event log and does not share native compaction state.
- New cloud sessions are discovered by the same project connector. Owners and participants attach execution runtimes to `multi` plus personal Solos they created; another member's Solo remains snapshot-only. Viewers remain snapshot-only everywhere.
- An authoritative role downgrade, conversion to read-only, archive, or project removal immediately removes the affected native thread from the execution hook allowlist and clears unpublished hook drafts/outbox state. The native Codex transcript is preserved, but work performed during the read-only interval remains local-only and is not uploaded if write access is later restored. With the `--install-hooks` compatibility path, a transient network failure does not trigger this cleanup, so already-authorized offline capture can resume after connectivity returns. Plugin Hooks require the connector process to remain online and do not provide offline capture.
- Sibling sessions use separate Codex threads and never hydrate one another's history.
- Agent turns are serialized across sessions sharing the same workspace to avoid conflicting concurrent edits.
- App Server access is local stdio and short-lived. Background execution and snapshots use operation-scoped children. The implementation task is distinctly named `<session> · GatherThread background`; do not use it for direct work if Codex Desktop lists it. If Desktop externally claims a completed background projection, GatherThread creates a new one, replays authoritative canonical history, and continues the next Web request. Prepared or started operations remain fail-closed rather than risking duplicate execution. After Desktop task creation, direct Desktop synchronization uses only the trusted local Hook relay and never opens that task through a competing App Server writer.
- The connector explicitly selects legacy rollout history while paginated history lacks the required full-history read, resume, injection, and compaction lifecycle. A new Desktop task is written to local binding state and the Hook allowlist only after its creating App Server exits and a fresh App Server can still read the persisted rollout; an unpersisted candidate is never exposed as a usable task.
- Existing bindings are resolved by project ID, GatherThread session ID, verified workspace, and persisted native thread ID. The connector checks every managed binding before considering first-prompt Solo discovery. A title change on either side therefore cannot create a new cloud Solo or a second native task.
- Web Agent execution is headless. If an MCP server requests an interactive form or URL elicitation, GatherThread returns the protocol-level `decline` response without opening the URL, supplying form content, or interrupting the whole Codex turn. Command, file-change, permission, and unknown server-initiated interactions remain fail-closed.
- A legacy `codex exec` mapping migrates on its next request to a new desktop-visible thread rebuilt from canonical history; the old native transcript is not deleted.

## Codex desktop boundary

Codex Desktop is the sole writer of each visible task. Web requests do not resume it; they use the background execution projection and publish their results to the canonical Web transcript. At the next Desktop prompt, the Hook supplies the next acknowledged capsule after that task's independent delivery cursor. A long backlog drains in canonical order over completed turns, while the visible answer remains a concise preview. The background projection still carries and locally compacts the complete canonical sequence. This preserves bounded Desktop context and server ordering, but public Codex APIs cannot insert remote events as historical bubbles into a task already owned by Desktop.

Connector state created before acknowledged capsules has no trustworthy proof that earlier fixed-size truncation delivered every event. On first load after this upgrade, the Desktop delivery cursor therefore starts at zero and safely replays canonical history in bounded capsules. Replayed items are context only and are never executed as new Agent requests.

Only managed execution threads with explicitly trusted plugin or project hooks are bidirectional for direct desktop input. The private `0600` thread registry allowlists their native thread IDs before relay; unrelated Codex tasks and immutable snapshot threads are dropped locally. The compatibility project Hook can also use its bounded offline spool, while the plugin Hook only forwards to a running connector. `--plugin-hooks` or `--install-hooks` starts a private Unix socket on POSIX or a project-mapping named pipe on Windows; without either option the connector listens on no Hook IPC endpoint. User MCP write calls use a separate per-run capability rather than relying on a guessable endpoint. The IPC endpoints, capability, registry, and compatibility spool never contain the GatherThread bearer token. A managed prompt may still contain sensitive content, so use a different, unmanaged Codex task for work that must remain private.

Web execution and a Desktop turn may run independently because they no longer share a native writer. Their accepted outputs are serialized by the server's canonical sequence. Stable retry messages are coalesced, so a persistent failure prints immediately, at most once per minute afterward, and once on recovery.

## Download a read-only session

When the current role cannot write a session, the Web UI shows **Download to Codex** instead of the composer. Each click creates a new server job frozen at that request's `through_sequence`. The local connector imports exactly that history into a fresh thread named `GatherThread snapshot · <project> · <session> · through <sequence>`.

Every download is independent and immutable: it never follows later cloud events, never claims an Agent request, and never publishes a desktop turn. Clicking again creates another snapshot rather than converting or updating the earlier one. A connector must remain running to claim the requesting user's snapshot job, including when the user is a viewer.

## Safer modes

Use a read-only Codex sandbox:

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --sandbox read-only
```

Share only the final answer, not structured tool calls or bounded tool results:

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --no-share-tool-events
```

The default is `workspace-write`. Automatic privilege escalation is always disabled; the connector does not support `danger-full-access`.

## Reset the local Codex thread

If you intentionally want new local Codex contexts for every session in the project binding, stop the connector and restart with:

```bash
npx --yes @gatherthread/codex-connect@0.1.0-beta.1 \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --project PROJECT_ID \
  --reset-codex-session
```

This deletes only the private local thread, cursor, outbox, and hook mapping files for that project binding. Review any pending outbox work before using it. It does not delete canonical GatherThread history or native Codex transcripts. Each live-writable session is rebuilt from its complete visible server history; future snapshot clicks still create independent threads.

## Stop and reconnect

Press `Control-C` to stop. Session runtimes become offline after their heartbeat expires, normally within 30 seconds. Restart the same command to reuse every session's local Codex thread and durable GatherThread cursor. One connector process manages the whole project.

Normal connector shutdown preserves the current execution allowlist for the explicit `--install-hooks` compatibility path, whose bundled project forwarder can capture a bounded offline turn. The preferred plugin forwarder has no offline spool and therefore requires the connector to remain running. Permission cleanup happens only after a successful authoritative ACL refresh, or after the server explicitly returns project access `403`/`404`.

## Troubleshooting

- `Codex CLI could not be started`: install Codex or pass `--codex-command /absolute/path/to/codex`.
- `Codex App Server could not be started`: update the local Codex/ChatGPT desktop installation; the connector requires `codex app-server --stdio`.
- `codex login status` fails: authenticate locally before connecting.
- `No active GatherThread projects are available for this user`: accept a project invitation or ask the owner to restore access. A viewer project is valid and runs in snapshot-only mode.
- Runtime remains offline: keep the connector terminal running, verify the Tailscale connection and HTTPS URL, then reload or wait up to five seconds for presence refresh.
- `Codex session state belongs to a different workspace/session`: use the matching command or explicitly reset the mapping.
- Import approaches the context limit: keep the connector running so it can compact and continue. If App Server does not report the model window, review the conservative fallback before raising it. The server history is not deleted.
- A managed task is not visible in Desktop: keep the connector running, reopen the generated workspace, and verify the task name shown in the connector output. Web Agent turns intentionally stay in the background projection and will not create Desktop history bubbles.
- A read-only snapshot task is missing: click **Download to Codex** and keep the snapshot connector running until the frozen job completes.
- A completed Desktop turn is still local: confirm the connector used `--plugin-hooks`, remained online for the whole turn, and the plugin Hooks were reviewed and trusted. Only the explicit `--install-hooks` compatibility file can spool an allowlisted Hook while the connector is stopped and drain it after restart. Turns missed by plugin Hooks, or completed before any trusted Hook was active, are never inferred or uploaded later.
- `already has an active writer`: update to the dual-projection connector. Current builds never open a Desktop-owned task from the background App Server; one stable retry is logged immediately and then at most once per minute.
- A process crash after claiming a request can leave that alpha request stuck. Submit a replacement request; automated claim lease recovery is not implemented yet.

## Security boundary

Shared history is untrusted collaboration data. The connector separates the server-verified local request from prior context, keeps the Codex sandbox active, disables automatic escalation, strips GatherThread credentials from the child environment, bounds output and hook input, removes raw reasoning/private prompts, and applies the common redactor before upload. Private state files and the compatibility project's offline Hook spool can still contain local conversation content, so protect the local user account and disk. These controls reduce but do not eliminate prompt-injection risk; review collaborators and use `read-only` for untrusted projects.

The server charges a conservative 1 KiB metadata allowance for every snapshot job, bounds one stored result to 8 KiB of UTF-8 JSON, and enforces cumulative job quotas of 4 MiB per user, 8 MiB per session, and 64 MiB per deployment by default. It also caps unfinished jobs at 64 per user, 256 per session, and 4096 per deployment. Snapshot results contain projection metadata rather than the imported canonical transcript.

[ADR-0013](adr/0013-single-writer-dual-codex-projections.md) records the dual-projection boundary, [ADR-0014](adr/0014-acknowledged-bounded-desktop-relay-capsules.md) records acknowledged relay delivery, and [ADR-0015](adr/0015-create-personal-solos-from-first-local-prompt.md) records first-prompt personal Solo creation. See the [official OpenAI Codex App Server documentation](https://developers.openai.com/codex/app-server) for the upstream protocol.
