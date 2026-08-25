import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { CollaborationDatabase, type DatabaseOptions } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { CollaborationService } from "../src/service.js";

function fixture(options: DatabaseOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-db-"));
  const database = new CollaborationDatabase(join(directory, "test.sqlite"), {
    authTokenPepper: "unit-test-auth-token-pepper",
    ...options,
  });
  const service = new CollaborationService(database);
  const ownerIdentity = database.bootstrapIdentity({
    user_id: "owner",
    display_name: "Owner",
    device_id: "owner-device",
    device_name: "Owner laptop",
  });
  const memberIdentity = database.createIdentity({
    user_id: "member",
    display_name: "Member",
    device_id: "member-device",
    device_name: "Member laptop",
  });
  return {
    directory,
    database,
    service,
    owner: ownerIdentity.actor,
    ownerToken: ownerIdentity.token,
    member: memberIdentity.actor,
    memberToken: memberIdentity.token,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function workerMessage(worker: Worker): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    worker.once("message", (message: Record<string, unknown>) => resolve(message));
    worker.once("error", reject);
  });
}

test("SQLite WAL assigns ordered sequences and replays an idempotent event", () => {
  const f = fixture();
  try {
    assert.equal(f.database.journalMode(), "wal");
    const { session } = f.service.createSession(f.owner, {
      session_id: "multi-1",
      idempotency_key: "create-multi-0001",
      mode: "multi",
      title: "Shared work",
    });
    const retriedCreation = f.service.createSession(f.owner, {
      session_id: "multi-1",
      idempotency_key: "create-multi-0001",
      mode: "multi",
      title: "Shared work",
    });
    assert.equal(retriedCreation.session.id, session.id);
    assert.throws(
      () => f.service.createSession(f.owner, {
        session_id: "multi-1",
        idempotency_key: "create-multi-0001",
        mode: "multi",
        title: "Changed title",
      }),
      (error: unknown) => error instanceof ApiError && error.code === "idempotency_conflict",
    );
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "member-set-0001");

    const first = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "chat-write-0001",
      type: "human_chat",
      visibility: "session",
      payload: { text: "hello", token: "must-not-persist", nested: "Bearer very-secret-value" },
    });
    const repeated = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "chat-write-0001",
      type: "human_chat",
      visibility: "session",
      payload: { text: "hello", token: "must-not-persist", nested: "Bearer very-secret-value" },
    });

    assert.deepEqual(repeated, first);
    assert.throws(
      () => f.service.appendEvent(f.member, session.id, {
        idempotency_key: "chat-write-0001",
        type: "human_chat",
        visibility: "session",
        payload: { text: "different retry body" },
      }),
      (error: unknown) => error instanceof ApiError && error.code === "idempotency_conflict",
    );
    assert.deepEqual(first.payload, {
      text: "hello",
      token: "[REDACTED]",
      nested: "Bearer [REDACTED]",
    });
    const replay = f.service.replay(f.member, session.id, 0, 100);
    assert.deepEqual(replay.events.map((event) => event.sequence), [1, 2, 3]);
    assert.equal(replay.cursor, 3);
    assert.equal(replay.has_more, false);

    const privateEvent = f.service.appendEvent(f.owner, session.id, {
      idempotency_key: "owner-private-0001",
      type: "context_snapshot",
      visibility: "owner_only",
      payload: { summary: "private" },
    });
    assert.equal(privateEvent.sequence, 4);
    assert.throws(
      () => f.service.appendEvent(f.member, session.id, {
        idempotency_key: "owner-private-0001",
        type: "human_chat",
        visibility: "session",
        payload: { text: "collision" },
      }),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    const memberReplay = f.service.replay(f.member, session.id, 3, 100);
    assert.deepEqual(memberReplay.events, []);
    assert.equal(memberReplay.cursor, 4);
  } finally {
    f.close();
  }
});

