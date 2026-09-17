import test from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_CONNECTION_NOTICE_STATE,
  advanceConnectionNotice,
  notificationPermissionNeeded,
} from "../src/notifications.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

test("connection-loss alerts remain enabled by default", () => {
  assert.equal(DEFAULT_SETTINGS.notifications.connectionLost, true);
});

test("connection loss is announced once only after a session has been live", () => {
  let result = advanceConnectionNotice(INITIAL_CONNECTION_NOTICE_STATE, {
    sessionId: "session-1",
    phase: "connecting",
  }, true);
  assert.equal(result.notify, false);

  result = advanceConnectionNotice(result.state, {
    sessionId: "session-1",
    phase: "blocked",
  }, true);
  assert.equal(result.notify, false, "an initial connection failure is not a dropped live connection");

  result = advanceConnectionNotice(result.state, {
    sessionId: "session-1",
    phase: "live",
  }, true);
  assert.equal(result.notify, false);

  result = advanceConnectionNotice(result.state, {
    sessionId: "session-1",
    phase: "offline",
  }, true);
  assert.equal(result.notify, true);

  result = advanceConnectionNotice(result.state, {
    sessionId: "session-1",
    phase: "connecting",
  }, true);
  assert.equal(result.notify, false);

  result = advanceConnectionNotice(result.state, {
    sessionId: "session-1",
    phase: "blocked",
  }, true);
  assert.equal(result.notify, false, "one outage must not create repeated notifications during retries");
});

test("a recovered session can announce a later outage and session switches reset tracking", () => {
  let result = advanceConnectionNotice(INITIAL_CONNECTION_NOTICE_STATE, {
    sessionId: "session-1",
    phase: "live",
  }, true);
  result = advanceConnectionNotice(result.state, { sessionId: "session-1", phase: "offline" }, true);
  assert.equal(result.notify, true);
  result = advanceConnectionNotice(result.state, { sessionId: "session-1", phase: "live" }, true);
  result = advanceConnectionNotice(result.state, { sessionId: "session-1", phase: "offline" }, true);
  assert.equal(result.notify, true);

  result = advanceConnectionNotice(result.state, { sessionId: "session-2", phase: "offline" }, true);
  assert.equal(result.notify, false, "a newly selected session has not yet established a live connection");
});

test("disabled connection notifications stay silent", () => {
  let result = advanceConnectionNotice(INITIAL_CONNECTION_NOTICE_STATE, {
    sessionId: "session-1",
    phase: "live",
  }, false);
  result = advanceConnectionNotice(result.state, { sessionId: "session-1", phase: "offline" }, false);
  assert.equal(result.notify, false);
});

test("either enabled notification setting requires browser permission", () => {
  assert.equal(notificationPermissionNeeded({ agentCompleted: false, connectionLost: false }), false);
  assert.equal(notificationPermissionNeeded({ agentCompleted: true, connectionLost: false }), true);
  assert.equal(notificationPermissionNeeded({ agentCompleted: false, connectionLost: true }), true);
});
