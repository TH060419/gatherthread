import test from "node:test";
import assert from "node:assert/strict";

import { SessionSync } from "../src/realtime.js";

const event = (sequence, sessionId = "s1") => ({
  id: `${sessionId}-${sequence}`,
  sessionId,
  sequence,
  type: "human_chat",
  actor: { id: "u1", username: "User" },
  createdAt: new Date(2026, 0, 1, 0, sequence).toISOString(),
  payload: { content: `event ${sequence}` },
});

class FakeApi {
  constructor(events = []) {
    this.events = events;
    this.subscriptions = [];
    this.replayCalls = [];
  }

  async replayEvents(sessionId, { afterSequence, limit }) {
    this.replayCalls.push({ sessionId, afterSequence });
    const available = this.events.filter(
      (item) => item.sessionId === sessionId && item.sequence > afterSequence,
    );
    const events = available.slice(0, limit);
    const headSequence = available.at(-1)?.sequence ?? afterSequence;
    return {
      events,
      headSequence,
      nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore: events.length < available.length,
    };
  }

  async openRealtime(options) {
    this.subscriptions.push(options);
    options.onState("live");
    return { close() {} };
  }

  emit(eventValue) {
    this.subscriptions.at(-1).onEvent(eventValue);
  }

  setSocketState(state) {
    this.subscriptions.at(-1).onState(state);
  }
}

test("initial replay is ordered and socket subscribes after the contiguous cursor", async () => {
  const api = new FakeApi([event(1), event(2)]);
  const sync = new SessionSync(api);
  await sync.connect("s1");
  const state = sync.snapshot();
  assert.equal(state.phase, "live");
  assert.equal(state.cursor, 2);
  assert.deepEqual(state.events.map((item) => item.sequence), [1, 2]);
  assert.equal(api.subscriptions[0].afterSequence, 2);
});

test("a socket gap triggers HTTP replay and drains buffered delivery without duplicates", async () => {
  const api = new FakeApi([]);
  const sync = new SessionSync(api);
  await sync.connect("s1");

  api.events.push(event(1), event(2), event(3));
  api.emit(event(3));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const state = sync.snapshot();
  assert.equal(state.phase, "live");
  assert.equal(state.cursor, 3);
  assert.equal(state.bufferedCount, 0);
  assert.deepEqual(state.events.map((item) => item.sequence), [1, 2, 3]);
  assert.equal(api.replayCalls.at(-1).afterSequence, 0);
});

test("duplicate and stale socket events are ignored", async () => {
  const api = new FakeApi([event(1)]);
  const sync = new SessionSync(api);
  await sync.connect("s1");
  api.emit(event(1));
  assert.deepEqual(sync.snapshot().events.map((item) => item.sequence), [1]);
});

test("a lost socket exposes an offline state without dropping confirmed history", async () => {
  const api = new FakeApi([event(1)]);
  const sync = new SessionSync(api, { reconnectDelay: 60_000 });
  await sync.connect("s1");
  api.setSocketState("offline");
  const state = sync.snapshot();
  assert.equal(state.phase, "offline");
  assert.equal(state.cursor, 1);
  assert.deepEqual(state.events.map((item) => item.sequence), [1]);
  sync.disconnect();
});

test("late callbacks from a previous session cannot pollute a new session", async () => {
  const api = new FakeApi([event(1, "s1"), event(1, "s2")]);
  const sync = new SessionSync(api);
  await sync.connect("s1");
  const oldSubscription = api.subscriptions.at(-1);
  await sync.connect("s2");
  oldSubscription.onEvent(event(2, "s1"));
  assert.equal(sync.snapshot().sessionId, "s2");
  assert.deepEqual(sync.snapshot().events.map((item) => item.sessionId), ["s2"]);
});
