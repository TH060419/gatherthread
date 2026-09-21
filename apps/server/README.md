# Collaboration server

The first-release server is a Node 24 ESM service built with TypeScript, Node's built-in SQLite driver, Zod, and `ws`. SQLite enables foreign keys, a five-second busy timeout, and WAL before migrations. Event append, per-session sequence allocation, membership read-model changes, and agent-request completion use `BEGIN IMMEDIATE` transactions. Socket fan-out is triggered only after the service method commits.

## Run

```sh
npm install --package-lock=false
npm run build
GATHERTHREAD_DATABASE_PATH=./data/collaboration.sqlite GATHERTHREAD_SERVER_PORT=18787 npm start
```

The default bind address is `127.0.0.1`. Configure only the documented `GATHERTHREAD_*` variables; generic `HOST` is intentionally ignored. Keep the application on loopback and expose an approved Caddy or Tailscale HTTPS edge instead.

## Authentication

`POST /v1/bootstrap` is a development-only first-user path. Production creates the first owner directly with `npm run owner-host:init`. The first device credential is returned once; SQLite stores only its peppered HMAC-SHA256 digest. New identities enter through a single-use project invitation. Additional devices use a separate ten-minute device authorization. `DELETE /v1/devices/:device_id` revokes that credential, its runtimes, delegated authorizations, browser sessions, and active sockets.

All other endpoints require `Authorization: Bearer <token>` or the same-origin HttpOnly browser session. Native WebSocket clients may send the bearer header. Browser clients call `POST /v1/realtime-ticket` and carry the returned 30-second, one-use, session-scoped ticket in the `Sec-WebSocket-Protocol` header. Credentials in WebSocket query strings are not accepted.

## HTTP contract

Successful JSON responses use `{ "data": ... }`; failures use `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health/live` | Unauthenticated process liveness only |
| `GET` | `/health` or `/health/ready` | Unauthenticated SQLite WAL, foreign-key, and write readiness |
| `POST` | `/v1/bootstrap` | One-time first identity and device token |
| `POST` | `/v1/browser-sessions` | Exchange a device credential for an HttpOnly browser session |
| `PATCH` | `/v1/devices/:device_id` | Rename one of the authenticated user's devices |
| `POST/GET` | `/v1/device-authorizations` | Create or list delegated device authorizations |
| `POST` | `/v1/device-authorizations/claim` | Claim a delegated authorization on a new device |
| `DELETE` | `/v1/devices/:device_id` | Revoke an owned device token and runtimes |
| `GET` | `/v1/me` | Return the authenticated user and device identity |
| `POST/GET` | `/v1/projects` | Create an empty project or list projects visible to the actor |
| `GET` | `/v1/projects/:project_id` | Read one visible project and the actor's role |
| `PATCH` | `/v1/projects/:project_id` | Owner-only idempotent project title update |
| `POST/GET` | `/v1/projects/:project_id/sessions` | Owner creates solo/multi; participant creates personal solo; members list sessions |
| `GET` | `/v1/projects/:project_id/members` | List project members |
| `PUT/DELETE` | `/v1/projects/:project_id/members/:user_id` | Owner-change or remove another member |
| `POST/GET/DELETE` | `/v1/projects/:project_id/invitations[/invite_id]` | Owner-manage project invitations |
| `POST` | `/v1/invitations/claim` | Atomically claim a project invitation as a new identity/device |
| `POST` | `/v1/invitations/accept` | Accept a project invitation as an authenticated identity |
| `GET` | `/v1/sessions` | Compatibility list of all visible sessions |
| `GET/PATCH` | `/v1/sessions/:session_id` | Read; project owner manages multi; Solo creator manages own Solo |
| `GET` | `/v1/sessions/:session_id/members` | Visible members and their most relevant active runtime |
| `POST` | `/v1/sessions/:session_id/events` | Append a validated, redacted canonical event |
| `GET` | `/v1/sessions/:session_id/events?after_sequence=N&limit=100` | Durable replay page and cursor |
| `POST` | `/v1/sessions/:session_id/local-turns` | Atomically commit one trusted local request, bounded tool events, and response |
| `POST` | `/v1/sessions/:session_id/snapshot-requests` | Freeze a new requester-owned read-only snapshot job |
| `GET` | `/v1/snapshot-requests[/:request_id]` | List or read requester-owned snapshot jobs |
| `POST` | `/v1/snapshot-requests/:request_id/{claim,complete,fail}` | Advance a job with an exact owned snapshot connector |
| `POST` | `/v1/runtimes` | Register or refresh an owned local runtime |
| `POST` | `/v1/runtimes/:runtime_id/heartbeat` | Mark an owned runtime online |
| `POST` | `/v1/sessions/:session_id/agent-requests/:event_id/claim` | Atomically claim the initiating user's request |
| `POST` | `/v1/sessions/:session_id/agent-requests/:event_id/progress` | Append idempotent public lifecycle or commentary progress under the active claim |
| `POST` | `/v1/sessions/:session_id/agent-requests/:event_id/complete` | Append a provenance-labelled response and complete its claim |
| `POST` | `/v1/sessions/:session_id/agent-requests/:event_id/pause` | Stop a claimed request at its author's instruction |
| `POST` | `/v1/realtime-ticket` | Issue a short-lived, one-use browser WebSocket ticket |

