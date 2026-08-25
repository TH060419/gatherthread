import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("../index.html", import.meta.url));
const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
const apiPath = fileURLToPath(new URL("../src/api.js", import.meta.url));

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
    'id="invitation-list" class="invitation-list" aria-label="Session invitations"',
  ]) {
    assert.match(html, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((html.match(/class="brand-mark(?: brand-mark-small)?"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="brand-mark(?: brand-mark-small)?"[^>]*>R</);
  assert.equal((html.match(/class="brand-mark(?: brand-mark-small)?"[^>]*>G</g) ?? []).length, 2);
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
  assert.match(main, /async function refreshMembers\(sessionId\)[\s\S]*?api\.listMembers\(sessionId\)/);
  assert.match(main, /async function selectSession\(sessionId\)[\s\S]*?startMemberRefresh\(sessionId\)/);
  assert.match(main, /window\.addEventListener\("pagehide",[\s\S]*?stopMemberRefresh\(\)/);
  assert.match(main, /function resetWorkspaceToAuth\(\)[\s\S]*?stopMemberRefresh\(\)/);
});

test("timeline renders both user content and harness response text", async () => {
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /event\.payload\?\.content \?\? event\.payload\?\.text \?\? "No visible content"/);
});
