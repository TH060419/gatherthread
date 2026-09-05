import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/errors.js";
import {
  DshDevicePairingBroker,
  dshPairingPollToken,
} from "../src/dsh-pairing.js";

function brokerFixture() {
  let now = Date.parse("2026-09-06T00:00:00.000Z");
  let id = 0;
  let entropy = 0;
  const broker = new DshDevicePairingBroker({
    now: () => now,
    randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    randomBytes(size) {
      entropy += 1;
      return Buffer.alloc(size, entropy);
    },
  });
  return {
    broker,
    advance(milliseconds: number) { now += milliseconds; },
  };
}

test("DSH pairing keeps the long-lived credential out of the browser approval", () => {
  const f = brokerFixture();
  const intent = f.broker.begin("DeepSeek Harness · macOS");
  assert.deepEqual(Object.keys(intent).sort(), [
    "expires_at",
    "interval_seconds",
    "pairing_id",
    "poll_token",
    "user_code",
    "verification_path",
  ]);
  assert.match(intent.poll_token, /^gtp_/u);
  assert.match(intent.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  assert.equal(intent.verification_path, `/#dsh-pair=${intent.user_code}`);

  const pending = f.broker.poll(intent.pairing_id, intent.poll_token, () => {
    throw new Error("pending pairing must not mint a device");
  });
  assert.equal(pending.status, "pending");

  const approval = f.broker.approve({
    user_id: "owner",
    display_name: "Owner",
    device_id: "browser-device",
  }, intent.user_code);
  assert.deepEqual(Object.keys(approval).sort(), [
    "device_name", "expires_at", "pairing_id", "status", "user_code",
  ]);
  assert.equal(JSON.stringify(approval).includes("gta_"), false);

  let issued = 0;
  const paired = f.broker.poll(intent.pairing_id, intent.poll_token, (userId, deviceName, deviceId) => {
    issued += 1;
    assert.equal(userId, "owner");
    assert.equal(deviceName, "DeepSeek Harness · macOS");
    assert.match(deviceId, /^dsh_/u);
    return {
      device_id: deviceId,
      token: "gta_fixture-long-lived-device-token",
      device: {} as never,
    };
  });
  if (paired.status !== "paired") throw new Error("approved pairing did not mint a device");
  assert.deepEqual(paired, {
    status: "paired",
    device_id: paired.device_id,
    token: "gta_fixture-long-lived-device-token",
  });
  assert.equal(issued, 1);
  assert.throws(
    () => f.broker.poll(intent.pairing_id, intent.poll_token, () => { throw new Error("replay"); }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
});

test("DSH pairing expires, binds approval identity, and fails closed at capacity", () => {
  const f = brokerFixture();
  const intent = f.broker.begin("DSH one");
  f.broker.approve({ user_id: "owner", display_name: "Owner", device_id: "browser-1" }, intent.user_code);
  assert.throws(
    () => f.broker.approve({ user_id: "other", display_name: "Other", device_id: "browser-2" }, intent.user_code),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  f.advance(5 * 60_000);
  assert.equal(f.broker.pendingCount, 0);
  assert.throws(
    () => f.broker.poll(intent.pairing_id, intent.poll_token, () => { throw new Error("expired"); }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );

  const limited = new DshDevicePairingBroker({ maxPending: 1 });
  limited.begin("first");
  assert.throws(
    () => limited.begin("second"),
    (error: unknown) => error instanceof ApiError && error.status === 503,
  );
});

test("DSH pairing poll authorization accepts only the dedicated header scheme", () => {
  assert.equal(
    dshPairingPollToken("DSH-Pairing gtp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM"),
    "gtp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM",
  );
  for (const value of [undefined, "Bearer gta_secret", "DSH-Pairing short", "DSH-Pairing token with space"]) {
    assert.throws(
      () => dshPairingPollToken(value),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
  }
});
