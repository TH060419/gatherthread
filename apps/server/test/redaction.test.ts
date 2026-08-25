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
    RELAYROOM_TOKEN: "acp_01234567890123456789012345678901",
    ACP_AUTH_TOKEN_PEPPER: "private-pepper",
    privateKey: "private-key-value",
    bearer: "opaque-bearer-secret",
    nested: {
      authToken: "private-token",
      tokenCount: 42,
      content: `access_token=lower-secret ${fakeGithubToken} ACP_AUTH_TOKEN_PEPPER=super-secret-value RELAYROOM_TOKEN=another-secret-value`,
      device: "acpd_01234567890123456789012345678901",
      aws: fakeAwsAccessKey,
      pem: fakePrivateKey,
    },
  }), {
    systemPrompt: "[REDACTED]",
    developer_prompt: "[REDACTED]",
    RELAYROOM_TOKEN: "[REDACTED]",
    ACP_AUTH_TOKEN_PEPPER: "[REDACTED]",
    privateKey: "[REDACTED]",
    bearer: "[REDACTED]",
    nested: {
      authToken: "[REDACTED]",
      tokenCount: 42,
      content: "access_token=[REDACTED] [REDACTED] ACP_AUTH_TOKEN_PEPPER=[REDACTED] RELAYROOM_TOKEN=[REDACTED]",
      device: "[REDACTED]",
      aws: "[REDACTED]",
      pem: "[REDACTED]",
    },
  });
});
