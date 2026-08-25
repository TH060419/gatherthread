# Collaboration server

The first-release server is a Node 24 ESM service built with TypeScript, Node's built-in SQLite driver, Zod, and `ws`. SQLite enables foreign keys, a five-second busy timeout, and WAL before migrations. Event append, per-session sequence allocation, membership read-model changes, and agent-request completion use `BEGIN IMMEDIATE` transactions. Socket fan-out is triggered only after the service method commits.

## Run

```sh
npm install --package-lock=false
npm run build
ACP_DATABASE_PATH=./data/collaboration.sqlite PORT=8787 npm start
```

The default bind address is `127.0.0.1`. Set `HOST` explicitly to expose the service beyond the local machine.

## Authentication

`POST /v1/bootstrap` creates the first user and device only while the database has no users. It returns the only copy of an opaque bearer token; SQLite stores its SHA-256 digest. An authenticated client may provision another identity with `POST /v1/users` or another token for the same user with `POST /v1/devices`. `DELETE /v1/devices/:device_id` revokes that token and its runtimes.

All other endpoints require `Authorization: Bearer <token>`. WebSocket clients should also send that header. Browser clients that cannot set upgrade headers may use `?access_token=...`; URLs must therefore be kept out of logs.

## HTTP contract

Successful JSON responses use `{ "data": ... }`; failures use `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health and active SQLite journal mode |
| `POST` | `/v1/bootstrap` | One-time first identity and device token |
| `POST` | `/v1/users` | Provision an identity and initial device token |
| `POST` | `/v1/devices` | Provision another token for the authenticated user |
| `DELETE` | `/v1/devices/:device_id` | Revoke an owned device token and runtimes |
| `POST` | `/v1/sessions` | Create a solo or multi session; requires `idempotency_key` |
| `GET` | `/v1/sessions` | List only sessions visible to the token user |
| `GET/PATCH` | `/v1/sessions/:session_id` | Read or owner-update mode, state, and title |
| `PUT/DELETE` | `/v1/sessions/:session_id/members/:user_id` | Owner-managed participant/viewer membership |
| `POST` | `/v1/sessions/:session_id/events` | Append a validated, redacted canonical event |
| `GET` | `/v1/sessions/:session_id/events?after_sequence=N&limit=100` | Durable replay page and cursor |
| `POST` | `/v1/runtimes` | Register or refresh an owned local runtime |
| `POST` | `/v1/runtimes/:runtime_id/heartbeat` | Mark an owned runtime online |
| `POST` | `/v1/sessions/:session_id/agent-requests/:event_id/claim` | Atomically claim the initiating user's request |
| `POST` | `/v1/sessions/:session_id/agent-requests/:event_id/complete` | Append a provenance-labelled response and complete its claim |

The server derives actor identity from the token and always assigns event ID (unless the client supplies a stable one), sequence, and timestamp. An idempotency key is scoped to one session and one actor: the same actor receives the original event, while a collision from another actor returns `409`. `agent_response`, `tool_call`, and `tool_result` appends require an owned `runtime_id`. `human_chat` is only an event append and has no execution side effect.

`GET /v1/sessions` returns an integration-friendly summary:

```json
{
  "data": {
    "sessions": [{
      "id": "session-id",
      "title": "Shared work",
      "mode": "multi",
      "state": "active",
      "role": "participant",
      "current_sequence": 42,
      "updated_at": "2026-08-25T12:00:00.000Z"
    }]
  }
}
```

The membership join is the ACL boundary: sessions for which the actor has no current membership are omitted.

## WebSocket contract

Connect to `/v1/ws`, then send:

```json
{"type":"subscribe","session_id":"session-id","after_sequence":42}
```

The server sends one or more `replay` pages, then `subscribed`. Committed live writes arrive as `event`. A `cursor` frame advances across an event hidden by visibility policy. Server ping frames are emitted every 15 seconds; clients that fail the next heartbeat are terminated. Clients should use the durable HTTP replay endpoint whenever their stored cursor indicates a gap.

## Security and first-release scope

Sessions are membership-only and owner-managed. Solo writes are owner-only; multi writes allow owners and participants; viewers are read-only. Payloads redact common credentials and default-private thinking/system/developer fields before persistence. Tokens are revocable, but the first release does not yet include invitation proofs, token expiry/rotation, rate limiting, TLS termination, multi-process fan-out, configurable retention, or attachment blob storage. Put the service behind an HTTPS reverse proxy for non-local deployment.
