// Transient registration state only. Never persist email, OTP, challenge or device credentials.
export function registrationError(error) {
  const messages = {
    registration_unavailable: "Email registration is temporarily unavailable.",
    registration_delivery: "The email could not be sent. Wait a minute and try again.",
    registration_invalid: "The code is incorrect or unavailable. Request a new code.",
    registration_limited: "Too many registration attempts. Please try later.",
    registration_challenge: "Complete the security check and try again.",
    email_login_invalid: "Email or password is incorrect.",
    password_busy: "Sign-in is busy. Please try again.",
    registration_browser: "Open registration in this browser and try again.",
    validation_error: "Check your email, names and eight-digit code.",
  };
  return messages[error?.code] ?? "Registration could not be completed. Please try again.";
}

export function mountRegistration({ document, api, localizer, identity, complete, busy }) {
  const get = (id) => document.getElementById(id);
  const form = get("registration-form");
  const send = get("registration-send");
  const verify = get("registration-verify");
  const error = get("registration-error");
  const status = get("registration-status");
  let config = null;
  let registrationId = null;
  let challenge = "";
  let widget = null;
  let generation = 0;
  let working = false;
  let resendAt = 0;
  let retryKey = null;
  let scriptPromise;
  const tell = (node, text) => { node.textContent = localizer.t(text); };
  const update = () => {
    send.disabled = working || !config?.enabled || !challenge || !get("registration-privacy").checked || Date.now() < resendAt;
    verify.disabled = working || !registrationId || !get("registration-privacy").checked;
    get("registration-email").readOnly = working;
  };
  const loadScript = () => {
    if (globalThis.turnstile) return Promise.resolve(globalThis.turnstile);
    if (!scriptPromise) scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.referrerPolicy = "no-referrer";
      const fail = () => { clearTimeout(timeout); script.remove(); reject(new Error("challenge unavailable")); };
      const timeout = setTimeout(fail, 15_000);
      script.onload = () => { clearTimeout(timeout); if (globalThis.turnstile?.render) resolve(globalThis.turnstile); else fail(); };
      script.onerror = fail;
      document.head.append(script);
    }).catch((reason) => { scriptPromise = null; throw reason; });
    return scriptPromise;
  };
  const renderChallenge = async () => {
    if (!config?.enabled || !get("registration-privacy").checked || widget !== null) return;
    const run = generation;
    tell(status, "Loading security check…");
    try {
      const turnstile = await loadScript();
      if (run !== generation || !get("registration-privacy").checked || widget !== null) return;
      widget = turnstile.render(get("registration-challenge"), {
        sitekey: config.site_key, action: "gt_register", cData: config.challenge_binding,
        size: "compact",
        language: document.documentElement.lang === "zh-CN" ? "zh-cn" : "en",
        "response-field": false,
        callback: (token) => { if (run !== generation) return; challenge = token; status.textContent = ""; update(); },
        "expired-callback": () => { challenge = ""; update(); },
        "error-callback": () => { challenge = ""; tell(error, "Security check unavailable. Retry or return to sign-in."); update(); },
      });
    } catch { if (run === generation) tell(error, "Security check unavailable. Retry or return to sign-in."); }
  };
  const resetChallenge = () => {
    challenge = "";
    if (widget !== null) globalThis.turnstile?.reset(widget);
    update();
  };
  const clear = () => {
    ++generation;
    if (widget !== null) globalThis.turnstile?.remove(widget);
    widget = null; challenge = ""; registrationId = null; retryKey = null; config = null; resendAt = 0;
    form.reset(); get("registration-code-step").hidden = true;
    error.textContent = ""; status.textContent = ""; update();
  };
  const enter = async () => {
    clear();
    const run = generation;
    tell(status, "Checking registration availability…");
    try {
      const nextConfig = await api.registrationStatus();
      if (run !== generation) return;
      config = nextConfig;
      tell(status, config.enabled ? "Enter your email to create a new account." : "Email registration is temporarily unavailable.");
      update();
    } catch { if (run === generation) tell(status, "Email registration is temporarily unavailable."); }
  };
  get("registration-privacy").addEventListener("change", () => {
    if (!get("registration-privacy").checked) {
      if (widget !== null) globalThis.turnstile?.remove(widget);
      widget = null; challenge = ""; update();
    } else { update(); void renderChallenge(); }
  });
  get("registration-challenge-retry").addEventListener("click", () => {
    if (widget !== null) globalThis.turnstile?.remove(widget);
    widget = null; challenge = ""; void renderChallenge();
  });
  send.addEventListener("click", async () => {
    if (working || send.disabled) return;
    const email = get("registration-email");
    if (!email.checkValidity() || !email.value.trim()) { tell(error, "Enter a valid email address."); email.focus(); return; }
    const run = generation;
    working = true; busy(true); error.textContent = ""; update();
    retryKey ??= globalThis.crypto.randomUUID();
    try {
      const result = await api.sendRegistration({ email: email.value, challenge_token: challenge,
        locale: document.documentElement.lang === "zh-CN" ? "zh-CN" : "en", idempotency_key: retryKey });
      if (run !== generation) return;
      registrationId = result.registration_id;
      get("registration-code-step").hidden = false;
      tell(status, "Check your inbox or spam folder. Use the latest code within 10 minutes. Resend after 60 seconds.");
      resendAt = Date.now() + result.resend_after_seconds * 1000;
      retryKey = null;
      get("registration-code").focus();
      setTimeout(() => { if (run === generation) update(); }, result.resend_after_seconds * 1000);
    } catch (reason) {
      if (run !== generation) return;
      tell(error, registrationError(reason));
      // After a known HTTP failure use a new reservation only following server cooldown.
      if (reason?.status) retryKey = null;
    } finally {
      working = false; busy(false); if (run === generation) resetChallenge();
    }
  });
  get("registration-email").addEventListener("input", () => {
    registrationId = null; retryKey = null; get("registration-code").value = "";
    get("registration-code-step").hidden = true; update();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (working) return;
    if (!registrationId) { if (!send.disabled) send.click(); return; }
    if (!get("registration-privacy").checked) return;
    const code = get("registration-code");
    if (!/^\d{8}$/.test(code.value)) { tell(error, "Enter the eight-digit email code."); code.focus(); return; }
    const password = get("registration-password");
    if (password.value.length < 12 || password.value.length > 128 || password.value !== get("registration-password-confirm").value) {
      tell(error, "Use 12–128 characters and make sure both passwords match."); password.focus(); return;
    }
    const run = generation;
    working = true; busy(true); error.textContent = ""; update();
    try {
      const profile = identity();
      const result = await api.verifyRegistration({ registration_id: registrationId, code: code.value,
        display_name: profile.displayName, device_name: profile.deviceName,
        remember_device: get("registration-remember").checked, privacy_acknowledged: true, password: password.value });
      if (run !== generation) return;
      code.value = ""; password.value = ""; get("registration-password-confirm").value = ""; get("registration-email").value = ""; registrationId = null;
      await complete(result);
    } catch (reason) { if (run === generation) tell(error, registrationError(reason)); }
    finally { working = false; busy(false); code.value = ""; password.value = ""; get("registration-password-confirm").value = ""; update(); }
  });
  const loginForm = get("email-login-form");
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (working) return;
    const email = get("email-login-email");
    const password = get("email-login-password");
    const errorNode = get("email-login-error");
    if (!email.checkValidity() || !email.value.trim() || password.value.length < 12) {
      tell(errorNode, "Check your email and password."); return;
    }
    const run = generation;
    working = true; busy(true);
    const submit = loginForm.querySelector("button[type=submit]"); submit.disabled = true;
    try {
      await api.prepareEmailLogin();
      const profile = identity();
      const result = await api.loginWithEmail({ email: email.value, password: password.value,
        device_name: profile.deviceName, remember_device: get("email-login-remember").checked });
      if (run !== generation) return;
      loginForm.reset(); await complete(result);
    } catch (reason) { if (run === generation) tell(errorNode, registrationError(reason)); }
    finally { password.value = ""; working = false; busy(false); submit.disabled = false; }
  });
  const clearAll = () => { clear(); loginForm.reset(); get("email-login-error").textContent = ""; };
  return { enter, clear: clearAll };
}
