import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CreateCodexLauncherAuthorizationInputSchema, ClaimCodexLauncherAuthorizationInputSchema } from "../src/index.js";

test("Launcher authorization accepts only a project and normalized verified-account email", () => {
  const input = { project_id: "project-123", email: " User+Tag@Example.Invalid " };
  assert.deepEqual(CreateCodexLauncherAuthorizationInputSchema.parse(input), { project_id: "project-123", email: "user+tag@example.invalid" });
  for (const extra of [{ password: "fixture8" }, { token: "not-a-token" }, { user_id: "someone" }]) {
    assert.equal(CreateCodexLauncherAuthorizationInputSchema.safeParse({ ...input, ...extra }).success, false);
  }
  for (const project_id of ["", "../outside", "a".repeat(129), "project\n123"]) {
    assert.equal(CreateCodexLauncherAuthorizationInputSchema.safeParse({ ...input, project_id }).success, false);
  }
});

test("Launcher password claim is strict, bounded and cannot override a device/account identity", () => {
  const input = { authorization_id: randomUUID(), project_id: "project-123", email: "user@example.invalid", password: "fixture8", device_name: "My Mac" };
  assert.deepEqual(ClaimCodexLauncherAuthorizationInputSchema.parse(input), input);
  for (const extra of [{ device_id: randomUUID() }, { user_id: "someone" }, { expires_at: null }, { authorization_token: "not-a-token" }]) {
    assert.equal(ClaimCodexLauncherAuthorizationInputSchema.safeParse({ ...input, ...extra }).success, false);
  }
  for (const password of ["short", "a".repeat(129)]) {
    assert.equal(ClaimCodexLauncherAuthorizationInputSchema.safeParse({ ...input, password }).success, false);
  }
  for (const authorization_id of ["", "not-a-uuid"]) {
    assert.equal(ClaimCodexLauncherAuthorizationInputSchema.safeParse({ ...input, authorization_id }).success, false);
  }
});
