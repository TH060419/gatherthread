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

## Brand assets

The invitation confirmation header uses `brand/lockup-color-transparent-light.svg` and `brand/lockup-color-transparent-dark.svg`, matching the approved `final-f` exports at `logo/svg/` in commit `74161e2` byte for byte. These are also the login/workspace lockups; the invitation header displays them at 184 CSS pixels with the existing light/dark theme selection. See the [approved asset usage guide](https://github.com/TH060419/gatherthread/blob/74161e2/logo/README.md).

## Beginner guide browser regression

With an existing Playwright installation and Chrome, build the app and keep `node apps/web/scripts/serve.mjs` running from the repository root. In another terminal run:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/browser/onboarding.mjs
```

The script uses only `/app/?mock=1`, disposable browser profiles and mock API fixtures. It walks all six guides at 1440×900, 390×844, 320×568, 820×1180 and 1024×768, including Chinese/English and empty/read-only accounts. It checks target visibility, ring geometry, cards beside controls, native-dialog layering, focus, example storage/origin isolation, absence of parent business writes, free practice, reset, toolbar navigation and language updates. Mobile/tablet runs use a mobile user agent and touch context to exercise the compact project drawer, Agent picker and tools sheets. Screenshots go to `/tmp/gatherthread-onboarding` by default. `ONBOARDING_ORIGIN`, `ONBOARDING_ARTIFACTS`, `ONBOARDING_BROWSER` and `ONBOARDING_WIDTH` override the preview, output directory, installed browser channel and selected width. `webkit` exercises Playwright WebKit and must not be reported as a real Safari check.

## Client contract

### Compact composer and guided GitHub settings

Desktop, phone and tablet use the same small Agent-settings button. It opens the existing Agent/model/reasoning and cloud-workspace controls in a scrollable dialog, never extending the message composer. Chat and Agent sends remain distinct. The test banner's height is excluded from the workspace viewport.

Project file collaboration opens GitHub first, with GT Cloud as the lightweight-trial alternative. Follow Connect account → Choose repository → Ready to use. Account/organization and repository name are separate fields. Returning from GitHub sign-in restores the original project's settings rather than selecting the first project. The short return hint is account-bound, single-use and expires after ten minutes; it contains project/session IDs, never OAuth codes, state or credentials.

After setup, Cloud Agent work and optional **Sync files from my computer** are separate actions. Computer sync keeps its independently authorized device workflow; an existing repository may prefill its unsaved form but never enables uploads. Advanced settings and saved task details stay collapsed. **Create a repository** opens GitHub's own form, where creation and visibility must be confirmed. These flows do not migrate GT Cloud files or replace GitHub permissions.

Startup displays a neutral restore screen while checking the HttpOnly browser session. It never shows a login form before a restored workspace, caches no identity, and offers reload if the application module fails to load. Cloud pending requests use cloud status, not local connector presence.

Run `tests/browser/workspace-guided-settings.mjs` after a build for isolated Chromium/WebKit pointer tests of short desktop windows, phones, tablets, test-banner sizing, cloud replies and delayed session restoration. Providers and GitHub writes are synthetic.

`tests/browser/github-storage-setup.mjs` additionally checks desktop, phone and tablet clicks through account authorization return, repository setup, optional computer-sync drafts and GT Cloud. All external traffic and GitHub writes are blocked; it does not certify a live OAuth installation or native Safari.

### Mobile workspace

On a likely phone or tablet, the browser asks whether to use the mobile interface. Login and Settings → General provide **Auto / Mobile / Desktop**, remembered only in the current browser. Switching is immediate without reloading, reauthenticating or clearing drafts; rotation and viewport size do not override an explicit choice. Mobile conversation navigation is a searchable drawer with project selection and a new-conversation action. Invitations, joining projects and project management have separate pages. Settings shows a short directory and one core section at a time. Project files keeps GitHub/GT Cloud connection/status; local transfers, recovery, merging and PR publication remain desktop operations. Hidden desktop preferences are preserved.

The small Agent pill opens the **existing** Agent/model/reasoning controls; **Chat only** and **Ask AI** remain separate actions, and the same Ask button becomes Pause/Resume during a request. Quotes, mentions and shared summaries remain available. Tablet portrait and landscape use the same controls, with a centered reading area. See [ADR-0057](../../docs/adr/0057-explicit-browser-interface-and-mobile-navigation.md).

On iPhone, iPad (including its desktop-style browser identity) and Android, local connection/install shortcuts remain unavailable even when Desktop is selected. Sign in with the same account as your computer to invoke its authorized online Codex/DSH runtime; keep that computer and connector online. With an Internet-reachable GatherThread server, the phone need not be near the computer or on the same network. A local-only server still needs a separately configured reachable connection. A touch laptop can decline the suggestion and keep Desktop; any desktop user can choose Mobile. This is presentation, not authorization: membership, session permissions, exact user-owned runtime/model routing and Cloud Agent availability gates stay unchanged. The isolated beginner example inherits the chosen presentation with its own guide toolbar and temporary mock state.

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
- `deleteMessage(sessionId, eventId, { idempotencyKey })` for explicit author-only deletion
- `createHistorySummary(...)` for explicit, selected-history Agent requests, plus per-user/project `getProjectContextPolicy(...)` and `setProjectContextPolicy(...)`
- `createSnapshotRequest(sessionId)` and `getSnapshotRequest(requestId)` for one-way Codex downloads
- `openRealtime({ sessionId, afterSequence, onEvent, onState })`

The project rail also exposes **Connect Codex**, which generates separate macOS/Linux and Windows PowerShell commands from the validated same-origin server URL and current project ID. These commands contain no credential; the CLI exchanges a one-use browser-issued authorization through hidden terminal input, creates or reuses the same-name local workspace, opens that workspace in Codex Desktop, and materializes all writable sessions as named tasks. After a synchronized Agent turn creates renderable native content, the connector launches the exact registered task link. Current Desktop builds have been observed to associate it with the project for the verified workspace, but the launcher returns no project-assignment receipt. No fake Agent turn is created merely to display an empty session. Activation failure is fail-soft and retryable while synchronization remains active.

At the exact official production/test HTTPS origins, that dialog prioritizes the Windows/macOS Launcher and folds terminal instructions under advanced connection. Its version-2 `gatherthread-connect:` URL carries validated environment/project/settings, the current email and a public one-use authorization ID, never a password or credential. The browser prepares this link before the user's Open Launcher click, preserving the native-opening gesture. The Launcher asks only for the account password and creates an independent Agent device; it never asks users to copy a Token in the new flow. Windows bundles Python/Node; the native macOS `.app` bundles Node. Both contain the fixed connector/plugin and brand icons. Older version-1 formal-site links remain accepted for compatibility. Linux/self-hosted users retain manual instructions. Launcher changes require rebuilt download archives before publication; source updates do not change already downloaded apps. Build notes are in `prototypes/codex-launcher/README.md` and `prototypes/codex-launcher/macos/README.md`.

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
POST /v1/sessions/:id/events/:event_id/delete
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
  "content_revision": 0,
  "next_after_sequence": 42,
  "has_more": false
}
```

Every event is expected to contain a stable `id`, monotonic per-session `sequence`, `idempotencyKey`, server-derived `actor`, timestamp, visibility, optional reply target, payload, and optional runtime provenance. The UI orders exclusively by sequence.

New projects start with no sessions. Owners may create `solo` or `multi`; participants may create only a personal `solo`; viewers see no creation action. Project and session names are trimmed, limited to 1–200 characters, and reject C0/C1 control characters while retaining ordinary Unicode. Project owners can rename `multi`, while each Solo creator can rename that Solo. A successful rename updates the open title and project sidebar immediately; metadata-only `session_state_change` events apply the same update in other clients subscribed to that session.

### Invitations and credentials

- Owners create project-level participant or viewer invitations that expire after 1 hour, 24 hours (the default), or 7 days.
- Participants can write and run their own agent in `multi`, create/write their own personal Solo, and read every other Solo. Project owners also read participant-created Solos rather than overriding them. Viewers are read-only across the project. Owners can change every other member's project role later.
- The invitation secret is returned only by creation and cannot be recovered from the invitation list. Copyable invitation information includes a one-use same-origin `#invite=` link and a key fallback. The recipient's link parser clears the fragment before session restoration; invitation secrets are not stored in Web Storage.
- A new user first registers with verified email and password, then explicitly confirms joining the invited project. No account access token is displayed. Invitations do not register accounts or replace email verification.
- An already signed-in user can accept an invitation without rotating or replacing their existing credential.
- Pending invitations can be revoked. Claimed, revoked, and expired records remain visible to the owner without exposing their secret.

### Codex downloads and connector state

- Owners and participants in multi sessions, plus a personal Solo's creator, retain live collaboration controls. Any member observing another person's Solo and all viewers instead receive a one-way “Download to Codex / 下载到 Codex” action.
- Each click creates an independent frozen snapshot through the server-returned `through_sequence`. A queued request means the server is waiting for a local snapshot connector; it does not mean a local task already exists.
- The UI polls only the individual in-memory request IDs and renders queued, claimed, importing, compacting, completed, and failed states. Failed requests retry by creating a new snapshot. Completed records show the local task or thread name returned in `result`.
- Live sessions normalize connector state into Synced, Offline with an optional pending count, Reconciling, Rebuilding, or Local fork. A runtime with `purpose: snapshot_connector` never enables the agent execution control.

### Manual history summaries

Session writers can select 1–100 loaded public messages or completed summaries, then explicitly confirm generation with their own currently selected online Agent, exact runtime, model, and effort. Pending/failed messages and generated summary prompts cannot be selected. The serialized source limit is 20 KiB with no truncation; an uncertain transport retry preserves the same idempotency key. A new retry or regeneration is offered only after a definitive rejection or terminal response, never automatically.

Summaries are shared, lossy derived Markdown. The default display folds the newest whole non-overlapping versions at their first original source; undeleted originals and valid older versions remain available. Selected earlier summaries expand to their original ancestry for overlap handling. Per-card/global display switches do not change Agent context injection or delete history. Readers may inspect valid versions; only session writers may regenerate, using their own Agent.

Settings expose summary instructions (browser preference, shared on generation; never enter secrets) and a separate server-backed context policy scoped to the current user/project. Summary mode reduces context but may lose details; original mode includes the original public messages and uses more context. This applies to future Agent requests started from the GatherThread Web app and explicit MCP context reads. It does not rewrite a running turn, remove existing Codex Desktop task history, or replace history already injected into ordinary DSH sessions. Already-loaded history remains managed by native automatic compaction. Generation uses the writer's selected local or Cloud Agent and may consume model quota. Only selected records are supplied as its shared-history context. A local summary is not a sandbox from local tools/files; a Cloud summary does not include project code.

### Delete your own messages / 删除自己发出的消息

With write access, use the trash icon beside your own chat, Agent request or Agent reply, then confirm. Owners cannot delete other members' messages. Deleting a request also removes its linked replies and work; dependent summaries and later generated work that may have used it become unavailable. The body becomes a placeholder; message identity, sequence, type, author, time and reply references remain.

All future GatherThread-prepared Agent history will exclude deleted content and invalidated results, including original-history mode and downloads of older history. Start a new request after history changes; update and reconnect an older connector if prompted. For the affected conversation, older GatherThread-created local tasks remain local-only and are not uploaded again.

Deletion does not roll back already executed file changes or erase other members' independent messages, manual reposts, existing local files/conversations, provider requests or independent copies. Physical erasure is not instantaneous. Backup, unreachable GT Cloud Git and log retention remain subject to the [privacy notice](../../site/privacy/index.html); see [ADR-0050](../../docs/adr/0050-author-message-erasure-and-context-revisions.md) for the canonical erasure/rebuild contract.

有发言权限时，点击自己的聊天消息、Agent 请求或 Agent 回复旁的垃圾桶，再确认删除。创建者也不能删除其他成员的消息。删除请求会同时删除关联回复和工作过程；依赖它的摘要及可能使用过它的后续生成内容会失效。正文变为占位提示，消息标识、顺序、类型、作者、时间和引用关系仍保留。

后续由 GatherThread 整理给 Agent 的历史不再包含已删除内容和失效结果，包括选择原文或下载较早的历史。历史变化后请重新请求；如提示连接器需要更新，请先更新并重新连接。受影响的旧共序本地会话仍保留为仅本地副本，不会再上传。

删除不回滚已经执行的文件改动，也不删除其他成员的独立消息、手工重发的副本、原有本地文件或会话，无法撤回已发给模型的内容或独立副本。物理清除不是瞬间完成；备份、不可达 GT Cloud Git 对象和日志保留规则见[隐私说明](../../site/privacy/index.html)，具体删除与重建规则见 [ADR-0050](../../docs/adr/0050-author-message-erasure-and-context-revisions.md)。

After a build, run `tests/browser/message-deletion.mjs` with `PLAYWRIGHT_MODULE_PATH` set to an existing Playwright installation. Its disposable loopback fixture uses real HTTP, HttpOnly cookies, SQLite and WebSocket delivery without external providers. Ordinary click/tap cases cover bilingual desktop, phone and tablet layouts in Chrome and Playwright WebKit, author/read-only/other-member controls, uncertain retries, derived summaries/quotes/mentions, drafts, focus, scroll position and stale deliveries. WebKit emulation is not native Safari or physical-device verification.

## Server integration notes

`HttpCollaborationApi` normalizes the server's snake_case `{data: ...}` envelope into the UI model. Server-calculated roles remain the security boundary. `SessionSync` ignores duplicate delivery, buffers out-of-order live events, recovers gaps by HTTP replay, accepts authoritative cursor jumps across visibility-filtered events, and invalidates callbacks from a previously selected session. A `message_deleted` control invalidates cached content and reloads authoritative history from zero; the separate `content_revision` fence rejects stale replay and WebSocket bodies. Quotes, mentions, summary sources and private task previews are refreshed rather than restored from older cached text.

## First-release limits

- Email/password login creates a browser session; transient passwords and OTPs are cleared from JavaScript. Recovery signs out every device and revokes Agent access without changing projects or roles. The default is a 24-hour server-side session held in a non-persistent `HttpOnly; SameSite=Strict; Path=/` Cookie. **Remember this device** uses a 30-day persistent Cookie instead. HTTPS adds `Secure` and `__Host-`. Reload restores the workspace; logout, device revocation, and token rotation revoke either session. Cookie-authenticated writes require an exact allowed Origin. Neither bearer nor browser token is placed in Web Storage or a URL.
- The Launcher email hint is non-secret and bound to the signed-in user. It lasts at most one day in sessionStorage, or 30 days in localStorage with Remember this device, and is cleared on logout. It does not authorize any action. Passwords, OTPs and credentials remain excluded. Existing restored sessions without a hint enter their email once; server identity remains digest-only.
- Project owners can change participant/viewer roles. There is no member-removal UI, attachment upload, reply UI, offline outbox, search, or runtime selection yet.
- The mock emits illustrative agent responses; real responses use the local bridge claim/complete workflow.
- An unanswered `agent_request` shows an accessible pulsing response indicator while its local runtime is online. If the runtime disconnects, the indicator changes to a static queued state and disappears only when a canonical linked response arrives.
- Linked `agent_progress` renders growing answers and available native-visible Thinking, Tool and Plan sections across Codex, DSH and Cloud Agent. Snapshots replace by request/stream/highest revision, including interleaved or replayed delivery; legacy delta history remains readable. Each section has a persistent arrow toggle. Paused partial work stays readable; focus and manually scrolled history stay in place. Copy/quote use the latest real canonical snapshot, while a quote to an earlier revision reveals that exact stored text. Rapidly updating bodies are intentionally not live regions. Final answers remain primary and use safe GFM plus locally bundled, bounded KaTeX. Raw HTML, dangerous links, hidden Codex reasoning and automatic remote Markdown image requests remain excluded. Matching connector/plugin and hosted image builds are needed; a Web update alone does not upgrade them.
- Drafts survive a temporary socket loss in memory, but not a full reload.
- The app is plain ES modules and CSS to remain independently runnable while the monorepo toolchain is still being created.
