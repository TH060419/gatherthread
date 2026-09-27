# Collaboration MCP service

This package exposes MCP JSON-RPC tools and resources over an injected collaboration API client. Its profiles deliberately separate model-facing collaboration tools from connector runtime controls.

The default `user` profile lists projects and sessions, reads history, appends a reviewed chat or Agent request, and returns sanitized connector status. It never exposes runtime registration, request claim/complete, or snapshot upload. The `runtime` profile exposes only those four internal tools and must not be configured as a normal Codex model server.

User tools:

- `collaboration_list_projects`
- `collaboration_list_project_sessions`
- `collaboration_list_sessions`
- `collaboration_read_history`
- `collaboration_read_context`
- `collaboration_append_chat`
- `collaboration_request_agent`
- `collaboration_get_connection_status`
- `collaboration_get_local_sync_status`
- `collaboration_set_local_auto_upload`
- `collaboration_upload_local_turns`
- `collaboration_import_codex_history`

The three local controls are routed only through the capability-protected connector transport. They can change a bound conversation's automatic upload preference, recover completed local turns after a missed Hook, or import Codex Desktop-visible history as a new local task after explicit user confirmation. The previous task is left for the user to archive. They do not expose the connector credential, and visible-history import leaves realtime canonical context injection enabled.

Visible-history import is not an idempotent tool: another deliberate invocation can create another local task. A lost response is not permission to blindly repeat it.

Internal runtime tools, unavailable in the user profile:

- `collaboration_register_runtime`
- `collaboration_claim_agent_request`
- `collaboration_complete_agent_request`
- `collaboration_upload_context_snapshot`

Resources include `collaboration://projects`, one session-list resource per visible project, `collaboration://sessions`, and one incremental history URI per visible session. Project tools preserve grouping and roles; canonical history remains session-scoped and accepts `after_sequence` and `limit` query parameters.

## Summary-aware public context

Use `collaboration_read_context` with `session_id` to read the authenticated user's project context policy (initially `summary`). Its optional `view` is an explicit `summary` or `original` override; omitting it preserves a user's saved policy. It is a read-only user tool available through both the private local connector and the developer-preview HTTP client, independent of the local Agent harness.

The result is `{ view, through_sequence, items }`. Each item contains `kind`, `event_id`, `sequence`, `actor_user_id`, and `content`. A summary also lists its complete `source_event_ids`. Summary view uses already completed, server-selected summaries in place of covered public messages and retains uncovered public text. This read starts no Agent run and does not compact, delete, or replace content already injected into a native Agent conversation. Summaries are lossy; use the originals to verify exact details.

`view: "original"` returns the original public conversation text, not the complete canonical event stream. `collaboration_read_history` and history resources still return exact canonical events with their existing `after_sequence`, `limit`, cursor, and pagination semantics. A context `through_sequence` describes the derived read's boundary and is not a replacement replay cursor. Internal execution clients may additionally fence a read with `readContext(sessionId, view, throughSequence)`; that fence is not a model-facing MCP argument.

Malformed arguments, unauthorized sessions, invalid context responses, resource limits, and older servers/connectors without the context API fail explicitly. The tool never silently substitutes raw history while claiming it is a summary. Context responses are limited to 256 KiB without clipping; use explicit paginated canonical history when a derived read exceeds that bound. Local calls retain the private capability and project/session routing checks; view selection does not bypass server membership permissions.

`createMcpHttpHandler` implements stateless JSON-RPC POST handling, batches, notifications, content-type validation, and explicit Origin allowlisting. An HTTP request with an Origin is rejected unless that origin was configured. Authentication and actor identity remain server-derived through the injected API client; MCP inputs cannot supply an actor username.

HTTP bodies and stdio lines default to a 1 MiB limit. The HTTP adapter counts actual streamed bytes and accepts an optional positive `maxMessageBytes` override. Both transports reject batches over 128 requests, JSON deeper than 64 levels or larger than 50,000 nodes before dispatch; accepted batch requests execute sequentially. Invalid JSON-RPC identifiers never dispatch tools. An embedding HTTP host must still enforce request authentication, connection/read deadlines and rate limits; this library handler is not a public unauthenticated server.

Snapshot uploads and visible text are redacted before transport. A `harness_transcript` upload replaces its native local-session identifier with a SHA-256 fingerprint before append. Exact `provider_request` capture is disabled by default and requires explicit service authorization, `exact_provider_request=true`, an observed-by value of `harness_hook` or `authorized_proxy`, and a runtime ID. Reconstructed content must use `canonical_history` or `harness_transcript`.

The handler is intentionally stateless and POST-only. It does not implement server-initiated SSE streams; durable incremental history is read through tools/resources and live delivery remains the collaboration server's WebSocket responsibility.

## Local stdio executable

The packaged Codex plugin launches fixed `@gatherthread/codex-connect@0.1.0-alpha.7 mcp`. Its default `connector` transport derives a private endpoint from the current workspace and reads a per-run capability from current-user-only connector state. The connector retains the server token; it is never passed to the MCP process. This is the ordinary Desktop path because Finder-launched applications do not reliably inherit terminal credential variables.

For repository development, build the workspace and launch `gatherthread-mcp` or `npm --workspace packages/mcp start` while the connector is running for the current directory. `GATHERTHREAD_MCP_TRANSPORT=server-env` switches to direct HTTP only for developer preview and then requires `GATHERTHREAD_API_URL` and `GATHERTHREAD_TOKEN`. The executable accepts no credential arguments and writes no logs to stdout; stdout is reserved for newline-delimited MCP JSON-RPC responses. A future public remote Streamable HTTP endpoint requires OAuth 2.1/PKCE and is not implemented here.

Optional environment:

- `GATHERTHREAD_REQUEST_TIMEOUT_MS`: upstream HTTP timeout
- `GATHERTHREAD_MCP_MAX_MESSAGE_BYTES`: maximum stdio JSON-RPC line size
- `GATHERTHREAD_MCP_TOOL_PROFILE`: `user` by default or internal `runtime`
- `GATHERTHREAD_MCP_TRANSPORT`: `connector` by default for users or developer-preview `server-env`
- `GATHERTHREAD_ALLOW_PROVIDER_REQUEST_CAPTURE`: `true` only when an authorized hook/proxy provides exact provider requests

Each stdio line is one JSON-RPC request or batch. Notifications produce no response. `SIGINT` and `SIGTERM` stop input processing and abort in-flight calls. Authentication and identity come from the running connector or, in developer preview, the GatherThread bearer token and server-side authorization; tool arguments cannot override them.
