import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { projectInvitationShareText } from "../src/invitation-share.js";

const htmlPath = fileURLToPath(new URL("../index.html", import.meta.url));
const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));

test("invitation UI offers the required roles and TTLs with 24 hours selected by default", async () => {
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<option value="participant">Participant<\/option>/);
  assert.match(html, /<option value="viewer">Viewer<\/option>/);
  assert.match(html, /id="invitation-role"[^>]*aria-describedby="invitation-role-help"/);
  assert.match(html, /id="invitation-role-help"/);
  assert.match(html, /<option value="1h">1 hour<\/option>/);
  assert.match(html, /<option value="24h" selected>24 hours<\/option>/);
  assert.match(html, /<option value="7d">7 days<\/option>/);
});

test("project invitation role control always offers participant and viewer", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /function renderInvitationRoleControl\(\)/);
  assert.match(main, /invitationRolePolicy\(\)/);
  assert.match(main, /option\.disabled = !allowed/);
  assert.match(main, /option\.hidden = !allowed/);
  assert.match(main, /roleSelect\.disabled = policy\.locked/);
  assert.match(main, /rolePolicy\.allowedRoles\.includes\(requestedRole\)/);
});

test("owner secret is rendered only from create response and cleared on session changes and logout", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /createdInvitationSecret = result\.inviteToken/);
  assert.match(main, /createdInvitationDetails = result\.invitation/);
  assert.match(main, /createdInvitationShareText = projectInvitationShareText\(createdInvitationSecret, createdInvitationDetails, locale\)/);
  assert.match(main, /element\("created-invite-secret"\)\.textContent = createdInvitationShareText/);
  assert.match(main, /navigator\.clipboard\.writeText\(createdInvitationShareText\)/);
  assert.match(main, /if \(localeChanged\) updateCreatedInvitationShareText\(normalized\.general\.locale\)/);
  assert.match(main, /async function selectSession\(sessionId\)[\s\S]*?clearCreatedInvitationSecret\(\)/);
  assert.match(main, /logout-button[\s\S]*?clearCreatedInvitationSecret\(\)/);
  assert.doesNotMatch(main, /state\.invitations[^\n]*inviteToken/);
});

test("project invitation copy includes one secret, joining instructions and exact Beijing expiry range", async () => {
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /id="created-invite-secret"[^>]*data-i18n-skip/);
  assert.match(html, /id="copy-invite-secret-button"[^>]*>Copy invitation<\/button>/);
  const secret = "gti_test-only-example-not-a-real-secret";
  const text = projectInvitationShareText(secret, {
    createdAt: "2026-09-28T00:00:00.000Z",
    expiresAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(text.split(secret).length - 1, 1);
  assert.match(text, /^邀请密钥：gti_test-only-example-not-a-real-secret\n/u);
  assert.match(text, /登录共序后.*右侧栏.*加入其他项目/u);
  assert.match(text, /有效期：2026\/09\/28 08:00 至 2026\/09\/29 08:00（北京时间）/u);
});

test("one-time invitation secret remains shareable if the server omits validity dates", () => {
  const secret = "gti_test-only-example-not-a-real-secret";
  const text = projectInvitationShareText(secret, {});
  assert.match(text, /^邀请密钥：gti_test-only-example-not-a-real-secret\n/u);
  assert.match(text, /有效期：请向邀请者确认/u);
});

test("English interface copies English invitation guidance and Beijing validity", () => {
  const secret = "gti_test-only-example-not-a-real-secret";
  const invitation = {
    createdAt: "2026-09-28T00:00:00.000Z",
    expiresAt: "2026-09-29T00:00:00.000Z",
  };
  const english = projectInvitationShareText(secret, invitation, "en");
  assert.match(english, /^Invitation secret: gti_test-only-example-not-a-real-secret\n/u);
  assert.match(english, /Join another project.*right sidebar/u);
  assert.match(english, /Valid: 2026-09-28 08:00 to 2026-09-29 08:00 \(China Standard Time\)/u);
  assert.doesNotMatch(english, /邀请密钥|有效期/u);
  assert.match(projectInvitationShareText(secret, {}, "en"), /Valid: Please confirm with the inviter/u);
});

test("project joining accepts invitations only after account login", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.doesNotMatch(main, /claimInvitationForm|api\.claimInvitation/u);
  assert.match(main, /acceptInvitationForm\.addEventListener[\s\S]*?api\.acceptInvitation/u);
  assert.match(main, /await selectProject\(result\.invitation\.projectId\)/u);
});

test("user authentication never displays or stores a device token", async () => {
  const [html, main] = await Promise.all([readFile(htmlPath, "utf8"), readFile(mainPath, "utf8")]);
  assert.doesNotMatch(html + main, /device-credential-dialog|new-device-access-token|showNewDeviceAccessToken/u);
  assert.doesNotMatch(main, /searchParams\.(?:set|append)\([^\n]*(?:access|token)/i);
});

test("refresh restoration is generation-safe and pagehide never logs out the server session", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /void restoreBrowserSession\(\)/);
  assert.match(main, /const actor = await api\.restoreSession\(\)/);
  assert.match(main, /generation !== authenticationGeneration/);
  assert.match(main, /function beginEmailAuthentication\(\) \{[\s\S]*?\+\+authenticationGeneration/);
  const pagehide = main.match(/window\.addEventListener\("pagehide",[\s\S]*?\n\}\);/)?.[0] ?? "";
  assert.match(pagehide, /sync\.disconnect\(\)/);
  assert.doesNotMatch(pagehide, /api\.logout/);
  assert.match(main, /event\.persisted[\s\S]*?restoreBrowserSession\(\)/);
});
