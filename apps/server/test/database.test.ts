import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
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

test("participants create creator-owned solo sessions while project owners and viewers remain read only", () => {
  const f = fixture();
  try {
    const project = f.service.createProject(f.owner, {
      project_id: "personal-solo-project",
      idempotency_key: "personal-solo-project-create",
      title: "Personal solos",
    });
    const shared = f.service.createSession(f.owner, {
      project_id: project.id,
      session_id: "personal-solo-shared",
      idempotency_key: "personal-solo-shared-create",
      mode: "multi",
      title: "Shared",
    }).session;
    f.service.setMembership(f.owner, shared.id, f.member.user_id, "participant", "personal-solo-member-add");

    const created = f.service.createSession(f.member, {
      project_id: project.id,
      session_id: "member-personal-solo",
      idempotency_key: "member-personal-solo-create",
      mode: "solo",
      title: "Member notes",
    });
    assert.equal(created.session.owner_user_id, f.member.user_id);
    assert.equal(f.service.listProjectSessions(f.owner, project.id)
      .find((session) => session.id === created.session.id)?.owner_user_id, f.member.user_id);
    assert.equal(f.service.appendEvent(f.member, created.session.id, {
      idempotency_key: "member-personal-solo-chat",
      type: "human_chat",
      visibility: "session",
      payload: { text: "mine" },
    }).sequence, 2);
    assert.equal(f.service.updateSession(f.member, created.session.id, {
      title: "Renamed by creator",
      idempotency_key: "member-personal-solo-rename",
    }).session.title, "Renamed by creator");
    assert.throws(() => f.service.updateSession(f.member, created.session.id, {
      mode: "multi",
      idempotency_key: "member-personal-solo-mode",
    }), (error: unknown) => error instanceof ApiError && error.status === 403);

    assert.throws(() => f.service.createSession(f.member, {
      project_id: project.id,
      idempotency_key: "member-illegal-multi-create",
      mode: "multi",
      title: "Not allowed",
    }), (error: unknown) => error instanceof ApiError && error.status === 403);
    assert.throws(() => f.service.appendEvent(f.owner, created.session.id, {
      idempotency_key: "owner-illegal-personal-solo-chat",
      type: "human_chat",
      visibility: "session",
      payload: { text: "not mine" },
    }), (error: unknown) => error instanceof ApiError && error.status === 403);
    assert.throws(() => f.service.updateSession(f.owner, created.session.id, {
      title: "Owner cannot rename",
      idempotency_key: "owner-illegal-personal-solo-rename",
    }), (error: unknown) => error instanceof ApiError && error.status === 403);
    assert.throws(() => f.service.registerRuntime(f.owner, {
      runtime_id: "owner-illegal-personal-solo-runtime",
      session_id: created.session.id,
      device_id: f.owner.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-test",
      local_session_id: "owner-illegal-personal-solo-thread",
      capture_fidelity: "harness_transcript",
    }), (error: unknown) => error instanceof ApiError && error.status === 403);

    f.service.setProjectMembership(f.owner, project.id, f.member.user_id, "viewer");
    assert.throws(() => f.service.appendEvent(f.member, created.session.id, {
      idempotency_key: "viewer-illegal-personal-solo-chat",
      type: "human_chat",
      visibility: "session",
      payload: { text: "read only now" },
    }), (error: unknown) => error instanceof ApiError && error.status === 403);
    assert.throws(() => f.service.createSession(f.member, {
      project_id: project.id,
      idempotency_key: "viewer-illegal-solo-create",
      mode: "solo",
      title: "Viewer local only",
    }), (error: unknown) => error instanceof ApiError && error.status === 403);
  } finally {
    f.close();
  }
});

test("session count quotas bound participant-created solos without breaking exact retries", () => {
  const userLimited = fixture({ maxUserSessions: 1, maxProjectSessions: 10, maxTotalSessions: 20 });
  try {
    const project = userLimited.service.createProject(userLimited.owner, {
      project_id: "user-session-quota-project",
      idempotency_key: "user-session-quota-project-create",
      title: "User quota",
    });
    const shared = userLimited.service.createSession(userLimited.owner, {
      project_id: project.id,
      idempotency_key: "user-session-quota-shared",
      mode: "multi",
      title: "Shared",
    }).session;
    userLimited.service.setMembership(
      userLimited.owner, shared.id, userLimited.member.user_id, "participant", "user-session-quota-member",
    );
    const first = userLimited.service.createSession(userLimited.member, {
      project_id: project.id,
      idempotency_key: "user-session-quota-personal",
      mode: "solo",
      title: "Personal",
    });
    assert.equal(userLimited.service.createSession(userLimited.member, {
      project_id: project.id,
      idempotency_key: "user-session-quota-personal",
      mode: "solo",
      title: "Personal",
    }).session.id, first.session.id);
    assert.throws(() => userLimited.service.createSession(userLimited.member, {
      project_id: project.id,
      idempotency_key: "user-session-quota-overflow",
      mode: "solo",
      title: "Overflow",
    }), (error: unknown) => error instanceof ApiError
      && error.code === "session_quota_exceeded"
      && (error.details as { scope?: string } | undefined)?.scope === "user");
  } finally {
    userLimited.close();
  }

  const aggregateLimited = fixture({ maxUserSessions: 3, maxProjectSessions: 2, maxTotalSessions: 3 });
  try {
    const firstProject = aggregateLimited.service.createProject(aggregateLimited.owner, {
      project_id: "aggregate-session-quota-one",
      idempotency_key: "aggregate-session-quota-one-create",
      title: "First",
    });
    aggregateLimited.service.createSession(aggregateLimited.owner, {
      project_id: firstProject.id,
      idempotency_key: "aggregate-session-quota-one-a",
      mode: "multi",
      title: "One A",
    });
    aggregateLimited.service.createSession(aggregateLimited.owner, {
      project_id: firstProject.id,
      idempotency_key: "aggregate-session-quota-one-b",
      mode: "solo",
      title: "One B",
    });
    assert.throws(() => aggregateLimited.service.createSession(aggregateLimited.owner, {
      project_id: firstProject.id,
      idempotency_key: "aggregate-session-quota-project-overflow",
      mode: "solo",
      title: "Project overflow",
    }), (error: unknown) => error instanceof ApiError
      && error.code === "session_quota_exceeded"
      && (error.details as { scope?: string } | undefined)?.scope === "project");

    const secondProject = aggregateLimited.service.createProject(aggregateLimited.owner, {
      project_id: "aggregate-session-quota-two",
      idempotency_key: "aggregate-session-quota-two-create",
      title: "Second",
    });
    const secondShared = aggregateLimited.service.createSession(aggregateLimited.owner, {
      project_id: secondProject.id,
      idempotency_key: "aggregate-session-quota-two-a",
      mode: "multi",
      title: "Two A",
    }).session;
    aggregateLimited.service.setMembership(
      aggregateLimited.owner, secondShared.id, aggregateLimited.member.user_id, "participant",
      "aggregate-session-quota-member",
    );
    assert.throws(() => aggregateLimited.service.createSession(aggregateLimited.member, {
      project_id: secondProject.id,
      idempotency_key: "aggregate-session-quota-total-overflow",
      mode: "solo",
      title: "Total overflow",
    }), (error: unknown) => error instanceof ApiError
      && error.code === "session_quota_exceeded"
      && (error.details as { scope?: string } | undefined)?.scope === "deployment");
  } finally {
    aggregateLimited.close();
  }
});

