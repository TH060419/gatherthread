# Local bridge

`LocalBridge` registers one session-scoped local runtime, keeps independent server and transcript cursors, imports authorized Codex or Claude Code transcripts, projects canonical history, and claims/completes eligible agent requests.

For Codex, prefer the built-in connector. Copy the operating-system-specific command from the project's **Connect Codex** dialog. It binds one GatherThread project to a safe same-name local workspace and discovers eligible sessions automatically. Each writable session has a Desktop-owned task plus a separate `exec`-source background projection.

```bash
npm run codex:connect -- \
  --url https://your-host.your-tailnet.ts.net \
  --project PROJECT_ID \
  --create-workspace \
  --model gpt-5.6-sol \
  --install-hooks
```

`--create-workspace` creates or exactly reuses `~/GatherThread Projects/<safe project name>` using a private credential-free binding marker, then opens that verified directory in Codex Desktop once. A failed or timed-out Desktop reveal is non-fatal and prints the directory for manual opening. Use `--workspace "/absolute/path"` instead when deliberately binding an existing source checkout. The token is always requested through hidden terminal input and is never copied from the Web page.

Canonical events are appended to the background projection with `thread/inject_items` in sequence order. Human chat renders as `actor_display_name · Human Chat：…`; Agent requests and responses retain explicit type labels, and only responses carry canonical harness/model provenance. Oversized events are split into bounded UTF-8 chunks and compacted locally. The Desktop projection receives the canonical delta through `UserPromptSubmit` rather than a second App Server writer. See the [full connector guide](../../docs/CODEX_CONNECT.md).

Project owners attach every active session. Participants attach only `multi` sessions because `solo` is read-only to them. Viewers cannot execute agents, but visible sessions remain eligible for snapshot-only workers. The session list is refreshed every five seconds, each live session remains in its own Codex thread, and turns sharing one local workspace execute serially.

Project discovery and scheduling depend on `ProjectHarnessAdapter`, not Codex process details. A Claude Code or DeepSeek Harness implementation supplies its descriptor, preflight, local-session identity, and per-session `HarnessExecutor` while reusing the same project/session loop. Codex-specific projection, compaction, local-turn outbox, reconciliation rebuild, snapshot, and hook capabilities remain on the Codex adapter.

The Codex implementation uses App Server stdio JSON-RPC, creates desktop-interactive threads named `GatherThread · <project> · <session>`, and fails closed on unexpected approval requests or ambiguous completed turns. Completed turns reported by the trusted project hooks have stable IDs derived from the App Server thread/turn IDs. They are persisted to an idempotent local outbox before `POST /sessions/:id/local-turns`. A non-divergent acknowledgement binds the returned canonical IDs without re-execution or duplicate injection. When the server reports reconciliation, a new thread is rebuilt and compacted completely off to the side; only after its sequence is verified does the state file atomically switch. The old thread is renamed `offline fork` and archived best-effort, never deleted.

Projection state version 3 records `cloudCursor`, `projectionGeneration`, model/context-window source and token estimate, `compactionGeneration`, `coveredThroughSequence`, `lastInjectedSequence`, the metadata sidecar, connector client/turn IDs, local-turn bindings, pending outbox entries, hook drafts, crash-recovery journals, and any in-progress rebuild checkpoint. The state and hook files are atomic/private (`0600`).

`HttpCollaborationClient.baseUrl` is the complete API root, for example `https://host.example/v1`. The client matches the server's snake_case v1 wire format. It expects these routes:

- `GET /sessions`
- `GET|POST /sessions/:sessionId/events`
- `POST /runtimes`
- `POST /runtimes/:runtimeId/heartbeat`
- `POST /sessions/:sessionId/agent-requests/:requestId/claim`
- `POST /sessions/:sessionId/agent-requests/:requestId/complete`
- `POST /sessions/:sessionId/local-turns`
- `GET /snapshot-requests/:requestId`
- `GET /snapshot-requests?status=...&limit=...`
- `POST /snapshot-requests/:requestId/claim`
- `POST /snapshot-requests/:requestId/complete`
- `POST /snapshot-requests/:requestId/fail`

`GET /sessions` is expected to apply server-side ACL filtering and return summaries with `id`, `title`, `mode`, `state`, `role`, `current_sequence`, and `updated_at`. The bridge treats `current_sequence` as the latest durable cursor.

Transcript roots have no implicit defaults and are configured separately for `codex` and `claude-code`. Imports are redacted before append. A transcript cursor advances only after every event has been accepted; stable idempotency keys make retries safe. The file cursor store writes atomically with mode `0600`.

Context snapshots require an explicit fidelity. Reconstructed canonical history is labelled `canonical_history`; parsed local logs are labelled `harness_transcript`. The snapshot fidelity must match the server-registered runtime fidelity, so the server-derived provenance cannot contradict the payload. `provider_request` is disabled by default and requires both service authorization and a caller assertion that an authorized hook or proxy observed the exact request. The bridge cannot independently verify a dishonest caller assertion.

