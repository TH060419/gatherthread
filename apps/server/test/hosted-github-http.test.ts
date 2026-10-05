import assert from "node:assert/strict";
import test from "node:test";
import { startCollaborationServer } from "../src/server.js";
const socketTest = process.platform === "win32" ? test.skip : test;
socketTest("cloud GitHub HTTP callback preserves Strict-cookie CSRF boundary and one-time device-bound state", async () => {
 const mails: Array<{ code: string }> = [];
 const registration = { enabled: true, siteKey: "synthetic", origin: "https://gt.example",
   mailer: { async send(mail: { code: string }) { mails.push(mail); } }, challenge: { async verify() { return true; } } };
 const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: "github-http-test-private-pepper-at-least-32", registration,
   publicBaseUrl: "https://gt.example", allowedOrigins: ["https://gt.example"],
   hostedAgent: { endpoints: [{ id: "one", profileId: "coding", label: "Coding", provider: "deepseek", model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1", apiToken: "fake-model", quotaGroup: "one", dailyRuns: 4, maxConcurrent: 1 }],
      image: `sha256:${"a".repeat(64)}`, userDailyRuns: 4, globalDailyRuns: 4, maxConcurrent: 1, runContainer: async () => "{}" },
   hostedGithub: { clientId: "fixture", clientSecret: "test-app", encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      callbackUrl: "https://gt.example/v1/hosted-github/callback", appSlug: "fixture-app", fetch: async (url) => {
        if (String(url).endsWith("/access_token")) return Response.json({ access_token: "ghu_fixture", refresh_token: "ghr_fixture", scope: "", expires_in: 28800, refresh_token_expires_in: 15897600 });
        return Response.json({ login: "fixture" });
      } } });
 try {
   const status = await fetch(`${server.origin}/v1/registration`);
   const registrationCookie = status.headers.getSetCookie()[0]!.split(";")[0]!;
   const enroll = (path: string, body: unknown) => fetch(`${server.origin}${path}`, { method: "POST",
     headers: { origin: registration.origin, cookie: registrationCookie, "content-type": "application/json" }, body: JSON.stringify(body) });
   const email = "github-http@example.invalid", password = "synthetic test password 42";
   const sent = await enroll("/v1/registration/send", { email, locale: "en", challenge_token: "synthetic",
     idempotency_key: "aab35690-f8a3-46de-aafa-48576cf54d0e" });
   assert.equal(sent.status, 202);
   const { data: pending } = await sent.json() as { data: { registration_id: string } };
   const verified = await enroll("/v1/registration/verify", { registration_id: pending.registration_id,
     code: mails[0]!.code, display_name: "Owner", device_name: "Browser", password, privacy_acknowledged: true, remember_device: false });
   assert.equal(verified.status, 201);
   const login = await enroll("/v1/email-login", { email, password, device_name: "Browser", remember_device: false });
   assert.equal(login.status, 201);
   const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
   const write = (path: string, body: unknown, origin?: string) => fetch(`${server.origin}${path}`, { method: "POST",
     headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
   assert.equal((await write("/v1/hosted-github/authorize", {})).status, 403);
   const authorize = await write("/v1/hosted-github/authorize", {}, "https://gt.example");
   assert.equal(authorize.status, 200);
   const { data } = await authorize.json() as { data: { authorization_url: string } };
   const state = new URL(data.authorization_url).searchParams.get("state")!;
   const callback = await fetch(`${server.origin}/v1/hosted-github/callback?code=fixture-code&state=${state}`, { redirect: "manual" });
   assert.equal(callback.status, 303); assert.ok(callback.headers.get("location")!.startsWith("/app/#github_code="));
   assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
   assert.equal((await write("/v1/hosted-github/complete", { code: "fixture", state })).status, 403);
   const completion = await write("/v1/hosted-github/complete", { code: "fixture", state }, "https://gt.example");
   assert.equal(completion.status, 200);
   assert.equal((await write("/v1/hosted-github/complete", { code: "fixture", state }, "https://gt.example")).status, 403);
   const response = await completion.text(); assert.ok(!response.includes("ghu_") && !response.includes("ghr_"));
 } finally { await server.close(); }
});