test("replay and storage quotas bound bytes without breaking cursor or idempotency semantics", () => {
  const f = fixture({
    maxEventBytes: 1_200,
    maxUserEventBytes: 2_100,
    maxSessionEventBytes: 20_000,
    maxTotalEventBytes: 20_000,
  });
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "quota-room",
      idempotency_key: "quota-room-create-1",
      mode: "multi",
      title: "Quota room",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "quota-member-add-1");
    const first = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "quota-event-first-1",
      type: "human_chat",
      visibility: "session",
      payload: { content: `一${"x".repeat(350)}` },
    });
    const second = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "quota-event-second-1",
      type: "human_chat",
      visibility: "session",
      payload: { content: `二${"y".repeat(350)}` },
    });
    const sequenceBeforeFailure = f.database.requireSession(session.id).next_sequence;
    const countBeforeFailure = (f.database.sqlite.prepare("SELECT count(*) AS count FROM events WHERE session_id = ?")
      .get(session.id) as { count: number }).count;
    assert.throws(
      () => f.service.appendEvent(f.member, session.id, {
        idempotency_key: "quota-event-third-1",
        type: "human_chat",
        visibility: "session",
        payload: { content: `三${"z".repeat(350)}` },
      }),
      (error: unknown) => error instanceof ApiError && error.code === "storage_quota_exceeded",
    );
    assert.equal(f.database.requireSession(session.id).next_sequence, sequenceBeforeFailure);
    assert.equal((f.database.sqlite.prepare("SELECT count(*) AS count FROM events WHERE session_id = ?")
      .get(session.id) as { count: number }).count, countBeforeFailure);
    assert.deepEqual(f.service.appendEvent(f.member, session.id, {
      idempotency_key: "quota-event-second-1",
      type: "human_chat",
      visibility: "session",
      payload: { content: `二${"y".repeat(350)}` },
    }), second);

    const collected: string[] = [];
    let cursor = 0;
    let pages = 0;
    while (true) {
      const page = f.service.replay(f.member, session.id, cursor, 100, 1_000);
      collected.push(...page.events.map((event) => event.id));
      cursor = page.cursor;
      pages += 1;
      if (!page.has_more) break;
    }
    assert.ok(pages > 1);
    assert.deepEqual(collected.slice(-2), [first.id, second.id]);
    assert.equal(new Set(collected).size, collected.length);
    assert.equal(cursor, sequenceBeforeFailure);
  } finally {
    f.close();
  }
});

test("existing event logs backfill the quota ledger and remain replayable when grandfathered over a new limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-quota-migration-"));
  const path = join(directory, "legacy.sqlite");
  const pepper = "legacy-quota-ledger-test-pepper";
  let database = new CollaborationDatabase(path, { authTokenPepper: pepper });
  try {
    const service = new CollaborationService(database);
    const owner = database.bootstrapIdentity({
      user_id: "owner",
      display_name: "Owner",
      device_id: "owner-device",
      device_name: "Owner laptop",
    }).actor;
    const { session } = service.createSession(owner, {
      session_id: "legacy-room",
      idempotency_key: "legacy-room-create-1",
      mode: "multi",
      title: "Legacy room",
    });
    for (const index of [1, 2]) {
      service.appendEvent(owner, session.id, {
        idempotency_key: `legacy-event-${index}`,
        type: "human_chat",
        visibility: "session",
        payload: { content: "legacy" },
      });
    }
    database.sqlite.exec("DROP TABLE event_storage_usage");
    database.close();

    database = new CollaborationDatabase(path, {
      authTokenPepper: pepper,
      maxEventBytes: 1_024,
      maxUserEventBytes: 1_024,
      maxSessionEventBytes: 10_000,
      maxTotalEventBytes: 10_000,
    });
    const reopened = new CollaborationService(database);
    const usage = database.sqlite.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM event_storage_usage")
      .get() as { bytes: number };
    assert.ok(usage.bytes > 1_024);
    assert.equal(reopened.replay(owner, session.id, 0, 100).events.length, 3);
    assert.equal(reopened.appendEvent(owner, session.id, {
      idempotency_key: "legacy-event-2",
      type: "human_chat",
      visibility: "session",
      payload: { content: "legacy" },
    }).sequence, 3);
    assert.throws(
      () => reopened.appendEvent(owner, session.id, {
        idempotency_key: "legacy-event-new-1",
        type: "human_chat",
        visibility: "session",
        payload: { content: "blocked" },
      }),
      (error: unknown) => error instanceof ApiError && error.code === "storage_quota_exceeded",
    );
  } finally {
    try { database.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("membership and session control events cannot exceed aggregate storage quotas", () => {
  const f = fixture({
    maxEventBytes: 1_200,
    maxUserEventBytes: 1_600,
    maxSessionEventBytes: 1_600,
    maxTotalEventBytes: 1_600,
  });
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "control-quota-room",
      idempotency_key: "control-quota-create-1",
      mode: "multi",
      title: "Control quota",
    });
    let rejected = false;
    for (let index = 0; index < 10; index += 1) {
      try {
        f.service.updateSession(f.owner, session.id, {
          title: `Control quota ${index}`,
          idempotency_key: `control-quota-update-${index}`,
        });
      } catch (error) {
        assert.ok(error instanceof ApiError && error.code === "storage_quota_exceeded");
        rejected = true;
        break;
      }
    }
    assert.equal(rejected, true);
    const usage = f.database.sqlite.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM event_storage_usage")
      .get() as { bytes: number };
    assert.ok(usage.bytes <= 1_600);
  } finally {
    f.close();
  }
});

