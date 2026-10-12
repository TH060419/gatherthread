import test from "node:test";
import assert from "node:assert/strict";
import { SessionSync } from "../src/realtime.js";

const event = (sequence, contentRevision = 0, type = "human_chat") => ({ id: `e-${sequence}`, sessionId: "s1",
  sequence, type, contentRevision, actor: { id: "me", username: "Me" }, createdAt: "2026-10-12T00:00:00.000Z",
  payload: { content: `private fixture ${sequence}` } });
const deleted = (item, revision) => ({ ...item, contentRevision: revision,
  deleted: { deleted_at: "2026-10-12T00:00:00.000Z", reason: "author" }, payload: { content: "[Message deleted]" }, provenance: null });
const marker = (sequence, revision) => ({ ...event(sequence, revision, "message_deleted"),
  payload: { target_event_id: "e-1", content_revision: revision } });
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
class Api {
  constructor() { this.events = [event(1)]; this.revision = 0; this.calls = []; this.pending = []; }
  async replayEvents(sessionId, { afterSequence }) {
    this.calls.push(afterSequence);
    if (this.defer) return new Promise(resolve => this.pending.push(resolve));
    return { events: structuredClone(this.events.filter(e => e.sequence > afterSequence)),
      contentRevision: this.revision, nextAfterSequence: this.events.at(-1)?.sequence ?? afterSequence, hasMore: false };
  }
  async openRealtime(options) { this.socket = options; return { close() {} }; }
}

test("a deletion marker scrubs cached bodies immediately and always rereads from zero", async () => {
  const api = new Api(), sync = new SessionSync(api); await sync.connect("s1");
  api.revision = 1; api.events = [deleted(event(1), 1), marker(2, 1)]; api.defer = true;
  api.socket.onEvent(marker(2, 1));
  assert.equal(JSON.stringify(sync.snapshot()).includes("private fixture"), false);
  assert.equal(sync.snapshot().contentRevision, 1);
  assert.equal(api.calls.at(-1), 0);
  api.pending.shift()({ events: structuredClone(api.events), contentRevision: 1, nextAfterSequence: 2, hasMore: false });
  await flush();
  assert.equal(sync.snapshot().events[0].deleted.reason, "author");
  assert.equal(sync.snapshot().phase, "live");
});

test("old replay and delayed socket bodies cannot resurrect deleted content", async () => {
  const api = new Api(), sync = new SessionSync(api); await sync.connect("s1");
  api.defer = true; api.socket.onEvent(event(3)); // starts old generation replay
  const oldReplay = api.pending.shift();
  api.revision = 1; api.events = [deleted(event(1), 1), event(2, 1), marker(3, 1)];
  api.socket.onEvent(marker(3, 1));
  const deletionReplay = api.pending.shift();
  oldReplay({ events: [event(2), event(3)], contentRevision: 0, nextAfterSequence: 3, hasMore: false });
  await flush();
  assert.equal(JSON.stringify(sync.snapshot()).includes("private fixture"), false);
  deletionReplay({ events: structuredClone(api.events), contentRevision: 1, nextAfterSequence: 3, hasMore: false });
  await flush();
  api.socket.onEvent(event(4));
  assert.equal(sync.snapshot().cursor, 3);
  assert.equal(sync.snapshot().events.some(e => e.sequence === 4), false);
  api.socket.onEvent(event(4, 1));
  assert.equal(sync.snapshot().cursor, 4);
});

test("HTTP deletion receipt invalidates an in-flight replay even if its marker has no gap", async () => {
  const api = new Api(), sync = new SessionSync(api); await sync.connect("s1");
  api.revision = 1; api.events = [deleted(event(1), 1), marker(2, 1)];
  await sync.invalidateContent({ contentRevision: 1, event: marker(2, 1) });
  assert.equal(sync.snapshot().contentRevision, 1);
  assert.deepEqual(api.calls, [0, 0]);
  assert.equal(sync.snapshot().events[0].deleted.reason, "author");
  const calls = api.calls.length; await sync.invalidateContent({ contentRevision: 0, event: marker(2, 0) });
  assert.equal(api.calls.length, calls, "older receipt cannot lower the read revision");
});

test("a higher replay revision discovered on reconnect replaces all earlier pages", async () => {
  const api = new Api(), sync = new SessionSync(api); await sync.connect("s1");
  api.revision = 1; api.events = [deleted(event(1), 1), marker(2, 1)];
  await sync.retry();
  assert.deepEqual(api.calls, [0, 1, 0]);
  assert.equal(sync.snapshot().events[0].deleted.reason, "author");
  assert.equal(JSON.stringify(sync.snapshot()).includes("private fixture"), false);
});
