import assert from "node:assert/strict";
import test from "node:test";
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