test("solo ACL rejects participant writes while preserving viewer replay", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "solo-1",
      idempotency_key: "create-solo-0001",
      mode: "solo",
      title: "Owner run",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "solo-member-0001");
    assert.throws(
      () => f.service.appendEvent(f.member, session.id, {
        idempotency_key: "illegal-write-0001",
        type: "human_chat",
        visibility: "session",
        payload: { text: "no" },
      }),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    assert.equal(f.service.replay(f.member, session.id, 0, 100).events.length, 2);
  } finally {
    f.close();
  }
});

test("only the initiating user's runtime can claim and complete an agent request", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "runtime-1",
      idempotency_key: "create-runtime-0001",
      mode: "multi",
      title: "Runtime work",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "runtime-member-0001");
    const request = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "agent-request-0001",
      type: "agent_request",
      visibility: "session",
      payload: { prompt: "do the work" },
    });
    const runtime = f.service.registerRuntime(f.member, {
      runtime_id: "runtime-member-1",
      session_id: session.id,
      device_id: f.member.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-5",
      local_session_id: "local-session-1",
      capture_fidelity: "harness_transcript",
    });
    const claim = f.service.claimAgentRequest(f.member, session.id, request.id, runtime.id);
    assert.equal(claim.status, "claimed");
    const secondRequest = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "agent-request-0002",
      type: "agent_request",
      visibility: "session",
      payload: { prompt: "do more work" },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, secondRequest.id, runtime.id),
      (error: unknown) => error instanceof ApiError && error.code === "runtime_busy",
    );
    const response = f.service.completeAgentRequest(
      f.member,
      session.id,
      request.id,
      runtime.id,
      "agent-response-0001",
      { text: "done" },
    );
    assert.equal(response.reply_to_event_id, request.id);
    assert.equal(response.runtime_provenance?.user_id, f.member.user_id);
    assert.equal(response.runtime_provenance?.capture_fidelity, "harness_transcript");
  } finally {
    f.close();
  }
});

