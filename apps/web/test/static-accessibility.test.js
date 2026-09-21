import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("../index.html", import.meta.url));
const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
const apiPath = fileURLToPath(new URL("../src/api.js", import.meta.url));
const stylesPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
const domainPath = fileURLToPath(new URL("../src/domain.js", import.meta.url));
const i18nPath = fileURLToPath(new URL("../src/i18n.js", import.meta.url));
const dshPath = fileURLToPath(new URL("../src/dsh.js", import.meta.url));
const manifestPath = fileURLToPath(new URL("../site.webmanifest", import.meta.url));
const brandLightPath = fileURLToPath(new URL("../brand/lockup-color-transparent-light.svg", import.meta.url));
const brandDarkPath = fileURLToPath(new URL("../brand/lockup-color-transparent-dark.svg", import.meta.url));

const brandedIconHashes = new Map([
  ["android-chrome-192x192.png", "f94f61adcee6cf206813081db0d286bbfde7f49445fcdb3f2c9da4f8892c2fce"],
  ["android-chrome-512x512.png", "d1f713c5434387b9ae0dcc5a25c9846bb2e6b9d9d9bd449627a634f295a6a0b8"],
  ["apple-touch-icon.png", "add47d2906d2e948164c888f55553294d04bb7def730dae64049ff0ec4f2fb7f"],
  ["favicon-16x16.png", "9129a203731aa9a79507337413ad8fad72598cb12c9f1fc0e3f679785eb2b446"],
  ["favicon-32x32.png", "b4a73786d625adcd01383dcf560c1ee53d08f326005d66ebc091716e80e91cc9"],
  ["favicon.ico", "26ea324379621f9b9bb48bb7ea4a47640def8e8bb2f6768b24105dacf69545ba"],
]);