test("project roles govern every current and future session while preserving solo read-only semantics", () => {
  const f = fixture();
  try {
    const project = f.service.createProject(f.owner, {
      project_id: "project-alpha",
      idempotency_key: "create-project-alpha",
      title: "Alpha",
    });
    const multi = f.service.createSession(f.owner, {
      project_id: project.id,
      session_id: "project-alpha-multi",
      idempotency_key: "create-project-alpha-multi",
      mode: "multi",
      title: "Implementation",
    }).session;
    const solo = f.service.createSession(f.owner, {
      project_id: project.id,
      session_id: "project-alpha-solo",
      idempotency_key: "create-project-alpha-solo",
      mode: "solo",
      title: "Owner notes",
    }).session;
    const invitation = f.service.createProjectInvitation(f.owner, project.id, {
      role: "participant",
      ttl: "1h",
    });
    const storedInvitation = f.database.sqlite.prepare("SELECT token_digest FROM project_invitations WHERE id = ?")
      .get(invitation.invitation.id) as { token_digest: string };
    assert.equal(
      storedInvitation.token_digest,
      createHmac("sha256", "unit-test-auth-token-pepper").update(invitation.invite_token).digest("hex"),
    );
    assert.equal(JSON.stringify(f.service.listProjectInvitations(f.owner, project.id)).includes(invitation.invite_token), false);
    const accepted = f.service.claimInvitationForActor(f.member, invitation.invite_token);
    assert.equal("project_id" in accepted.invitation && accepted.invitation.project_id, project.id);
    assert.equal(accepted.event, null);
    assert.deepEqual(
      f.service.listProjectSessions(f.member, project.id).map((session) => session.id).sort(),
      [multi.id, solo.id].sort(),
    );
    assert.equal(f.service.appendEvent(f.member, multi.id, {
      idempotency_key: "project-participant-chat",
      type: "human_chat",
      visibility: "session",
      payload: { content: "can edit multi" },
    }).sequence, 2);
    assert.throws(
      () => f.service.appendEvent(f.member, solo.id, {
        idempotency_key: "project-participant-solo",
        type: "human_chat",
        visibility: "session",
        payload: { content: "cannot edit solo" },
      }),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );

    const downgraded = f.service.setProjectMembership(f.owner, project.id, f.member.user_id, "viewer");
    assert.equal(downgraded.role, "viewer");
    assert.throws(
      () => f.service.appendEvent(f.member, multi.id, {
        idempotency_key: "project-viewer-chat",
        type: "human_chat",
        visibility: "session",
        payload: { content: "cannot edit any session" },
      }),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    assert.throws(
      () => f.service.setProjectMembership(f.owner, project.id, f.owner.user_id, "viewer"),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
  } finally {
    f.close();
  }
});

test("project creation leaves the project empty until the owner creates a session", () => {
  const f = fixture();
  try {
    const project = f.service.createProject(f.owner, {
      project_id: "empty-project",
      idempotency_key: "create-empty-project",
      title: "Empty project",
    });
    assert.equal(project.role, "owner");
    assert.equal(project.session_count, 0);
    assert.deepEqual(f.service.listProjectSessions(f.owner, project.id), []);
    assert.equal(f.service.listProjects(f.owner)[0]!.session_count, 0);

    const retried = f.service.createProject(f.owner, {
      project_id: "empty-project",
      idempotency_key: "create-empty-project",
      title: "Empty project",
    });
    assert.equal(retried.id, project.id);
    assert.equal(retried.session_count, 0);
    assert.deepEqual(f.service.listProjectSessions(f.owner, project.id), []);
  } finally {
    f.close();
  }
});

test("cloud deletion is creator-scoped, cascades server history, and leaves unrelated projects intact", () => {
  const f = fixture();
  try {
    const project = f.service.createProject(f.owner, {
      project_id: "delete-project", idempotency_key: "delete-project-create", title: "Delete me",
    });
    const retainedProject = f.service.createProject(f.owner, {
      project_id: "retained-project", idempotency_key: "retained-project-create", title: "Keep me",
    });
    const ownerSession = f.service.createSession(f.owner, {
      project_id: project.id, session_id: "owner-delete-session", idempotency_key: "owner-delete-session-create",
      mode: "multi", title: "Owner session",
    }).session;
    const invitation = f.service.createProjectInvitation(f.owner, project.id, { role: "participant", ttl: "1h" });
    f.service.claimInvitationForActor(f.member, invitation.invite_token);
    const memberSession = f.service.createSession(f.member, {
      project_id: project.id, session_id: "member-delete-session", idempotency_key: "member-delete-session-create",
      mode: "solo", title: "Member session",
    }).session;
    f.service.appendEvent(f.member, memberSession.id, {
      idempotency_key: "member-delete-event", type: "human_chat", visibility: "session", payload: { content: "cloud only" },
    });

    assert.throws(
      () => f.service.deleteSession(f.member, ownerSession.id),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
    assert.throws(
      () => f.service.deleteProject(f.member, project.id),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
    assert.deepEqual(f.service.deleteSession(f.member, memberSession.id), {
      project_id: project.id, session_id: memberSession.id,
    });
    assert.throws(
      () => f.database.requireSession(memberSession.id),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
    assert.equal((f.database.sqlite.prepare("SELECT count(*) AS count FROM events WHERE session_id = ?")
      .get(memberSession.id) as { count: number }).count, 0);

    const secondMemberSession = f.service.createSession(f.member, {
      project_id: project.id, session_id: "member-delete-by-owner", idempotency_key: "member-delete-by-owner-create",
      mode: "solo", title: "Owner may delete this cloud copy",
    }).session;
    assert.equal(f.service.deleteSession(f.owner, secondMemberSession.id).session_id, secondMemberSession.id);
    const deleted = f.service.deleteProject(f.owner, project.id);
    assert.deepEqual(deleted, { project_id: project.id, session_ids: [ownerSession.id] });
    assert.throws(
      () => f.database.requireProject(project.id),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
    assert.equal(f.database.requireProject(retainedProject.id).title, "Keep me");
  } finally {
    f.close();
  }
});

test("owner rename is transactional, monotonic, idempotent, and emits metadata only", () => {
  let timestamp = new Date("2026-08-25T12:00:00.000Z");
  const f = fixture({ clock: () => timestamp });
  try {
    const project = f.service.createProject(f.owner, {
      project_id: "rename-project", idempotency_key: "rename-project-create", title: "Rename",
    });
    const { session } = f.service.createSession(f.owner, {
      project_id: project.id, session_id: "rename-session", idempotency_key: "rename-session-create",
      mode: "multi", title: "Before",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "rename-session-member");
    const beforeProjectUpdatedAt = f.database.requireProject(project.id).updated_at;
    timestamp = new Date("2026-08-25T11:00:00.000Z");
    const renamed = f.service.updateSession(f.owner, session.id, {
      title: "After", idempotency_key: "rename-session-0001",
    });
    assert.equal(renamed.session.title, "After");
    assert.deepEqual(renamed.event.payload, { action: "renamed", title: "After" });
    assert.equal(JSON.stringify(renamed.event.payload).includes("Before"), false);
    assert.equal(f.database.requireProject(project.id).updated_at, beforeProjectUpdatedAt);
    assert.equal(f.service.updateSession(f.owner, session.id, {
      title: "After", idempotency_key: "rename-session-0001",
    }).event.id, renamed.event.id);
    const changedMode = f.service.updateSession(f.owner, session.id, {
      mode: "solo", idempotency_key: "session-mode-0001",
    });
    assert.equal(changedMode.session.mode, "solo");
    assert.deepEqual(changedMode.event.payload, { action: "updated", mode: "solo" });
    assert.throws(() => f.service.updateSession(f.member, session.id, {
      title: "Denied", idempotency_key: "rename-session-denied",
    }), (error: unknown) => error instanceof ApiError && error.status === 403);
  } finally {
    f.close();
  }
});

test("only the project owner can rename a project and retries are idempotent", () => {
  let timestamp = new Date("2026-08-25T12:00:00.000Z");
  const f = fixture({ clock: () => timestamp });
  try {
    const project = f.service.createProject(f.owner, {
      project_id: "project-title", idempotency_key: "project-title-create", title: "Before",
    });
    const invitation = f.service.createProjectInvitation(f.owner, project.id, { role: "participant", ttl: "1h" });
    f.service.claimInvitationForActor(f.member, invitation.invite_token);
    const beforeUpdatedAt = project.updated_at;
    timestamp = new Date("2026-08-25T13:00:00.000Z");

    const renamed = f.service.updateProject(f.owner, project.id, {
      title: "After 🚀", idempotency_key: "project-title-rename-0001",
    });
    assert.equal(renamed.title, "After 🚀");
    assert.equal(renamed.updated_at, timestamp.toISOString());
    assert.notEqual(renamed.updated_at, beforeUpdatedAt);
    assert.equal(f.service.updateProject(f.owner, project.id, {
      title: "After 🚀", idempotency_key: "project-title-rename-0001",
    }).updated_at, renamed.updated_at);
    assert.throws(() => f.service.updateProject(f.owner, project.id, {
      title: "Different", idempotency_key: "project-title-rename-0001",
    }), (error: unknown) => error instanceof ApiError && error.status === 409);
    assert.throws(() => f.service.updateProject(f.member, project.id, {
      title: "Denied", idempotency_key: "project-title-denied-0001",
    }), (error: unknown) => error instanceof ApiError && error.status === 404);
  } finally {
    f.close();
  }
});

test("legacy session-only databases migrate each session into an isolated project", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-project-migration-"));
  const path = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      mode TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      next_sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE memberships (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, user_id)
    ) STRICT;
    INSERT INTO users VALUES ('owner', 'Owner', '2026-08-25T00:00:00.000Z');
    INSERT INTO users VALUES ('member', 'Member', '2026-08-25T00:00:00.000Z');
    INSERT INTO sessions VALUES ('legacy-a', 'owner', 'multi', 'A', 'active', 0, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
    INSERT INTO sessions VALUES ('legacy-b', 'owner', 'solo', 'B', 'active', 0, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
    INSERT INTO memberships VALUES ('legacy-a', 'owner', 'owner', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
    INSERT INTO memberships VALUES ('legacy-a', 'member', 'participant', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
    INSERT INTO memberships VALUES ('legacy-b', 'owner', 'owner', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
  `);
  legacy.close();

  const database = new CollaborationDatabase(path, { authTokenPepper: "migration-test-pepper" });
  try {
    const first = database.requireSession("legacy-a");
    const second = database.requireSession("legacy-b");
    assert.notEqual(first.project_id, second.project_id);
    assert.equal(database.projectMembershipRole(first.project_id, "member"), "participant");
    assert.equal(database.projectMembershipRole(second.project_id, "member"), null);
    assert.equal(database.listProjects("owner").length, 2);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
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
    const secondDevice = f.database.createDevice(f.member.user_id, "Member second device", "member-device-claim-race");
    const secondActor = { ...f.member, device_id: secondDevice.device_id };
    const competingRuntime = f.service.registerRuntime(secondActor, {
      runtime_id: "runtime-member-claim-race",
      session_id: session.id,
      device_id: secondDevice.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-5",
      local_session_id: "local-session-claim-race",
      capture_fidelity: "harness_transcript",
    });
    assert.throws(
      () => f.service.claimAgentRequest(secondActor, session.id, request.id, competingRuntime.id),
      (error: unknown) => error instanceof ApiError && error.code === "agent_request_already_claimed",
    );
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
    assert.equal(
      f.service.claimAgentRequest(f.member, session.id, secondRequest.id, runtime.id).status,
      "claimed",
      "terminal completion must release the runtime for the next request",
    );
  } finally {
    f.close();
  }
});

/**
 * A claim-lease fixture: one `multi` session with `member` as a participant, a
 * request from `member`, and two `member` runtimes on two devices. `nowMs` is
 * mutable so a test can advance the clock past a claim lease without sleeping.
 */
function claimLeaseFixture(nowMs: { value: number }) {
  const f = fixture({ clock: () => new Date(nowMs.value) });
  const { session } = f.service.createSession(f.owner, {
    session_id: "lease-session",
    idempotency_key: "create-lease-0001",
    mode: "multi",
    title: "Lease work",
  });
  f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "lease-member-0001");
  const secondDevice = f.database.createDevice(f.member.user_id, "Member second device", "member-device-lease-2");
  const secondActor = { ...f.member, device_id: secondDevice.device_id };
  const first = f.service.registerRuntime(f.member, {
    runtime_id: "runtime-lease-1",
    session_id: session.id,
    device_id: f.member.device_id,
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    local_session_id: "local-lease-1",
    capture_fidelity: "harness_transcript",
  });
  const second = f.service.registerRuntime(secondActor, {
    runtime_id: "runtime-lease-2",
    session_id: session.id,
    device_id: secondActor.device_id,
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    local_session_id: "local-lease-2",
    capture_fidelity: "harness_transcript",
  });
  const request = (idempotencyKey: string) => f.service.appendEvent(f.member, session.id, {
    idempotency_key: idempotencyKey,
    type: "agent_request",
    visibility: "session",
    payload: {
      prompt: "do the work",
      execution_profile: {
        harness: "codex",
        provider: "openai",
        model: "gpt-5",
        runtime_id: first.id,
      },
    },
  });
  /**
   * Keep both devices present across a clock jump. Runtime presence and claim
   * liveness are separate questions: a device that is up and heartbeating can
   * still be holding a claim whose execution has wedged, which is the case
   * automatic re-dispatch exists to recover from.
   */
  const keepAlive = () => {
    f.service.heartbeatRuntime(f.member, first.id);
    f.service.heartbeatRuntime(secondActor, second.id);
  };
  return { f, sessionId: session.id, secondActor, first, second, request, keepAlive };
}

/** Comfortably past any claim lease the server would choose for itself. */
const PAST_LEASE_MS = 10 * 60_000;

test("an abandoned exact-runtime claim can only be reclaimed by that runtime", () => {
  const nowMs = { value: Date.parse("2026-09-20T00:00:00.000Z") };
  const { f, sessionId, secondActor, first, second, request, keepAlive } = claimLeaseFixture(nowMs);
  try {
    const event = request("agent-request-lease-0001");
    assert.equal(f.service.claimAgentRequest(f.member, sessionId, event.id, first.id).status, "claimed");
    // The claiming device never comes back. Its lease has to lapse, or the
    // request is stuck forever and no other runtime may answer it.
    nowMs.value += PAST_LEASE_MS;
    keepAlive();
    assert.throws(
      () => f.service.claimAgentRequest(secondActor, sessionId, event.id, second.id),
      (error: unknown) => error instanceof ApiError && error.code === "conflict",
      "an exact target must not silently move to another runtime",
    );
    const takeover = f.service.claimAgentRequest(f.member, sessionId, event.id, first.id);
    assert.equal(takeover.status, "claimed");
    assert.equal(takeover.runtime_id, first.id);
    assert.equal(takeover.attempt_count, 2);
    assert.equal(
      f.service.completeAgentRequest(f.member, sessionId, event.id, first.id, "agent-response-lease-0001", { text: "done" }, undefined, undefined, 2)
        .reply_to_event_id,
      event.id,
      "the current exact-runtime attempt owns the completion",
    );
  } finally {
    f.close();
  }
});

test("a runtime with a live claim cannot reclaim another lapsed request", () => {
  const nowMs = { value: Date.parse("2026-09-20T00:00:00.000Z") };
  const { f, sessionId, first, request, keepAlive } = claimLeaseFixture(nowMs);
  try {
    const lapsed = request("agent-request-lease-slot-0001");
    assert.equal(f.service.claimAgentRequest(f.member, sessionId, lapsed.id, first.id).status, "claimed");
    nowMs.value += PAST_LEASE_MS;
    keepAlive();
    const live = request("agent-request-lease-slot-0002");
    assert.equal(f.service.claimAgentRequest(f.member, sessionId, live.id, first.id).status, "claimed");
    assert.throws(
      () => f.service.claimAgentRequest(f.member, sessionId, lapsed.id, first.id),
      (error: unknown) => error instanceof ApiError && error.code === "runtime_busy",
    );
  } finally {
    f.close();
  }
});

test("expired and superseded claim attempts cannot publish progress or completion", () => {
  const nowMs = { value: Date.parse("2026-09-20T00:00:00.000Z") };
  const { f, sessionId, first, request, keepAlive } = claimLeaseFixture(nowMs);
  try {
    const event = request("agent-request-lease-fence-0001");
    const firstClaim = f.service.claimAgentRequest(f.member, sessionId, event.id, first.id);
    assert.equal(firstClaim.attempt_count, 1);
    nowMs.value += PAST_LEASE_MS;
    keepAlive();
    assert.throws(
      () => f.service.appendAgentProgress(f.member, sessionId, event.id, first.id, "progress-expired-0001", { content: "stale" }, undefined, undefined, 1),
      (error: unknown) => error instanceof ApiError && error.code === "conflict",
    );
    const secondClaim = f.service.claimAgentRequest(f.member, sessionId, event.id, first.id);
    assert.equal(secondClaim.attempt_count, 2);
    assert.throws(
      () => f.service.completeAgentRequest(f.member, sessionId, event.id, first.id, "complete-stale-0001", { text: "stale" }, undefined, undefined, 1),
      (error: unknown) => error instanceof ApiError && error.code === "conflict",
    );
    assert.equal(
      f.service.completeAgentRequest(f.member, sessionId, event.id, first.id, "complete-current-0001", { text: "done" }, undefined, undefined, 2).reply_to_event_id,
      event.id,
    );
  } finally {
    f.close();
  }
});

test("a lapsed claim no longer wedges the runtime that was holding it", () => {
  const nowMs = { value: Date.parse("2026-09-20T00:00:00.000Z") };
  const { f, sessionId, first, request, keepAlive } = claimLeaseFixture(nowMs);
  try {
    const abandoned = request("agent-request-lease-0002");
    assert.equal(f.service.claimAgentRequest(f.member, sessionId, abandoned.id, first.id).status, "claimed");
    nowMs.value += PAST_LEASE_MS;
    keepAlive();
    // One runtime may hold one active claim. A claim nobody is working on is not
    // active, so the device that came back must be free for the next request.
    const next = request("agent-request-lease-0003");
    assert.equal(
      f.service.claimAgentRequest(f.member, sessionId, next.id, first.id).status,
      "claimed",
      "an abandoned claim must not consume the runtime's single active slot",
    );
  } finally {
    f.close();
  }
});

test("a claim that keeps reporting progress is never taken over", () => {
  const nowMs = { value: Date.parse("2026-09-20T00:00:00.000Z") };
  const { f, sessionId, secondActor, first, second, request, keepAlive } = claimLeaseFixture(nowMs);
  try {
    const event = request("agent-request-lease-0004");
    assert.equal(f.service.claimAgentRequest(f.member, sessionId, event.id, first.id).status, "claimed");
    for (let step = 1; step <= 3; step += 1) {
      nowMs.value += PAST_LEASE_MS / 3;
      f.service.appendAgentProgress(f.member, sessionId, event.id, first.id, `progress-lease-000${String(step)}`, {
        content: `step ${String(step)}`,
      });
    }
    // Three half-lease steps is far past one lease, but every step proved the
    // claimant is still working, so the claim is alive rather than abandoned.
    keepAlive();
    assert.throws(
      () => f.service.claimAgentRequest(secondActor, sessionId, event.id, second.id),
      (error: unknown) => error instanceof ApiError && error.code === "conflict",
    );
  } finally {
    f.close();
  }
});

test("a request fails visibly instead of ping-ponging between runtimes forever", () => {
  const nowMs = { value: Date.parse("2026-09-20T00:00:00.000Z") };
  const { f, sessionId, first, request, keepAlive } = claimLeaseFixture(nowMs);
  try {
    const event = request("agent-request-lease-0005");
    assert.equal(f.service.claimAgentRequest(f.member, sessionId, event.id, first.id).status, "claimed");
    // Every runtime that picks the request up dies the same way. Automatic
    // re-dispatch has to run out somewhere, and has to say so when it does.
    const published: string[] = [];
    const unsubscribe = f.service.onEvent((candidate) => published.push(candidate.id));
    const holders = [[f.member, first.id]] as const;
    let bounded = false;
    for (let round = 0; round < 10; round += 1) {
      const [actor, runtimeId] = holders[round % holders.length]!;
      nowMs.value += PAST_LEASE_MS;
      keepAlive();
      try {
        f.service.claimAgentRequest(actor, sessionId, event.id, runtimeId);
      } catch (error) {
        assert.ok(error instanceof ApiError && error.code === "agent_request_failed", `unexpected ${String(error)}`);
        bounded = true;
        break;
      }
    }
    assert.ok(bounded, "automatic re-dispatch must run out rather than rotate between runtimes forever");
    assert.throws(
      () => f.service.claimAgentRequest(f.member, sessionId, event.id, first.id),
      (error: unknown) => error instanceof ApiError && error.code === "agent_request_failed",
      "an exhausted request must stay failed rather than be re-dispatched again",
    );
    const failure = f.service.replay(f.member, sessionId, 0, 100).events
      .find((candidate) => candidate.type === "agent_response" && candidate.reply_to_event_id === event.id);
    assert.ok(failure, "the timeline must carry a canonical failure response");
    assert.equal((failure.payload as { status?: string }).status, "failed");
    assert.ok(published.includes(failure.id), "terminal failure must be published to live subscribers");
    unsubscribe();
  } finally {
    f.close();
  }
});

test("a database written before claim leases migrates its claims into recoverable ones", () => {
  const nowMs = { value: Date.parse("2026-09-20T00:00:00.000Z") };
  const lease = claimLeaseFixture(nowMs);
  const path = join(lease.f.directory, "test.sqlite");
  const event = lease.request("agent-request-migration-0001");
  assert.equal(lease.f.service.claimAgentRequest(lease.f.member, lease.sessionId, event.id, lease.first.id).status, "claimed");
  lease.f.database.close();

  // Put the claim table back into exactly the shape the previous release wrote,
  // so reopening exercises the migration rather than the fresh schema.
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE agent_request_claims;
    CREATE TABLE agent_request_claims (
      request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL REFERENCES runtimes(id),
      claimed_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'completed'))
    ) STRICT;
  `);
  legacy.prepare(`
    INSERT INTO agent_request_claims(request_event_id, runtime_id, claimed_at, completed_at, status)
    VALUES (?, ?, ?, NULL, 'claimed')
  `).run(event.id, lease.first.id, "2026-09-20T00:00:00.000Z");
  legacy.close();

  const reopened = new CollaborationDatabase(path, { authTokenPepper: "unit-test-auth-token-pepper" });
  try {
    const service = new CollaborationService(reopened);
    nowMs.value += PAST_LEASE_MS;
    service.heartbeatRuntime(lease.f.member, lease.first.id);
    service.heartbeatRuntime(lease.secondActor, lease.second.id);
    // The migrated row carries no lease, so nothing is renewing it. It must read
    // as recoverable rather than keep holding the request — and the runtime —
    // for ever, which is exactly what the previous release did.
    const takeover = service.claimAgentRequest(lease.f.member, lease.sessionId, event.id, lease.first.id);
    assert.equal(takeover.status, "claimed");
    assert.equal(takeover.runtime_id, lease.first.id);
  } finally {
    reopened.close();
    rmSync(lease.f.directory, { recursive: true, force: true });
  }
});

test("DeepSeek Harness claims honor the exact Web-selected runtime and model without changing Codex claims", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "dsh-runtime-routing",
      idempotency_key: "create-dsh-runtime-routing",
      mode: "multi",
      title: "DSH routing",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "dsh-routing-member");
    const secondDevice = f.database.createDevice(f.member.user_id, "Second DSH", "dsh-routing-device-2");
    const secondActor = { ...f.member, device_id: secondDevice.device_id };
    const firstRuntime = f.service.registerRuntime(f.member, {
      runtime_id: "dsh-routing-runtime-1",
      session_id: session.id,
      device_id: f.member.device_id,
      harness: "deepseek-harness",
      provider: "provider-one",
      model: "CaseSensitive/Model-X",
      local_session_id: "dsh-routing-local-1",
      capture_fidelity: "harness_transcript",
    });
    const secondRuntime = f.service.registerRuntime(secondActor, {
      runtime_id: "dsh-routing-runtime-2",
      session_id: session.id,
      device_id: secondDevice.device_id,
      harness: "deepseek-harness",
      provider: "provider-two",
      model: "CaseSensitive/Model-X",
      local_session_id: "dsh-routing-local-2",
      capture_fidelity: "harness_transcript",
    });
    const request = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "dsh-routing-request-1",
      type: "agent_request",
      visibility: "session",
      payload: {
        content: "Use the selected DSH device",
        execution_profile: {
          harness: "deepseek-harness",
          provider: "provider-two",
          model: "CaseSensitive/Model-X",
          runtime_id: secondRuntime.id,
        },
      },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, request.id, firstRuntime.id),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    assert.equal(
      f.service.claimAgentRequest(secondActor, session.id, request.id, secondRuntime.id).runtime_id,
      secondRuntime.id,
    );

    const wrongProvider = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "dsh-routing-request-wrong-provider",
      type: "agent_request",
      visibility: "session",
      payload: {
        content: "Do not cross provider bindings",
        execution_profile: {
          harness: "deepseek-harness",
          provider: "provider-two",
          model: "CaseSensitive/Model-X",
          runtime_id: firstRuntime.id,
        },
      },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, wrongProvider.id, firstRuntime.id),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );

    const ambiguous = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "dsh-routing-request-2",
      type: "agent_request",
      visibility: "session",
      payload: {
        content: "An old untargeted DSH request",
        execution_profile: { harness: "deepseek-harness", model: "CaseSensitive/Model-X" },
      },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, ambiguous.id, firstRuntime.id),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
  } finally {
    f.close();
  }
});

test("Agent request claims stay on the selected harness and exact runtime with legacy Codex compatibility", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "cross-harness-routing",
      idempotency_key: "create-cross-harness-routing",
      mode: "multi",
      title: "Cross-harness routing",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "cross-harness-member");
    const codex = f.service.registerRuntime(f.member, {
      runtime_id: "cross-harness-codex",
      session_id: session.id,
      device_id: f.member.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-5.6-sol",
      local_session_id: "cross-harness-codex-local",
      capture_fidelity: "harness_transcript",
    });
    const dsh = f.service.registerRuntime(f.member, {
      runtime_id: "cross-harness-dsh",
      session_id: session.id,
      device_id: f.member.device_id,
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      local_session_id: "cross-harness-dsh-local",
      capture_fidelity: "harness_transcript",
    });

    const codexRequest = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "cross-harness-codex-request",
      type: "agent_request",
      visibility: "session",
      payload: {
        content: "Run in Codex",
        execution_profile: {
          harness: "codex",
          model: "gpt-5.6-luna",
          runtime_id: codex.id,
        },
      },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, codexRequest.id, dsh.id),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    assert.equal(
      f.service.claimAgentRequest(f.member, session.id, codexRequest.id, codex.id).runtime_id,
      codex.id,
    );
    f.service.completeAgentRequest(
      f.member,
      session.id,
      codexRequest.id,
      codex.id,
      "cross-harness-codex-response",
      { content: "Codex done" },
    );

    const dshRequest = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "cross-harness-dsh-request",
      type: "agent_request",
      visibility: "session",
      payload: {
        content: "Run in DSH",
        execution_profile: {
          harness: "deepseek-harness",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          runtime_id: dsh.id,
        },
      },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, dshRequest.id, codex.id),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    assert.equal(
      f.service.claimAgentRequest(f.member, session.id, dshRequest.id, dsh.id).runtime_id,
      dsh.id,
    );
    f.service.completeAgentRequest(
      f.member,
      session.id,
      dshRequest.id,
      dsh.id,
      "cross-harness-dsh-response",
      { content: "DSH done" },
    );

    const legacyRequest = f.service.appendEvent(f.member, session.id, {
      idempotency_key: "cross-harness-legacy-request",
      type: "agent_request",
      visibility: "session",
      payload: { content: "Old clients mean Codex" },
    });
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, legacyRequest.id, dsh.id),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
    assert.equal(
      f.service.claimAgentRequest(f.member, session.id, legacyRequest.id, codex.id).runtime_id,
      codex.id,
    );
  } finally {
    f.close();
  }
});

