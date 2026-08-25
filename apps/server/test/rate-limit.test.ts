import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter } from "../src/rate-limit.js";

test("fixed-window rate limiter rejects requests over the limit and resets", () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 10_000, limit: 2 });
  assert.deepEqual(limiter.consume("client", 1_000), {
    allowed: true,
    limit: 2,
    remaining: 1,
    retryAfterSeconds: 10,
  });
  assert.equal(limiter.consume("client", 2_000).allowed, true);
  assert.equal(limiter.consume("client", 3_000).allowed, false);
  assert.equal(limiter.consume("client", 11_000).allowed, true);
});

test("fixed-window rate limiter bounds untrusted key cardinality", () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 10_000, limit: 1, maxKeys: 2 });
  assert.equal(limiter.consume("a", 1_000).allowed, true);
  assert.equal(limiter.consume("b", 1_000).allowed, true);
  assert.equal(limiter.consume("c", 1_000).allowed, false);
  assert.equal(limiter.consume("c", 11_000).allowed, true);
});

test("fixed-window rate limiter validates configuration", () => {
  assert.throws(() => new FixedWindowRateLimiter({ windowMs: 0, limit: 1 }), /windowMs/);
  assert.throws(() => new FixedWindowRateLimiter({ windowMs: 1, limit: 0 }), /limit/);
  assert.throws(() => new FixedWindowRateLimiter({ windowMs: 1, limit: 1, maxKeys: 0 }), /maxKeys/);
});
