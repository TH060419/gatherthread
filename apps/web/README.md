# GatherThread web client

This package is a dependency-free first-release client for the collaboration protocol described in `../../docs`. It uses the real, same-origin `/v1` API by default. The in-memory mock is available only when explicitly requested.

## Run

```bash
cd apps/web
npm run dev
```

Start the API with `GATHERTHREAD_ALLOWED_ORIGINS=http://127.0.0.1:4173`, then open `http://127.0.0.1:4173` and enter an access token from the owner host. The development server proxies same-origin `/v1` and `/health` requests to `GATHERTHREAD_WEB_API_ORIGIN` (default `http://127.0.0.1:8787`).

For the isolated mock preview, explicitly open `http://127.0.0.1:4173/?mock=1` and sign in with `demo-token`.

```bash
npm test
npm run build
```

The static build is written to `apps/web/dist`.

## Client contract

`src/api.js` defines the replaceable transport boundary. `MockCollaborationApi` and `HttpCollaborationApi` expose the same operations:

- `authenticate(token)` -> server-derived current user
- `listProjects()`, `getProject(...)`, and `createProject(...)`
- `listProjectSessions(...)`, `listProjectMembers(...)`, and `createSession(projectId, ...)`
- `getSession(sessionId)`, permission-checked `renameSession(sessionId, ...)`, and `listMembers(sessionId)`
- project-scoped `createInvitation(...)`, `listInvitations(...)`, `revokeInvitation(...)`, and `setProjectMemberRole(...)`
- distinct `claimInvitation(...)` and `acceptInvitation(...)` methods for new and existing users
- `replayEvents(sessionId, { afterSequence, limit })`
- distinct `appendHumanChat(...)` and `appendAgentRequest(...)` methods
- `createSnapshotRequest(sessionId)` and `getSnapshotRequest(requestId)` for one-way Codex downloads
- `openRealtime({ sessionId, afterSequence, onEvent, onState })`

The project rail also exposes **Connect Codex**, which generates separate macOS/Linux and Windows PowerShell commands from the validated same-origin server URL and current project ID. These commands contain no credential; the CLI requests the device token through hidden terminal input, creates or reuses the same-name local workspace, opens that workspace in Codex Desktop, and materializes all writable sessions as named tasks. After a synchronized Agent turn creates renderable native content, the connector launches the exact registered task link. Current Desktop builds have been observed to associate it with the project for the verified workspace, but the launcher returns no project-assignment receipt. No fake Agent turn is created merely to display an empty session. Activation failure is fail-soft and retryable while synchronization remains active.

The production HTTP/WS endpoints are:

```text
GET  /v1/me
GET  /v1/projects
POST /v1/projects
GET  /v1/projects/:id
GET  /v1/projects/:id/sessions
POST /v1/projects/:id/sessions
GET  /v1/projects/:id/members
PUT  /v1/projects/:id/members/:user_id
GET  /v1/projects/:id/invitations
POST /v1/projects/:id/invitations
GET  /v1/sessions/:id
PATCH /v1/sessions/:id
GET  /v1/sessions/:id/members
GET  /v1/sessions/:id/events?after_sequence=N&limit=100
POST /v1/sessions/:id/events
POST /v1/sessions/:id/snapshot-requests  {}
GET  /v1/snapshot-requests?session_id=:session_id&limit=40
GET  /v1/snapshot-requests/:request_id
POST /v1/realtime-ticket
WS   websocket_url with gatherthread-ticket.ONE_USE_SHORT_LIVED_TICKET subprotocol
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

New projects start with no sessions. Owners may create `solo` or `multi`; participants may create only a personal `solo`; viewers see no creation action. Project and session names are trimmed, limited to 1–200 characters, and reject C0/C1 control characters while retaining ordinary Unicode. Project owners can rename `multi`, while each Solo creator can rename that Solo. A successful rename updates the open title and project sidebar immediately; metadata-only `session_state_change` events apply the same update in other clients subscribed to that session.

### Invitations and credentials

- Owners create project-level participant or viewer invitations that expire after 1 hour, 24 hours (the default), or 7 days.
- Participants can write and run their own agent in `multi`, create/write their own personal Solo, and read every other Solo. Project owners also read participant-created Solos rather than overriding them. Viewers are read-only across the project. Owners can change every other member's project role later.
- The invitation secret is returned only by the create request. The UI keeps it in memory long enough to copy it, never adds it to a URL or browser storage, and cannot recover it from the invitation list.
- A new user can claim an invitation with a display name and device name. Invitation claim and browser-session issuance commit atomically; the UI opens the invited project and shows the device credential once in a blocking copy dialog for password-manager storage.
- An already signed-in user can accept an invitation without rotating or replacing their existing credential.
- Pending invitations can be revoked. Claimed, revoked, and expired records remain visible to the owner without exposing their secret.

### Codex downloads and connector state

- Owners and participants in multi sessions, plus a personal Solo's creator, retain live collaboration controls. Any member observing another person's Solo and all viewers instead receive a one-way “Download to Codex / 下载到 Codex” action.
- Each click creates an independent frozen snapshot through the server-returned `through_sequence`. A queued request means the server is waiting for a local snapshot connector; it does not mean a local task already exists.
- The UI polls only the individual in-memory request IDs and renders queued, claimed, importing, compacting, completed, and failed states. Failed requests retry by creating a new snapshot. Completed records show the local task or thread name returned in `result`.
- Live sessions normalize connector state into Synced, Offline with an optional pending count, Reconciling, Rebuilding, or Local fork. A runtime with `purpose: snapshot_connector` never enables the agent execution control.

## Server integration notes

`HttpCollaborationApi` normalizes the server's snake_case `{data: ...}` envelope into the UI model. Server-calculated roles remain the security boundary. `SessionSync` ignores duplicate delivery, buffers out-of-order live events, recovers gaps by HTTP replay, accepts authoritative cursor jumps across visibility-filtered events, and invalidates callbacks from a previously selected session.

## First-release limits

- The entered device bearer is used only to create a 24-hour server-side browser session and is then cleared from JavaScript. The opaque session token is held in a non-persistent `HttpOnly; SameSite=Strict; Path=/` Cookie, with `Secure` and `__Host-` under HTTPS. Reload restores the workspace; logout, device revocation, and token rotation revoke the session. Cookie-authenticated writes require an exact allowed Origin. Neither bearer nor browser token is placed in Web Storage or a URL.
- Project owners can change participant/viewer roles. There is no member-removal UI, attachment upload, reply UI, offline outbox, search, or runtime selection yet.
- The mock emits illustrative agent responses; real responses use the local bridge claim/complete workflow.
- An unanswered `agent_request` shows an accessible pulsing response indicator while its local runtime is online. If the runtime disconnects, the indicator changes to a static queued state and disappears only when a canonical linked response arrives.
- Linked `agent_progress` lifecycle status and public commentary render live while the request is pending. Once the final response arrives, the work log is closed by default and the safe GFM-rendered final answer remains primary. Bundled KaTeX renders `$...$`, `$$...$$`, `\\(...\\)`, and `\\[...\\]` formulas without trusting formula-supplied commands. Raw HTML, dangerous link protocols, hidden reasoning, and automatic remote Markdown image requests are excluded.
- Drafts survive a temporary socket loss in memory, but not a full reload.
- The app is plain ES modules and CSS to remain independently runnable while the monorepo toolchain is still being created.
