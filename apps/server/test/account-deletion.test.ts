import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { startCollaborationServer } from "../src/server.js";

test("deleting an account requires ownership transfer, deletes Solo, retains anonymized Multi, and revokes devices", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-account-delete-"));
  const database = new CollaborationDatabase(join(directory, "test.sqlite"), {
    authTokenPepper: "account-deletion-test-pepper-not-a-credential",
  });
  try {
    const service = new CollaborationService(database);
    const owner = database.bootstrapIdentity({ user_id: "leaving", display_name: "Leaving",
      device_id: "leaving-device", device_name: "Laptop" }).actor;
    const member = database.createIdentity({ user_id: "staying", display_name: "Staying",
      device_id: "staying-device", device_name: "Tablet" }).actor;
    const project = service.createProject(owner, { title: "Together", idempotency_key: "account-project-1" });
    const invite = service.createProjectInvitation(owner, project.id, { role: "participant" });
    service.claimInvitationForActor(member, invite.invite_token);
    const multi = service.createSession(owner, { project_id: project.id, session_id: "shared-test",
      idempotency_key: "account-multi-1", mode: "multi", title: "Shared" }).session;
    const solo = service.createSession(owner, { project_id: project.id, session_id: "private-test",
      idempotency_key: "account-solo-1", mode: "solo", title: "Private" }).session;
    service.appendEvent(owner, multi.id, { type: "human_chat", visibility: "session",
      idempotency_key: "account-message-1", payload: { content: "Shared work remains" } });
    service.appendEvent(owner, solo.id, { type: "human_chat", visibility: "session",
      idempotency_key: "account-message-2", payload: { content: "Private work goes" } });
    const preview = service.accountDeletionPreview(owner);
    assert.equal(preview.owned_projects[0]?.id, project.id);
    assert.equal(preview.solo_sessions, 1);
    assert.equal(preview.shared_events, 2);
    assert.throws(() => service.deleteAccount(owner), /Transfer or delete/u);
    assert.equal(service.transferProjectOwnership(owner, project.id, member.user_id, "account-transfer-1").owner_user_id,
      member.user_id);
    assert.equal(service.transferProjectOwnership(owner, project.id, member.user_id, "account-transfer-1").owner_user_id,
      member.user_id);
    service.removeProjectMembership(member, project.id, owner.user_id);
    assert.throws(() => service.deleteSession(owner, multi.id), /Session/u,
      "a former owner who has left cannot delete a retained shared session");
    assert.equal(service.deleteAccount(owner).deleted_solo_sessions, 1);
    assert.equal(database.sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(owner.user_id), undefined);
    assert.equal(database.sqlite.prepare("SELECT 1 FROM devices WHERE id = ?").get(owner.device_id), undefined);
    for (const table of ["project_memberships", "memberships", "runtimes", "browser_sessions", "remembered_accounts"] as const) {
      assert.equal((database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
        .get(owner.user_id) as { count: number }).count, 0, `${table} no longer links the deleted account`);
    }
    assert.equal(database.sqlite.prepare("SELECT 1 FROM sessions WHERE id = ?").get(solo.id), undefined);
    assert.equal(database.requireSession(multi.id).owner_user_id, "deleted-account");
    const event = database.sqlite.prepare("SELECT actor_user_id, actor_display_name FROM events WHERE session_id = ? AND type = 'human_chat'")
      .get(multi.id) as { actor_user_id: string; actor_display_name: string };
    assert.equal(event.actor_user_id, "deleted-account");
    assert.equal(event.actor_display_name, "Deleted member");
    assert.equal(database.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.throws(() => service.accountDeletionPreview(owner));
    assert.equal(service.listProjectSessions(member, project.id).some((session) => session.id === multi.id), true);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("account deletion HTTP requires a browser session and allowed Origin, then revokes all sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-account-http-"));
  const browserOrigin = "http://127.0.0.1:8787";
  const running = await startCollaborationServer({ databasePath: join(directory, "server.sqlite"),
    authTokenPepper: "account-http-test-pepper-not-a-credential", allowedOrigins: [browserOrigin] }, 0);
  const request = async (path: string, options: { method?: string; cookie?: string; token?: string;
    origin?: string; body?: unknown } = {}) => fetch(`${running.origin}${path}`, {
    method: options.method ?? "GET",
    headers: { ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  try {
    const identity = running.database.bootstrapIdentity({ user_id: "http-owner", display_name: "Owner",
      device_id: "http-device", device_name: "Laptop" });
    const opened = await request("/v1/browser-sessions", { method: "POST", token: identity.token,
      origin: browserOrigin });
    assert.equal(opened.status, 201);
    const cookie = opened.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    assert.equal((await request("/v1/account/deletion-preview", { token: identity.token })).status, 403);
    assert.equal((await request("/v1/account", { method: "DELETE", token: identity.token,
      origin: browserOrigin, body: { confirmation: "DELETE" } })).status, 403);
    assert.equal((await request("/v1/account", { method: "DELETE", cookie,
      body: { confirmation: "DELETE" } })).status, 403);
    assert.equal((await request("/v1/account", { method: "DELETE", cookie,
      origin: browserOrigin, body: { confirmation: "delete" } })).status, 400);
    assert.equal((await request("/v1/account/deletion-preview", { cookie })).status, 200);
    const deleted = await request("/v1/account", { method: "DELETE", cookie,
      origin: browserOrigin, body: { confirmation: "DELETE" } });
    assert.equal(deleted.status, 200);
    assert.match(deleted.headers.get("set-cookie") ?? "", /gatherthread_session=;/u);
    assert.equal((await request("/v1/me", { cookie })).status, 401);
    assert.equal((await request("/v1/me", { token: identity.token })).status, 401);
  } finally {
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
