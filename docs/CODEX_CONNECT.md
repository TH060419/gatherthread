# Connect a local Codex runtime

The built-in connector binds one GatherThread project to one local agent project directory. It automatically discovers visible sessions. Each live-writable session has a Desktop-owned task named `GatherThread · <project> · <session>` and a separate `exec`-source background projection. The Desktop task accepts local interactive turns through trusted hooks; the background projection imports canonical history and runs Web **Request my agent** turns. The canonical server log joins both directions without two processes writing one native task.

Project roles determine the connector mode:

| Project role | `multi` session | `solo` session |
|---|---|---|
| `owner` | live bidirectional synchronization | live bidirectional synchronization |
| `participant` | live bidirectional synchronization | read-only **Download to Codex** snapshot |
| `viewer` | read-only **Download to Codex** snapshot | read-only **Download to Codex** snapshot |

The connector may therefore run for a viewer, but it registers only isolated `snapshot_connector` runtimes and never an execution runtime.

## Prerequisites

- A local checkout of GatherThread with dependencies installed.
- Node.js 24 or newer.
- An authenticated Codex installation. The connector checks PATH and, on macOS, the CLI bundled with the ChatGPT/Codex desktop app.
- Network access to the owner host, normally through the accepted Tailscale machine share.
- Your own GatherThread device access token. Do not use another collaborator's token.
- Permission to create `~/GatherThread Projects/`, or an existing local source directory that Codex may access.

## Start the connector

In the GatherThread Web UI, select the project and open **Connect Codex**. Copy the command for the local operating system, then run it from the GatherThread checkout. The generated command resembles:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --project PROJECT_ID \
  --create-workspace \
  --model gpt-5.6-sol \
  --install-hooks
```

The copied command contains no browser cookie, invitation secret, or device token. The connector requests the GatherThread device token through a hidden terminal prompt, validates current access to the selected project, and creates or exactly reuses `~/GatherThread Projects/<safe project name>`. A private credential-free marker prevents that directory from being reused for a different server or project. It then materializes every live-writable session sequentially and resumes per-session state after a partial failure. The token stays only in the connector process and is removed from the Codex child environment.

With `--create-workspace`, the connector creates or reuses a same-name local Desktop project directory and opens the verified directory before synchronization begins. It creates Desktop tasks without synthetic Agent turns and keeps Web execution in private background tasks that are never deep-linked. Codex exposes no public project-assignment receipt, so the connector does not edit Desktop private state. The generated directory initially contains connector state but no source checkout. To bind an existing source directory instead, use the advanced form and omit `--create-workspace`:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --project PROJECT_ID \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --install-hooks
```

`--install-hooks` is required only when prompts typed directly in Codex Desktop must be published to GatherThread. It merges GatherThread's `UserPromptSubmit` and `Stop` hooks into `<workspace>/.codex/hooks.json`; it does not replace other hook arrays. Open Codex Desktop Settings, enable Hooks, and inspect the exact generated file before trusting it. Installation is never implicit. Without enabled Hooks, Web-triggered Agent requests, canonical cloud projection, and read-only snapshots still work, but direct Desktop turns remain local.

`--model` selects the isolated background model used for Web-triggered Agent requests; it does not lock the model selected inside a Desktop task. Trusted Hooks freeze the actual Desktop-reported model on each uploaded local turn, so changing models between turns is supported. Codex 0.148 does not include reasoning effort in the observed Hook payload; GatherThread records that optional per-turn field when a Hook provides it and otherwise leaves it unset rather than guessing.

Keep the terminal open. The Web member panel refreshes runtime presence every five seconds. When it shows `codex · openai · <model>` as online, enter a message and select **Request my agent**.

## Synchronization behavior

