import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ApiError, HttpCollaborationApi } from "../src/api.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function environment(t, fetch) {
  const previousFetch = globalThis.fetch, previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const reports = [];
  globalThis.fetch = fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true,
    value: { __gtPageRecovery: { report: (...args) => reports.push(args) } } });
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window;
  });
  return { reports };
}
const timeout = error => error instanceof ApiError && error.status === 0 && error.code === "request_timeout";

test("general API headers cannot hang past 45 seconds even when fetch ignores abort; reporting has no private fields", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, transported;
  const { reports } = environment(t, (_url, options) => { calls++; transported = options; return new Promise(() => {}); });
  const pending = new HttpCollaborationApi().request("/v1/private-fixture?secret=PRIVATE_URL_MARKER", {
    method: "POST", body: JSON.stringify({ idempotency_key: "fixture-stable-key", content: "PRIVATE_BODY_MARKER" }),
  });
  let settled = false; pending.catch(() => { settled = true; });
  t.mock.timers.tick(44_999); await flush(); assert.equal(settled, false); assert.deepEqual(reports, []);
  const checked = assert.rejects(pending, error => {
    assert.ok(timeout(error)); assert.equal(/PRIVATE_|fixture-stable-key/u.test(error.message), false); return true;
  });
  t.mock.timers.tick(1); await checked;
  assert.equal(transported.signal.aborted, true); assert.equal(calls, 1);
  assert.deepEqual(reports, [["request_timeout"]]);
  t.mock.timers.tick(90_000); await flush(); assert.equal(calls, 1); assert.equal(reports.length, 1);
});

for (const status of [200, 403]) {
  test(`general API deadline covers a hung ${status} JSON body that ignores abort`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let bodyReads = 0, calls = 0, transported;
    const { reports } = environment(t, async (_url, options) => {
      calls++; transported = options; return { ok: status < 400, status, json() { bodyReads++; return new Promise(() => {}); } };
    });
    const pending = new HttpCollaborationApi().request("/v1/fixture-body"); await flush();
    assert.equal(bodyReads, 1);
    const checked = assert.rejects(pending, timeout); t.mock.timers.tick(45_000); await checked;
    assert.equal(calls, 1); assert.equal(transported.signal.aborted, true); assert.deepEqual(reports, [["request_timeout"]]);
  });
}

test("late headers cannot decode or return a response after the acknowledgement deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const headers = deferred(); let calls = 0, reads = 0;
  const { reports } = environment(t, () => { calls++; return headers.promise; });
  const pending = new HttpCollaborationApi().request("/v1/fixture-late-headers");
  const checked = assert.rejects(pending, timeout); t.mock.timers.tick(45_000); await checked;
  headers.resolve({ ok: true, status: 200, json() { reads++; return Promise.resolve({ data: { private: "LATE_PRIVATE_BODY" } }); } });
  await flush(); assert.equal(reads, 0); assert.equal(calls, 1); assert.deepEqual(reports, [["request_timeout"]]);
});

test("a body completing after timeout cannot resolve the already rejected request or automatically retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const body = deferred(); let calls = 0, resolved = false;
  const { reports } = environment(t, async () => { calls++; return { ok: true, status: 200, json: () => body.promise }; });
  const pending = new HttpCollaborationApi().request("/v1/fixture-late-body");
  pending.then(() => { resolved = true; }, () => {}); await flush();
  const checked = assert.rejects(pending, timeout); t.mock.timers.tick(45_000); await checked;
  body.resolve({ data: { private: "LATE_PRIVATE_BODY" } }); await flush();
  assert.equal(resolved, false); assert.equal(calls, 1); assert.deepEqual(reports, [["request_timeout"]]);
});

for (const phase of ["headers", "body"]) {
  test(`caller cancellation promptly interrupts hung ${phase} without a timeout report`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0, transported;
    const { reports } = environment(t, (_url, options) => {
      calls++; transported = options;
      return phase === "headers" ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) });
    });
    const controller = new AbortController(), reason = new DOMException("Synthetic caller cancelled", "AbortError");
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    let added = 0, removed = 0;
    controller.signal.addEventListener = (...args) => { if (args[0] === "abort") added++; return add(...args); };
    controller.signal.removeEventListener = (...args) => { if (args[0] === "abort") removed++; return remove(...args); };
    const pending = new HttpCollaborationApi().request("/v1/fixture-cancel", { signal: controller.signal }); await flush();
    const checked = assert.rejects(pending, error => error === reason); controller.abort(reason); await checked;
    assert.equal(transported.signal.aborted, true); assert.equal(transported.signal.reason, reason);
    assert.equal(calls, 1); assert.equal(added, 1); assert.equal(removed, 1);
    t.mock.timers.tick(90_000); await flush(); assert.deepEqual(reports, []);
  });
}

