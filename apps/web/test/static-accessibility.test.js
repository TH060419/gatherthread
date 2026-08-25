import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("../index.html", import.meta.url));
const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
const apiPath = fileURLToPath(new URL("../src/api.js", import.meta.url));
const stylesPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
const domainPath = fileURLToPath(new URL("../src/domain.js", import.meta.url));

test("the shell exposes landmarks, labelled forms, status regions, and separate send controls", async () => {
  const html = await readFile(htmlPath, "utf8");
  for (const requirement of [
    'class="skip-link"',
    '<span class="headline-line">One room.</span>',
    '<span class="headline-line">Many minds.</span>',
    '<nav class="session-rail"',
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
    'id="rename-session-button"',
    'id="rename-session-dialog"',
    'id="rename-session-form"',
    'for="rename-session-name"',
    'id="rename-session-error" class="form-error" role="alert"',
    'id="download-codex-button"',
    '<span lang="zh-Hans">下载到 Codex</span>',
    'id="connector-status" class="connector-status" role="status"',
    'id="snapshot-request-error" class="form-error" role="alert"',
    'id="snapshot-request-list" class="snapshot-request-list" aria-label="Codex snapshot downloads"',
    'id="connect-codex-button"',
    '<span>Connect Codex</span>',
    '<span lang="zh-Hans">连接 Codex</span>',
    'id="connect-codex-dialog"',
    'aria-labelledby="connect-codex-title"',
    'id="connect-codex-activation"',
    'data-copy-command="posix"',
    'data-copy-command="powershell"',
    'id="copy-posix-command-status"',
    'id="copy-powershell-command-status"',
  ]) {
    assert.match(html, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((html.match(/class="brand-mark(?: brand-mark-small)?"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="brand-mark(?: brand-mark-small)?"[^>]*>R</);
  assert.equal((html.match(/class="brand-mark(?: brand-mark-small)?"[^>]*>G</g) ?? []).length, 2);
});

test("project Codex connector explains scope, credential prompting, hook trust, and focus restoration", async () => {
  const [html, main, styles] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  assert.match(html, /root of your local GatherThread repository/i);
  assert.match(html, /creates or reuses and opens the same-name local Desktop project/i);
  assert.match(html, /connects every editable session with one Desktop task and one isolated background Agent runtime/i);
  assert.match(html, /Single-writer synchronization/i);
  assert.match(html, /Codex Desktop exclusively owns the visible task/i);
  assert.match(html, /Web Agent requests run in an isolated background projection/i);
  assert.doesNotMatch(html, /Move to project|manual Desktop step/i);
  assert.match(html, /device token is requested by a hidden CLI prompt/i);
  assert.match(html, /review and trust them in Codex <code>\/hooks<\/code>/i);
  assert.match(main, /projectCodexConnectionCommands\(\{[\s\S]*?baseUrl: location\.origin[\s\S]*?projectId: state\.project\.id/);
  assert.doesNotMatch(main, /connect-codex-move-project-name|renderCodexDesktopMoveGuide/);
  assert.match(main, /connectCodexDialog\.addEventListener\("close"[\s\S]*?returnFocus\.focus\(\)/);
  assert.match(main, /navigator\.clipboard\?\.writeText[\s\S]*?document\.execCommand\?\.\("copy"\)/);
  assert.match(styles, /\.codex-connect-dialog[\s\S]*?width: min\(720px/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.command-heading[\s\S]*?flex-direction: column/);
  assert.doesNotMatch(main, /searchParams\.(?:set|append)\([^\n]*(?:device|token|credential)/i);
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
  assert.match(main, /api\.createSnapshotRequest\(state\.session\.id\)/);
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

test("pending agent feedback is announced and respects reduced-motion preferences", async () => {
  const [main, styles] = await Promise.all([readFile(mainPath, "utf8"), readFile(stylesPath, "utf8")]);
  assert.match(main, /className = "agent-pending-status"/);
  assert.match(main, /setAttribute\("role", "status"\)/);
  assert.match(main, /setAttribute\("aria-live", "polite"\)/);
  assert.match(styles, /@keyframes agent-thinking-pulse/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("empty canonical events do not render a visible placeholder message", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(main, /No visible content/);
  assert.match(main, /if \(content\) \{/);
});

test("session rename updates local metadata and applies realtime control events", async () => {
  const [main, api] = await Promise.all([readFile(mainPath, "utf8"), readFile(apiPath, "utf8")]);
  assert.match(main, /api\.renameSession\(sessionId/);
  assert.match(main, /sessionMetadataFromEvent\(event\)/);
  assert.match(main, /state\.sessions = state\.sessions\.map/);
  assert.match(main, /renderSessionHeader\(\)/);
  assert.match(main, /renderSessionList\(\)/);
  assert.match(api, /method: "PATCH"/);
});

test("an empty project exposes the owner-only first-session action", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /element\("empty-state-title"\)\.textContent = "Start a shared thread\."/);
  assert.match(main, /element\("empty-create-button"\)\.textContent = "Create your first session"/);
  assert.match(main, /element\("empty-create-button"\)\.hidden = !isOwner/);
});

test("the multiline login headline keeps safe vertical spacing", async () => {
  const styles = await readFile(stylesPath, "utf8");
  assert.match(styles, /\.auth-story h1 \{[\s\S]*?line-height: 1\.08;/);
  assert.match(styles, /\.headline-line \{[\s\S]*?padding-block: 0\.02em;/);
});

test("timeline renders both user content and harness response text", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /eventContent,/);
  assert.match(main, /const content = eventContent\(event\);/);
});