test("switching Codex to DSH and back preserves one canonical session with ordered idempotent provenance", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "harness-switch-history",
      idempotency_key: "create-harness-switch-history",
      mode: "multi",
      title: "Harness switch history",
    });
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "harness-switch-member");
    const codex = f.service.registerRuntime(f.member, {
      runtime_id: "harness-switch-codex",
      session_id: session.id,
      device_id: f.member.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-5.6-sol",
      local_session_id: "harness-switch-codex-local",
      capture_fidelity: "harness_transcript",
    });
    const dsh = f.service.registerRuntime(f.member, {
      runtime_id: "harness-switch-dsh",
      session_id: session.id,
      device_id: f.member.device_id,
      harness: "deepseek-harness",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      local_session_id: "harness-switch-dsh-local",
      capture_fidelity: "harness_transcript",
    });
    const commits = [
      f.service.commitLocalTurn(f.member, session.id, {
        local_turn_id: "codex-turn-one",
        runtime_id: codex.id,
        based_on_sequence: f.database.requireSession(session.id).next_sequence,
        occurred_at: "2026-09-06T01:00:00.000Z",
        request_payload: { content: "Codex one" },
        response_payload: { content: "Codex answer one" },
      }),
      f.service.commitLocalTurn(f.member, session.id, {
        local_turn_id: "dsh-turn-one",
        runtime_id: dsh.id,
        based_on_sequence: f.database.requireSession(session.id).next_sequence,
        occurred_at: "2026-09-06T01:01:00.000Z",
        request_payload: { content: "DSH one" },
        response_payload: { content: "DSH answer one" },
      }),
      f.service.commitLocalTurn(f.member, session.id, {
        local_turn_id: "codex-turn-two",
        runtime_id: codex.id,
        based_on_sequence: f.database.requireSession(session.id).next_sequence,
        occurred_at: "2026-09-06T01:02:00.000Z",
        request_payload: { content: "Codex two" },
        response_payload: { content: "Codex answer two" },
      }),
    ];
    assert.deepEqual(
      f.service.commitLocalTurn(f.member, session.id, {
        local_turn_id: "dsh-turn-one",
        runtime_id: dsh.id,
        based_on_sequence: commits[1]!.head_before_commit,
        occurred_at: "2026-09-06T01:01:00.000Z",
        request_payload: { content: "DSH one" },
        response_payload: { content: "DSH answer one" },
      }),
      commits[1],
    );
    const events = f.service.replay(f.member, session.id, 0, 100).events;
    const turnEvents = events.filter((event) => event.runtime_provenance !== null);
    assert.deepEqual(turnEvents.map((event) => event.sequence), [3, 4, 5, 6, 7, 8]);
    assert.deepEqual(turnEvents.map((event) => event.runtime_provenance?.harness), [
      "codex", "codex", "deepseek-harness", "deepseek-harness", "codex", "codex",
    ]);
    assert.ok(turnEvents.every((event) => event.session_id === session.id));
    assert.equal(f.service.listSessions(f.member).filter((candidate) => candidate.id === session.id).length, 1);
  } finally {
    f.close();
  }
});

