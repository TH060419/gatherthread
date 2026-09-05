import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_STATUS_MAX_ID_LENGTH,
  DSH_STATUS_MAX_LABEL_LENGTH,
  DSH_STATUS_MAX_SESSIONS,
  DSH_STATUS_PATH,
  DshStatusController,
  registerDshStatusRoute,
} from "../src/status.js";

test("public status is a fixed, bounded allowlist with no secret or host-path field", () => {
  const times = [
    new Date("2026-09-06T00:00:00.000Z"),
    new Date("2026-09-06T00:00:01.000Z"),
    new Date("2026-09-06T00:00:02.000Z"),
    new Date("2026-09-06T00:00:03.000Z"),
  ];
  let index = 0;
  const status = new DshStatusController({
    bindingMode: "project",
    projectName: "Project One",
    now: () => times[Math.min(index++, times.length - 1)] as Date,
  });
  status.upsertSession({
    sessionId: "session-1",
    title: "General",
    state: "running",
    synced: true,
  });
  status.setConnection("connected");
  const snapshot = status.snapshot();
  assert.deepEqual(Object.keys(snapshot), [
    "schemaVersion",
    "integration",
    "connection",
    "bindingMode",
    "projectName",
    "activeSessionCount",
    "sessions",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys(snapshot.sessions[0] ?? {}), [
    "sessionId", "title", "state", "lastSyncedAt",
  ]);
  assert.equal(snapshot.activeSessionCount, 1);
  const encoded = JSON.stringify(snapshot);
  for (const forbidden of [
    "token", "authorization", "headers", "workspacePath", "stateRoot", "stack",
    "/Users/private", "fixture-secret",
  ]) {
    assert.equal(encoded.toLowerCase().includes(forbidden.toLowerCase()), false);
  }

  assert.throws(
    () => new DshStatusController({ bindingMode: "project", projectName: "/Users/private/project" }),
    /safe bounded display text/,
  );
  assert.throws(
    () => status.upsertSession({ sessionId: "s", title: "C:\\private\\state", state: "idle" }),
    /safe bounded display text/,
  );
  assert.throws(
    () => status.upsertSession({ sessionId: "s".repeat(DSH_STATUS_MAX_ID_LENGTH + 1), title: "x", state: "idle" }),
    /safe bounded display text/,
  );
  assert.throws(
    () => status.upsertSession({ sessionId: "safe", title: "x".repeat(DSH_STATUS_MAX_LABEL_LENGTH + 1), state: "idle" }),
    /safe bounded display text/,
  );
});

test("project reconciliation is capped and preserves only eligible public Sessions", () => {
  const status = new DshStatusController({ bindingMode: "project", projectName: "Project" });
  const sessions = Array.from({ length: DSH_STATUS_MAX_SESSIONS + 5 }, (_, index) => ({
    id: `session-${String(index).padStart(3, "0")}`,
    name: `Session ${String(index)}`,
    mode: "multi" as const,
    role: "participant" as const,
    state: "active" as const,
  }));
  status.reconcileProjectSessions(sessions, ["session-000", "session-001"]);
  assert.equal(status.snapshot().sessions.length, DSH_STATUS_MAX_SESSIONS);
  assert.equal(status.snapshot().activeSessionCount, 2);
  status.reconcileProjectSessions([sessions[1] as (typeof sessions)[number]], ["session-001"]);
  assert.deepEqual(status.snapshot().sessions.map((session) => session.sessionId), ["session-001"]);
  status.markSessionsOffline();
  assert.equal(status.snapshot().sessions[0]?.state, "offline");
  assert.equal(status.snapshot().activeSessionCount, 0);
});

test("project reconciliation replaces a reordered 100-Session window without overflow", () => {
  const status = new DshStatusController({ bindingMode: "project", projectName: "Project" });
  const sessions = Array.from({ length: DSH_STATUS_MAX_SESSIONS + 1 }, (_, index) => ({
    id: `session-${String(index).padStart(3, "0")}`,
    name: `Session ${String(index)}`,
    mode: "multi" as const,
    role: "participant" as const,
    state: "active" as const,
  }));
  status.reconcileProjectSessions(sessions, []);
  assert.equal(status.snapshot().sessions.length, DSH_STATUS_MAX_SESSIONS);
  assert.equal(status.snapshot().sessions.some((session) => session.sessionId === "session-100"), false);

  const reordered = [sessions[100] as (typeof sessions)[number], ...sessions.slice(0, 100)];
  assert.doesNotThrow(() => status.reconcileProjectSessions(reordered, ["session-100"]));
  const snapshot = status.snapshot();
  assert.equal(snapshot.sessions.length, DSH_STATUS_MAX_SESSIONS);
  assert.equal(snapshot.sessions.some((session) => session.sessionId === "session-100"), true);
  assert.equal(snapshot.sessions.some((session) => session.sessionId === "session-099"), false);
  assert.equal(snapshot.activeSessionCount, 1);
});

test("status route is exact, read-only, cacheless, HEAD-safe, and unavailable after disposal", async () => {
  let route: {
    path: string;
    methods: readonly string[];
    requestBody: string;
    fetch: (request: Request) => Promise<Response>;
  } | undefined;
  let unregisters = 0;
  const context = {
    connection: {
      fetch: {
        register(input: typeof route) {
          route = input;
          return async () => { unregisters += 1; route = undefined; };
        },
      },
    },
  };
  const status = new DshStatusController({ bindingMode: "single", projectName: "Project" });
  status.upsertSession({ sessionId: "session-1", title: "General", state: "idle" });
  const dispose = registerDshStatusRoute(context, status);
  assert.ok(dispose);
  assert.equal(route?.path, DSH_STATUS_PATH);
  assert.deepEqual(route?.methods, ["GET", "HEAD"]);
  assert.equal(route?.requestBody, "buffered");
  if (route === undefined) throw new Error("route fixture was not registered");
  const fetchRoute = route.fetch;

  const get = await fetchRoute(new Request(`http://127.0.0.1${DSH_STATUS_PATH}`));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(get.headers.get("content-security-policy"), "default-src 'none'");
  assert.deepEqual(await get.json(), status.snapshot());

  const head = await fetchRoute(new Request(`http://127.0.0.1${DSH_STATUS_PATH}`, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.ok(Number(head.headers.get("content-length")) > 0);
  assert.equal((await fetchRoute(new Request(
    `http://127.0.0.1${DSH_STATUS_PATH}?debug=1`,
  ))).status, 400);
  assert.equal((await fetchRoute(new Request(
    `http://127.0.0.1${DSH_STATUS_PATH}`,
    { method: "POST" },
  ))).status, 405);

  await dispose();
  await dispose();
  assert.equal(unregisters, 1);
  assert.equal((await fetchRoute(new Request(`http://127.0.0.1${DSH_STATUS_PATH}`))).status, 404);
});

test("headless Host without Connection registers no browser route", () => {
  const status = new DshStatusController({ bindingMode: "project", projectName: "Project" });
  assert.equal(registerDshStatusRoute({}, status), undefined);
});
