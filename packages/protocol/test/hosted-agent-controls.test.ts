import assert from "node:assert/strict";
import test from "node:test";
import { HostedHistorySummaryInputSchema, HostedAgentPausedSchema, HostedAgentAcceptedSchema } from "../src/index.js";

test("cloud summary inputs require exact profiles and reject client content, code, identity and metadata", () => {
  const input = { profile_id: "sf-qwen35-4b", source_event_ids: ["source"], idempotency_key: "fixture-summary" };
  assert.equal(HostedHistorySummaryInputSchema.safeParse(input).success, true);
  for (const patch of [{ profile_id: undefined }, { source_event_ids: [] }, { source_event_ids: ["source", "source"] },
    { content: "forged" }, { include_code: true }, { user_id: "other" }, { history_summary: {} }, { execution_profile: {} }]) {
    assert.equal(HostedHistorySummaryInputSchema.safeParse({ ...input, ...patch }).success, false);
  }
});

test("cloud control responses are strict and cannot expose private executor data", () => {
  const paused = { request_event_id: "fixture", status: "paused" };
  assert.equal(HostedAgentPausedSchema.safeParse(paused).success, true);
  assert.equal(HostedAgentPausedSchema.safeParse({ ...paused, container: "private" }).success, false);
  assert.equal(HostedAgentAcceptedSchema.safeParse({ replayed: false }).success, false);
});
