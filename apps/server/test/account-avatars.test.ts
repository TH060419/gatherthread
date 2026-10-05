import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AvatarIdSchema, SetAccountAvatarInputSchema, SessionAvatarProfilesSchema } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { startCollaborationServer } from "../src/server.js";
import { browserSessionFixture } from "./auth-fixtures.js";

test("avatars are account-wide, idempotent mutable metadata; departed authors keep profiles without rewriting events", () => {
  const db = new CollaborationDatabase(":memory:");
  try {
    const service = new CollaborationService(db);
    const owner = db.bootstrapIdentity({ display_name: "Same name", device_name: "Laptop" }).actor;
    const peer = db.createIdentity({ display_name: "Same name", device_name: "Phone" }).actor;
    const other = db.createIdentity({ display_name: "Private author", device_name: "Desktop" }).actor;
    const outsider = db.createIdentity({ display_name: "Outsider", device_name: "Browser" }).actor;
    const project = service.createProject(owner, { title: "Avatars", idempotency_key: "avatar-project" });
    for (const member of [peer, other]) service.claimInvitationForActor(member,
      service.createProjectInvitation(owner, project.id, { role: "participant" }).invite_token);
    const session = service.createSession(owner, { project_id: project.id, title: "Multi", mode: "multi", idempotency_key: "avatar-multi" }).session;
    const solo = service.createSession(owner, { project_id: project.id, title: "Solo", mode: "solo", idempotency_key: "avatar-solo" }).session;
    service.appendEvent(peer, session.id, { type: "human_chat", visibility: "session", idempotency_key: "avatar-message", payload: { content: "Retained" } });
    service.appendEvent(owner, session.id, { type: "human_chat", visibility: "owner_only", idempotency_key: "avatar-private", payload: { content: "Private" } });
    // Historical private author fixture (as if this account were a former owner).
    db.sqlite.prepare("UPDATE events SET actor_user_id = ?, actor_display_name = ? WHERE session_id = ? AND idempotency_key = ?")
      .run(other.user_id, other.display_name, session.id, "avatar-private");
    const before = db.sqlite.prepare("SELECT * FROM events ORDER BY id").all();
    assert.equal(db.accountAvatar(owner.user_id), null);
    db.setAccountAvatar(owner, "cat");
    db.setAccountAvatar(peer, "fox");
    assert.deepEqual(db.setAccountAvatar(peer, "fox"), { user_id: peer.user_id, avatar_id: "fox" });
    assert.equal(db.listSessionAvatarProfiles(owner, solo.id).find(p => p.user_id === peer.user_id)?.avatar_id, "fox");
    service.removeProjectMembership(owner, project.id, peer.user_id);
    service.removeProjectMembership(owner, project.id, other.user_id);
    // Add a viewer after the authors have left: only readable history may reveal their profile.
    service.claimInvitationForActor(outsider, service.createProjectInvitation(owner, project.id, { role: "viewer" }).invite_token);
    const visible = SessionAvatarProfilesSchema.parse({ profiles: db.listSessionAvatarProfiles(outsider, session.id) }).profiles;
    assert.equal(visible.find(p => p.user_id === peer.user_id)?.avatar_id, "fox");
    assert.equal(visible.some(p => p.user_id === other.user_id), false);
    db.setAccountAvatar(peer, "owl");
    assert.equal(db.listSessionAvatarProfiles(outsider, session.id).find(p => p.user_id === peer.user_id)?.avatar_id, "owl");
    // Membership mutations add events, but the original event bytes are untouched.
    for (const row of before) assert.deepEqual(db.sqlite.prepare("SELECT * FROM events WHERE id = ?").get(String(row.id)), row);
    assert.throws(() => db.listSessionAvatarProfiles(peer, session.id));
    db.deleteAccount(peer);
    assert.equal(db.listSessionAvatarProfiles(outsider, session.id).find(p => p.user_id === "deleted-account")?.avatar_id, null);
    db.setAccountAvatar(owner, null);
    assert.equal(db.accountAvatar(owner.user_id), null);
    db.sqlite.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), owner.device_id);
    assert.throws(() => db.setAccountAvatar(owner, "bear"));
  } finally { db.close(); }
});