- Canonical events are projected in server sequence order into the background execution task. The first synchronization imports all visible history; later synchronizations inject only the canonical delta.
- Each visible message is prefixed with its frozen `actor_display_name` and explicit canonical type: `Human Chat`, `Agent Request`, `Agent Response`, or the specific tool/other event type. Only `Agent Response` adds harness and model from that canonical event's runtime; missing runtime uses the explicit `GatherThread · shared` placeholders and never borrows the local connector runtime. Structured attribution stays in private connector state.
- Human chat and other collaborators' agent responses become context but do not trigger Codex. Human chat can be authored only in GatherThread.
- Only an unbound `agent_request` authored by the same authenticated user is eligible for that user's execution runtime.
- With reviewed project hooks installed and trusted, `UserPromptSubmit` supplies a canonical relay capsule under the Hook's 2,500-token additional-context ceiling and records the exact prompt. The Agent is asked to display only `Loaded N cloud updates / 已加载 N 条云端更新` plus at most three short previews; exact ordered bodies are marked as untrusted model-only context. Oversized UTF-8 content is checkpointed and resumed over later completed Desktop turns. The separate delivery cursor advances only after `Stop`; cancellation repeats the same capsule, and an omitted chunk is never silently acknowledged. `Stop` durably queues the final assistant text for one atomic local-turn commit. Current public Hook payloads omit the completed structured tool stream, so Desktop-originated tool events are not uploaded.
- Output already produced by the same Codex thread is bound to the returned canonical event IDs rather than injected or executed again.
- Local completed turns are persisted to a private idempotent outbox before upload. A disconnected connector retries that outbox after network recovery.
- If the server has not advanced beyond the local turn's base sequence, acknowledgement only advances the binding and cursor. If it has advanced, the server appends the local turn after its authoritative head and asks the connector to reconcile.
- Background reconciliation builds a new execution projection off to the side from the complete canonical sequence, compacts as needed, verifies coverage, and only then switches that private binding. The Desktop-owned task is never renamed, archived, or replaced by the connector.
- Conversation reconciliation changes Codex thread state only. It never resets, checks out, or overwrites local project source files.
- Codex compaction remains local. The connector uses App Server token-usage and model-context-window updates when available, with a conservative configured estimate as fallback. GatherThread keeps the full canonical event log and does not share native compaction state.
- New sessions are discovered by the same project connector. Owners attach execution runtimes to all sessions; participants attach them only to `multi`; viewers remain snapshot-only.
- An authoritative role downgrade, conversion to read-only, archive, or project removal immediately removes the affected native thread from the execution hook allowlist and clears unpublished hook drafts/outbox state. The native Codex transcript is preserved, but work performed during the read-only interval remains local-only and is not uploaded if write access is later restored. A transient network failure does not trigger this cleanup, so already-authorized offline capture can resume after connectivity returns.
- Sibling sessions use separate Codex threads and never hydrate one another's history.
- Agent turns are serialized across sessions sharing the same workspace to avoid conflicting concurrent edits.
- App Server access is local stdio and short-lived. Background execution and snapshots use operation-scoped children. The implementation task is distinctly named `GatherThread background · <project> · <session>`; do not use it for direct work if Codex Desktop lists it. If Desktop externally claims a completed background projection, GatherThread creates a new one, replays authoritative canonical history, and continues the next Web request. Prepared or started operations remain fail-closed rather than risking duplicate execution. After Desktop task creation, direct Desktop synchronization uses only the trusted local Hook relay and never opens that task through a competing App Server writer.
- A legacy `codex exec` mapping migrates on its next request to a new desktop-visible thread rebuilt from canonical history; the old native transcript is not deleted.

## Codex desktop boundary

Codex Desktop is the sole writer of each visible task. Web requests do not resume it; they use the background execution projection and publish their results to the canonical Web transcript. At the next Desktop prompt, the Hook supplies the next acknowledged capsule after that task's independent delivery cursor. A long backlog drains in canonical order over completed turns, while the visible answer remains a concise preview. The background projection still carries and locally compacts the complete canonical sequence. This preserves bounded Desktop context and server ordering, but public Codex APIs cannot insert remote events as historical bubbles into a task already owned by Desktop.

Connector state created before acknowledged capsules has no trustworthy proof that earlier fixed-size truncation delivered every event. On first load after this upgrade, the Desktop delivery cursor therefore starts at zero and safely replays canonical history in bounded capsules. Replayed items are context only and are never executed as new Agent requests.

Only managed execution threads with trusted project hooks are bidirectional for direct desktop input. The private `0600` thread registry allowlists their native thread IDs before hook relay or offline spooling; unrelated Codex tasks and immutable snapshot threads are dropped locally. `--install-hooks` starts a private Unix socket on POSIX or a stable project-mapping named pipe on Windows; without it the connector listens on no hook IPC endpoint. The IPC endpoint, registry, and spool never contain the GatherThread bearer token. A managed prompt may still contain sensitive content, so use a different, unmanaged Codex task for work that must remain private.

Web execution and a Desktop turn may run independently because they no longer share a native writer. Their accepted outputs are serialized by the server's canonical sequence. Stable retry messages are coalesced, so a persistent failure prints immediately, at most once per minute afterward, and once on recovery.

## Download a read-only session

When the current role cannot write a session, the Web UI shows **Download to Codex** instead of the composer. Each click creates a new server job frozen at that request's `through_sequence`. The local connector imports exactly that history into a fresh thread named `GatherThread snapshot · <project> · <session> · through <sequence>`.

