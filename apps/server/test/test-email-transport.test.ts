import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { testEmailTransport } from "../src/test-email-transport.js";
import { registrationFromEnvironment } from "../src/registration-providers.js";

test("test mail transport marks both locales and password notices without changing recipient or provider receipt", async () => {
  const messages: Array<{ subject: string; text: string; to: string[] }> = [];
  const transport: typeof fetch = async (_input, init) => { messages.push(JSON.parse(String(init!.body))); assert.equal(new Headers(init?.headers).get("idempotency-key"), "fixture-receipt"); return new Response(null, { status: 202 }); };
  for (const subject of ["GatherThread 注册验证码", "GatherThread registration code", "GatherThread 密码已重设", "GatherThread password reset code"]) {
    const response = await testEmailTransport("https://test.gatherthread.cn", transport)("https://api.resend.com/emails", { method: "POST", headers: { "idempotency-key": "fixture-receipt" }, body: JSON.stringify({ subject, text: "Fixture", to: ["fixture@example.invalid"] }) });
    assert.equal(response.status, 202);
    assert.match(messages.at(-1)!.subject, /^\[测试环境 \/ TEST\]/);
    assert.match(messages.at(-1)!.text, /https:\/\/test\.gatherthread\.cn\/app\//);
    assert.deepEqual(messages.at(-1)!.to, ["fixture@example.invalid"]);
  }
  assert.throws(() => testEmailTransport("https://gatherthread.cn"));
  await assert.rejects(testEmailTransport("https://test.gatherthread.cn", transport)("https://unapproved.invalid"));
});

test("existing registration provider labels test deployment mail and preserves production mail", async () => {
  const messages: Array<{ subject: string; text: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => { messages.push(JSON.parse(String(init!.body))); return new Response(null, { status: 200 }); };
  try {
    const fixture = { GATHERTHREAD_PUBLIC_REGISTRATION: "true", GATHERTHREAD_PASSWORD_RECOVERY: "true",
      GATHERTHREAD_TURNSTILE_SITE_KEY: "fixture_site_key", GATHERTHREAD_TURNSTILE_SECRET: randomBytes(24).toString("hex"),
      GATHERTHREAD_REGISTRATION_RESEND_KEY: randomBytes(24).toString("hex"), GATHERTHREAD_REGISTRATION_FROM: "fixture@example.invalid" };
    for (const deployment of ["production", "test"] as const) {
      const options = registrationFromEnvironment({ ...fixture, GATHERTHREAD_DEPLOYMENT_ENVIRONMENT: deployment }, deployment === "test" ? "https://test.gatherthread.cn" : "https://gatherthread.cn");
      await options.mailer!.send({ email: "fixture@example.invalid", code: "00000000", locale: "zh-CN", deliveryId: randomUUID() });
      if (deployment === "test") { assert.match(messages.at(-1)!.subject, /^\[测试环境 \/ TEST\]/); assert.match(messages.at(-1)!.text, /https:\/\/test\.gatherthread\.cn\/app\//); }
      else { assert.equal(messages.at(-1)!.subject, "GatherThread 注册验证码"); assert.doesNotMatch(messages.at(-1)!.text, /test\.gatherthread\.cn/); }
    }
  } finally { globalThis.fetch = original; }
});