The server derives actor identity from the credential and always assigns event ID (unless the client supplies a stable one), sequence, and canonical server timestamp. A local capture time is retained only as payload metadata and cannot change project ordering. An idempotency key is scoped to one session and is bound to the actor, event type, visibility, reply target, payload, and runtime; only an identical retry receives the original event, while a different operation returns `409 idempotency_conflict`. `agent_progress` requires the exact owned runtime and an active matching request claim; the generic event route cannot forge it. `agent_response`, `tool_call`, and `tool_result` appends require an owned execution `runtime_id`. A runtime may hold only one active request claim. `human_chat` is only an event append and has no execution side effect.

`GET /v1/projects/:project_id/sessions` returns integration-friendly summaries with their project ID:

```json
{
  "data": {
    "sessions": [{
      "id": "session-id",
      "project_id": "project-id",
      "title": "Shared work",
      "mode": "multi",
      "state": "active",
      "role": "participant",
      "current_sequence": 42,
      "member_count": 3,
      "updated_at": "2026-08-25T12:00:00.000Z"
    }]
  }
}
```

Project membership is the broad ACL boundary. A participant can write `multi`; a viewer reads all project sessions. Owners and participants may create personal `solo`, and the persisted `owner_user_id` identifies its immutable creator: only that creator can write or rename the Solo while retaining a non-viewer project role. Even the project owner reads another member's Solo. The project owner alone creates `multi` and can change or remove every other member.

Project creation inserts only the project and its owner membership, so a new project's `session_count` is `0`. An owner or participant explicitly creates an eligible first session; existing sessions named `General` are preserved and no migration backfills one. Project creation, session creation, owner-only `PATCH /v1/projects/:project_id`, and authorized `PATCH /v1/sessions/:session_id` share a trimmed 1–200 character, control-character-free `title` policy; invalid title mutations return `422 validation_error`. A session title or mode change emits a metadata-only `session_state_change` event, allowing subscribed clients to refresh session metadata without exposing previous names or conversation content. Project title changes are owner-only and idempotent; they update project metadata without renaming local harness workspaces.

## WebSocket contract

Connect to `/v1/ws`, then send:

```json
{"type":"subscribe","session_id":"session-id","after_sequence":42}
```

The server sends one or more `replay` pages, then `subscribed`. Committed live writes arrive as `event`. A `cursor` frame advances across an event hidden by visibility policy while the actor remains a member. Device or project-membership revocation closes the socket with policy code 1008 before another event or cursor is sent. Server ping frames are emitted every 15 seconds; clients that fail the next heartbeat are terminated. Clients should use the durable HTTP replay endpoint whenever their stored cursor indicates a gap.

Set `GATHERTHREAD_ALLOWED_ORIGINS` to a comma-separated exact Origin allowlist when the browser is hosted separately, for example `http://127.0.0.1:4173`. Cross-origin requests are denied by default.

## Security and first-release scope

Projects are private and owner-managed. Solo writes are creator-only; multi writes allow owners and participants; viewers are read-only. New sessions default to hard limits of 512 per creator, 2,048 per project, and 8,192 per deployment; exact idempotent retries still return the original session at the limit. Project invitations are single-use, peppered, and expire after one hour, 24 hours, or seven days. Payloads redact common credentials and default-private thinking/system/developer fields before persistence. A non-owner member reading another user's activity receives public attribution rather than local device, runtime, or native-session identifiers. Snapshot jobs are charged at least 1 KiB each, completion data is bounded to 8 KiB, cumulative storage defaults to 4 MiB per user, 8 MiB per session, and 64 MiB per deployment, and unfinished jobs default to 64/256/4096 respectively. The beta still lacks multi-process fan-out, automatic retention jobs, attachment blob storage, and open registration. Use a documented connection profile; public access is supported only through the invitation-only Alibaba Cloud ECS profile with the application retained on loopback.
