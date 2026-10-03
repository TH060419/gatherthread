import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { redactJson } from "../src/redaction.js";

test("redaction covers environment credentials, camelCase prompts, and issued device secrets", () => {
  const fakeGithubToken = ["ghp", "012345678901234567890123"].join("_");
  const fakeAwsAccessKey = ["AKIA", "0123456789012345"].join("");
  const fakePrivateKey = [
    "-----BEGIN",
    "PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
  ].join(" ");

  assert.deepEqual(redactJson({
    systemPrompt: "private system instructions",
    developer_prompt: "private developer instructions",
    GATHERTHREAD_TOKEN: "gta_01234567890123456789012345678901",
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "private-pepper",
    privateKey: "private-key-value",
    local_session_id: "/private/local/thread.jsonl",
    bearer: "opaque-bearer-secret",
    nested: {
      authToken: "private-token",
      tokenCount: 42,
      content: `access_token=lower-secret ${fakeGithubToken} GATHERTHREAD_AUTH_TOKEN_PEPPER=super-secret-value GATHERTHREAD_TOKEN=another-secret-value`,
      device: "gtd_01234567890123456789012345678901",
      browser: "gtb_01234567890123456789012345678901",
      legacyCredential: "acp_01234567890123456789012345678901",
      aws: fakeAwsAccessKey,
      pem: fakePrivateKey,
    },
  }), {
    systemPrompt: "[REDACTED]",
    developer_prompt: "[REDACTED]",
    GATHERTHREAD_TOKEN: "[REDACTED]",
    GATHERTHREAD_AUTH_TOKEN_PEPPER: "[REDACTED]",
    privateKey: "[REDACTED]",
    local_session_id: "[REDACTED]",
    bearer: "[REDACTED]",
    nested: {
      authToken: "[REDACTED]",
      tokenCount: 42,
      content: "access_token=[REDACTED] [REDACTED] GATHERTHREAD_AUTH_TOKEN_PEPPER=[REDACTED] GATHERTHREAD_TOKEN=[REDACTED]",
      device: "[REDACTED]",
      browser: "[REDACTED]",
      legacyCredential: "[REDACTED]",
      aws: "[REDACTED]",
      pem: "[REDACTED]",
    },
  });
});

const gatePepperFixture = "NON_SECRET_GATE_PEPPER_FIXTURE";
const gatePepperPayload = {
  content: `GATHERTHREAD_TEST_GATE_PEPPER=${gatePepperFixture}`,
  nested: [{ GATHERTHREAD_TEST_GATE_PEPPER: gatePepperFixture, test_gate_pepper: gatePepperFixture,
    testGatePepper: gatePepperFixture, authTokenPepper: "NON_SECRET_AUTH_PEPPER_FIXTURE", tokenCount: 42,
    testGatePepperRotationDate: "2026-10-04", note: "Ordinary shared text" }],
};
const sanitizedGatePepperPayload = {
  content: "GATHERTHREAD_TEST_GATE_PEPPER=[REDACTED]",
  nested: [{ GATHERTHREAD_TEST_GATE_PEPPER: "[REDACTED]", test_gate_pepper: "[REDACTED]",
    testGatePepper: "[REDACTED]", authTokenPepper: "[REDACTED]", tokenCount: 42,
    testGatePepperRotationDate: "2026-10-04", note: "Ordinary shared text" }],
};

test("test gate pepper is redacted in nested keys and environment assignments without hiding ordinary fields", () => {
  assert.deepEqual(redactJson(gatePepperPayload), sanitizedGatePepperPayload);
  assert.equal(redactJson(`export GATHERTHREAD_TEST_GATE_PEPPER: ${gatePepperFixture}; tokenCount=42`),
    "export GATHERTHREAD_TEST_GATE_PEPPER: [REDACTED]; tokenCount=42");
});

test("shared human and tool events persist and replay redacted test gate pepper", t => {
  const database = new CollaborationDatabase(":memory:", { authTokenPepper: randomBytes(32).toString("hex") });
  t.after(() => database.close());
  const service = new CollaborationService(database);
  const { actor } = database.bootstrapIdentity({ display_name: "Redaction fixture", device_name: "Fixture device" });
  const { session } = service.createSession(actor, { title: "Redaction fixture", mode: "multi", idempotency_key: "pepper-session" });
  const runtime = service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id,
    harness: "codex", provider: "fixture", model: "fixture", local_session_id: "fixture-local-only", capture_fidelity: "harness_transcript" });
  const request = service.appendEvent(actor, session.id, { type: "agent_request", visibility: "session", idempotency_key: "pepper-request",
    payload: { prompt: "Fixture only", execution_profile: { harness: "codex", provider: "fixture", model: "fixture", runtime_id: runtime.id } } });
  const claim = service.claimAgentRequest(actor, session.id, request.id, runtime.id);
  assert.equal(claim.attempt_count, 1);
  for (const type of ["human_chat", "tool_call", "tool_result"] as const) {
    const payload = type === "human_chat" ? gatePepperPayload : { tool_name: "fixture", tool_call_id: "fixture-call", ...gatePepperPayload };
    const expected = type === "human_chat" ? sanitizedGatePepperPayload : { tool_name: "fixture", tool_call_id: "fixture-call", ...sanitizedGatePepperPayload };
    const event = service.appendEvent(actor, session.id, { type, visibility: "session", idempotency_key: `pepper-${type}`, payload,
      ...(type === "human_chat" ? {} : { runtime_id: runtime.id, reply_to_event_id: request.id, claim_attempt: 1 }) });
    assert.deepEqual(event.payload, expected);
    assert.deepEqual(database.getEvent(session.id, event.id).payload, expected, "stored event is sanitized before any replay");
    const persisted = database.sqlite.prepare("SELECT payload_json FROM events WHERE id=?").get(event.id) as { payload_json: string };
    assert.equal(persisted.payload_json.includes(gatePepperFixture), false);
    const replayed = service.replay(actor, session.id, 0, 100).events.find(item => item.id === event.id)!;
    assert.deepEqual(replayed.payload, expected);
  }
});