test("device credentials use peppered HMAC digests and track use, expiry, revocation, and rotation", () => {
  const f = fixture();
  try {
    const row = f.database.sqlite.prepare("SELECT token_hash FROM devices WHERE id = ?")
      .get(f.owner.device_id) as { token_hash: string };
    assert.equal(
      row.token_hash,
      createHmac("sha256", "unit-test-auth-token-pepper").update(f.ownerToken).digest("hex"),
    );
    assert.equal(row.token_hash.includes(f.ownerToken), false);
    assert.deepEqual(f.database.authenticate(f.ownerToken), f.owner);
    assert.ok(f.database.getDevice(f.owner, f.owner.device_id).last_used_at);

    const rotated = f.service.rotateDeviceToken(f.owner, f.owner.device_id, "2099-01-01T00:00:00.000Z");
    assert.equal(rotated.device.token_version, 2);
    assert.ok(rotated.device.rotated_at);
    assert.throws(() => f.database.authenticate(f.ownerToken), (error: unknown) => error instanceof ApiError && error.status === 401);
    assert.deepEqual(f.database.authenticate(rotated.token), f.owner);

    const expired = f.database.createDevice(
      f.owner.user_id,
      "Expired credential",
      "expired-device",
      "2000-01-01T00:00:00.000Z",
    );
    assert.equal(expired.device.expires_at, "2000-01-01T00:00:00.000Z");
    assert.throws(() => f.database.authenticate(expired.token), (error: unknown) => error instanceof ApiError && error.status === 401);

    f.service.revokeDevice(f.owner, f.owner.device_id);
    assert.throws(() => f.database.authenticate(rotated.token), (error: unknown) => error instanceof ApiError && error.status === 401);
    assert.ok(f.database.getDevice(f.owner, f.owner.device_id).revoked_at);
  } finally {
    f.close();
  }
});

test("browser sessions store only peppered digests and expire or revoke with their device", () => {
  let instant = new Date("2026-08-25T00:00:00.000Z");
  const f = fixture({ clock: () => instant });
  try {
    const first = f.database.createBrowserSession(f.owner);
    assert.match(first.token, /^gtb_[A-Za-z0-9_-]{43}$/);
    assert.equal(
      new Date(first.expires_at).getTime() - instant.getTime(),
      24 * 60 * 60 * 1_000,
    );
    const stored = f.database.sqlite.prepare("SELECT token_digest FROM browser_sessions WHERE id = ?")
      .get(first.session_id) as { token_digest: string };
    assert.equal(
      stored.token_digest,
      createHmac("sha256", "unit-test-auth-token-pepper").update(first.token).digest("hex"),
    );
    assert.equal(JSON.stringify(f.database.sqlite.prepare("SELECT * FROM browser_sessions").all()).includes(first.token), false);
    assert.deepEqual(f.database.authenticateBrowserSession(first.token).actor, f.owner);

    const replacement = f.database.createBrowserSession(f.owner);
    assert.throws(
      () => f.database.authenticateBrowserSession(first.token),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    assert.deepEqual(f.database.authenticateBrowserSession(replacement.token).actor, f.owner);
    f.database.revokeBrowserSession(replacement.session_id, f.owner);
    assert.throws(
      () => f.database.authenticateBrowserSession(replacement.token),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );

    const expired = f.database.createBrowserSession(f.owner);
    instant = new Date(expired.expires_at);
    assert.throws(
      () => f.database.authenticateBrowserSession(expired.token),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );

    instant = new Date("2026-08-27T00:00:00.000Z");
    const invalidatedByRotation = f.database.createBrowserSession(f.owner);
    f.service.rotateDeviceToken(f.owner, f.owner.device_id);
    assert.throws(
      () => f.database.authenticateBrowserSession(invalidatedByRotation.token),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );

    const invalidatedByRevocation = f.database.createBrowserSession(f.owner);
    f.service.revokeDevice(f.owner, f.owner.device_id);
    assert.throws(
      () => f.database.authenticateBrowserSession(invalidatedByRevocation.token),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
  } finally {
    f.close();
  }
});

test("invitation claim and requested browser session commit atomically", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "atomic-browser-invite",
      idempotency_key: "create-atomic-browser-invite",
      mode: "multi",
      title: "Atomic browser invite",
    });
    const invitation = f.service.createInvitation(f.owner, session.id, { role: "participant" });
    f.database.sqlite.exec(`
      CREATE TRIGGER fail_browser_session_insert
      BEFORE INSERT ON browser_sessions
      BEGIN SELECT RAISE(ABORT, 'simulated browser session failure'); END;
    `);
    assert.throws(() => f.database.claimInvitation({
      invite_token: invitation.invite_token,
      user_id: "atomic-invitee",
      display_name: "Atomic Invitee",
      device_id: "atomic-invitee-device",
      device_name: "Browser",
    }, { browserSession: true }));
    const afterFailure = f.database.sqlite.prepare("SELECT claimed_at FROM invitations WHERE id = ?")
      .get(invitation.invitation.id) as { claimed_at: string | null };
    assert.equal(afterFailure.claimed_at, null);
    const userCount = f.database.sqlite.prepare("SELECT count(*) AS count FROM users WHERE id = ?")
      .get("atomic-invitee") as { count: number };
    assert.equal(userCount.count, 0);
    f.database.sqlite.exec("DROP TRIGGER fail_browser_session_insert");

    const claimed = f.database.claimInvitation({
      invite_token: invitation.invite_token,
      user_id: "atomic-invitee",
      display_name: "Atomic Invitee",
      device_id: "atomic-invitee-device",
      device_name: "Browser",
    }, { browserSession: true });
    assert.deepEqual(f.database.authenticateBrowserSession(claimed.browser_session.token).actor, claimed.actor);
  } finally {
    f.close();
  }
});

