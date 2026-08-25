# Relayroom web client

This package is a dependency-free first-release client for the collaboration protocol described in `../../docs`. It runs against an in-memory mock by default so the product flow can be reviewed before the server and shared protocol package are integrated.

## Run

```bash
cd apps/web
npm run dev
```

Open `http://127.0.0.1:4173` and sign in with `demo-token`.

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

The proposed HTTP/WS endpoints are:

```text
GET  /api/me
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:id
GET  /api/sessions/:id/members
GET  /api/sessions/:id/events?after_sequence=N&limit=100
POST /api/sessions/:id/events
POST /api/realtime-ticket
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

## Server integration points

Before switching `main.js` to `HttpCollaborationApi`, the server and client must agree on:

1. Exact event and error schemas, including whether wire keys are snake_case.
2. Authentication lifecycle and the one-use realtime ticket response. A long-lived bearer token must not be put in the WebSocket URL.
3. Subscribe acknowledgement, heartbeat/control envelopes, close codes, and whether HTTP replay finishes before or races with live fan-out.
4. Replay pagination semantics, retention-truncated cursors, and the authoritative server head.
5. Server-calculated role/capability fields. Client-side role checks improve UX but are not a security boundary.
6. Runtime presence/eligibility and the canonical representation of agent-request claim/completion.
7. Provenance and fidelity field names. Reconstructed history must never be labelled as an exact provider request.

`SessionSync` advances its cursor only across contiguous events. Duplicate delivery is ignored, later socket events are buffered, gaps are recovered by paginated HTTP replay, and switching sessions invalidates late callbacks from the previous generation.

## First-release limits

- The preview stores the mock token in `sessionStorage`; production credential storage requires a security decision.
- There is no invitation, membership editing, attachment upload, reply UI, offline outbox, search, or runtime selection yet.
- The mock emits agent responses but does not model bridge claim/complete events or tool streams.
- Drafts survive a temporary socket loss in memory, but not a full reload.
- The app is plain ES modules and CSS to remain independently runnable while the monorepo toolchain is still being created.
