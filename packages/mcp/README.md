# Collaboration MCP service

This package exposes stateless MCP JSON-RPC tools and resources over an injected authenticated collaboration API client.

Tools:

- `collaboration_list_projects`
- `collaboration_list_project_sessions`
- `collaboration_list_sessions`
- `collaboration_read_history`
- `collaboration_append_chat`
- `collaboration_request_agent`
- `collaboration_register_runtime`
- `collaboration_claim_agent_request`
- `collaboration_complete_agent_request`
- `collaboration_upload_context_snapshot`

Resources include `collaboration://projects`, one session-list resource per visible project, `collaboration://sessions`, and one incremental history URI per visible session. Project tools preserve grouping and roles; canonical history remains session-scoped and accepts `after_sequence` and `limit` query parameters.

`createMcpHttpHandler` implements stateless JSON-RPC POST handling, batches, notifications, content-type validation, and explicit Origin allowlisting. An HTTP request with an Origin is rejected unless that origin was configured. Authentication and actor identity remain server-derived through the injected API client; MCP inputs cannot supply an actor username.

Snapshot uploads and visible text are redacted before transport. A `harness_transcript` upload replaces its native local-session identifier with a SHA-256 fingerprint before append. Exact `provider_request` capture is disabled by default and requires explicit service authorization, `exact_provider_request=true`, an observed-by value of `harness_hook` or `authorized_proxy`, and a runtime ID. Reconstructed content must use `canonical_history` or `harness_transcript`.

The handler is intentionally stateless and POST-only. It does not implement server-initiated SSE streams; durable incremental history is read through tools/resources and live delivery remains the collaboration server's WebSocket responsibility.

## Local stdio executable

Build the workspace and configure an MCP host to launch `gatherthread-mcp` (or `npm --workspace packages/mcp start`) with `GATHERTHREAD_API_URL` and `GATHERTHREAD_TOKEN` in its environment. The executable accepts no credential arguments and writes no logs to stdout; stdout is reserved for newline-delimited MCP JSON-RPC responses. `GATHERTHREAD_API_URL` must be HTTPS except for a loopback host and cannot contain URL credentials.

Optional environment:

- `GATHERTHREAD_REQUEST_TIMEOUT_MS`: upstream HTTP timeout
- `GATHERTHREAD_MCP_MAX_MESSAGE_BYTES`: maximum stdio JSON-RPC line size
- `GATHERTHREAD_ALLOW_PROVIDER_REQUEST_CAPTURE`: `true` only when an authorized hook/proxy provides exact provider requests

Each stdio line is one JSON-RPC request or batch. Notifications produce no response. `SIGINT` and `SIGTERM` stop input processing and abort in-flight GatherThread HTTP calls. Authentication and identity still come from the GatherThread bearer token and server-side authorization; tool arguments cannot override them.
