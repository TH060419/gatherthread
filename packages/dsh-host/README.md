# GatherThread DeepSeek Harness Host bundle

This publish-ready, opt-in package binds the writable Sessions of one
GatherThread Project to distinct DeepSeek Harness Sessions. Installing the
package adds its identity-marked DSH profile layer; without that explicit
installation, GatherThread does not load in DSH or alter the GatherThread
server, Web app, Codex bridge, or Claude adapter.

The normal path is the published `@deepseek-ai/dsh` CLI, not a DSH source
checkout. This build's profile layer targets `0.2.1-rc.2`, the release bundled
with the DeepSeek Harness desktop application, and serves both the `desktop` and
`web` profiles of that release. The legacy source-only diagnostic remains fixed
to `dsh-v0.1.7-rc.2`, commit `477b4f420553e8a52c2fbccc464d7561b239c443`; it is
not an automatic fallback for the current layer. All version-sensitive Host calls remain inside
`src/dsh-compat.ts`. The package does not install a DSH runtime dependency.

### Supported releases

| DSH release | Profile | Profile layer |
|---|---|---|
| `0.2.1-rc.2` (desktop app and `npx` Web) | `desktop`, `web` | `cordis.patch.yml` |
| `0.1.7-rc.2` | `web`, `headless` | Immutable published `0.1.0-beta.2` artifact; `cordis.patch.dsh-0.1.yml` is its frozen source reference |

`package.json` declares `engines.dsh: ">=0.2.1-rc.2 <0.3.0"` and the same range
for an optional `@deepseek-ai/dsh` peer. Newer DSH checks `engines.dsh`; older
`0.1.7-rc.2` ignores that field but checks the peer range before composing any
bundle patch. An incompatible bundle is therefore refused before it can alter
Connection. The optional peer does not install a DSH runtime. Use the immutable
published `0.1.0-beta.2` artifact on `0.1.7-rc.2` instead: `0.2.1-rc.2` renamed
Connection's trust service from `webRuntime` to `webStartup`, and one static row
cannot inject both. The frozen YAML is a reference, not an alternative install
for this build; the current manifest always selects `cordis.patch.yml`. This
source change does not replace the published Beta 2 npm artifact.
[ADR-0058](../../docs/adr/0058-dsh-desktop-profile-and-version-gated-plugin-layer.md)
records the boundary.

## Plugin-first connection

Use **Connect DeepSeek Harness → Download packages for this server** in GatherThread to download its source-matched DSH plugin TGZ. Replace the example path below with the downloaded file's full path:

```text
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add "/absolute/path/to/LOCAL_DSH_PLUGIN.tgz"
npx @deepseek-ai/dsh@0.2.1-rc.2 web
# In DSH: Settings -> GatherThread / 共序 -> Sign in and pair
```

The desktop application manages its own `desktop` profile, so install into that
profile from its bundled CLI instead of starting a second Web server:

```text
dsh plugin --profile desktop add "/absolute/path/to/LOCAL_DSH_PLUGIN.tgz"
```

On Windows, use a quoted path such as `C:/Users/you/Downloads/your-plugin.tgz`. The registry's `@gatherthread/dsh-host@0.1.0-beta.1` is an older build and does not include the current message-deletion safeguards. If server downloads are unavailable, [build the matching source checkout](../../docs/DSH_CONNECT.md#source-checkout-fallback); do not substitute the old npm build.

Check the pinned CLI with `npx @deepseek-ai/dsh@0.2.1-rc.2 --version`. The normal start
command already pins `0.2.1-rc.2`. The pinned DSH does not
expose the root CLI version as a stable Host service, so the package does not
inspect npx cache paths or claim runtime-version introspection. The install
command pins the exact verified CLI, while every required Host/Client service is
validated structurally and fails closed before a request can be claimed.

`dsh plugin --profile web add` is the pinned DSH release's official package installation
mechanism. It initializes a missing `web` profile on first use, invokes pnpm,
and appends only packages declaring `dsh.bundle`. The pinned DSH has no verified
public plugin marketplace, marketplace index, or registration workflow. This
repository change prepares the package but does not publish it or modify a real
DSH profile.

