# Relayroom web client

This package is a dependency-free first-release client for the collaboration protocol described in `../../docs`. It uses the real, same-origin `/v1` API by default. The in-memory mock is available only when explicitly requested.

## Run

```bash
cd apps/web
npm run dev
```

Start the API with `ACP_ALLOWED_ORIGINS=http://127.0.0.1:4173`, then open `http://127.0.0.1:4173` and enter an access token from the owner host. The development server proxies same-origin `/v1` and `/health` requests to `ACP_WEB_API_ORIGIN` (default `http://127.0.0.1:8787`).

For the isolated mock preview, explicitly open `http://127.0.0.1:4173/?mock=1` and sign in with `demo-token`.

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
- `createInvitation(...)`, `listInvitations(...)`, and `revokeInvitation(...)`
- distinct `claimInvitation(...)` and `acceptInvitation(...)` methods for new and existing users
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
WS   websocket_url with relayroom-ticket.ONE_USE_SHORT_LIVED_TICKET subprotocol
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

### Invitations and credentials

- Owners create participant or viewer invitations that expire after 1 hour, 24 hours (the default), or 7 days.
- The invitation secret is returned only by the create request. The UI keeps it in memory long enough to copy it, never adds it to a URL or browser storage, and cannot recover it from the invitation list.
- A new user can claim an invitation with a display name and device name; the returned device credential is adopted in memory and opens the invited session directly.
- An already signed-in user can accept an invitation without rotating or replacing their existing credential.
- Pending invitations can be revoked. Claimed, revoked, and expired records remain visible to the owner without exposing their secret.

## Server integration notes

`HttpCollaborationApi` normalizes the server's snake_case `{data: ...}` envelope into the UI model. Server-calculated roles remain the security boundary. `SessionSync` ignores duplicate delivery, buffers out-of-order live events, recovers gaps by HTTP replay, accepts authoritative cursor jumps across visibility-filtered events, and invalidates callbacks from a previously selected session.

## First-release limits

- The client keeps the entered bearer token only in JavaScript memory. Reloading or closing the tab clears it and requires sign-in again. A future browser-auth design should replace the bearer entry flow with an owner-host-issued `HttpOnly; Secure; SameSite=Strict` cookie and CSRF protection.
- There is no membership editing, attachment upload, reply UI, offline outbox, search, or runtime selection yet.
- The mock emits illustrative agent responses; real responses use the local bridge claim/complete workflow.
- Drafts survive a temporary socket loss in memory, but not a full reload.
- The app is plain ES modules and CSS to remain independently runnable while the monorepo toolchain is still being created.