test("existing users migrate to initials; selected avatars survive reopening and unknown IDs fall back safely", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-avatar-migration-"));
  const path = join(directory, "test.sqlite");
  let db = new CollaborationDatabase(path);
  try {
    const actor = db.bootstrapIdentity({ display_name: "Legacy", device_name: "Laptop" }).actor;
    db.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE users DROP COLUMN avatar_id");
    legacy.close();
    db = new CollaborationDatabase(path);
    assert.equal(db.accountAvatar(actor.user_id), null);
    db.setAccountAvatar(actor, "rabbit");
    db.close();
    db = new CollaborationDatabase(path);
    assert.equal(db.accountAvatar(actor.user_id), "rabbit");
    db.sqlite.prepare("UPDATE users SET avatar_id = 'future-catalog-id' WHERE id = ?").run(actor.user_id);
    assert.equal(db.accountAvatar(actor.user_id), null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("self-avatar HTTP enforces browser/Origin/strict allowlist and authorized profile reads", async () => {
  const browserOrigin = "http://127.0.0.1:8787";
  const running = await startCollaborationServer({ databasePath: ":memory:", allowedOrigins: [browserOrigin],
    authTokenPepper: "avatar-test-pepper-only-not-a-credential" }, 0);
  try {
    const identity = running.database.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" });
    const stranger = running.database.createIdentity({ display_name: "Stranger", device_name: "Phone" });
    const opened = browserSessionFixture(running, { token: identity.token, origin: browserOrigin });
    const cookie = opened.headers.get("set-cookie")!.split(";", 1)[0]!;
    const put = (body: unknown, headers: Record<string, string> = { cookie, origin: browserOrigin }) => fetch(`${running.origin}/v1/me/avatar`, {
      method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await put({ avatar_id: "cat" }, { authorization: `Bearer ${identity.token}` })).status, 403);
    assert.equal((await put({ avatar_id: "cat" }, { cookie })).status, 403);
    assert.equal((await put({ avatar_id: "cat" }, { cookie, origin: "https://untrusted.example" })).status, 403);
    for (const body of [{ avatar_id: "https://images.example/photo.svg" }, { avatar_id: "cat", user_id: stranger.actor.user_id }, {}]) {
      assert.equal((await put(body)).status, 400);
      assert.equal(SetAccountAvatarInputSchema.safeParse(body).success, false);
    }
    for (const id of AvatarIdSchema.options) assert.equal((await put({ avatar_id: id })).status, 200);
    const me = await fetch(`${running.origin}/v1/me`, { headers: { cookie } }).then(r => r.json()) as { data: { avatar_id: string } };
    assert.equal(me.data.avatar_id, "owl");
    const service = running.service;
    const project = service.createProject(identity.actor, { title: "Profile ACL", idempotency_key: "avatar-http-project" });
    const session = service.createSession(identity.actor, { project_id: project.id, title: "Private", mode: "solo", idempotency_key: "avatar-http-session" }).session;
    const route = `${running.origin}/v1/sessions/${session.id}/avatar-profiles`;
    assert.equal((await fetch(route, { headers: { authorization: `Bearer ${stranger.token}` } })).status, 404);
    const profiles = await fetch(route, { headers: { cookie } }).then(r => r.json()) as { data: unknown };
    assert.equal(SessionAvatarProfilesSchema.parse(profiles.data).profiles[0]?.avatar_id, "owl");
    assert.equal((await put({ avatar_id: null })).status, 200);
    running.database.sqlite.prepare("UPDATE browser_sessions SET revoked_at = ? WHERE user_id = ?").run(new Date().toISOString(), identity.actor.user_id);
    assert.equal((await put({ avatar_id: "cat" })).status, 401);
  } finally { await running.close(); }
});