Inside DSH, choose the GatherThread public service or enter one custom
server origin. The same field covers an HTTPS LAN host, self-hosted deployment,
or Tailscale address; plain HTTP is accepted only on loopback. The plugin opens
an outbound HTTPS connection. A five-minute, single-use short code is confirmed
through a signed-in GatherThread email account. Project invitations grant
membership only and cannot authorize pairing. Signup is closed by default. The resulting long-lived device
grant is stored only by DSH's credential service and never appears in argv, a
URL, browser storage, logs, status RPC, or shared history. Once paired, the
plugin reconnects automatically whenever DSH starts.

Before removal, use **Disconnect** inside the DSH panel to clear the local
grant, then run:

```text
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web remove @gatherthread/dsh-host
```

The official command removes only this package dependency and profile layer;
other plugins remain untouched. The repository-level `npm run dsh:connect --
--help` source-checkout connector and the examples under `bundle/` remain
advanced/offline diagnostics, not the normal user path.

## GitHub code synchronization

Beta 2 includes direct GitHub controls and requires matching server, Web app and native plugin releases. The project owner first connects an existing repository and base branch in Web. Install Git 2.38+ and GitHub CLI on the device, then open **Settings → GatherThread / 共序 → 项目代码 · GitHub（推荐）**. Click **连接 GitHub · 打开浏览器** to start local browser sign-in if needed, then authorize that exact project/repository configuration. `gh auth login --hostname github.com --git-protocol https --web` remains a local fallback. This consent is separate from GT Cloud and conversation sync; a new GitHub binding automatically uploads settled changes while idle and can be switched off. Configuration changes, including pause/resume, require renewed local authorization.

The Web app may request code operations only on your selected online runtime and cannot grant this local consent. Code and GitHub credentials travel directly to GitHub. GitHub permissions remain independent of GT membership; removing a GT member or project does not revoke GitHub access or delete GitHub data. See [Project code collaboration](../../docs/CODE_SYNC.md) for setup, recovery, limits and GitHub workflow-trigger risks.

GitHub 接入仍为**未发布源码预览**，需使用匹配的服务端、网页与原生插件源码构建，不能假定固定版本 npm 包已支持。在网页配置现有仓库后，每台设备安装 Git 2.38+ 与 GitHub CLI，再进入 **Settings → GatherThread / 共序 → 项目代码 · GitHub（推荐）**，点击“连接 GitHub · 打开浏览器”完成本机登录，并核对、逐项目授权。终端命令仍可作为保底。GitHub、GT Cloud 和会话同步分别授权；新 GitHub 绑定在 Agent 空闲时会自动上传稳定改动，可关闭且重连后保持关闭。配置变化及暂停后恢复需重新本地授权。网页不能替代本地文件授权，共序成员变化或项目删除不会撤销 GitHub 权限或删除 GitHub 数据。完整流程见[项目代码协作文档](../../docs/CODE_SYNC.md)。

## Security and recovery

Only allowlisted public text/tool fields leave DSH. An exact GatherThread-claimed
prompt can additionally stream native-exposed thinking and real plans. The live
listener verifies owned Agent, Session and execution; the npm fallback requires
DSH's genuine Agent-loop marker rather than a model-name match. Raw request
bodies, headers, replay state, tool-private metadata and unrelated native streams
stay outside the mapper. Tool arguments are parsed and redacted before upload;
incomplete JSON emits only a preparation marker. The connector holds one active request, persists a private atomic
cursor/outbox, reuses DSH's official Session resume/repair path, and releases its
listeners, timer, HTTP abort signal, Agent handle, and write ownership on unload.

The `web` profile discovers `client/client.js` through DSH's official
`dsh.client` declaration. The settings Slot uses DSH's authenticated native RPC
carrier for pairing, configuration, and bounded status. The legacy status route
is read-only and available only when native RPC is absent. Both paths stay
behind DSH's same-origin Cookie/Host/Origin checks, and neither sends an
authorization header to the browser. A permanent 4xx clears displayed project
and Session details and stops polling; transient failures receive only three
bounded retries.

