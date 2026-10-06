# GatherThread web client

This package is a plain JavaScript first-release client for the collaboration protocol described in `../../docs`. It uses the real, same-origin `/v1` API by default. The in-memory mock is available only when explicitly requested.

## Run

```bash
cd apps/web
npm run dev
```

Start the API with `GATHERTHREAD_ALLOWED_ORIGINS=http://127.0.0.1:4173`, then open `http://127.0.0.1:4173` for the product home and choose **Get Started** to enter the application at `/app/`. Sign in with your email and password, or register after the operator enables registration. Use **Forgot password?** to request a code when recovery is enabled. The development server proxies same-origin `/v1` and `/health` requests to `GATHERTHREAD_WEB_API_ORIGIN` (default `http://127.0.0.1:18787`).

Browser API requests are restricted to the page's origin before any credential is sent. Legacy `?api=...` links are still forwarded to `/app/`, but an external or credential-bearing API URL is rejected. To use another deployment, open that deployment's own `/app/`; development continues to use the same-origin proxy above.

For the isolated mock preview, explicitly open `http://127.0.0.1:4173/app/?mock=1` and sign in with email `demo@example.invalid` and password `isolated demo password`. Legacy root `?mock=1`, project/session fragments, and DSH pairing fragments are forwarded to `/app/` with their query and fragment preserved.

```bash
npm test
npm run build
```

The static build is written to `apps/web/dist`.

## Beginner guide browser regression

