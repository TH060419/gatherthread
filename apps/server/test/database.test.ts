import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CollaborationDatabase } from "../src/database.js";
import { ApiError } from "../src/errors.js";
import { CollaborationService } from "../src/service.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acp-db-"));
  const database = new CollaborationDatabase(join(directory, "test.sqlite"));
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
    member: memberIdentity.actor,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
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
      payload: { text: "different retry body" },
    });

    assert.deepEqual(repeated, first);
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