Host and browser lifecycles are intentionally separate. Disabling the Host
Loader entry immediately unregisters the status and RPC routes. Client bundle HMR uses
the official client-module SSE/fiber refresh path, which drains the previous
Slot and timer before registering one replacement. The earlier `0.1.7-rc.2`
native/browser gate checked that adding or removing a package from the client
graph is observed by a newly loaded page, not treated as Host-entry disposal.
That complete flow has not yet been re-run with the new `0.2.1-rc.2` pin.

## Project binding

`bindingMode: project` discovers Sessions only through the existing
`GET /v1/projects/:project_id/sessions` and authenticates identity through
`GET /v1/me`. Viewer Sessions are never writable. A Solo Session is writable
only by its `owner_user_id`; Multi Sessions use the authoritative owner or
participant role. A 403 or 404 Project response stops every Session binding for
that Project, while a
transient discovery failure preserves the last safe set and retries with a
bounded exponential delay.

Every eligible Session has its own DSH Session id, HTTP abort scope, connector
state file, runtime identity, heartbeat, canonical cursor and durable outbox.
The project gate bounds the whole claim-to-settlement operation. Claims are
leased and renewed by accepted progress, so a Session that stops producing work
releases its request for the exact recorded runtime to reclaim; the gate still bounds this
connector's own concurrency while it holds one. Removing or downgrading a Session
cancels its queued permit before it can claim a request. Existing single-Session configuration remains
valid when `bindingMode` is omitted; both modes resolve the real current actor
before applying Solo permissions.

During an active claimed prompt, selected native-visible answer, thinking, tool
and plan updates coalesce into bounded redacted snapshots. Generic activity
markers carry no native content and remain separate from presence. Accepted
progress renews the exact claim attempt. Progress, completion,
and request-linked tool outbox entries are rebound to the renewed attempt after a
crash recovery, while stale attempts remain fenced by the server.

The installed native plugin stores one account-level model route and reconciles
every active Project visible to the paired GatherThread identity. Adding a
Project starts its isolated manager without another pairing step. Archiving a
Project or revoking access stops only that Project manager; its local workspace
and DSH Session history are retained. A failure in one Project does not stop
healthy peers, and discovery retries periodically.

For a `deepseek-official` route, the plugin also advertises the exact models and
reasoning efforts returned by DSH's public LLM catalog. The GatherThread work
page may select one advertised combination for an individual Agent request.
That selection is installed only on the borrowed Agent while the request runs
and is removed in `finally`; it does not rewrite DSH Web's saved model choice.
Unsupported combinations fail closed. Older plugins and non-DeepSeek routes
retain the account route's fixed provider and model.

An existing schema-v1 single-Project pairing keeps its device credential when
the plugin is upgraded, but deliberately drops the old model binding. The user
must choose the DSH model and explicitly select **Connect all accessible
Projects** once; the migration never broadens the former Project scope in the
background. Likewise, an obsolete Client that still submits `projectId` is
rejected instead of silently treating that choice as account-wide consent.

Each Project uses the same marker-validated `~/GatherThread Projects/<name>`
workspace as the Codex connection path. The plugin registers that directory
through DSH's public `workspaceRegistry` service, including for viewer-only
Projects, but creates and attaches native Agent Sessions only for Sessions the
paired actor may edit. Existing GatherThread Session titles are applied through
the public `sessionTitle` service, flushed, and then attached to the Project
workspace so they appear in DSH's native work page. No private DSH persistence
file is read or modified. GatherThread-origin conversations use DSH's ordinary
editable `standard` preset; an obsolete read-only projection is detached from
the workspace after its editable replacement is durable, without deleting the
old local log.

For an owner or participant, the first successfully completed human/assistant
turn in a new DSH conversation creates one creator-owned cloud Solo with the
same stable Session identity, then uploads that turn atomically. The live Agent
remains owned by DSH while GatherThread borrows its public handle, so neither
side disposes the other's conversation. Empty conversations, failed turns, and
all viewer conversations remain local-only. Creation and turn upload are both
idempotent across refreshes and reconnects.

## Native bidirectional history

