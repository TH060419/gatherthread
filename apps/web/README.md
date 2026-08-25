# Relayroom web client

This package is a dependency-free first-release client for the collaboration protocol described in `../../docs`. It runs against an in-memory mock by default and can connect directly to the production `/v1` server.

## Run

```bash
cd apps/web
npm run dev
```

Open `http://127.0.0.1:4173` and sign in with `demo-token`.

For the real server, start it with `ACP_ALLOWED_ORIGINS=http://127.0.0.1:4173`, then open `http://127.0.0.1:4173/?api=http://127.0.0.1:8787`.

```bash
npm test
npm run build
```

The static build is written to `apps/web/dist`.

## Client contract

`src/api.js` defines the replaceable transport boundary. `MockCollaborationApi` and `HttpCollaborationApi` expose the same operations:

- `authenticate(token)` -> server-derived current user
- `listSessions()` and `createSession({ name, mode, idempotencyKey })`
- `getSession(sessionId)` and `listMembers(sessionId)`
- `replayEvents(sessionId, { afterSequence, limit })`
- distinct `appendHumanChat(...)` and `appendAgentRequest(...)` methods
- `openRealtime({ sessionId, afterSequence, onEvent, onState })`

The production HTTP/WS endpoints are:

```text
GET  /v1/me
GET  /v1/sessions
POST /v1/sessions
GET  /v1/sessions/:id
GET  /v1/sessions/:id/members
GET  /v1/sessions/:id/events?after_sequence=N&limit=100
POST /v1/sessions/:id/events
POST /v1/realtime-ticket
WS   websocket_url?ticket=ONE_USE_SHORT_LIVED_TICKET
```

Replay pages accept either camelCase mock fields or the proposed wire fields:

```json
{
  "events": [],
  "head_sequence": 42,
  "next_after_sequence": 42,
  "has_more": false
}
```

Every event is expected to contain a stable `id`, monotonic per-session `sequence`, `idempotencyKey`, server-derived `actor`, timestamp, visibility, optional reply target, payload, and optional runtime provenance. The UI orders exclusively by sequence.

## Server integration notes

`HttpCollaborationApi` normalizes the server's snake_case `{data: ...}` envelope into the UI model. Server-calculated roles remain the security boundary. `SessionSync` ignores duplicate delivery, buffers out-of-order live events, recovers gaps by HTTP replay, accepts authoritative cursor jumps across visibility-filtered events, and invalidates callbacks from a previously selected session.

## First-release limits

- The client stores the entered token in `sessionStorage`; hardened credential storage still requires a deployment-specific decision.
- There is no invitation, membership editing, attachment upload, reply UI, offline outbox, search, or runtime selection yet.
- The mock emits illustrative agent responses; real responses use the local bridge claim/complete workflow.
- Drafts survive a temporary socket loss in memory, but not a full reload.
- The app is plain ES modules and CSS to remain independently runnable while the monorepo toolchain is still being created.
