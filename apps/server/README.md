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

Users verify an email address, set a password and sign in with that email and password. Public Beta registration is not invitation-only; it stays closed by default until the operator completes the [registration preflight](../../docs/OPERATIONS.md#public-beta-registration-preflight). `owner-host:init` prepares private hosting configuration; it does not create an account or issue a user token. Project invitations grant membership to an already signed-in account. Retired bootstrap, qualification activation, user-token login and invitation-created identity routes return `410 account_flow_retired`.

Each browser device has an independent HttpOnly Cookie session, allowing one account on multiple devices. Native Agent devices use separate ten-minute authorizations or browser-approved DSH pairing; SQLite stores only peppered credential digests. `DELETE /v1/devices/:device_id` revokes that device's credential, runtimes, delegated authorizations, browser sessions and active sockets. Password recovery has its own default-closed operator switch; a completed reset revokes every device and Agent authorization without deleting projects.

Account-entry and health routes have their own public validation and limits. Workspace routes require the same-origin HttpOnly browser session or an independently authorized native Bearer credential where that route permits it; account-management routes do not accept native credentials. Native WebSocket clients may send the bearer header. Browser clients call `POST /v1/realtime-ticket` and carry the returned 30-second, one-use, session-scoped ticket in the `Sec-WebSocket-Protocol` header. Credentials in WebSocket query strings are not accepted.

## HTTP contract

Successful JSON responses use `{ "data": ... }`; failures use `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health/live` | Unauthenticated process liveness only |
| `GET` | `/health` or `/health/ready` | Unauthenticated SQLite WAL, foreign-key, and write readiness |
| `GET` | `/v1/registration` | Public registration availability and browser-bound challenge configuration |
| `POST` | `/v1/registration/send` | Validate the challenge and send a browser-bound email code |
| `POST` | `/v1/registration/verify` | Verify the email code and atomically create an account, password and Cookie session |
| `GET/POST` | `/v1/email-login` | Read login availability or sign in with email and password |
| `GET` | `/v1/password-reset` | Read independently gated password-recovery availability |
| `POST` | `/v1/password-reset/{send,verify}` | Send a recovery code or reset the password and revoke all devices |
| `DELETE` | `/v1/browser-sessions/current` | Log out the current browser session |
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
| `PUT/DELETE` | `/v1/projects/:project_id/members/:user_id` | Owner-change or remove a member; non-owners may leave their own membership after file checks |
| `POST/GET/DELETE` | `/v1/projects/:project_id/invitations[/invite_id]` | Owner-manage project invitations |
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

Projects are private and owner-managed. Solo writes are creator-only; multi writes allow owners and participants; viewers are read-only. New sessions default to hard limits of 512 per creator, 2,048 per project, and 8,192 per deployment; exact idempotent retries still return the original session at the limit. Project invitations are single-use, peppered, and expire after one hour, 24 hours, or seven days. Payloads redact common credentials and default-private thinking/system/developer fields before persistence. A non-owner member reading another user's activity receives public attribution rather than local device, runtime, or native-session identifiers. Snapshot jobs are charged at least 1 KiB each, completion data is bounded to 8 KiB, cumulative storage defaults to 4 MiB per user, 8 MiB per session, and 64 MiB per deployment, and unfinished jobs default to 64/256/4096 respectively. Multi-process fan-out, attachment blob storage and general conversation-retention jobs remain out of scope; operator backup and unreachable-Git retention jobs are separate. Public verified-email registration requires approved provider and abuse-control configuration. Keep the application on loopback behind the documented HTTPS profile, including Alibaba Cloud ECS. See the [interface contracts](../../docs/INTERFACE_CONTRACTS.md) for exact route authentication and quotas.