Canonical history is replayed in server sequence order through DSH's public
`Session.append(..., { surfaceOp: "append" })` API and acknowledged only after
the public Session flush completes. Human requests use ordinary identified user
messages. External Agent answers use identified `gatherthread` plugin relay
messages with visible attribution; this keeps them model-visible without
forging an `assistant/message` whose provider stream could not pass DSH's
restore invariants. Stable `gatherthread:<event-id>` message IDs make a retry
after an uncertain cursor save harmless.

A complete turn typed directly in the bound DSH Session is flushed, reduced to
public request/final-answer text, and stored in the private connector outbox
before one atomic `commitLocalTurn`. Reasoning, raw streams, replay state and
private tool metadata never enter that commit. Transport failures retain the
same local-turn ID for idempotent replay. Canonical events attributed to the
same runtime advance the projection cursor but are not appended back to DSH,
while events written through another harness are imported normally. V1
connector state deliberately restarts only the native projection cursor at zero
once so history that the earlier poller observed but discarded is backfilled.

Automatic upload is stored independently for every bound DSH conversation and
defaults on. In **Settings -> GatherThread / 共序**, the user can switch it off
without stopping cloud-to-local projection, or choose **Manual upload** to scan
and send completed eligible local turns. The manual action is also the recovery
path after a missed native event or transport interruption, uses the existing
durable idempotent outbox, and never silently re-enables automatic upload.

## Native collaboration workspace prototype (latest DSH)

This branch adds **GatherThread / 共序** to DSH's sidebar using the official main
panel Slot. Prototype development targets **DSH 0.2.2-alpha.2**, the newest
published alpha checked on 2026-10-30. The older release instructions and
compatibility matrix above describe the existing connector baseline, not a
requirement to downgrade a newer DSH installation.

1. Build a local package: `npm run build:ts && npm run build:dsh-plugin`, then
   `npm pack --workspace @gatherthread/dsh-host --ignore-scripts`.
2. In a matching latest Desktop installation, use its bundled CLI:
   `dsh plugin --profile desktop add "/absolute/path/to/gatherthread-dsh-host-0.1.0-beta.6.tgz"`.
   Restart DSH. Never start the Electron-owned desktop profile from a second CLI.
3. In **Settings → GatherThread / 共序**, pair your account and select the local
   provider/model using the existing connection flow.
4. Open **GatherThread / 共序** in the sidebar, then select a project and session
   from the workspace's left column. Search filters the session list without
   changing the active conversation. The middle column holds shared messages
   and the composer; the right column shows members and shared context.
   **发送聊天** sends only a human message. **请求本机 DSH** explicitly starts an
   Agent request on this device. The **DSH · 推理强度** button below the composer
   opens model/reasoning selectors using the native runtime's available catalog.
   They do not overwrite the saved connection default.
5. **＋ 新建会话** creates a Multi conversation or private Solo; **重命名** is
   available to session managers. **引用** links a canonical message rather than
   copying it into the outgoing prompt. **复制** copies the displayed text.
6. Once an ordinary local request is running, **暂停 Agent** pauses its claim.
   **继续 Agent** starts a new request with the original model and current shared
   context, preserving an unsent chat draft. It does not restore internal thought.
7. Expand **共享上下文 → 查看当前上下文** to preview the effective shared context.
   On narrow panels, **成员与上下文** opens a dialog instead of squeezing the
   conversation. Execution progress remains expandable. Messages show
   their participants, Agent progress/replies, and fixed failure notices.
8. Shared messages use the host's **MarkdownText**, code highlighting, math and
   tables. Click an image to open DSH's native lightbox; broken images show a
   fallback. **查看原文** switches to source, **展开长消息** reads a longer bounded
   canonical message, and **复制展开内容** copies that displayed expansion.
   Members use the same catalog avatars as Web; replies add the Agent badge to
   the verified execution owner's avatar.
9. A relative Markdown file link opens a read-only local-project preview using
   the existing file safety checks. Missing/oversized/binary files give recovery
   guidance and a native file-panel entry. This is the local copy, not the
   sender's original attachment. HTTP(S) links remain ordinary external links;
   this change does not add binary uploads or authenticated remote attachments.

