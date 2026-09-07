# Collaboration MCP service

This package exposes MCP JSON-RPC tools and resources over an injected collaboration API client. Its profiles deliberately separate model-facing collaboration tools from connector runtime controls.

The default `user` profile lists projects and sessions, reads history, appends a reviewed chat or Agent request, and returns sanitized connector status. It never exposes runtime registration, request claim/complete, or snapshot upload. The `runtime` profile exposes only those four internal tools and must not be configured as a normal Codex model server.

User tools:

- `collaboration_list_projects`
- `collaboration_list_project_sessions`
- `collaboration_list_sessions`
- `collaboration_read_history`
- `collaboration_append_chat`
- `collaboration_request_agent`
- `collaboration_get_connection_status`

Internal runtime tools, unavailable in the user profile:

- `collaboration_register_runtime`
- `collaboration_claim_agent_request`
- `collaboration_complete_agent_request`
- `collaboration_upload_context_snapshot`

Resources include `collaboration://projects`, one session-list resource per visible project, `collaboration://sessions`, and one incremental history URI per visible session. Project tools preserve grouping and roles; canonical history remains session-scoped and accepts `after_sequence` and `limit` query parameters.

`createMcpHttpHandler` implements stateless JSON-RPC POST handling, batches, notifications, content-type validation, and explicit Origin allowlisting. An HTTP request with an Origin is rejected unless that origin was configured. Authentication and actor identity remain server-derived through the injected API client; MCP inputs cannot supply an actor username.

Snapshot uploads and visible text are redacted before transport. A `harness_transcript` upload replaces its native local-session identifier with a SHA-256 fingerprint before append. Exact `provider_request` capture is disabled by default and requires explicit service authorization, `exact_provider_request=true`, an observed-by value of `harness_hook` or `authorized_proxy`, and a runtime ID. Reconstructed content must use `canonical_history` or `harness_transcript`.

The handler is intentionally stateless and POST-only. It does not implement server-initiated SSE streams; durable incremental history is read through tools/resources and live delivery remains the collaboration server's WebSocket responsibility.

## Local stdio executable

The packaged Codex plugin launches fixed `@gatherthread/codex-connect@0.1.0-alpha.2 mcp`. Its default `connector` transport derives a private endpoint from the current workspace and reads a per-run capability from current-user-only connector state. The connector retains the server token; it is never passed to the MCP process. This is the ordinary Desktop path because Finder-launched applications do not reliably inherit terminal credential variables.

For repository development, build the workspace and launch `gatherthread-mcp` or `npm --workspace packages/mcp start` while the connector is running for the current directory. `GATHERTHREAD_MCP_TRANSPORT=server-env` switches to direct HTTP only for developer preview and then requires `GATHERTHREAD_API_URL` and `GATHERTHREAD_TOKEN`. The executable accepts no credential arguments and writes no logs to stdout; stdout is reserved for newline-delimited MCP JSON-RPC responses. A future public remote Streamable HTTP endpoint requires OAuth 2.1/PKCE and is not implemented here.

Optional environment:

- `GATHERTHREAD_REQUEST_TIMEOUT_MS`: upstream HTTP timeout
- `GATHERTHREAD_MCP_MAX_MESSAGE_BYTES`: maximum stdio JSON-RPC line size
- `GATHERTHREAD_MCP_TOOL_PROFILE`: `user` by default or internal `runtime`
- `GATHERTHREAD_MCP_TRANSPORT`: `connector` by default for users or developer-preview `server-env`
- `GATHERTHREAD_ALLOW_PROVIDER_REQUEST_CAPTURE`: `true` only when an authorized hook/proxy provides exact provider requests

Each stdio line is one JSON-RPC request or batch. Notifications produce no response. `SIGINT` and `SIGTERM` stop input processing and abort in-flight calls. Authentication and identity come from the running connector or, in developer preview, the GatherThread bearer token and server-side authorization; tool arguments cannot override them.
