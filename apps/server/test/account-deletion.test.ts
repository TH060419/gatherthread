import { browserSessionFixture } from "./auth-fixtures.js";
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
      device_id: "staying-device", device_name: "Tablet", can_create_projects: true }).actor;
    const viewer = database.createIdentity({ user_id: "viewing", display_name: "Viewing",
      device_id: "viewing-device", device_name: "Phone" }).actor;
    const project = service.createProject(owner, { title: "Together", idempotency_key: "account-project-1" });
    const invite = service.createProjectInvitation(owner, project.id, { role: "participant" });
    service.claimInvitationForActor(member, invite.invite_token);
    service.claimInvitationForActor(viewer,
      service.createProjectInvitation(owner, project.id, { role: "viewer" }).invite_token);
    const multi = service.createSession(owner, { project_id: project.id, session_id: "shared-test",
      idempotency_key: "account-multi-1", mode: "multi", title: "Shared" }).session;
    const solo = service.createSession(owner, { project_id: project.id, session_id: "private-test",
      idempotency_key: "account-solo-1", mode: "solo", title: "Private" }).session;
    service.appendEvent(owner, multi.id, { type: "human_chat", visibility: "session",
      idempotency_key: "account-message-1", payload: { content: "Shared work remains" } });
    const runtime = service.registerRuntime(owner, { session_id: multi.id, device_id: owner.device_id,
      harness: "codex", provider: "test", model: "test", local_session_id: "private-local-thread",
      capture_fidelity: "harness_transcript" });
    database.sqlite.prepare("UPDATE events SET payload_json=? WHERE session_id=? AND idempotency_key=?")
      .run(JSON.stringify({ content: "Shared work remains", runtime_id: runtime.id,
        local_session_id: runtime.local_session_id }), multi.id, "account-message-1");
    service.appendEvent(owner, solo.id, { type: "human_chat", visibility: "session",
      idempotency_key: "account-message-2", payload: { content: "Private work goes" } });
    const preview = service.accountDeletionPreview(owner);
    assert.equal(preview.owned_projects[0]?.id, project.id);
    assert.equal(preview.solo_sessions, 1);
    assert.equal(preview.shared_events, 2);
    assert.throws(() => service.deleteAccount(owner), /Transfer or delete/u);
    assert.throws(() => service.transferProjectOwnership(member, project.id, viewer.user_id, "account-transfer-denied"));
    assert.throws(() => service.transferProjectOwnership(owner, project.id, viewer.user_id, "account-transfer-viewer"),
      /existing participant/u);
    const memberProject = service.createProject(member, { title: "Full quota", idempotency_key: "member-quota-project" });
    database.sqlite.prepare(`INSERT INTO code_repositories
      (project_id,main_commit,main_logical_bytes,created_at) VALUES (?,?,?,?)`)
      .run(memberProject.id, "0".repeat(40), 128 * 1024 * 1024, new Date().toISOString());
    database.sqlite.prepare(`INSERT INTO code_repositories
      (project_id,main_commit,main_logical_bytes,created_at) VALUES (?,?,?,?)`)
      .run(project.id, "0".repeat(40), 1, new Date().toISOString());
    assert.throws(() => service.transferProjectOwnership(owner, project.id, member.user_id, "account-transfer-quota"),
      /capacity/u);
    database.sqlite.prepare("DELETE FROM code_repositories WHERE project_id IN (?,?)")
      .run(memberProject.id, project.id);
    assert.equal(service.transferProjectOwnership(owner, project.id, member.user_id, "account-transfer-1").owner_user_id,
      member.user_id);
    assert.equal(service.transferProjectOwnership(owner, project.id, member.user_id, "account-transfer-1").owner_user_id,
      member.user_id);
    assert.throws(() => service.transferProjectOwnership(owner, project.id, viewer.user_id, "account-transfer-1"),
      /retry does not match/u);
    assert.equal((database.sqlite.prepare("SELECT role FROM memberships WHERE session_id=? AND user_id=?")
      .get(multi.id, member.user_id) as { role: string }).role, "owner");
    assert.equal((database.sqlite.prepare("SELECT role FROM memberships WHERE session_id=? AND user_id=?")
      .get(multi.id, owner.user_id) as { role: string }).role, "participant");
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
    const retainedPayload = database.sqlite.prepare("SELECT payload_json FROM events WHERE session_id=? AND idempotency_key=?")
      .get(multi.id, "account-message-1") as { payload_json: string };
    assert.deepEqual(JSON.parse(retainedPayload.payload_json), { content: "Shared work remains",
      runtime_id: "deleted-runtime", local_session_id: "private" });
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
    const recipient = running.database.createIdentity({ user_id: "http-recipient", display_name: "Recipient",
      device_id: "http-recipient-device", device_name: "Tablet" }).actor;
    const service = new CollaborationService(running.database);
    const project = service.createProject(identity.actor, { title: "HTTP transfer", idempotency_key: "http-transfer-project" });
    service.claimInvitationForActor(recipient,
      service.createProjectInvitation(identity.actor, project.id, { role: "participant" }).invite_token);
    const opened = browserSessionFixture(running, { token: identity.token, origin: browserOrigin });
    assert.equal(opened.status, 201);
    const cookie = opened.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const transferPath = `/v1/projects/${project.id}/transfer-ownership`;
    const transferBody = { target_user_id: recipient.user_id, idempotency_key: "http-transfer-attempt" };
    assert.equal((await request(transferPath, { method: "POST", token: identity.token,
      origin: browserOrigin, body: transferBody })).status, 403);
    assert.equal((await request(transferPath, { method: "POST", cookie,
      origin: "https://untrusted.example", body: transferBody })).status, 403);
    assert.equal((await request(transferPath, { method: "POST", cookie,
      origin: browserOrigin, body: transferBody })).status, 200);
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