The isolated latest-runtime check used an official package installation in a
custom Web profile (the shared Desktop UI/Host stack), a local GT server and a
mock model. It verified that another member's shared message reaches the actual
DSH provider request, that the reply returns to canonical history, and that a
second request succeeds after restarting DSH with the same saved conversations. It did not
upgrade the user's app, use paid models or test an installed latest Electron
binary. Chromium and Safari checks cover the native workspace; Safari additionally
verifies native select menus, Chinese input, chat receipts and context previews.

V4 compatibility can also be checked without a model or user profile. Set
`GATHERTHREAD_TEST_DSH_V4_MODULE` to the absolute `@deepseek-ai/dsh-session/lib/index.js`
path in an isolated latest DSH installation, then run
`node --test packages/dsh-host/dist/test/dsh-v4-replay.test.js` after the TypeScript
build. This uses DSH's own storage relationship validator and restore API to cover
shared imports, native permission metadata, context replacement, reconnect and
deletion-safe projections. Existing malformed local sessions are preserved and
refused; the prototype does not silently rewrite their history.

Drafts and pending request identities remain in memory across panel navigation;
copy important drafts before reloading DSH. After a missing receipt, use
**重试同一次发送** to reuse the request identity. If choosing **保留草稿，结束重试**,
check shared history before sending it as a new request. An offline local Agent
never silently routes to another device/model.

**管理我的 Agent**, beside the model selector, opens local connection settings
or explicitly labelled **前往网页版** links for Agent sharing and Agent Teams. These links open the current project in a separate browser tab (the system browser in DSH Desktop); choose the corresponding feature under **管理我的 Agent** there. Browser authentication is separate from DSH pairing. A local test server must serve the built Web app as well as `/v1`; an API-only fixture cannot open a working management page. The dialog shows the target URL, next step, and a copy fallback after clicking.

Workspace controls and dialogs reuse the host-provided `@deepseek-ai/dsh-client-ui-primitives` Button, Modal, and product icons, plus official `--dsw-*` theme tokens. Older hosts without the atoms retain a basic accessible HTML fallback. No upstream source, theme bundle, or private desktop API is copied into the plugin.
These links use the paired server and selected project/session; they contain no
device grant and may require a separate Web sign-in. Full sharing/Team editors
and project administration have not yet been migrated into the native panel.
The existing connection settings retain their Git controls. Architecture and limits:
[ADR-0065](../../docs/adr/0065-dsh-native-collaboration-workspace.md).

In the collaboration workspace, **文件 / Files** opens local previews and
comparisons or GT-cloud/GitHub branches, text editing and commit history.
**Git 同步 / Git sync** opens the current project's existing synchronization
controls. Native DSH file preview opens the exact connected conversation.
Local files remain private unless the user explicitly adds a text excerpt to a
chat draft and sends it. Local editing, binary attachments and advanced Git
review/merge still use existing native/Web tools. See the canonical
[prototype scope](../../docs/PRODUCT_SPEC.md#dsh-collaboration-workspace-prototype)
and [RPC limits](../../docs/INTERFACE_CONTRACTS.md#dsh-workspace-rpc-prototype).

### Beta 6 alignment

The prototype is based on main `ec69ada` (Beta 6, 2026-10-30), including the
reviewed Web updates in #124, #126 and #127. Team presets, versioned JSON
import/export and AI-assisted configuration remain available through the
workspace's **Manage my Agents → Agent Teams** Web entry. Browser preferences
remain browser-local; they do not override DSH's native theme or permissions.

A private Solo created in this DSH panel is a cleanup candidate only during this
Client lifetime. Switching projects/conversations asks the server to discard it
only if no submitted content exists. Chat drafts, file drafts and uncertain send
receipts retain the conversation. Server-side atomic checks preserve concurrent
writes and deny other users' Solo/Multi. Failed cleanup shows a retained-session
notice; an older server never falls back to unconditional deletion. Closing the
entire panel/process may leave an empty Solo, which can be managed on Web.

DSH public Button, Modal, icons, theme tokens, main/sidebar Slots and native file
navigation remain reused. The official master interfaces were also checked at
`ce7073d512`; the isolated runtime is the current published alpha
`0.2.2-alpha.2` (the npm `latest` line is `0.2.1-rc.5`). No private UI module or
second copy of DSH's window chrome is introduced.