test("site icons retain GatherThread identity without forcing standalone launch behavior", async () => {
  const [html, manifestText] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  for (const reference of [
    'href="./favicon.ico"',
    'href="./favicon-32x32.png"',
    'href="./favicon-16x16.png"',
    'href="./apple-touch-icon.png"',
    'href="./site.webmanifest"',
  ]) {
    assert.match(html, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.name, "GatherThread");
  assert.equal(manifest.short_name, "GatherThread");
  assert.equal(manifest.theme_color, "#FBFAF7");
  assert.equal(manifest.background_color, "#FBFAF7");
  assert.equal(Object.hasOwn(manifest, "display"), false);
  assert.deepEqual(manifest.icons.map((icon) => icon.src), [
    "./android-chrome-192x192.png",
    "./android-chrome-512x512.png",
  ]);
  for (const [file, expectedHash] of brandedIconHashes) {
    const icon = await readFile(new URL(`../${file}`, import.meta.url));
    assert.equal(createHash("sha256").update(icon).digest("hex"), expectedHash, `${file} must use the approved app icon`);
  }
});

test("the shell exposes landmarks, labelled forms, status regions, and separate send controls", async () => {
  const [html, main, styles] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  for (const requirement of [
    'class="skip-link"',
    'class="auth-mark-motion auth-thread-field"',
    'class="auth-canonical-extension" aria-hidden="true"',
    '<span class="headline-line">One room,</span>',
    '<span class="headline-line">Many minds.</span>',
    '<nav id="session-rail" class="session-rail"',
    'id="main-content"',
    '<aside id="member-panel"',
    'aria-live="polite"',
    'for="token"',
    'id="send-chat-button"',
    'id="send-agent-button"',
    'id="claim-invitation-form"',
    'for="claim-invite-secret"',
    'id="accept-invitation-form"',
    'for="accept-invite-secret"',
    'id="create-invitation-form"',
    'for="invitation-role"',
    'for="invitation-ttl"',
    'id="created-invitation" class="created-invitation" role="status" aria-live="polite" hidden',
    'id="invitation-list" class="invitation-list" aria-label="Project invitations"',
    'id="project-select"',
    'id="create-project-form"',
    'id="rename-project-button"',
    'id="rename-project-dialog"',
    'id="rename-project-form"',
    'for="rename-project-name"',
    'id="rename-project-error" class="form-error" role="alert"',
    'id="rename-session-button"',
    'id="rename-session-dialog"',
    'id="rename-session-form"',
    'for="rename-session-name"',
    'for="rename-session-mode"',
    'id="rename-session-error" class="form-error" role="alert"',
    'id="download-codex-button"',
    'id="connector-status" class="connector-status"',
    'id="import-visible-history-button"',
    'id="snapshot-request-error" class="form-error" role="alert"',
    'id="snapshot-request-list" class="snapshot-request-list" aria-label="Codex snapshot downloads"',
    'id="connect-codex-button"',
    '<span>Connect Codex</span>',
    'id="settings-button"',
    'id="settings-dialog"',
    'id="attention-notice" class="attention-notice" role="status" aria-live="assertive" aria-atomic="true" hidden',
    'id="dismiss-attention-notice" class="attention-notice-dismiss" type="button" aria-label="Dismiss notification"',
    'id="settings-locale"',
    'id="settings-ambient-canvas"',
    'id="settings-composer-height"',
    'id="session-access-note"',
    'id="composer-layout-resizer"',
    'aria-label="Resize message composer"',
    'aria-orientation="horizontal"',
    'id="connect-codex-dialog"',
    'aria-labelledby="connect-codex-title"',
    'id="connect-codex-activation"',
    'data-copy-command="posix"',
    'data-copy-command="powershell"',
    'data-copy-command="marketplace"',
    'id="copy-posix-command-status"',
    'id="copy-powershell-command-status"',
    'id="copy-marketplace-command-status"',
  ]) {
    assert.match(html, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /value="pronounced">Pronounced</);
  assert.doesNotMatch(html, /Subtle · recommended/);
  assert.equal((html.match(/brand\/lockup-color-transparent-light\.svg/g) ?? []).length, 2);
  assert.equal((html.match(/brand\/lockup-color-transparent-dark\.svg/g) ?? []).length, 2);
  assert.match(html, /M72 66 C210 62 218 190 356 194 C438 196 442 300 525 314/);
  assert.match(html, /M38 442 C176 438 225 338 350 336 C430 335 462 324 525 314/);
  assert.match(html, /M166 560 C254 470 283 434 376 390 C444 358 474 326 525 314/);
  assert.match(html, /M525 314 C610 314 672 314 760 314/);
  assert.equal((html.match(/class="auth-thread-traveler"/g) ?? []).length, 7);
  assert.match(html, /id="settings-button"[^>]*aria-label="Open Settings"[^>]*title="Settings"[^>]*data-tooltip/);
  assert.match(html, /id="rename-session-button"[\s\S]*?aria-label="Rename session"[\s\S]*?title="Rename"[\s\S]*?<svg/);
  assert.match(html, /id="delete-session-button"[^>]*aria-label="Delete"[^>]*title="Delete"[^>]*data-tooltip/);
  for (const color of ["#20C1DC", "#2E96F5", "#A766F0", "#F66DB9"]) {
    assert.match(html, new RegExp(color));
  }
  assert.doesNotMatch(html, /#08B9D8|#168AF4|#9A50EE|#F456AE/);
  assert.doesNotMatch(html, /class="brand-mark(?: brand-mark-small)?"/);
  assert.match(main, /title\.title = session\.name/);
  assert.match(main, /element\("session-title"\)\.title = session\.name/);
  assert.match(main, /localizer\.t\("Continue"\)/);
  assert.match(styles, /\.session-button strong \{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.match(styles, /\.title-line h1 \{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.match(styles, /select:not\(:disabled\):hover/);
  assert.match(styles, /html\[lang="zh-CN"\] \.agent-request-profile select/);
  assert.match(styles, /\.composer \.agent-request-profile \{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.composer \.agent-request-profile select \{[\s\S]*?-webkit-appearance:\s*none;[\s\S]*?appearance:\s*none/);
  assert.match(main, /const enabledHarnesses = currentProjectEnabledHarnesses\(settings\)/u);
  assert.match(main, /connectorGuidance = enabledHarnesses\.map/);
  assert.match(styles, /\.composer-layout-resizer[\s\S]*?cursor:\s*row-resize/);
  assert.match(main, /installComposerLayoutResizer\(composerLayoutResizer\)/);
  assert.match(main, /renderMarkdown\(content\)/);
  assert.match(main, /renderProgressDisclosure\(progressByRequest\.get\(event\.replyTo\), false\)/);
  assert.match(main, /details\.open = live/);
  assert.match(main, /expandedWorklogs\.has\(worklogId\)/);
  assert.match(main, /details\.addEventListener\("toggle"/);
});

test("official light and dark lockups include the approved mark and outlined wordmark", async () => {
  const [light, dark] = await Promise.all([
    readFile(brandLightPath, "utf8"),
    readFile(brandDarkPath, "utf8"),
  ]);
  for (const asset of [light, dark]) {
    assert.match(asset, /viewBox="0 0 890 145"/);
    assert.match(asset, /M50 135 H158 C210 135 245 215 298 240/);
    assert.match(asset, /M50 42 H167 C241 42 320 184 404 184 H540/);
    assert.match(asset, /#20C1DC/);
    assert.match(asset, /#F66DB9/);
  }
  assert.match(light, /color="#111318"/);
  assert.match(dark, /color="#FFFFFF"/);
});

test("project Codex connector presents a concise Alpha install-connect-confirm flow", async () => {
  const [html, main, domain, styles, i18n] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(domainPath, "utf8"),
    readFile(stylesPath, "utf8"),
    readFile(i18nPath, "utf8"),
  ]);
  assert.match(html, /Alpha preview/i);
  assert.match(html, /Official service is not open yet/i);
  assert.match(html, />1<\/span>[\s\S]*<h3>Install once<\/h3>[\s\S]*>2<\/span>[\s\S]*<h3>Connect this project<\/h3>[\s\S]*>3<\/span>[\s\S]*<h3>Confirm in Codex<\/h3>/);
  assert.match(html, /The terminal keeps this project connected/i);
  assert.match(html, /Review and enable the GatherThread Hooks/i);
  assert.match(html, /Keep the terminal open/i);
  assert.doesNotMatch(html, /Move to project|manual Desktop step/i);
  assert.match(html, /device token is requested by a hidden CLI prompt/i);
  assert.match(html, /only copies commands/i);
  assert.match(html, /codex: command not found/);
  assert.match(html, /npm install -g @openai\/codex/);
  assert.match(html, /codex plugin --help/);
  assert.match(html, /codex plugin marketplace add https:\/\/github\.com\/TH060419\/gatherthread\.git --ref v0\.1\.0-alpha\.5 --sparse \.agents\/plugins --sparse plugins\/gatherthread/);
  assert.match(domain, /--plugin-hooks/);
  const pluginCommands = (html.match(/id="connect-codex-marketplace-command"[^>]*>([^<]+)/)?.[1] ?? "")
    .replace(/\r\n?/gu, "\n");
  assert.equal(pluginCommands, "codex plugin marketplace add https://github.com/TH060419/gatherthread.git --ref v0.1.0-alpha.5 --sparse .agents/plugins --sparse plugins/gatherthread\ncodex plugin add gatherthread@gatherthread");
  assert.doesNotMatch(pluginCommands, /gta_|Bearer|cookie|token=|password|client_secret/i);
  assert.match(i18n, /Alpha 预览版/);
  assert.match(i18n, /"Install once": "仅需安装一次"/);
  assert.match(i18n, /如果终端提示.*codex: command not found.*npm install -g @openai\/codex.*codex plugin --help/);
  assert.match(i18n, /"Connect this project": "连接当前项目"/);
  assert.match(i18n, /"Confirm in Codex": "在 Codex 中确认"/);
  assert.doesNotMatch(html, /Codex <code>\/hooks<\/code>/i);
  assert.match(main, /projectCodexConnectionCommands\(\{[\s\S]*?baseUrl: location\.origin[\s\S]*?projectId: state\.project\.id/);
  assert.doesNotMatch(main, /connect-codex-move-project-name|renderCodexDesktopMoveGuide/);
  assert.match(main, /connectCodexDialog\.addEventListener\("close"[\s\S]*?returnFocus\.focus\(\)/);
  assert.match(main, /navigator\.clipboard\?\.writeText[\s\S]*?document\.execCommand\?\.\("copy"\)/);
  assert.match(main, /"Plugin install commands copied\."/);
  assert.match(styles, /\.codex-connect-dialog[\s\S]*?width: min\(760px/);
  assert.match(styles, /\.codex-cli-recovery-hint[\s\S]*?margin: 10px 0 12px 35px/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.command-heading[\s\S]*?flex-direction: column/);
  assert.doesNotMatch(main, /searchParams\.(?:set|append)\([^\n]*(?:device|token|credential)/i);
});

test("DeepSeek Harness is a selectable exact runtime with the same concise three-step guide", async () => {
  const [html, main, api, dsh, styles, i18n] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(apiPath, "utf8"),
    readFile(dshPath, "utf8"),
    readFile(stylesPath, "utf8"),
    readFile(i18nPath, "utf8"),
  ]);
  for (const id of [
    "connect-dsh-button",
    "connect-dsh-dialog",
    "connect-dsh-start-command",
    "connect-dsh-version-command",
    "connect-dsh-pinned-start-command",
    "connect-dsh-install-command",
    "connect-dsh-server-url",
    "connect-dsh-runtime-list",
    "approve-dsh-pairing-dialog",
    "approve-dsh-pairing-form",
    "approve-dsh-pairing-code",
    "agent-harness-select",
    "agent-dsh-runtime-select",
    "settings-agent-harness",
    "settings-dsh-runtime",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /value="deepseek-harness">DeepSeek Harness<\/option>/);
  assert.match(html, /Alpha preview/i);
  assert.match(html, />1<\/span>[\s\S]*<h3>Install once<\/h3>[\s\S]*>2<\/span>[\s\S]*<h3>Open DSH<\/h3>[\s\S]*>3<\/span>[\s\S]*<h3>Pair this server<\/h3>/);
  assert.match(html, /Official service is not open yet/i);
  assert.match(html, /The plugin connects outward/i);
  assert.match(html, /Verified DSH version: 0\.1\.2-rc\.1/);
  assert.match(html, /current local, LAN, self-hosted, or Tailscale server/i);
  assert.match(html, /single-use and expires shortly/);
  assert.match(dsh, /DSH_START_COMMAND = `npx @deepseek-ai\/dsh@\$\{DSH_NPM_VERSION\} web`/);
  assert.match(dsh, /plugin --profile web add @gatherthread\/dsh-host/);
  assert.doesNotMatch(dsh, /--dsh-source|(?:https?|dsh):\/\/localhost|deep[-_ ]?link/iu);
  assert.match(main, /api\.listSessionRuntimes\(sessionId\)/);
  assert.match(main, /dshExecutionProfile\(currentDshResolution\(\)\.runtime\)/);
  assert.match(api, /runtime_id: input\.executionProfile\.runtimeId/);
  assert.match(main, /resolveCodexRuntime\(state\.executionRuntimes\)/);
  assert.match(main, /codexExecutionProfile\(currentCodexResolution\(\)\.runtime/);
  assert.doesNotMatch(
    main.match(/function renderComposerPermissions\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "",
    /membership\.runtime/u,
  );
  assert.match(api, /provider: input\.executionProfile\.provider/);
  assert.doesNotMatch(main, /fetch\([^\n]*(?:localhost|127\.0\.0\.1)|new WebSocket\([^\n]*(?:localhost|127\.0\.0\.1)/iu);
  assert.doesNotMatch(`${main}\n${dsh}`, /(?:local|session)Storage[^\n]*(?:pair|token|credential)/iu);
  assert.match(styles, /\.connection-guide/);
  assert.match(styles, /\.connection-preview-banner/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.dsh-runtime-row/);
  assert.match(i18n, /不假设公共账户注册系统已经上线/);
  assert.match(i18n, /长期设备凭据只保存在 DSH 本机凭据库/);
});

test("read-only Codex downloads remain one-way and poll independent snapshot jobs", async () => {
  const [html, main, domain] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(domainPath, "utf8"),
  ]);
  assert.match(html, /frozen, read-only copy/i);
  assert.match(html, /never writes back/i);
  assert.match(main, /sessionDeliveryMode\([\s\S]*?downloadCodexButton\.hidden = isLive[\s\S]*?composer\.hidden = !isLive/);
  assert.match(main, /api\.createSnapshotRequest\(state\.session\.id, "immutable"\)/);
  assert.match(main, /api\.getSnapshotRequest\(request\.id\)/);
  assert.match(main, /snapshotStatusView\(request\)/);
  assert.match(main, /data-action", "retry-snapshot"/);
  for (const label of ["Synced", "Offline", "Reconciling", "Rebuilding", "Local fork"]) {
    assert.match(`${main}\n${domain}`, new RegExp(label));
  }
});

test("the real API is the default and bearer credentials are never persisted", async () => {
  const [main, api] = await Promise.all([readFile(mainPath, "utf8"), readFile(apiPath, "utf8")]);
  assert.match(main, /query\.get\("mock"\) === "1"/);
  assert.match(main, /new HttpCollaborationApi\(\{ baseUrl: configuredApiUrl \}\)/);
  assert.doesNotMatch(`${main}\n${api}`, /(?:local|session)Storage/);
  assert.doesNotMatch(main, /searchParams\.(?:set|append)\([^\n]*(?:invite|token)/i);
  assert.doesNotMatch(`${main}\n${api}`, /console\.(?:log|info|debug|warn|error)/);
});

test("runtime presence refreshes while a session is open and stops with the page lifecycle", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /function startMemberRefresh\(sessionId\)[\s\S]*?setInterval\(\(\) => void refreshMembers\(sessionId\), 5_000\)/);
  assert.match(main, /async function refreshMembers\(sessionId\)[\s\S]*?api\.listMembers\(sessionId\)[\s\S]*?renderTimeline\(\)/);
  assert.match(main, /async function selectSession\(sessionId\)[\s\S]*?startMemberRefresh\(sessionId\)/);
  assert.match(main, /window\.addEventListener\("pagehide",[\s\S]*?stopMemberRefresh\(\)/);
  assert.match(main, /function resetWorkspaceToAuth\(\)[\s\S]*?stopMemberRefresh\(\)/);
  assert.match(main, /error\?\.status === 403 \|\| error\?\.status === 404[\s\S]*?sync\.disconnect\(\)[\s\S]*?await enterWorkspace\(\)/);
});

test("timeline auto-follow runs only for appended events and preserves a reader's position", async () => {
  const [main, styles] = await Promise.all([readFile(mainPath, "utf8"), readFile(stylesPath, "utf8")]);
  assert.match(main, /renderTimeline\(\{ followNewEvents: snapshot\.events\.length > previousCount \}\)/);
  assert.match(main, /function renderTimeline\(\{ followNewEvents = false \} = \{\}\)/);
  assert.match(main, /const scrollSnapshot = captureTimelineScroll\([\s\S]*?followNewEvents/);
  assert.match(main, /settleTimelineScroll\(timelineRegion, \{[\s\S]*?\.\.\.scrollSnapshot/);
  const timelineRule = styles.match(/\.timeline-region \{[\s\S]*?\}/)?.[0] ?? "";
  assert.doesNotMatch(timelineRule, /scroll-behavior:\s*smooth/);
});

test("pending agent feedback is announced and respects reduced-motion preferences", async () => {
  const [main, styles] = await Promise.all([readFile(mainPath, "utf8"), readFile(stylesPath, "utf8")]);
  assert.match(main, /className = "agent-pending-status"/);
  assert.match(main, /setAttribute\("role", "status"\)/);
  assert.match(main, /setAttribute\("aria-live", "polite"\)/);
  assert.match(styles, /@keyframes agent-thinking-pulse/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("connection interruption notifications are edge-triggered and permission-aware", async () => {
  const [html, main, styles] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  assert.match(html, /id="attention-notice" class="attention-notice" role="status" aria-live="assertive"/);
  assert.match(main, /advanceConnectionNotice\([\s\S]*state\.settings\.notifications\.connectionLost/);
  assert.match(main, /if \(connectionTransition\.notify\) notifyConnectionLost\(\)/);
  assert.match(main, /notificationPermissionNeeded\(nextSettings\.notifications\)/);
  assert.match(main, /Notification\.permission !== "granted"/);
  assert.match(styles, /\.attention-notice\s*\{[\s\S]*position: fixed/);
});

test("empty canonical events do not render a visible placeholder message", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(main, /No visible content/);
  assert.match(main, /if \(content\) \{/);
});

test("remembered login and current-device naming remain explicit and accessible", async () => {
  const [html, main, api] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(apiPath, "utf8"),
  ]);
  for (const id of [
    "login-remember-device",
    "claim-remember-device",
    "settings-device",
    "settings-device-name",
    "settings-device-status",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /for="login-remember-device"/);
  assert.match(html, /for="claim-remember-device"/);
  assert.match(html, /for="settings-device-name"/);
  assert.match(main, /automaticDeviceName\(\)/);
  assert.match(main, /api\.renameDevice\(state\.currentUser\.device_id/);
  assert.match(api, /remember_device: rememberDevice/);
  assert.doesNotMatch(main, /localStorage.*device/i);
});

test("session settings update local metadata and apply realtime control events", async () => {
  const [main, api] = await Promise.all([readFile(mainPath, "utf8"), readFile(apiPath, "utf8")]);
  assert.match(main, /api\.updateSession\(sessionId/);
  assert.match(main, /sessionMetadataFromEvent\(event\)/);
  assert.match(main, /state\.sessions = state\.sessions\.map/);
  assert.match(main, /renderSessionHeader\(\)/);
  assert.match(main, /element\("session-access-note"\)\.hidden = session\.mode !== "solo"/);
  assert.match(main, /renderSessionList\(\)/);
  assert.match(api, /method: "PATCH"/);
});

test("session settings let the project creator change an owned session mode", async () => {
  const [html, main, api] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(apiPath, "utf8"),
  ]);
  assert.match(html, /id="rename-session-mode"[\s\S]*?<option value="solo">Solo<\/option>[\s\S]*?<option value="multi">Multi<\/option>/);
  assert.match(main, /state\.project\?\.role === "owner"[\s\S]*?state\.session\.ownerUserId === state\.currentUser\?\.id/);
  assert.match(main, /api\.updateSession\(sessionId/);
  assert.match(main, /updateSessionMetadata\(sessionId, renamed\)/);
  assert.match(api, /async updateSession\(sessionId/);
});

test("project rename is creator-gated and refreshes project metadata in place", async () => {
  const [html, main, api, i18n] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(apiPath, "utf8"),
    readFile(i18nPath, "utf8"),
  ]);
  assert.match(html, /id="rename-project-button"[\s\S]*?aria-controls="rename-project-dialog"/);
  assert.match(main, /state\.project\?\.role !== "owner"/);
  assert.match(main, /api\.renameProject\(projectId/);
  assert.match(main, /state\.projects = state\.projects\.map/);
  assert.match(main, /renderProjectSelect\(\)/);
  assert.match(api, /async renameProject\(projectId/);
  assert.match(i18n, /"Rename project": "重命名项目"/);
});

test("cloud deletion is explicit, creator-gated, and preserves local work in the confirmation copy", async () => {
  const [html, main, api, i18n] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(apiPath, "utf8"),
    readFile(i18nPath, "utf8"),
  ]);
  for (const id of [
    "delete-project-button",
    "delete-session-button",
    "delete-cloud-dialog",
    "delete-cloud-form",
    "delete-cloud-description",
    "delete-cloud-local-note",
    "delete-cloud-error",
    "confirm-delete-cloud-button",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Local projects, files, Codex tasks, and Agent conversations stay on every device/);
  assert.match(main, /session\.ownerUserId === state\.currentUser\?\.id \|\| state\.project\?\.role === "owner"/);
  assert.match(main, /await api\.deleteSession\(target\.id\)/);
  assert.match(main, /await api\.deleteProject\(target\.id\)/);
  assert.match(api, /async deleteSession\(sessionId\)[\s\S]*?method: "DELETE"/);
  assert.match(api, /async deleteProject\(projectId\)[\s\S]*?method: "DELETE"/);
  assert.match(i18n, /共享的云端历史将被永久删除/);
});

test("an empty project lets owners and participants create an eligible first session", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /element\("empty-state-title"\)\.textContent = "Start a shared thread\."/);
  assert.match(main, /element\("empty-create-button"\)\.textContent = "Create your first session"/);
  assert.match(main, /element\("empty-create-button"\)\.hidden = !mayCreate/);
});

test("the multiline login headline keeps safe vertical spacing", async () => {
  const styles = await readFile(stylesPath, "utf8");
  assert.match(styles, /\.auth-shell \{[\s\S]*?height: 100dvh;[\s\S]*?overflow: hidden;/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 740px\)/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 600px\)[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.auth-story h1 \{[\s\S]*?line-height: 1\.08;/);
  assert.match(styles, /\.headline-line \{[\s\S]*?padding-block: 0\.02em;/);
  assert.match(styles, /@keyframes auth-mark-thread-flow/);
  assert.match(styles, /@keyframes auth-ring-primary/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.auth-mark-flow path/);
});

test("timeline renders both user content and harness response text", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /eventContent,/);
  assert.match(main, /const content = eventContent\(event\);/);
});

test("settings switches use a Safari-safe visual track and dark responses use semantic colors", async () => {
  const [html, styles] = await Promise.all([readFile(htmlPath, "utf8"), readFile(stylesPath, "utf8")]);
  assert.equal((html.match(/class="settings-switch-visual"/g) ?? []).length, 5);
  assert.equal((html.match(/Human chat is shared without triggering a local agent\./g) ?? []).length, 0);
  assert.match(styles, /\.settings-toggle input\[type="checkbox"\]:checked \+ \.settings-switch-visual::after/);
  assert.match(styles, /\.event-agent_response \{[\s\S]*?background: var\(--response-surface\);[\s\S]*?color: var\(--ink\);/);
  assert.match(styles, /html\[lang="zh-CN"\] \{[\s\S]*?--locale-text-boost: 1\.08;/);
});

test("custom numeric settings use spinner-free digit inputs", async () => {
  const [html, styles] = await Promise.all([readFile(htmlPath, "utf8"), readFile(stylesPath, "utf8")]);
  assert.doesNotMatch(html, /type="number"/);
  for (const id of [
    "settings-text-scale",
    "settings-left-width",
    "settings-right-width",
    "settings-composer-height",
    "settings-context-budget",
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="digits-only-input"[^>]*type="text"[^>]*inputmode="numeric"`));
  }
  assert.match(styles, /\.numeric-setting-context label \{[\s\S]*?grid-template-columns: minmax\(64px, 1fr\) 100px;/);
});

test("custom Codex models explain that access must already be configured", async () => {
  const [html, i18n] = await Promise.all([readFile(htmlPath, "utf8"), readFile(i18nPath, "utf8")]);
  const explanation = "This registers a model name for calls; it does not configure model access. Configure a supported model in Codex first, then add its name here.";
  assert.match(html, new RegExp(explanation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(i18n, /这里只登记调用模型名，不配置模型接入。请先自行在 Codex 中配置受支持的模型，再将其名称添加到这里。/);
});

test("Codex visible-history import exposes first-session and disabled choices", async () => {
  const [html, main, i18n] = await Promise.all([
    readFile(htmlPath, "utf8"), readFile(mainPath, "utf8"), readFile(i18nPath, "utf8"),
  ]);
  assert.match(html, /id="settings-visible-history-sync"/);
  assert.match(html, /option value="first-connect" selected/);
  assert.doesNotMatch(html, /option value="every-update"/);
  assert.match(html, /option value="never"/);
  assert.match(i18n, /每个会话首次在本地建立时导入一次/);
  assert.match(i18n, /手动导入会新建任务，请自行归档旧任务；实时上下文注入始终保持启用/);
  assert.match(i18n, /手动导入会创建新的 Codex 本地任务，不会覆盖或归档旧任务。确认新任务可用后，请自行归档旧任务。实时上下文注入不受影响/);
  assert.match(html, /id="import-visible-history-button"/);
  assert.match(main, /createSnapshotRequest\(sessionId, "visible_history_replace"\)/);
  assert.match(main, /request\.result\?\.previous_task_retained/);
  for (const id of ["codex-local-sync-controls", "codex-local-runtime-select", "codex-auto-upload-toggle", "upload-local-turns-button"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Auto-upload local turns to cloud/);
  assert.match(html, /Upload local turns to cloud now/);
  assert.match(i18n, /本地回合自动上传至云端/);
  assert.match(i18n, /立即从本地上传至云端/);
  assert.match(main, /"local_sync_status"/);
  assert.match(main, /"local_auto_upload_enable"/);
  assert.match(main, /"local_auto_upload_disable"/);
  assert.match(main, /"local_turn_upload"/);
});

test("workspace rails and dense session context use accessible icon disclosures", async () => {
  const [html, main, styles, i18n] = await Promise.all([
    readFile(htmlPath, "utf8"), readFile(mainPath, "utf8"), readFile(stylesPath, "utf8"), readFile(i18nPath, "utf8"),
  ]);
  assert.match(html, /id="toggle-session-rail-button"[^>]*aria-controls="session-rail"[^>]*aria-expanded="true"[^>]*data-tooltip[\s\S]*?<svg/);
  assert.match(html, /id="mobile-members-button"[^>]*aria-controls="member-panel"[^>]*aria-expanded="true"[^>]*data-tooltip[\s\S]*?<svg/);
  assert.match(html, /class="account-cluster"[\s\S]*?id="logout-button"[\s\S]*?id="mobile-members-button"[\s\S]*?<\/div>/);
  assert.match(html, /id="topbar-session-context"[^>]*hidden[\s\S]*?id="topbar-project-name"[\s\S]*?id="topbar-session-name"/);
  assert.match(html, /id="session-context-details"[\s\S]*?<summary[^>]*aria-label="Show session status details"[^>]*aria-controls="session-context-panel"[^>]*aria-expanded="false"[\s\S]*?id="session-context-panel"[^>]*aria-label="Session status details"/);
  assert.match(html, /class="session-context-panel-heading"[\s\S]*?Session status details[\s\S]*?Codex history[\s\S]*?Local turns to cloud/);
  assert.match(main, /workspace\.dataset\.leftRailCollapsed/);
  assert.match(main, /workspace\.dataset\.rightPanelCollapsed/);
  assert.match(main, /memberPanel\.classList\.toggle\("member-panel-open"/);
  assert.match(main, /function renderWorkspaceContext\(\)/);
  assert.match(main, /sessionContextDetails\.open = false;[\s\S]*?updateSessionContextDisclosure\(\)/);
  assert.match(styles, /\.workspace\[data-left-rail-collapsed="true"\][\s\S]*?\.session-rail/);
  assert.match(styles, /\.workspace\[data-right-panel-collapsed="true"\][\s\S]*?\.member-panel/);
  assert.match(styles, /\.session-context-panel[\s\S]*?position:\s*absolute/);
  assert.match(i18n, /展开会话侧栏/);
  assert.match(i18n, /收起成员侧栏/);
  assert.match(i18n, /会话状态详情/);
});

test("Codex-only history and upload controls follow the saved project Agent selection", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /element\("visible-history-controls"\)\.hidden = !currentProjectEnabledHarnesses\(\)\.includes\("codex"\)/);
  assert.match(main, /const available = Boolean\(state\.session\)[\s\S]*?currentProjectEnabledHarnesses\(\)\.includes\("codex"\)/);
  assert.match(main, /state\.settings = settingsStore\.set\(settingsPreview\);[\s\S]*?renderSessionDeliveryControls\(\);[\s\S]*?ensureCodexLocalSyncStatus\(\)/);
});

test("project Agent shortcuts are selectable, contextual, and compact in the fixed session rail", async () => {
  const [html, main, styles, i18n] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(stylesPath, "utf8"),
    readFile(i18nPath, "utf8"),
  ]);
  for (const id of ["settings-enabled-codex", "settings-enabled-dsh", "settings-agent-summary"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.equal((html.match(/class="icon-button rail-create-button"/g) ?? []).length, 2);
  assert.match(main, /projectEnabledHarnesses/);
  assert.match(main, /connectCodexButton\.hidden = !enabled\.has\("codex"\)/);
  assert.match(main, /connectDshButton\.hidden = !enabled\.has\(DSH_HARNESS\)/);
  assert.match(main, /const enabledHarnesses = currentProjectEnabledHarnesses\(\);[\s\S]*?agentHarnessSelect\.replaceChildren\(\);/);
  assert.match(main, /for \(const enabledHarness of enabledHarnesses\)[\s\S]*?agentHarnessSelect\.append\(option\);/);
  assert.match(main, /DeepSeek Harness supplies this project's runtime and handles new Agent requests by default\./);
  assert.match(i18n, /当前项目使用 DeepSeek Harness 运行环境，并默认由其处理新的 Agent 请求。/);
  assert.match(styles, /\.session-list \{[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.rail-create-button \{[\s\S]*?width: 34px;[\s\S]*?height: 34px;/);
});

test("the composer uses its accessible divider instead of a scrolling control panel", async () => {
  const [html, styles, main] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(stylesPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);
  assert.match(html, /id="composer-layout-resizer"[\s\S]*?role="separator"[\s\S]*?aria-orientation="horizontal"/);
  assert.match(styles, /\.composer \{[\s\S]*?grid-template-rows: minmax\(58px, 1fr\)[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.composer > textarea \{[\s\S]*?resize: none;/);
  assert.match(main, /installComposerLayoutResizer\(composerLayoutResizer\)/);
});

test("a failed Agent response is shown as a failure with an explicit retry", async () => {
  const [main, styles] = await Promise.all([readFile(mainPath, "utf8"), readFile(stylesPath, "utf8")]);
  // The failure has to be visible: a request that no runtime could finish must
  // not read as an ordinary answer, and it must offer a way forward.
  assert.match(main, /isFailedAgentResponse\(event\)/);
  assert.match(main, /failedRequestFor,/);
  assert.match(main, /canRetryFailedAgentRequest\(request, state\.currentUser\)/);
  assert.match(main, /event-agent_response-failed/);
  assert.match(main, /setAttribute\("data-action", "retry-agent-request"\)/);
  assert.match(main, /retryAgentRequestInput\(/);
  assert.match(main, /api\.appendAgentRequest\(state\.session\.id/);
  assert.match(main, /closest\("button\[data-action='retry-agent-request'\]"\)/);
  assert.match(styles, /\.event-agent_response-failed/);
  assert.match(styles, /\.agent-retry-button/);
});
