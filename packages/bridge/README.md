# Local bridge

`LocalBridge` registers one session-scoped local runtime, keeps independent server and transcript cursors, imports authorized Codex or Claude Code transcripts, hydrates canonical history, and claims/completes agent requests.

`HttpCollaborationClient.baseUrl` is the complete API root, for example `https://host.example/v1`. The client matches the server's snake_case v1 wire format. It expects these routes:

- `GET /sessions`
- `GET|POST /sessions/:sessionId/events`
- `POST /runtimes`
- `POST /sessions/:sessionId/agent-requests/:requestId/claim`
- `POST /sessions/:sessionId/agent-requests/:requestId/complete`

`GET /sessions` is expected to apply server-side ACL filtering and return summaries with `id`, `title`, `mode`, `state`, `role`, `current_sequence`, and `updated_at`. The bridge treats `current_sequence` as the latest durable cursor.

Transcript roots have no implicit defaults and are configured separately for `codex` and `claude-code`. Imports are redacted before append. A transcript cursor advances only after every event has been accepted; stable idempotency keys make retries safe. The file cursor store writes atomically with mode `0600`.

Context snapshots require an explicit fidelity. Reconstructed canonical history is labelled `canonical_history`; parsed local logs are labelled `harness_transcript`. The snapshot fidelity must match the server-registered runtime fidelity, so the server-derived provenance cannot contradict the payload. `provider_request` is disabled by default and requires both service authorization and a caller assertion that an authorized hook or proxy observed the exact request. The bridge cannot independently verify a dishonest caller assertion.

Agent completion follows the server's single-response contract: tool events are appended idempotently, then the claimed request is completed as one canonical `agent_response`. The alpha does not yet implement claim abandonment or lease expiry. If a bridge crashes after claiming, that request remains stuck and the session owner must submit a replacement request.

## Local worker executable

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

The adapter is a real executable boundary, not a built-in Codex or Claude Code invocation. For each claim it receives one `HarnessExecutionInput` JSON object followed by a newline on stdin. It must write one `HarnessExecutionResult` JSON object to stdout and exit successfully. stdout must contain only that object. A minimal result is:

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

The executable does not invent a harness command. Deployments must explicitly configure an adapter that knows how to call their authorized local harness and translate its observed transcript into this contract.