test("agent progress is ordered, idempotent, claim-bound, and cannot follow completion", () => {
  const f = fixture();
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "agent-progress",
      idempotency_key: "create-agent-progress",
      mode: "multi",
      title: "Agent progress",
    });
    const request = f.service.appendEvent(f.owner, session.id, {
      idempotency_key: "agent-progress-request",
      type: "agent_request",
      visibility: "session",
      payload: { content: "work" },
    });
    const runtime = f.service.registerRuntime(f.owner, {
      runtime_id: "agent-progress-runtime",
      session_id: session.id,
      device_id: f.owner.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-test",
      local_session_id: "agent-progress-local",
      capture_fidelity: "harness_transcript",
    });
    f.service.claimAgentRequest(f.owner, session.id, request.id, runtime.id);
    const progress = f.service.appendAgentProgress(
      f.owner, session.id, request.id, runtime.id, "agent-progress-event", { content: "Checking files" },
    );
    const retry = f.service.appendAgentProgress(
      f.owner, session.id, request.id, runtime.id, "agent-progress-event", { content: "Checking files" },
    );
    assert.equal(progress.id, retry.id);
    assert.equal(progress.type, "agent_progress");
    assert.equal(progress.reply_to_event_id, request.id);
    const response = f.service.completeAgentRequest(
      f.owner, session.id, request.id, runtime.id, "agent-progress-response", { content: "Done" },
    );
    assert.equal(response.sequence, progress.sequence + 1);
    assert.throws(
      () => f.service.appendAgentProgress(
        f.owner, session.id, request.id, runtime.id, "agent-progress-late", { content: "Too late" },
      ),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
  } finally {
    f.close();
  }
});