test("new and existing users claim invitation-bound membership without exposing an invitee credential to the owner", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "invite-session",
      idempotency_key: "create-invite-session",
      mode: "multi",
      title: "Invitation work",
    });
    const created = f.service.createInvitation(f.owner, session.id, { role: "participant" });
    assert.equal(created.invitation.role, "participant");
    assert.equal(
      new Date(created.invitation.expires_at).getTime() - new Date(created.invitation.created_at).getTime(),
      24 * 60 * 60 * 1_000,
    );
    assert.deepEqual(Object.keys(created).sort(), ["invitation", "invite_token"]);
    assert.match(created.invite_token, /^gti_/);
    const stored = f.database.sqlite.prepare("SELECT token_digest FROM invitations WHERE id = ?")
      .get(created.invitation.id) as { token_digest: string };
    assert.equal(
      stored.token_digest,
      createHmac("sha256", "unit-test-auth-token-pepper").update(created.invite_token).digest("hex"),
    );
    assert.equal(JSON.stringify(f.database.sqlite.prepare("SELECT * FROM invitations").all()).includes(created.invite_token), false);

    const claimed = f.service.claimInvitation({
      invite_token: created.invite_token,
      user_id: "invitee",
      display_name: "Invitee",
      device_id: "invitee-device",
      device_name: "Invitee laptop",
    });
    assert.match(claimed.token, /^gta_/);
    assert.equal(f.database.membershipRole(session.id, "invitee"), "participant");
    assert.deepEqual(f.database.authenticate(claimed.token), claimed.actor);
    assert.equal("token" in created, false);
    assert.throws(
      () => f.service.claimInvitation({
        invite_token: created.invite_token,
        display_name: "Replay",
        device_name: "Replay device",
      }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );

    const existingInvite = f.service.createInvitation(f.owner, session.id, { role: "viewer", ttl: "1h" });
    const existingClaim = f.service.claimInvitationForActor(f.member, existingInvite.invite_token);
    assert.equal(f.database.membershipRole(session.id, f.member.user_id), "viewer");
    assert.equal("token" in existingClaim, false);
    assert.deepEqual(
      f.service.listInvitationAudit(f.owner, session.id).map((entry) => entry.action),
      ["created", "claimed", "created", "claimed"],
    );
  } finally {
    f.close();
  }
});