Every download is independent and immutable: it never follows later cloud events, never claims an Agent request, and never publishes a desktop turn. Clicking again creates another snapshot rather than converting or updating the earlier one. A connector must remain running to claim the requesting user's snapshot job, including when the user is a viewer.

## Safer modes

Use a read-only Codex sandbox:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --sandbox read-only
```

Share only the final answer, not structured tool calls or bounded tool results:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --no-share-tool-events
```

The default is `workspace-write`. Automatic privilege escalation is always disabled; the connector does not support `danger-full-access`.

## Reset the local Codex thread

If you intentionally want new local Codex contexts for every session in the project binding, stop the connector and restart with:

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --workspace "/absolute/path/to/your/project" \
  --model gpt-5.6-sol \
  --project PROJECT_ID \
  --reset-codex-session
```

This deletes only the private local thread, cursor, outbox, and hook mapping files for that project binding. Review any pending outbox work before using it. It does not delete canonical GatherThread history or native Codex transcripts. Each live-writable session is rebuilt from its complete visible server history; future snapshot clicks still create independent threads.

## Stop and reconnect

Press `Control-C` to stop. Session runtimes become offline after their heartbeat expires, normally within 30 seconds. Restart the same command to reuse every session's local Codex thread and durable GatherThread cursor. One connector process manages the whole project.

Normal connector shutdown deliberately preserves the current execution allowlist so an already-authorized managed thread can capture an offline turn. Permission cleanup happens only after a successful authoritative ACL refresh, or after the server explicitly returns project access `403`/`404`.

## Troubleshooting

- `Codex CLI could not be started`: install Codex or pass `--codex-command /absolute/path/to/codex`.
- `Codex App Server could not be started`: update the local Codex/ChatGPT desktop installation; the connector requires `codex app-server --stdio`.
- `codex login status` fails: authenticate locally before connecting.
- `No active GatherThread projects are available for this user`: accept a project invitation or ask the owner to restore access. A viewer project is valid and runs in snapshot-only mode.
- Runtime remains offline: keep the connector terminal running, verify the Tailscale connection and HTTPS URL, then reload or wait up to five seconds for presence refresh.
- `Codex session state belongs to a different workspace/session`: use the matching command or explicitly reset the mapping.
- Import approaches the context limit: keep the connector running so it can compact and continue. If App Server does not report the model window, review the conservative fallback before raising it. The server history is not deleted.
- A managed task is not visible in Desktop: keep the connector running with `--install-hooks`, reopen the generated workspace, and verify the task name shown in the connector output. Web Agent turns intentionally stay in the background projection and will not create Desktop history bubbles.
- A read-only snapshot task is missing: click **Download to Codex** and keep the snapshot connector running until the frozen job completes.
- A completed Desktop turn is still local: confirm the connector was started with `--install-hooks`, Hooks are enabled in Codex Desktop Settings, and the generated `.codex/hooks.json` was reviewed; then keep the connector running or restart it to drain the outbox. Turns completed before trusted Hooks were active are deliberately not inferred or uploaded later.
- `already has an active writer`: update to the dual-projection connector. Current builds never open a Desktop-owned task from the background App Server; one stable retry is logged immediately and then at most once per minute.
- A process crash after claiming a request can leave that alpha request stuck. Submit a replacement request; automated claim lease recovery is not implemented yet.

## Security boundary

Shared history is untrusted collaboration data. The connector separates the server-verified local request from prior context, keeps the Codex sandbox active, disables automatic escalation, strips GatherThread credentials from the child environment, bounds output and hook input, removes raw reasoning/private prompts, and applies the common redactor before upload. Private state files and offline hook spool entries can still contain local conversation content, so protect the local user account and disk. These controls reduce but do not eliminate prompt-injection risk; review collaborators and use `read-only` for untrusted projects.

The server charges a conservative 1 KiB metadata allowance for every snapshot job, bounds one stored result to 8 KiB of UTF-8 JSON, and enforces cumulative job quotas of 4 MiB per user, 8 MiB per session, and 64 MiB per deployment by default. It also caps unfinished jobs at 64 per user, 256 per session, and 4096 per deployment. Snapshot results contain projection metadata rather than the imported canonical transcript.

[ADR-0013](adr/0013-single-writer-dual-codex-projections.md) records the current Codex synchronization boundary. See the [official OpenAI Codex App Server documentation](https://developers.openai.com/codex/app-server) for the upstream protocol.
