import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
  assert.match(main, /element\("created-invite-secret"\)\.textContent = createdInvitationSecret/);
  assert.match(main, /async function selectSession\(sessionId\)[\s\S]*?clearCreatedInvitationSecret\(\)/);
  assert.match(main, /logout-button[\s\S]*?clearCreatedInvitationSecret\(\)/);
  assert.doesNotMatch(main, /state\.invitations[^\n]*inviteToken/);
});

test("new and existing user forms route to project-level claim and accept methods", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /claimInvitationForm\.addEventListener[\s\S]*?api\.claimInvitation/);
  assert.match(main, /acceptInvitationForm\.addEventListener[\s\S]*?api\.acceptInvitation/);
  assert.match(main, /await enterWorkspace\(result\.invitation\.projectId\)/);
  assert.match(main, /await selectProject\(result\.invitation\.projectId\)/);
});

test("new users receive a one-time copyable device token without browser storage or URL exposure", async () => {
  const [html, main] = await Promise.all([readFile(htmlPath, "utf8"), readFile(mainPath, "utf8")]);
  for (const id of [
    "device-credential-dialog",
    "new-device-access-token",
    "copy-device-access-token-button",
    "acknowledge-device-access-token-button",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(main, /showNewDeviceAccessToken\(result\.accessToken\)/);
  assert.match(main, /element\("new-device-access-token"\)\.textContent = token/);
  assert.match(main, /deviceCredentialDialog\.addEventListener\("cancel", \(event\) => event\.preventDefault\(\)\)/);
  assert.match(main, /clearNewDeviceAccessToken\(\)/);
  assert.doesNotMatch(`${html}\n${main}`, /(?:local|session)Storage/);
  assert.doesNotMatch(main, /searchParams\.(?:set|append)\([^\n]*(?:access|token)/i);
});

test("refresh restoration is generation-safe and pagehide never logs out the server session", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /void restoreBrowserSession\(\)/);
  assert.match(main, /const actor = await api\.restoreSession\(\)/);
  assert.match(main, /generation !== authenticationGeneration/);
  assert.match(main, /claimInvitationForm\.addEventListener[\s\S]*?const generation = \+\+authenticationGeneration/);
  const pagehide = main.match(/window\.addEventListener\("pagehide",[\s\S]*?\n\}\);/)?.[0] ?? "";
  assert.match(pagehide, /sync\.disconnect\(\)/);
  assert.doesNotMatch(pagehide, /api\.logout/);
  assert.match(main, /event\.persisted[\s\S]*?restoreBrowserSession\(\)/);
});
