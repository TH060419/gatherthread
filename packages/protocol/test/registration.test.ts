import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { VerifyPasswordResetInputSchema, SendPasswordResetInputSchema, AccountPasswordSchema, EmailAccountSessionSchema, EmailLoginInputSchema, RegistrationEmailSchema, SendRegistrationInputSchema, VerifyRegistrationInputSchema } from "../src/registration.js";

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


test("password recovery rejects mismatched passwords, wrong-purpose IDs and caller privilege overrides", () => {
  const input = { reset_id: randomUUID(), email: "A@example.com", code: "12345678", password: "isolated password 47", password_confirmation: "isolated password 47", locale: "en" };
  assert.equal(VerifyPasswordResetInputSchema.parse(input).email, "a@example.com");
  for (const extra of [{ password_confirmation: "another password 82" }, { user_id: "owner" }, { token: "credential" }, { registration_id: randomUUID() }, { code: "short" }]) assert.equal(VerifyPasswordResetInputSchema.safeParse({ ...input, ...extra }).success, false);
  assert.equal(SendPasswordResetInputSchema.safeParse({ email: input.email, challenge_token: "challenge", idempotency_key: randomUUID(), locale: "en", purpose: "registration" }).success, false);
});

test("registration, sign-in and recovery share the 8–128-character password policy", () => {
  for (const [password, accepted] of [["x".repeat(7), false], ["x".repeat(8), true],
    ["x".repeat(128), true], ["x".repeat(129), false]] as const) {
    assert.equal(AccountPasswordSchema.safeParse(password).success, accepted);
    assert.equal(VerifyRegistrationInputSchema.safeParse({ registration_id: randomUUID(), code: "12345678",
      display_name: "Fixture", device_name: "Fixture", privacy_acknowledged: true, password }).success, accepted);
    assert.equal(EmailLoginInputSchema.safeParse({ email: "fixture@example.invalid", device_name: "Fixture", password }).success, accepted);
    assert.equal(VerifyPasswordResetInputSchema.safeParse({ reset_id: randomUUID(), email: "fixture@example.invalid",
      code: "12345678", password, password_confirmation: password, locale: "en" }).success, accepted);
  }
  // Existing no-truncation/no-normalization and Unicode bounds remain unchanged.
  assert.equal(AccountPasswordSchema.parse("  abcd  "), "  abcd  ");
  assert.equal(AccountPasswordSchema.parse("界".repeat(128)), "界".repeat(128));
  assert.equal(AccountPasswordSchema.safeParse("😀".repeat(129)).success, false);
});
