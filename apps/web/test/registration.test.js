import test from "node:test";
import assert from "node:assert/strict";
import { mountRegistration } from "../src/registration.js";
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture(api, passwordReset = false) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", checked: false, disabled: false,
      hidden: false, listeners: {}, focus() {}, checkValidity: () => true,
      addEventListener(event, fn) { this.listeners[event] = fn; },
      reset() {}, querySelector: () => get(`${id}-submit`) });
    return nodes.get(id);
  };
  let generation = 0; const completed = [], busy = [];
  const ui = mountRegistration({ document: { getElementById: get, documentElement: { lang: "en" } }, api,
    passwordReset, onReset: () => completed.push("reset"), localizer: { t: (x) => x }, identity: () => ({ displayName: "Fixture", deviceName: "Fixture browser" }),
    beginAuthentication: () => { const current = ++generation; return () => current === generation; },
    complete: async (result, current) => { if (current()) completed.push(result); }, busy: (x) => busy.push(x) });
  const submit = () => { get("email-login-email").value = "fixture@example.invalid"; get("email-login-password").value = "isolated fixture password"; return get("email-login-form").listeners.submit({ preventDefault() {} }); };
  return { get, ui, submit, completed, busy, generation: () => generation };
}
for (const outcome of ["success", "failure"]) {
  test(`cleared email form ignores stale ${outcome} and does not alter a newer login`, async () => {
    const old = deferred(), newer = deferred(); let calls = 0;
    const f = fixture({ prepareEmailLogin: async () => {}, loginWithEmail: () => (++calls === 1 ? old.promise : newer.promise) });
    const first = f.submit(); await Promise.resolve(); assert.equal(f.generation(), 1);
    f.ui.clear(); const second = f.submit(); await Promise.resolve();
    if (outcome === "success") old.resolve({ actor: { id: "old" } }); else old.reject({ code: "email_login_invalid" });
    await first;
    assert.equal(f.get("email-login-form-submit").disabled, true);
    assert.equal(f.get("email-login-error").textContent, "");
    assert.equal(f.get("email-login-password").value, "isolated fixture password");
    newer.resolve({ actor: { id: "new" } }); await second;
    assert.deepEqual(f.completed, [{ actor: { id: "new" } }]); assert.equal(f.get("email-login-password").value, "");
  });
}
test("authentication starts before email preparation and clearing prevents the actual login request", async () => {
  const preparation = deferred(); let logins = 0;
  const f = fixture({ prepareEmailLogin: () => preparation.promise, loginWithEmail: async () => { logins += 1; } });
  const work = f.submit(); assert.equal(f.generation(), 1);
  f.ui.clear(); preparation.resolve(); await work;
  assert.equal(logins, 0); assert.equal(f.completed.length, 0);
});
for (const outcome of ["success", "failure"]) {
  test(`verification starts authentication before its request and ignores late ${outcome} after switching`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred();
    const originalTurnstile = Object.getOwnPropertyDescriptor(globalThis, "turnstile");
    globalThis.turnstile = { render: (_node, options) => { options.callback("isolated-challenge"); return "widget"; }, reset() {}, remove() {} };
    t.after(() => { if (originalTurnstile) Object.defineProperty(globalThis, "turnstile", originalTurnstile); else delete globalThis.turnstile; });
    const f = fixture({ registrationStatus: async () => ({ enabled: true }),
      sendRegistration: async () => ({ registration_id: "isolated-pending", resend_after_seconds: 60 }),
      verifyRegistration: () => { assert.equal(f.generation(), 1); return pending.promise; },
      prepareEmailLogin: async () => {}, loginWithEmail: async () => ({ actor: { id: "new-login" } }) });
    await f.ui.enter(); f.get("registration-privacy").checked = true;
    f.get("registration-privacy").listeners.change(); await Promise.resolve();
    f.get("registration-email").value = "fixture@example.invalid";
    await f.get("registration-send").listeners.click();
    f.get("registration-code").value = "12345678";
    f.get("registration-password").value = f.get("registration-password-confirm").value = "isolated fixture password";
    const work = f.get("registration-form").listeners.submit({ preventDefault() {} });
    assert.equal(f.generation(), 1); f.ui.clear(); await f.submit();
    if (outcome === "success") pending.resolve({ actor: { id: "old-verification" } }); else pending.reject({ code: "registration_invalid" });
    await work;
    assert.deepEqual(f.completed, [{ actor: { id: "new-login" } }]);
    assert.equal(f.get("registration-error").textContent, "");
    assert.equal(f.get("email-login-form-submit").disabled, false);
  });
}


for (const outcome of ["success", "failure"]) {
  test(`cleared password recovery ignores stale ${outcome} and never enters the workspace`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred();
    const original = Object.getOwnPropertyDescriptor(globalThis, "turnstile");
    globalThis.turnstile = { render: (_node, options) => { assert.equal(options.action, "gt_password_reset"); options.callback("isolated-challenge"); return "widget"; }, reset() {}, remove() {} };
    t.after(() => { if (original) Object.defineProperty(globalThis, "turnstile", original); else delete globalThis.turnstile; });
    const f = fixture({ passwordResetStatus: async () => ({ enabled: true }),
      sendPasswordReset: async () => ({ reset_id: "isolated-reset", resend_after_seconds: 60 }),
      verifyPasswordReset: (input) => { assert.equal(input.reset_id, "isolated-reset"); assert.equal(input.password, input.password_confirmation); assert.equal(f.generation(), 1); return pending.promise; } }, true);
    await f.ui.enter(); f.get("password-reset-privacy").checked = true;
    f.get("password-reset-privacy").listeners.change(); await Promise.resolve();
    f.get("password-reset-email").value = "fixture@example.invalid";
    await f.get("password-reset-send").listeners.click();
    f.get("password-reset-code").value = "12345678";
    f.get("password-reset-password").value = f.get("password-reset-password-confirm").value = "isolated replacement password";
    const work = f.get("password-reset-form").listeners.submit({ preventDefault() {} });
    f.ui.clear();
    if (outcome === "success") pending.resolve({ reset: true }); else pending.reject({ code: "registration_invalid" });
    await work; assert.deepEqual(f.completed, []); assert.equal(f.get("password-reset-error").textContent, "");
  });
}

test("password recovery stays disabled when unavailable and invalidates its receipt on email editing", async () => {
  const f = fixture({ passwordResetStatus: async () => ({ enabled: false }) }, true);
  await f.ui.enter();
  assert.equal(f.get("password-reset-send").disabled, true);
  assert.equal(f.get("password-reset-status").textContent, "Password recovery is temporarily unavailable.");
  f.get("password-reset-code").value = "12345678";
  f.get("password-reset-email").listeners.input();
  assert.equal(f.get("password-reset-code").value, ""); assert.equal(f.get("password-reset-code-step").hidden, true);
});