test("an already cancelled caller never sends a request and retains its exact reason", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0; const { reports } = environment(t, () => { calls++; return new Promise(() => {}); });
  const controller = new AbortController(); controller.abort(new Error("Synthetic already-cancelled reason"));
  await assert.rejects(new HttpCollaborationApi().request("/v1/fixture-pre-abort", { signal: controller.signal }), error => error === controller.signal.reason);
  t.mock.timers.tick(90_000); assert.equal(calls, 0); assert.deepEqual(reports, []);
});

test("successful requests keep URL, method, key, headers and cookie behavior exactly once and clear listeners/timers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], controller = new AbortController(); let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { if (args[0] === "abort") added++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { if (args[0] === "abort") removed++; return remove(...args); };
  const { reports } = environment(t, async (url, options) => { calls.push({ url, options }); return Response.json({ data: { accepted: true } }); });
  const body = JSON.stringify({ idempotency_key: "fixture-exact-key", content: "Synthetic body" });
  const value = await new HttpCollaborationApi({ baseUrl: "https://synthetic.example/" }).request("/v1/fixture%3Aid?after=5", {
    method: "PUT", body, signal: controller.signal, credentials: "omit", headers: { "X-Fixture": "fixed" },
  });
  assert.deepEqual(value, { accepted: true }); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://synthetic.example/v1/fixture%3Aid?after=5");
  assert.equal(calls[0].options.method, "PUT"); assert.equal(calls[0].options.body, body);
  assert.equal(calls[0].options.credentials, "include");
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json", "Content-Type": "application/json", "X-Fixture": "fixed" });
  assert.equal(calls[0].options.signal.aborted, false); assert.equal(added, 1); assert.equal(removed, 1);
  t.mock.timers.tick(90_000); assert.deepEqual(reports, []); assert.equal(calls[0].options.signal.aborted, false);
});

test("204, ordinary HTTP errors, transport errors and malformed JSON finish without a timeout report", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const networkError = new TypeError("Synthetic transport failure"), syntaxError = new SyntaxError("Synthetic malformed response");
  const responses = [new Response(null, { status: 204 }), Response.json({ error: { code: "fixture_rejected", message: "Synthetic action rejected" } }, { status: 403 }),
    networkError, { ok: true, status: 200, json: async () => { throw syntaxError; } }];
  let calls = 0;
  const { reports } = environment(t, async () => { const value = responses[calls++]; if (value instanceof Error) throw value; return value; });
  const api = new HttpCollaborationApi();
  assert.equal(await api.request("/v1/fixture-204"), undefined);
  await assert.rejects(api.request("/v1/fixture-http-error"), error => error instanceof ApiError && error.status === 403 && error.code === "fixture_rejected");
  await assert.rejects(api.request("/v1/fixture-transport-error"), error => error === networkError);
  await assert.rejects(api.request("/v1/fixture-json-error"), error => error === syntaxError);
  t.mock.timers.tick(90_000); await flush(); assert.equal(calls, 4); assert.deepEqual(reports, []);
});

test("deadline remains effective when there is no window or the recovery hook throws", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { reports } = environment(t, () => new Promise(() => {}));
  for (const available of [false, true]) {
    if (!available) delete globalThis.window;
    else globalThis.window = { __gtPageRecovery: { report() { throw new Error("Synthetic UI hook error"); } } };
    const pending = new HttpCollaborationApi().request("/v1/fixture-hook");
    const checked = assert.rejects(pending, timeout); t.mock.timers.tick(45_000); await checked;
  }
  assert.deepEqual(reports, []);
});

test("shorter Team and sharing deadlines cancel the general request without a false page-timeout report", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0; const { reports } = environment(t, () => { calls++; return new Promise(() => {}); });
  const api = new HttpCollaborationApi({ sharingDeadlineMs: 80 });
  for (const action of ["teamRequest", "sharingRequest"]) {
    const pending = api[action]("/v1/fixture-shorter-deadline");
    const checked = assert.rejects(pending, timeout); t.mock.timers.tick(80); await checked;
  }
  t.mock.timers.tick(90_000); await flush(); assert.equal(calls, 2); assert.deepEqual(reports, []);
});

for (const phase of ["headers", "body"]) {
  test(`real HTTP ${phase} stall is bounded through body completion without retry`, async t => {
    const accepted = deferred(), nativeFetch = globalThis.fetch, delivered = deferred(); let requests = 0, transported;
    const server = createServer((_request, response) => {
      requests++; accepted.resolve();
      if (phase === "body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"data":'); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const { reports } = environment(t, async (url, options) => {
      transported = options; const response = await nativeFetch(url, options); delivered.resolve(); return response;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const api = new HttpCollaborationApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const pending = api.request("/v1/fixture-real-hang");
    await accepted.promise; if (phase === "body") await delivered.promise;
    const checked = assert.rejects(pending, timeout); t.mock.timers.tick(45_000); await checked;
    assert.equal(requests, 1); assert.equal(transported.signal.aborted, true); assert.deepEqual(reports, [["request_timeout"]]);
    t.mock.timers.reset();
  });
}
