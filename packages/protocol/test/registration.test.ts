import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AccountPasswordSchema, EmailAccountSessionSchema, EmailLoginInputSchema, RegistrationEmailSchema, SendRegistrationInputSchema, VerifyRegistrationInputSchema } from "../src/registration.js";

test("registration/email/password contracts normalize conservatively and reject overrides", () => {
  assert.equal(RegistrationEmailSchema.parse(" Test.Name+beta@Example.COM "), "test.name+beta@example.com");
  assert.notEqual(RegistrationEmailSchema.parse("test.name@example.com"), RegistrationEmailSchema.parse("testname@example.com"));
  for (const email of ["a\r\nb@example.com", "a@example.com\nBcc:x@example.com", "a@localhost", "测试@example.com", "a..b@example.com", "a@-example.com"]) assert.equal(RegistrationEmailSchema.safeParse(email).success, false);
  const send = { email: "a@example.com", challenge_token: "challenge", idempotency_key: randomUUID(), locale: "en" };
  assert.equal(SendRegistrationInputSchema.safeParse({ ...send, user_id: "owner" }).success, false);
  const verify = { registration_id: randomUUID(), code: "12345678", display_name: "A", device_name: "B", privacy_acknowledged: true, password: "test password long enough" };
  assert.equal(VerifyRegistrationInputSchema.safeParse(verify).success, true);
  for (const key of ["user_id", "device_id", "can_create_projects", "token", "role"]) assert.equal(VerifyRegistrationInputSchema.safeParse({ ...verify, [key]: "owner" }).success, false);
  assert.equal(VerifyRegistrationInputSchema.safeParse({ ...verify, privacy_acknowledged: false }).success, false);
  assert.equal(EmailLoginInputSchema.safeParse({ email: "a@example.com", password: verify.password, device_name: "B", display_name: "new name" }).success, false);
  assert.equal(AccountPasswordSchema.safeParse("short").success, false);
  assert.equal(EmailAccountSessionSchema.safeParse({ actor: { user_id: "a", device_id: "d", display_name: "A", can_create_projects: true }, expires_at: new Date().toISOString(), token: "secret" }).success, false);
});