test("runtime presence becomes offline without heartbeats and returns online after one", () => {
  let instant = new Date("2026-08-25T00:00:00.000Z");
  const f = fixture({ clock: () => instant });
  try {
    const { session } = f.service.createSession(f.owner, {
      session_id: "runtime-presence",
      idempotency_key: "create-runtime-presence",
      mode: "multi",
      title: "Runtime presence",
    });
    const runtime = f.service.registerRuntime(f.owner, {
      session_id: session.id,
      device_id: f.owner.device_id,
      harness: "codex",
      provider: "openai",
      model: "gpt-test",
      local_session_id: "presence-local",
      capture_fidelity: "harness_transcript",
    });
    assert.equal(f.service.listMembers(f.owner, session.id)[0]?.runtime?.status, "online");

    instant = new Date("2026-08-25T00:00:31.000Z");
    assert.equal(f.service.listMembers(f.owner, session.id)[0]?.runtime?.status, "offline");
    f.service.heartbeatRuntime(f.owner, runtime.id);
    assert.equal(f.service.listMembers(f.owner, session.id)[0]?.runtime?.status, "online");
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

test("local-turn commits and private snapshot connector jobs preserve sync invariants", () => {
  const f = fixture();
  try {
    const session = f.service.createSession(f.owner, {
      session_id: "sync-contract-room", idempotency_key: "sync-contract-room-create",
      mode: "multi", title: "Sync contract",
    }).session;
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "sync-contract-member");
    const execution = f.service.registerRuntime(f.member, {
      runtime_id: "sync-execution", session_id: session.id, device_id: f.member.device_id,
      purpose: "execution", harness: "codex", provider: "openai", model: "gpt-5",
      local_session_id: "sync-execution-local", capture_fidelity: "harness_transcript",
    });
    const connector = f.service.registerRuntime(f.member, {
      runtime_id: "sync-snapshot", session_id: session.id, device_id: f.member.device_id,
      purpose: "snapshot_connector", harness: "connector", provider: "local", model: "snapshot",
      local_session_id: "sync-snapshot-local", capture_fidelity: "canonical_history",
    });
    assert.equal(
      f.service.listMembers(f.member, session.id).find((member) => member.user_id === f.member.user_id)?.runtime?.id,
      execution.id,
    );
    const head = f.database.requireSession(session.id).next_sequence;
    const input = {
      local_turn_id: "local-turn-1", runtime_id: execution.id, based_on_sequence: head - 1,
      occurred_at: "2026-08-25T12:00:00.000Z",
      observed_model: "gpt-5.6-terra", observed_reasoning_effort: "high",
      request_payload: { prompt: "work", token: "secret" }, response_payload: { answer: "done" },
      tool_events: [{ type: "tool_result" as const, payload: { authorization: "hidden" } }],
    };
    const committed = f.service.commitLocalTurn(f.member, session.id, input);
    assert.equal(committed.reconciliation_required, true);
    assert.equal(committed.request_event.actor_display_name, "Member");
    assert.equal(committed.response_event.actor_display_name, "Member");
    assert.deepEqual(f.service.commitLocalTurn(f.member, session.id, input), committed);
    assert.deepEqual(committed.request_event.payload, {
      prompt: "work",
      token: "[REDACTED]",
      _gatherthread_client: { occurred_at: input.occurred_at },
    });
    assert.notEqual(committed.request_event.created_at, input.occurred_at);
    assert.equal(committed.request_event.runtime_provenance?.local_session_id, "private");
    assert.equal(committed.request_event.runtime_provenance?.model, "gpt-5.6-terra");
    assert.equal(committed.response_event.runtime_provenance?.reasoning_effort, "high");
    assert.equal((f.database.sqlite.prepare(`
      SELECT json_extract(runtime_provenance_json, '$.local_session_id') AS local_session_id
      FROM events WHERE id = ?
    `).get(committed.request_event.id) as { local_session_id: string }).local_session_id, "private");
    assert.equal((f.database.sqlite.prepare("SELECT count(*) AS count FROM agent_request_claims").get() as { count: number }).count, 0);
    assert.throws(
      () => f.service.claimAgentRequest(f.member, session.id, committed.request_event.id, execution.id),
      (error: unknown) => error instanceof ApiError
        && error.status === 409
        && error.code === "agent_request_already_completed",
    );
    f.database.sqlite.prepare("UPDATE users SET display_name = 'Renamed member' WHERE id = ?").run(f.member.user_id);
    assert.equal(
      f.service.replay(f.member, session.id, committed.request_event.sequence - 1, 10).events[0]?.actor_display_name,
      "Member",
    );
    const snapshot = f.service.createSnapshotRequest(f.member, session.id);
    const canonicalHead = f.database.requireSession(session.id).next_sequence;
    assert.equal(snapshot.through_sequence, canonicalHead);
    assert.equal(snapshot.kind, "immutable");
    const visibleImport = f.service.createSnapshotRequest(f.member, session.id, "visible_history_replace");
    assert.equal(visibleImport.kind, "visible_history_replace");
    const localStatus = f.service.createSnapshotRequest(f.member, session.id, "local_sync_status", execution.id);
    assert.equal(localStatus.target_runtime_id, execution.id);
    assert.throws(
      () => f.service.claimSnapshotRequest(f.member, localStatus.id, connector.id),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    assert.equal(f.service.claimSnapshotRequest(f.member, localStatus.id, execution.id).status, "claimed");
    assert.deepEqual(f.service.completeSnapshotRequest(f.member, localStatus.id, execution.id, {
      automatic_upload: true, pending_local_turns: 0, uploadable_local_turns: 2,
    }).result, { automatic_upload: true, pending_local_turns: 0, uploadable_local_turns: 2 });
    assert.equal(f.service.claimSnapshotRequest(f.member, snapshot.id, connector.id).status, "claimed");
    assert.deepEqual(f.service.completeSnapshotRequest(f.member, snapshot.id, connector.id, {
      summary: "ready", api_key: "secret",
    }).result, { summary: "ready", api_key: "[REDACTED]" });
    assert.equal(f.database.requireSession(session.id).next_sequence, canonicalHead);
    f.service.setProjectMembership(f.owner, session.project_id, f.member.user_id, "viewer");
    assert.equal(f.service.createSnapshotRequest(f.member, session.id).kind, "immutable");
    assert.throws(
      () => f.service.createSnapshotRequest(f.member, session.id, "visible_history_replace"),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    assert.equal(f.service.heartbeatRuntime(f.member, connector.id).purpose, "snapshot_connector");
    const viewerPresence = f.service.listMembers(f.member, session.id)
      .find((member) => member.user_id === f.member.user_id)?.runtime;
    assert.equal(viewerPresence?.id, connector.id);
    assert.equal(viewerPresence?.purpose, "snapshot_connector");
    assert.equal(viewerPresence?.status, "online");
    assert.throws(
      () => f.service.commitLocalTurn(f.member, session.id, { ...input, local_turn_id: "viewer-turn" }),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
  } finally {
    f.close();
  }
});

test("event actor display names are required for new databases and backfilled for legacy logs", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatherthread-event-attribution-"));
  const path = join(directory, "events.sqlite");
  let database = new CollaborationDatabase(path, { authTokenPepper: "event-attribution-pepper" });
  try {
    const owner = database.bootstrapIdentity({
      user_id: "owner", display_name: "Frozen Owner", device_id: "owner-device", device_name: "Laptop",
    }).actor;
    const service = new CollaborationService(database);
    const session = service.createSession(owner, {
      session_id: "attribution-room", idempotency_key: "attribution-room-create",
      mode: "multi", title: "Attribution",
    }).session;
    const column = (database.sqlite.prepare("PRAGMA table_info(events)").all() as Array<{ name: string; notnull: number }>)
      .find((item) => item.name === "actor_display_name");
    assert.equal(column?.notnull, 1);
    database.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TRIGGER IF EXISTS events_actor_display_name_required_insert;
      DROP TRIGGER IF EXISTS events_actor_display_name_required_update;
      ALTER TABLE events DROP COLUMN actor_display_name;
    `);
    legacy.close();

    database = new CollaborationDatabase(path, { authTokenPepper: "event-attribution-pepper" });
    const replayed = database.replay(session.id, 0, 10, true).events[0];
    assert.equal(replayed?.actor_display_name, "Frozen Owner");
    assert.throws(
      () => database.sqlite.prepare(`
        INSERT INTO events(
          id, session_id, sequence, idempotency_key, type, actor_user_id, actor_display_name,
          created_at, visibility, reply_to_event_id, payload_json, runtime_provenance_json
        ) VALUES ('bad-event', ?, 999, 'bad-event-key', 'human_chat', 'owner', NULL,
          '2026-08-25T00:00:00.000Z', 'session', NULL, '{}', NULL)
      `).run(session.id),
    );
  } finally {
    try { database.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("snapshot result and aggregate quotas roll back atomically with a consistent ledger", () => {
  const f = fixture({
    maxSnapshotResultBytes: 2_048,
    maxUserSnapshotBytes: 4_500,
    maxSessionSnapshotBytes: 5_000,
    maxTotalSnapshotBytes: 5_000,
  });
  try {
    const session = f.service.createSession(f.owner, {
      session_id: "snapshot-quota-room", idempotency_key: "snapshot-quota-room-create",
      mode: "multi", title: "Snapshot quota",
    }).session;
    const connector = f.service.registerRuntime(f.owner, {
      runtime_id: "snapshot-quota-connector", session_id: session.id, device_id: f.owner.device_id,
      purpose: "snapshot_connector", harness: "connector", provider: "local", model: "snapshot",
      local_session_id: "snapshot-quota-local", capture_fidelity: "canonical_history",
    });
    const complete = (id: string, content: string) => {
      const request = f.service.createSnapshotRequest(f.owner, session.id);
      f.service.claimSnapshotRequest(f.owner, request.id, connector.id);
      return { request, result: () => f.service.completeSnapshotRequest(f.owner, request.id, connector.id, { content }) };
    };
    const first = complete("first", "a".repeat(1_400));
    const firstResult = first.result();
    const usageAfterFirst = (f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage")
      .get() as { bytes: number }).bytes;
    assert.equal(usageAfterFirst, (f.database.sqlite.prepare("SELECT storage_bytes FROM snapshot_requests WHERE id = ?")
      .get(first.request.id) as { storage_bytes: number }).storage_bytes);
    assert.throws(
      () => f.service.completeSnapshotRequest(f.owner, first.request.id, connector.id, { content: "changed" }),
      (error: unknown) => error instanceof ApiError && error.code === "idempotency_conflict",
    );
    assert.deepEqual(f.service.completeSnapshotRequest(f.owner, first.request.id, connector.id, { content: "a".repeat(1_400) }), firstResult);
    assert.equal((f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage")
      .get() as { bytes: number }).bytes, usageAfterFirst);

    const second = complete("second", "b".repeat(1_400));
    assert.throws(second.result, (error: unknown) => error instanceof ApiError && error.code === "storage_quota_exceeded");
    const rejected = f.database.sqlite.prepare("SELECT status, result_json, storage_bytes FROM snapshot_requests WHERE id = ?")
      .get(second.request.id) as { status: string; result_json: string | null; storage_bytes: number };
    assert.equal(rejected.status, "claimed");
    assert.equal(rejected.result_json, null);
    assert.equal(rejected.storage_bytes, 1_024);
    assert.equal((f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage")
      .get() as { bytes: number }).bytes, usageAfterFirst + 1_024);

    const oversized = complete("oversized", "x".repeat(100_000));
    assert.throws(oversized.result, (error: unknown) => error instanceof ApiError && error.code === "storage_quota_exceeded");
    assert.equal(
      (f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage").get() as { bytes: number }).bytes,
      (f.database.sqlite.prepare("SELECT SUM(storage_bytes) AS bytes FROM snapshot_requests").get() as { bytes: number }).bytes,
    );
  } finally {
    f.close();
  }
});

test("snapshot lists are newest-first, session-filtered, and response-byte bounded", () => {
  const f = fixture();
  try {
    const firstSession = f.service.createSession(f.owner, {
      session_id: "snapshot-list-a", idempotency_key: "snapshot-list-a-create", mode: "multi", title: "A",
    }).session;
    const secondSession = f.service.createSession(f.owner, {
      project_id: firstSession.project_id,
      session_id: "snapshot-list-b", idempotency_key: "snapshot-list-b-create", mode: "multi", title: "B",
    }).session;
    for (let index = 0; index < 45; index += 1) f.service.createSnapshotRequest(f.owner, firstSession.id);
    const target = f.service.createSnapshotRequest(f.owner, secondSession.id);
    const filtered = f.service.listSnapshotRequests(f.owner, "pending", secondSession.id, 40);
    assert.deepEqual(filtered.map((request) => request.id), [target.id]);
    const newest = f.service.listSnapshotRequests(f.owner, "pending", undefined, 40);
    assert.equal(newest[0]?.id, target.id);

    const connector = f.service.registerRuntime(f.owner, {
      runtime_id: "snapshot-list-connector", session_id: firstSession.id, device_id: f.owner.device_id,
      purpose: "snapshot_connector", harness: "connector", provider: "local", model: "snapshot",
      local_session_id: "snapshot-list-local", capture_fidelity: "canonical_history",
    });
    for (let index = 0; index < 20; index += 1) {
      const request = f.service.createSnapshotRequest(f.owner, firstSession.id);
      f.service.claimSnapshotRequest(f.owner, request.id, connector.id);
      f.service.completeSnapshotRequest(f.owner, request.id, connector.id, { content: "x".repeat(7_000), index });
    }
    const completed = f.service.listSnapshotRequests(f.owner, "completed", firstSession.id, 100);
    assert.ok(completed.length < 20);
    assert.ok(Buffer.byteLength(JSON.stringify(completed)) <= 128 * 1024);
  } finally {
    f.close();
  }
});

test("snapshot metadata and unresolved jobs are hard bounded without deleting terminal audit", () => {
  const f = fixture({
    maxUserActiveSnapshotRequests: 2,
    maxSessionActiveSnapshotRequests: 3,
    maxTotalActiveSnapshotRequests: 4,
  });
  try {
    const first = f.service.createSession(f.owner, {
      session_id: "snapshot-active-a", idempotency_key: "snapshot-active-a-create", mode: "multi", title: "A",
    }).session;
    const second = f.service.createSession(f.owner, {
      project_id: first.project_id,
      session_id: "snapshot-active-b", idempotency_key: "snapshot-active-b-create", mode: "multi", title: "B",
    }).session;
    f.service.setMembership(f.owner, first.id, f.member.user_id, "participant", "snapshot-active-member");
    const outsider = f.database.createIdentity({
      user_id: "outsider", display_name: "Outsider", device_id: "outsider-device", device_name: "Laptop",
    }).actor;
    f.service.setMembership(f.owner, first.id, outsider.user_id, "participant", "snapshot-active-outsider");

    const ownerOne = f.service.createSnapshotRequest(f.owner, first.id);
    f.service.createSnapshotRequest(f.owner, first.id);
    assert.throws(
      () => f.service.createSnapshotRequest(f.owner, second.id),
      (error: unknown) => error instanceof ApiError && error.status === 409 && /User/.test(error.message),
    );
    f.service.createSnapshotRequest(f.member, first.id);
    assert.throws(
      () => f.service.createSnapshotRequest(f.member, first.id),
      (error: unknown) => error instanceof ApiError && error.status === 409 && /Session/.test(error.message),
    );
    f.service.createSnapshotRequest(f.member, second.id);
    assert.throws(
      () => f.service.createSnapshotRequest(outsider, second.id),
      (error: unknown) => error instanceof ApiError && error.status === 409 && /Deployment/.test(error.message),
    );

    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM snapshot_requests")
      .get() as { count: number }).count, 4);
    assert.equal((f.database.sqlite.prepare("SELECT SUM(bytes) AS bytes FROM snapshot_storage_usage")
      .get() as { bytes: number }).bytes, 4 * 1_024);

    const connector = f.service.registerRuntime(f.owner, {
      runtime_id: "snapshot-active-connector", session_id: first.id, device_id: f.owner.device_id,
      purpose: "snapshot_connector", harness: "connector", provider: "local", model: "snapshot",
      local_session_id: "snapshot-active-local", capture_fidelity: "canonical_history",
    });
    f.service.claimSnapshotRequest(f.owner, ownerOne.id, connector.id);
    f.service.completeSnapshotRequest(f.owner, ownerOne.id, connector.id, { summary: "kept for audit" });
    assert.equal(f.service.getSnapshotRequest(f.owner, ownerOne.id).status, "completed");
    assert.doesNotThrow(() => f.service.createSnapshotRequest(outsider, second.id));
    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM snapshot_requests WHERE status IN ('pending','claimed')")
      .get() as { count: number }).count, 4);
    assert.equal((f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM snapshot_requests WHERE id = ?")
      .get(ownerOne.id) as { count: number }).count, 1);
  } finally {
    f.close();
  }
});

test("client occurrence times cannot control canonical clocks and response provenance is minimized", () => {
  let now = new Date("2026-08-25T12:00:00.000Z");
  const f = fixture({ clock: () => now });
  try {
    const session = f.service.createSession(f.owner, {
      session_id: "canonical-clock", idempotency_key: "canonical-clock-create", mode: "multi", title: "Clock",
    }).session;
    f.service.setMembership(f.owner, session.id, f.member.user_id, "participant", "canonical-clock-member");
    const ownerRuntime = f.service.registerRuntime(f.owner, {
      runtime_id: "owner-private-runtime", session_id: session.id, device_id: f.owner.device_id,
      purpose: "execution", harness: "codex", provider: "openai", model: "gpt-test",
      local_session_id: "/private/owner/thread", capture_fidelity: "harness_transcript",
    });
    const memberRuntime = f.service.registerRuntime(f.member, {
      runtime_id: "member-private-runtime", session_id: session.id, device_id: f.member.device_id,
      purpose: "execution", harness: "codex", provider: "openai", model: "gpt-test",
      local_session_id: "/private/member/thread", capture_fidelity: "harness_transcript",
    });

    const memberView = f.service.listMembers(f.member, session.id);
    assert.equal(memberView.find((member) => member.user_id === f.owner.user_id)?.runtime?.id, "private");
    assert.equal(memberView.find((member) => member.user_id === f.owner.user_id)?.runtime?.device_id, "private");
    assert.equal(memberView.find((member) => member.user_id === f.member.user_id)?.runtime?.id, memberRuntime.id);
    assert.equal(f.service.listMembers(f.owner, session.id)
      .find((member) => member.user_id === f.member.user_id)?.runtime?.id, memberRuntime.id);

    now = new Date("2026-08-25T11:00:00.000Z");
    const committed = f.service.commitLocalTurn(f.owner, session.id, {
      local_turn_id: "future-client-time", runtime_id: ownerRuntime.id, based_on_sequence: 1,
      occurred_at: "9999-12-31T23:59:59.999Z",
      request_payload: { text: "question" }, response_payload: { text: "answer" },
    });
    assert.equal(committed.request_event.created_at, now.toISOString());
    assert.deepEqual(committed.request_event.payload, {
      text: "question", _gatherthread_client: { occurred_at: "9999-12-31T23:59:59.999Z" },
    });
    assert.equal(committed.request_event.runtime_provenance?.local_session_id, "private");
    assert.equal(f.database.requireProject(session.project_id).updated_at, "2026-08-25T12:00:00.000Z");

    const ownerReplay = f.service.replay(f.owner, session.id, committed.request_event.sequence - 1, 10).events[0];
    assert.equal(ownerReplay?.runtime_provenance?.runtime_id, ownerRuntime.id);
    assert.equal(ownerReplay?.runtime_provenance?.device_id, f.owner.device_id);
    assert.equal(ownerReplay?.runtime_provenance?.local_session_id, "private");
    const memberReplay = f.service.replay(f.member, session.id, committed.request_event.sequence - 1, 10).events[0];
    assert.equal(memberReplay?.runtime_provenance?.runtime_id, "private");
    assert.equal(memberReplay?.runtime_provenance?.device_id, "private");
    assert.equal(memberReplay?.runtime_provenance?.local_session_id, "private");
  } finally {
    f.close();
  }
});
