import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent } from "../src/hosted-agent.js";
import { hostedFailureCode } from "../src/hosted-agent-errors.js";

test("private exception text cannot become a public hosted error", () => {
  for (const value of ["private-token secret body", "https://private.invalid", "ENOENT /host/secret"]) assert.equal(hostedFailureCode(new Error(value)), "model_unavailable");
  assert.equal(hostedFailureCode(new Error("container_timeout")), "container_timeout");
});
const socketTest = process.platform === "win32" ? test.skip : test;
for (const failure of ["container_timeout", "private-provider-token=never-public"]) {
  socketTest(`hosted failure ${failure.startsWith("private") ? "private" : failure} settles once with safe diagnostics and frees capacity`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-cloud-failure-"));
    const db = new CollaborationDatabase(join(directory, "db"), { authTokenPepper: "test-error-pepper" });
    try {
      const service = new CollaborationService(db);
      const actor = db.bootstrapIdentity({ display_name: "Fixture", device_name: "Fixture" }).actor;
      const { session } = service.createSession(actor, { title: "Fixture", mode: "multi", idempotency_key: "session" });
      const agent = new HostedAgent(service, new CodeRepository(db, join(directory, "code")), {
        endpoints: [{ id: "fake", profileId: "fake", label: "Fake", model: "free", provider: "openai-compatible",
          baseUrl: "https://api.example.invalid/v1", apiToken: "private-test-token", quotaGroup: "fake", dailyRuns: 5, maxConcurrent: 1 }],
        image: `sha256:${"a".repeat(64)}`, maxConcurrent: 1, userDailyRuns: 5, globalDailyRuns: 5,
        runContainer: async () => { throw new Error(failure); },
      });
      const result = await agent.request(actor, session.id, { content: "Fixture", include_code: false, profile_id: "fake", idempotency_key: "request" });
      const payload = result.response_event?.payload as { status: string; content: string; error: { code: string; provider_attempts: number } };
      assert.equal(payload.status, "failed");
      assert.equal(payload.error.code, failure === "container_timeout" ? failure : "model_unavailable");
      assert.equal(payload.error.provider_attempts, 0);
      assert.equal(JSON.stringify(payload).includes("private"), false);
      assert.equal(db.hostedActiveRuns(), 0);
      assert.equal(service.finishHostedAgentRequest(result.request_event.id, { content: "late" }), undefined);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