With an existing Playwright installation and Chrome, build the app and keep `node apps/web/scripts/serve.mjs` running from the repository root. In another terminal run:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/browser/onboarding.mjs
```

The script uses only `/app/?mock=1`, disposable browser profiles and mock API fixtures. It walks all six guides at 1440×900, 390×844, 320×568, 820×1180 and 1024×768, including Chinese/English and empty/read-only accounts. It checks target visibility, ring geometry, cards beside controls, native-dialog layering, focus, example storage/origin isolation, absence of parent business writes, free practice, reset, toolbar navigation and language updates. Mobile/tablet runs use a mobile user agent and touch context to exercise the compact project drawer, Agent picker and tools sheets. Screenshots go to `/tmp/gatherthread-onboarding` by default. `ONBOARDING_ORIGIN`, `ONBOARDING_ARTIFACTS`, `ONBOARDING_BROWSER` and `ONBOARDING_WIDTH` override the preview, output directory, installed browser channel and selected width. `webkit` exercises Playwright WebKit and must not be reported as a real Safari check.

## Client contract

### Mobile workspace

On phones and tablets up to 1366 CSS pixels wide, projects/sessions, members and conversation tools open in modal sheets. The small Agent pill opens the **existing** Agent/model/reasoning controls; **Chat only** and **Ask AI** remain separate actions, and the same Ask button becomes Pause/Resume during a request. Quotes, mentions, summary generation/original-view switching, project files and Settings remain available. Tablet portrait and landscape use the same controls, with a centered reading area. Beyond that width, the original controls return without changing drafts or runtime selection.

On iPhone, iPad (including its desktop-style browser identity) and Android, local connection/install shortcuts are hidden. Sign in with the same account as your computer to invoke its authorized online Codex/DSH runtime; keep that computer and connector online. With an Internet-reachable GatherThread server, the phone need not be near the computer or on the same network. A local-only server still needs a separately configured reachable connection. Desktop browsers, including touch laptops and narrow windows, retain the desktop controls and connection shortcuts. This is presentation, not authorization: the server keeps enforcing membership, session permissions, exact user-owned runtime/model routing and the existing Cloud Agent availability gate. The isolated beginner example uses the corresponding desktop or compact mobile/tablet controls, with its own guide toolbar and temporary mock state.

After `npm run build`, run the local HTTP/WebSocket browser fixture (no live provider calls):

```bash
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright/index.mjs node tests/browser/mobile-workspace.mjs
```

The fixture covers bilingual phone controls, remote same-account Codex/DSH selection and model/effort, pause/resume target and draft preservation, quotes/mentions, summaries, modal keyboard/focus, empty projects and layout resizing. It also checks iPad desktop-style and Android tablet identities at 768/820/1024/1180/1366 widths and verifies that Mac desktops and Windows touch laptops never enter the mobile presentation. Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for an existing Chrome and `BROWSER_OUTPUT_DIRECTORY` for screenshots. Chrome and Playwright WebKit are exercised; emulation does not certify a physical iPad/iPhone keyboard or native Safari behavior.

### Transport

`src/api.js` defines the replaceable transport boundary. `MockCollaborationApi` and `HttpCollaborationApi` expose the same operations:

- `prepareEmailLogin()`, `loginWithEmail(...)` -> server-derived current user; `passwordResetStatus()`, `sendPasswordReset(...)`, `verifyPasswordReset(...)` -> recovery without auto-login
- `listProjects()`, `getProject(...)`, and `createProject(...)`
- `listProjectSessions(...)`, `listProjectMembers(...)`, and `createSession(projectId, ...)`
- `getSession(sessionId)`, permission-checked `renameSession(sessionId, ...)`, and `listMembers(sessionId)`
- project-scoped `createInvitation(...)`, `listInvitations(...)`, `revokeInvitation(...)`, and `setProjectMemberRole(...)`
- `acceptInvitation(...)` after account sign-in
- `replayEvents(sessionId, { afterSequence, limit })`
- distinct `appendHumanChat(...)` and `appendAgentRequest(...)` methods
- `createHistorySummary(...)` for explicit, selected-history Agent requests, plus per-user/project `getProjectContextPolicy(...)` and `setProjectContextPolicy(...)`
- `createSnapshotRequest(sessionId)` and `getSnapshotRequest(requestId)` for one-way Codex downloads
- `openRealtime({ sessionId, afterSequence, onEvent, onState })`

The project rail also exposes **Connect Codex**, which generates separate macOS/Linux and Windows PowerShell commands from the validated same-origin server URL and current project ID. These commands contain no credential; the CLI exchanges a one-use browser-issued authorization through hidden terminal input, creates or reuses the same-name local workspace, opens that workspace in Codex Desktop, and materializes all writable sessions as named tasks. After a synchronized Agent turn creates renderable native content, the connector launches the exact registered task link. Current Desktop builds have been observed to associate it with the project for the verified workspace, but the launcher returns no project-assignment receipt. No fake Agent turn is created merely to display an empty session. Activation failure is fail-soft and retryable while synchronization remains active.

The same dialog offers an optional Windows/macOS Launcher button on the official HTTPS origin. Its `gatherthread-connect:` URL contains the validated server URL, project ID, model, context-window limit, and history-import mode, but no credential. The Windows ZIP bundles Python and Node; the native macOS `.app` bundles Node. Both include the fixed connector and local plugin source and ask for the browser-issued one-use device authorization in their own GUI. The manual terminal commands remain available for other platforms, self-hosting, and recovery. Launcher build and installation notes are in `prototypes/codex-launcher/README.md` and `prototypes/codex-launcher/macos/README.md`.

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
POST /v1/sessions/:id/history-summaries
GET  /v1/projects/:id/context-policy
PUT  /v1/projects/:id/context-policy
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

### Manual history summaries

Session writers can select 1–100 loaded public messages or completed summaries, then explicitly confirm generation with their own currently selected online Agent, exact runtime, model, and effort. Pending/failed messages and generated summary prompts cannot be selected. The serialized source limit is 20 KiB with no truncation; an uncertain transport retry preserves the same idempotency key. A new retry or regeneration is offered only after a definitive rejection or terminal response, never automatically.

Summaries are shared, lossy derived Markdown. The default display folds the newest whole non-overlapping versions at their first original source; every original and older version remains available. Selected earlier summaries expand to their original ancestry for overlap handling. Per-card/global display switches do not change Agent context injection or delete history. Readers may inspect all versions; only session writers may regenerate, using their own Agent.

Settings expose summary instructions (browser preference, shared on generation; never enter secrets) and a separate server-backed context policy scoped to the current user/project. Summary mode reduces context but may lose details; original mode includes the original public messages and uses more context. This applies to future Agent requests started from the GatherThread Web app and explicit MCP context reads. It does not rewrite a running turn, remove existing Codex Desktop task history, or replace history already injected into ordinary DSH sessions. Already-loaded history remains managed by native automatic compaction. Generation still uses the writer's selected local Agent and may consume model quota. Only selected records are supplied as its shared-history context; this is not a guarantee of sandbox isolation from local tools or files.

## Server integration notes

`HttpCollaborationApi` normalizes the server's snake_case `{data: ...}` envelope into the UI model. Server-calculated roles remain the security boundary. `SessionSync` ignores duplicate delivery, buffers out-of-order live events, recovers gaps by HTTP replay, accepts authoritative cursor jumps across visibility-filtered events, and invalidates callbacks from a previously selected session.

## First-release limits

- Email/password login creates a browser session; transient passwords and OTPs are cleared from JavaScript. Recovery signs out every device and revokes Agent access without changing projects or roles. The default is a 24-hour server-side session held in a non-persistent `HttpOnly; SameSite=Strict; Path=/` Cookie. **Remember this device** uses a 30-day persistent Cookie instead. HTTPS adds `Secure` and `__Host-`. Reload restores the workspace; logout, device revocation, and token rotation revoke either session. Cookie-authenticated writes require an exact allowed Origin. Neither bearer nor browser token is placed in Web Storage or a URL.
- Project owners can change participant/viewer roles. There is no member-removal UI, attachment upload, reply UI, offline outbox, search, or runtime selection yet.
- The mock emits illustrative agent responses; real responses use the local bridge claim/complete workflow.
- An unanswered `agent_request` shows an accessible pulsing response indicator while its local runtime is online. If the runtime disconnects, the indicator changes to a static queued state and disappears only when a canonical linked response arrives.
- Linked `agent_progress` lifecycle status and public commentary render live while the request is pending. Once the final response arrives, the work log is closed by default and the safe GFM-rendered final answer remains primary. Bundled KaTeX renders `$...$`, `$$...$$`, `\\(...\\)`, and `\\[...\\]` formulas without trusting formula-supplied commands. Raw HTML, dangerous link protocols, hidden reasoning, and automatic remote Markdown image requests are excluded.
- Drafts survive a temporary socket loss in memory, but not a full reload.
- The app is plain ES modules and CSS to remain independently runnable while the monorepo toolchain is still being created.
