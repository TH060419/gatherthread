import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolveDeviceCredential } from "../src/device-credential.js";
const grant = () => `gtd_${randomBytes(32).toString("base64url")}`;
const credential = () => `gta_${randomBytes(32).toString("base64url")}`;
test("one-use authorization exchanges only with the chosen server and never forwards a password or bearer", async () => {
  const authorization = grant(), token = credential(); let calls = 0;
  const transport = (async (url, options) => {
    calls += 1; assert.equal(url, "https://fixture.invalid/v1/device-authorizations/claim");
    assert.equal(options?.redirect, "error"); assert.equal(new Headers(options?.headers).has("authorization"), false);
    assert.deepEqual(JSON.parse(String(options?.body)), { authorization_token: authorization, device_name: "Codex connector" });
    return Response.json({ data: { token } });
  }) as typeof fetch;
  assert.equal(await resolveDeviceCredential(authorization, "https://fixture.invalid/v1", transport), token);
  assert.equal(calls, 1);
  assert.equal(await resolveDeviceCredential(token, "https://fixture.invalid/v1", transport), token);
  assert.equal(calls, 1);
});
test("ambiguous, expired, malformed and oversized claims fail without retry or exposing credentials", async () => {
  const authorization = grant();
  for (const response of [() => Response.json({ error: { message: authorization } }, { status: 401 }),
    () => Response.json({ data: { token: "invalid" } }), () => new Response("x".repeat(20_000))]) {
    let calls = 0;
    await assert.rejects(resolveDeviceCredential(authorization, "https://fixture.invalid/v1", (async () => { calls += 1; return response(); }) as typeof fetch), (e: Error) => {
      assert.doesNotMatch(e.message, new RegExp(authorization)); return /Create a new one/.test(e.message);
    }); assert.equal(calls, 1);
  }
});
test("passwords and malformed device inputs never leave the connector", async () => {
  let calls = 0;
  const transport = (async () => { calls += 1; throw new Error("must not send"); }) as typeof fetch;
  for (const value of ["isolated fixture password", "gtd_short", "gta_invalid\nheader", ""]) {
    await assert.rejects(resolveDeviceCredential(value, "https://fixture.invalid/v1", transport));
  }
  assert.equal(calls, 0);
});
