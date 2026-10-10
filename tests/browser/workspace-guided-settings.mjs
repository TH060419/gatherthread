// Real pointer paths with isolated identities and fake model/GitHub boundaries.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import { TestGateStore } from "../../apps/server/dist/src/test-gate.js";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const reserve = createServer(); await new Promise(r => reserve.listen(0, "127.0.0.1", r));
const port = reserve.address().port; await new Promise(r => reserve.close(r));
const origin = `http://127.0.0.1:${port}`;
const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-guided-gate-")));
const gate = { databasePath: join(directory, "admission.sqlite"), origin, pepper: randomBytes(32).toString("hex") };
const gateAdmin = new TestGateStore(gate);
let releaseRun;
const mails = [];
const registration = { enabled: true, origin, siteKey: "fixture", challenge: { async verify() { return true; } },
  mailer: { async send(mail) { mails.push(mail); } } };
const server = await startCollaborationServer({ databasePath: ":memory:", authTokenPepper: randomBytes(32).toString("hex"),
  registration,
  testGate: gate,
  staticDirectory: resolve("apps/web/dist"), publicBaseUrl: origin, allowedOrigins: [origin],
  hostedAgent: { endpoints: [{ id: "fake", profileId: "free", label: "Free model", provider: "openai-compatible", model: "free-model",
    baseUrl: "https://api.example.invalid/v1", apiToken: "test-only-model", quotaGroup: "fake", dailyRuns: 100, maxConcurrent: 2 }],
    image: `sha256:${"a".repeat(64)}`, userDailyRuns: 5, globalDailyRuns: 100, maxConcurrent: 2,
    runContainer: () => new Promise(r => { releaseRun = () => r(JSON.stringify({ answer: "Fixture answer", files: [], save_error: null })); }) },
}, port);
const output = resolve("output/playwright/guided-settings"); mkdirSync(output, { recursive: true });
let scenarios = 0;
try {
 for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch({ headless: true, ...(engineName === "chromium" ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? engine.executablePath() } : {}) });
  try {
   for (const [locale, width, height, mobile] of [["zh-CN", 1440, 900, false], ["en", 1280, 600, false], ["en", 390, 844, false], ["zh-CN", 390, 844, true], ["en", 820, 1180, true]]) {
    const marker = randomUUID(), email = `${randomUUID()}@example.invalid`;
    const pending = await server.database.registration.send({ email, locale, challenge_token: randomUUID(), idempotency_key: randomUUID() }, marker, randomUUID(), registration);
    const identity = await server.database.verifyPublicRegistration({ registration_id: pending.registration_id, code: mails.at(-1).code,
      display_name: "UI tester", device_name: "Browser", password: randomUUID(), remember_device: false, privacy_acknowledged: true }, marker, randomUUID(), registration);
    const issue = identity.browser_session;
    const project = server.service.createProject(identity.actor, { title: "UI fixture", idempotency_key: randomUUID() });
    const { session } = server.service.createSession(identity.actor, { project_id: project.id, title: "UI conversation", mode: "multi", idempotency_key: randomUUID() });
    const context = await browser.newContext({ viewport: { width, height }, locale, hasTouch: mobile, isMobile: mobile,
      ...(mobile ? { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1" } : {}), reducedMotion: "reduce" });
    await context.addCookies([{ name: "gatherthread_session", value: issue.token, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const admission = gateAdmin.issue(1, 1)[0];
    assert.equal((await context.request.post(`${origin}/v1/test-gate`, { headers: { origin }, data: { admission_code: admission.admission_code } })).status(), 200);
    await context.addInitScript(locale => {
      localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
      localStorage.setItem("gatherthread.settings.v1", JSON.stringify({ version: 12, agents: { activeHarness: "cloud", enabledHarnesses: ["cloud", "codex"] } }));
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) { return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : read.call(this, key); };
      window.authFlashed = false;
      const watch = () => { const auth = document.getElementById("auth-view"); if (auth && auth.getClientRects().length && getComputedStyle(auth).display !== "none") window.authFlashed = true; };
      new MutationObserver(watch).observe(document, { subtree: true, attributes: true, childList: true });
    }, locale);
    const page = await context.newPage(); const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.route("**/bootstrap.js*", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("} catch {", "} catch (error) { window.fixtureBootError = error.message;") });
    });
    await page.route("**/v1/me", async route => { await new Promise(r => setTimeout(r, 250)); await route.continue(); });
    let github = { enabled: true, connected: false, login: null, binding: null, installation_url: "https://github.com/apps/fixture/installations/new" };
    await page.route("**/hosted-github", route => route.fulfill({ json: { data: github } }));
    await page.route("**/hosted-github/tasks", route => route.fulfill({ json: { data: { tasks: [] } } }));
    await page.route("**/hosted-github/repository", async route => {
      const input = route.request().postDataJSON();
      assert.deepEqual(input, { repository: "fixture/my-project", base_branch: "main" });
      github = { ...github, binding: input };
      await route.fulfill({ json: { data: github } });
    });
    try {
      await page.goto(`${origin}/app/#project=${project.id}&session=${session.id}`);
      await page.waitForFunction(() => document.documentElement.dataset.bootState !== "loading");
      assert.equal(await page.evaluate(() => window.fixtureBootError), undefined, "module initialization succeeded");
      await page.locator("#workspace").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => window.authFlashed), false);
      await page.locator("#code-notice-continue").click();
      await page.locator("#session-view:not([hidden])").waitFor();
      await page.waitForFunction(() => document.getElementById("agent-harness-select").value === "cloud" && !document.getElementById("send-agent-button").disabled);
      for (const id of ["mobile-agent-button", "send-chat-button", "send-agent-button"]) {
        const box = await page.locator(`#${id}`).boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= height, `${id} remains reachable at ${width}x${height}: ${JSON.stringify(box)}`);
      }
      await page.locator("#mobile-agent-button").click();
      await page.locator("#cloud-agent-source").selectOption("trial");
      assert.equal(await page.locator("#agent-cloud-model-select").isVisible(), true);
      await page.screenshot({ path: resolve(output, `${engineName}-${locale}-${width}-agent.png`) });
      await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
      await page.screenshot({ path: resolve(output, `${engineName}-${locale}-${width}-composer.png`) });
      await page.locator("#message-input").fill("A synthetic question"); await page.locator("#send-agent-button").click();
      await page.locator(".agent-pending-status").filter({ hasText: locale === "zh-CN" ? "云端 Agent 正在处理" : "Cloud Agent is working" }).waitFor();
      assert.doesNotMatch(await page.locator(".agent-pending-status").textContent(), /local runtime/);
      releaseRun(); await page.getByText("Fixture answer", { exact: true }).waitFor();
      if (mobile) { await page.locator("#mobile-tools-button").click(); }
      await page.locator("#project-code-button").click(); await page.locator("#code-provider-github").click();
      await page.locator("#cloud-github-authorize").waitFor({ state: "visible" });
      assert.equal(await page.locator("#cloud-github-repository-form").isVisible(), false);
      github = { ...github, connected: true, login: "fixture" };
      await page.locator("#code-provider-gt-cloud").click(); await page.locator("#code-provider-github").click();
      await page.locator("#cloud-github-owner").waitFor({ state: "visible" });
      assert.equal(await page.locator("#cloud-github-owner").inputValue(), "fixture");
      await page.locator("#cloud-github-name").fill("my-project");
      assert.equal(await page.locator("#cloud-github-create").getAttribute("href"), "https://github.com/new?name=my-project");
      assert.equal(await page.locator("#github-cloud-home").isVisible(), false);
      await page.locator("#cloud-github-repository-form button[type=submit]").click();
      await page.locator("#github-cloud-home").waitFor({ state: "visible" });
      assert.equal(await page.locator("#cloud-github-repository-form").isVisible(), false);
      await page.locator("#cloud-github-edit").click();
      assert.equal(await page.locator("#cloud-github-name").inputValue(), "my-project");
      await page.locator("#cloud-github-back").click();
      await page.locator("#github-cloud-home").waitFor({ state: "visible" });
      await page.locator("#cloud-github-account-settings").click();
      await page.locator("#github-cloud-account").waitFor({ state: "visible" });
      assert.equal(await page.locator("#github-cloud-home").isVisible(), false);
      await page.locator("#github-mode-local").click();
      await page.locator("#github-code-owner").fill("team"); await page.locator("#github-code-name").fill("project");
      assert.equal(await page.locator("#github-code-repository").inputValue(), "team/project");
      assert.equal(await page.locator("#cloud-github-authorize").isVisible(), false);
      await page.screenshot({ path: resolve(output, `${engineName}-${locale}-${width}-github.png`) });
      await page.locator("#github-code-save").click();
      await page.locator("#code-confirm-accept").click();
      await page.locator("#github-code-device").waitFor({ state: "visible" });
      assert.match(await page.locator("#github-code-status").textContent(), locale === "zh-CN" ? /仓库已保存/ : /Repository saved/);
      assert.equal(await page.locator("#github-code-form").isVisible(), false);
      assert.equal(await page.locator("#github-code-auth").isDisabled(), true, "missing computer never grants local authorization");
      await page.locator("#github-code-ready").click();
      await page.locator("#github-local-home").waitFor({ state: "visible" });
      assert.equal(await page.locator("#github-code-upload").isDisabled(), true);
      await page.locator("#github-code-edit").click();
      assert.equal(await page.locator("#github-code-owner").inputValue(), "team");
      assert.equal(await page.locator("#github-code-name").inputValue(), "project");
      await page.locator("#github-code-back").click();
      await page.locator("#github-local-home").waitFor({ state: "visible" });
      await page.locator("#close-project-code-button").click();
      await page.reload(); await page.locator("#workspace").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => window.authFlashed), false, "reload never flashes login");
      assert.deepEqual(errors, []); scenarios++;
    } finally { releaseRun?.(); await context.close(); }
   }
  } finally { await browser.close(); }
 }
 console.log(`GUIDED_SETTINGS_POINTER_FLOWS=${scenarios} PASS`);
} finally { await server.close(); gateAdmin.close(); rmSync(directory, { recursive: true, force: true }); }
