// Transient registration state only. Never persist email, OTP, challenge or device credentials.
export function registrationError(error) {
  const messages = {
    registration_unavailable: "Email registration is temporarily unavailable.",
    password_reset_unavailable: "Password recovery is temporarily unavailable.",
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

let scriptPromise;
export function mountRegistration({ document, api, localizer, identity, beginAuthentication, complete, busy, passwordReset = false, onReset }) {
  const get = (id) => document.getElementById(passwordReset ? id.replace(/^registration-/, "password-reset-") : id);
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
  const tell = (node, text) => {
    const source = passwordReset ? text.replace("Email registration", "Password recovery").replace("Too many registration attempts", "Too many recovery attempts").replace("Registration could not be completed", "Password could not be reset").replace("Open registration", "Open password recovery").replace("Check your email, names and eight-digit code.", "Check your email, password and eight-digit code.").replace("Sign-in is busy.", "Password service is busy.") : text;
    if (localizer.setText) localizer.setText(node, source);
    else node.textContent = localizer.t(source);
  };
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
        sitekey: config.site_key, action: passwordReset ? "gt_password_reset" : "gt_register", cData: config.challenge_binding,
        size: "compact",
        language: document.documentElement.lang === "zh-CN" ? "zh-cn" : "en",
        "response-field": false,
        callback: (token) => { if (run !== generation) return; challenge = token; status.textContent = ""; update(); },
        "expired-callback": () => { if (run !== generation) return; challenge = ""; update(); },
        "error-callback": () => { if (run !== generation) return; challenge = ""; tell(error, "Security check unavailable. Retry or return to sign-in."); update(); },
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
    working = false; busy(false);
    get("email-login-form").querySelector("button[type=submit]").disabled = false;
    widget = null; challenge = ""; registrationId = null; retryKey = null; config = null; resendAt = 0;
    form.reset(); get("registration-code-step").hidden = true;
    error.textContent = ""; status.textContent = ""; update();
  };
  const enter = async () => {
    clear();
    const run = generation;
    tell(status, passwordReset ? "Checking password recovery availability…" : "Checking registration availability…");
    try {
      const nextConfig = await (passwordReset ? api.passwordResetStatus() : api.registrationStatus());
      if (run !== generation) return;
      config = nextConfig;
      tell(status, config.enabled ? (passwordReset ? "Enter the email address you used to register." : "Enter your email to create a new account.") : "Email registration is temporarily unavailable.");
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
      const result = await (passwordReset ? api.sendPasswordReset.bind(api) : api.sendRegistration.bind(api))({ email: email.value, challenge_token: challenge,
        locale: document.documentElement.lang === "zh-CN" ? "zh-CN" : "en", idempotency_key: retryKey });
      if (run !== generation) return;
      registrationId = passwordReset ? result.reset_id : result.registration_id;
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
      if (run === generation) { working = false; busy(false); resetChallenge(); }
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
    const currentAuthentication = beginAuthentication();
    const isCurrent = () => run === generation && currentAuthentication();
    working = true; busy(true); error.textContent = ""; update();
    try {
      const profile = passwordReset ? null : identity();
      const result = await (passwordReset
        ? api.verifyPasswordReset({ reset_id: registrationId, email: get("registration-email").value, code: code.value,
          password: password.value, password_confirmation: get("registration-password-confirm").value,
          locale: document.documentElement.lang === "zh-CN" ? "zh-CN" : "en" })
        : api.verifyRegistration({ registration_id: registrationId, code: code.value,
          display_name: profile.displayName, device_name: profile.deviceName,
          remember_device: get("registration-remember").checked, privacy_acknowledged: true, password: password.value }));
      if (!isCurrent()) return;
      code.value = ""; password.value = ""; get("registration-password-confirm").value = ""; get("registration-email").value = ""; registrationId = null;
      if (passwordReset) { working = false; busy(false); onReset(); }
      else await complete(result, isCurrent);
    } catch (reason) { if (isCurrent()) tell(error, registrationError(reason)); }
    finally { if (isCurrent()) { working = false; busy(false); code.value = ""; password.value = ""; get("registration-password-confirm").value = ""; update(); } }
  });
  if (passwordReset) return { enter, clear };
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
    const currentAuthentication = beginAuthentication();
    const isCurrent = () => run === generation && currentAuthentication();
    working = true; busy(true); errorNode.textContent = "";
    const submit = loginForm.querySelector("button[type=submit]"); submit.disabled = true;
    try {
      await api.prepareEmailLogin();
      if (!isCurrent()) return;
      const profile = identity();
      const result = await api.loginWithEmail({ email: email.value, password: password.value,
        device_name: profile.deviceName, remember_device: get("email-login-remember").checked });
      if (!isCurrent()) return;
      loginForm.reset(); await complete(result, isCurrent);
    } catch (reason) { if (isCurrent()) tell(errorNode, registrationError(reason)); }
    finally { if (isCurrent()) { password.value = ""; working = false; busy(false); submit.disabled = false; } }
  });
  const clearAll = () => { clear(); loginForm.reset(); get("email-login-error").textContent = ""; };
  return { enter, clear: clearAll };
}
