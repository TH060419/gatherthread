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

test("invitation role control locks solo sessions to viewer and restores both multi roles", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /function renderInvitationRoleControl\(\)/);
  assert.match(main, /invitationRolePolicy\(state\.session\?\.mode\)/);
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

test("new and existing user forms route to distinct claim and accept methods", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /claimInvitationForm\.addEventListener[\s\S]*?api\.claimInvitation/);
  assert.match(main, /acceptInvitationForm\.addEventListener[\s\S]*?api\.acceptInvitation/);
  assert.match(main, /await enterWorkspace\(result\.invitation\.sessionId\)/);
  assert.match(main, /await selectSession\(result\.invitation\.sessionId\)/);
});
