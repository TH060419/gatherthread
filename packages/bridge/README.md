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

Agent completion follows the server's single-response contract: tool events are appended idempotently, then the claimed request is completed as one canonical `agent_response`. A failed claim expires or is resolved according to server policy; this package does not currently expose claim abandonment.