test("expired and revoked invitations fail closed and leave content-free audit records", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-expiry-"));
  let instant = new Date("2026-01-01T00:00:00.000Z");
  const database = new CollaborationDatabase(join(directory, "test.sqlite"), {
    authTokenPepper: "unit-test-auth-token-pepper",
    clock: () => instant,
  });
  const service = new CollaborationService(database);
  try {
    const owner = database.bootstrapIdentity({
      user_id: "owner-expiry",
      display_name: "Owner",
      device_id: "owner-expiry-device",
      device_name: "Owner laptop",
    }).actor;
    const { session } = service.createSession(owner, {
      session_id: "expiry-session",
      idempotency_key: "create-expiry-session",
      mode: "multi",
      title: "Expiry work",
    });
    const expiring = service.createInvitation(owner, session.id, { role: "viewer", ttl: "1h" });
    instant = new Date("2026-01-01T01:00:00.001Z");
    assert.throws(
      () => service.claimInvitation({
        invite_token: expiring.invite_token,
        display_name: "Late",
        device_name: "Late device",
      }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    assert.ok(service.listInvitations(owner, session.id)[0]?.expired_at);

    const revoked = service.createInvitation(owner, session.id, { role: "participant", ttl: "7d" });
    service.revokeInvitation(owner, session.id, revoked.invitation.id);
    assert.throws(
      () => service.claimInvitation({
        invite_token: revoked.invite_token,
        display_name: "Revoked",
        device_name: "Revoked device",
      }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    const audit = service.listInvitationAudit(owner, session.id);
    assert.deepEqual(audit.map((entry) => entry.action), ["created", "expired", "created", "revoked"]);
    assert.equal(JSON.stringify(audit).includes(expiring.invite_token), false);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("device authorization is short-lived, single-use, and returns the new credential only on claim", () => {
  const f = fixture();
  try {
    const created = f.service.createDeviceAuthorization(f.owner);
    assert.deepEqual(Object.keys(created).sort(), ["authorization", "authorization_token"]);
    assert.match(created.authorization_token, /^gtd_/);
    const claimed = f.service.claimDeviceAuthorization({
      authorization_token: created.authorization_token,
      device_id: "owner-second-device",
      device_name: "Owner tablet",
    });
    assert.match(claimed.token, /^gta_/);
    assert.equal(claimed.actor.user_id, f.owner.user_id);
    assert.deepEqual(f.database.authenticate(claimed.token), claimed.actor);
    assert.equal("token" in created, false);
    assert.throws(
      () => f.service.claimDeviceAuthorization({
        authorization_token: created.authorization_token,
        device_name: "Replay device",
      }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
  } finally {
    f.close();
  }
});

test("runtime provenance and delegated device authorization remain bound to the authenticated device", () => {
  const f = fixture();
  try {
    const second = f.database.createDevice(f.member.user_id, "Member desktop", "member-device-2");
    const secondActor = { ...f.member, device_id: second.device_id };
    const { session } = f.service.createSession(f.owner, {
      session_id: "device-bound-runtime",
      idempotency_key: "device-bound-session-1",
      mode: "multi",
      title: "Device bound runtime",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "device-bound-member-1");

    assert.throws(
      () => f.service.registerRuntime(f.member, {
        session_id: session.id,
        device_id: second.device_id,
        harness: "codex",
        provider: "openai",
        model: "gpt-5",
        local_session_id: "forged-device",
        capture_fidelity: "harness_transcript",
      }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );

    const runtime = f.service.registerRuntime(secondActor, {
      session_id: session.id,
      device_id: second.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-5",
      local_session_id: "real-device",
      capture_fidelity: "harness_transcript",
    });
    assert.throws(
      () => f.service.appendEvent(f.member, session.id, {
        idempotency_key: "forged-runtime-event-1",
        type: "tool_result",
        visibility: "session",
        runtime_id: runtime.id,
        payload: { content: "forged" },
      }),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    assert.throws(
      () => f.service.heartbeatRuntime(f.member, runtime.id),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
    const request = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "device-bound-request-1",
      type: "agent_request",
      visibility: "session",
      payload: { content: "work" },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, request.id, runtime.id),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    assert.equal(f.service.claimAgentRequest(secondActor, session.id, request.id, runtime.id).status, "claimed");
    assert.throws(
      () => f.service.completeAgentRequest(f.member, session.id, request.id, runtime.id, "forged-complete-1", { content: "forged" }),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    const completed = f.service.completeAgentRequest(
      secondActor,
      session.id,
      request.id,
      runtime.id,
      "device-bound-complete-1",
      { content: "done" },
    );
    assert.throws(
      () => f.service.completeAgentRequest(f.member, session.id, request.id, runtime.id, "device-bound-complete-1", { content: "done" }),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    assert.equal(completed.runtime_provenance?.device_id, second.device_id);

    assert.throws(
      () => f.service.rotateDeviceToken(f.member, second.device_id),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    const delegated = f.service.createDeviceAuthorization(secondActor);
    f.service.revokeDevice(f.member, second.device_id);
    assert.throws(
      () => f.service.appendEvent(secondActor, session.id, {
        idempotency_key: "revoked-cached-actor-1",
        type: "human_chat",
        visibility: "session",
        payload: { content: "must not persist" },
      }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    assert.throws(
      () => f.service.claimDeviceAuthorization({
        authorization_token: delegated.authorization_token,
        device_name: "Attacker recovery",
      }),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
  } finally {
    f.close();
  }
});

test("concurrent invitation claims commit exactly one identity, membership, and credential", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-invite-race-"));
  const databasePath = join(directory, "test.sqlite");
  const pepper = "unit-test-race-auth-token-pepper";
  const database = new CollaborationDatabase(databasePath, { authTokenPepper: pepper });
  const service = new CollaborationService(database);
  const owner = database.bootstrapIdentity({
    user_id: "race-owner",
    display_name: "Owner",
    device_id: "race-owner-device",
    device_name: "Owner laptop",
  }).actor;
  const { session } = service.createSession(owner, {
    session_id: "race-session",
    idempotency_key: "create-race-session",
    mode: "multi",
    title: "Race work",
  });
  const invitation = service.createInvitation(owner, session.id, { role: "participant" });
  database.close();

  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { CollaborationDatabase } = await import(workerData.moduleUrl);
      const database = new CollaborationDatabase(workerData.databasePath, { authTokenPepper: workerData.pepper });
      parentPort.postMessage({ ready: true });
      parentPort.once("message", () => {
        try {
          const result = database.claimInvitation({
            invite_token: workerData.inviteToken,
            user_id: workerData.userId,
            display_name: workerData.userId,
            device_id: workerData.deviceId,
            device_name: "Race device",
          });
          parentPort.postMessage({ success: true, userId: result.actor.user_id });
        } catch (error) {
          parentPort.postMessage({ success: false, code: error && error.code });
        } finally {
          database.close();
        }
      });
    })().catch((error) => parentPort.postMessage({ success: false, error: String(error) }));
  `;
  const makeWorker = (suffix: string) => new Worker(workerSource, {
    eval: true,
    workerData: {
      moduleUrl: new URL("../src/database.js", import.meta.url).href,
      databasePath,
      pepper,
      inviteToken: invitation.invite_token,
      userId: `race-user-${suffix}`,
      deviceId: `race-device-${suffix}`,
    },
  });
  const workers = [makeWorker("a"), makeWorker("b")];
  try {
    await Promise.all(workers.map(workerMessage));
    const results = workers.map((worker) => {
      const message = workerMessage(worker);
      worker.postMessage("go");
      return message;
    });
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter((outcome) => outcome.success === true).length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.success === false).length, 1);

    const verification = new CollaborationDatabase(databasePath, { authTokenPepper: pepper });
    try {
      const memberCount = verification.sqlite.prepare("SELECT count(*) AS count FROM memberships WHERE session_id = ? AND role = 'participant'")
        .get(session.id) as { count: number };
      const claimCount = verification.sqlite.prepare("SELECT count(*) AS count FROM invitation_audit WHERE invitation_id = ? AND action = 'claimed'")
        .get(invitation.invitation.id) as { count: number };
      assert.equal(memberCount.count, 1);
      assert.equal(claimCount.count, 1);
    } finally {
      verification.close();
    }
  } finally {
    for (const worker of workers) await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
});