Agent completion follows the server's single-response contract: tool events are appended idempotently, then the claimed request is completed as one canonical `agent_response`. The alpha does not yet implement claim abandonment or lease expiry. If a bridge crashes after claiming, that request remains stuck and the session owner must submit a replacement request.

## Codex project hooks

Pass `--install-hooks` to merge the GatherThread `UserPromptSubmit` and `Stop` command hooks into `<workspace>/.codex/hooks.json`. These reviewed and trusted hooks are required for publishing turns typed directly in Codex desktop; without them, Web-triggered execution, canonical projection, and read-only snapshots still work while direct desktop turns remain local. Installation is explicit because Codex requires a project trust review; inspect and approve the exact definition with `/hooks`. The hook command contains only private local socket/spool/registry paths, never the GatherThread token.

With `--install-hooks`, the running connector owns a private Unix socket relay on POSIX or a stable project-mapping named pipe on Windows. `UserPromptSubmit` records an outbox draft and supplies a bounded canonical delta. `Stop` supplies the final response, which is made publishable without opening the Desktop-owned task. Current public Stop payloads omit structured tools, so Desktop-originated tool events are omitted. Offline allowlisted events use a bounded private spool.

After a successful authoritative ACL refresh, any session that became read-only, archived, or inaccessible is removed from the managed execution map and hook registry, and its unpublished draft/outbox state is made permanently local-only. The native transcript is retained. Restoring write access does not retroactively upload work from that interval. Transient refresh failures preserve existing authorized bindings, and normal connector shutdown preserves the allowlist for offline capture; an explicit project `403`/`404` clears all execution bindings and stale spool entries.

Desktop and Web turns may run independently because they use separate native writers. The server's canonical sequence orders the accepted results. See [ADR-0013](../../docs/adr/0013-single-writer-dual-codex-projections.md).

Snapshot jobs use an exact-session runtime with `purpose: "snapshot_connector"`, a fresh independent thread, and canonical history frozen through `through_sequence`. The completion result includes `thread_id`, `thread_name`, sequence/model/projection metadata, and `immutable: true`. Snapshot runtimes never claim agent requests or publish local turns, and completed snapshot threads are never polled again.

## Generic local worker executable

Build the workspace and run `gatherthread-bridge` (or `npm --workspace packages/bridge start`). The executable accepts no command-line configuration. GatherThread credentials are read only from `GATHERTHREAD_TOKEN`, are removed from the adapter child process environment, and are never printed or passed as process arguments.

Required environment:

- `GATHERTHREAD_API_URL`: complete GatherThread API root, such as `https://gatherthread.example/v1`; plain HTTP is accepted only for a loopback host
- `GATHERTHREAD_TOKEN`: bearer token
- `GATHERTHREAD_SESSION_ID`, `GATHERTHREAD_DEVICE_ID`, `GATHERTHREAD_LOCAL_SESSION_ID`: session-scoped runtime identity
- `GATHERTHREAD_HARNESS`: `codex` or `claude-code`
- `GATHERTHREAD_PROVIDER`, `GATHERTHREAD_MODEL`: runtime provenance
- `GATHERTHREAD_ADAPTER_COMMAND`: an explicit executable path or command name implementing the adapter contract below

Optional environment:

- `GATHERTHREAD_ADAPTER_ARGS_JSON`: JSON string array of adapter arguments; the GatherThread token is rejected if embedded here
- `GATHERTHREAD_CURSOR_PATH`: durable cursor file; defaults to `~/.gatherthread/bridge-cursor.json`
- `GATHERTHREAD_CAPABILITIES_JSON`: JSON string array registered with the runtime
- `GATHERTHREAD_POLL_INTERVAL_MS`, `GATHERTHREAD_POLL_LIMIT`
- `GATHERTHREAD_REQUEST_TIMEOUT_MS`, `GATHERTHREAD_ADAPTER_TIMEOUT_MS`, `GATHERTHREAD_ADAPTER_MAX_OUTPUT_BYTES`

The worker registers exactly one runtime for one GatherThread session, reads canonical events after the persisted server cursor, claims each `agent_request`, supplies canonical history through that request to the configured adapter, validates and redacts the adapter result, then completes the claim. The cursor advances only after the corresponding event has been handled. `SIGINT` and `SIGTERM` abort in-flight HTTP and adapter work and close the polling loop.

This generic worker retains an external executable boundary for custom adapters and Claude Code integrations. For each claim the adapter receives one `HarnessExecutionInput` JSON object followed by a newline on stdin. It must write one `HarnessExecutionResult` JSON object to stdout and exit successfully. stdout must contain only that object. A minimal result is:

```json
{
  "localSessionId": "local-harness-session",
  "events": [
    {
      "kind": "assistant",
      "localEventId": "stable-local-event-id",
      "harness": "codex",
      "captureFidelity": "harness_transcript",
      "content": "answer"
    }
  ]
}
```

The generic worker does not invent a harness command. Deployments using it must explicitly configure an adapter that knows how to call their authorized local harness and translate its observed transcript into this contract. Codex users do not need this adapter command; `gatherthread-codex` provides the built-in implementation.
