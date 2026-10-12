// Cookie-authenticated API settings + ordinary pointer checks. Synthetic keys,
// isolated in-memory accounts and a controlled executor; no real provider calls.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const directory = mkdtempSync(join(tmpdir(), "gt-personal-api-browser-"));
const reserve = createServer(); await new Promise(done => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port; await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`, mails = [];
let failNextCloudRun = false;
const registration = { enabled: true, origin, siteKey: "fixture", challenge: { async verify() { return true; } },
  mailer: { async send(mail) { mails.push(mail); } } };
const server = await startCollaborationServer({ databasePath: ":memory:", codeRepositoryDirectory: join(directory, "code"),
  authTokenPepper: randomBytes(32).toString("hex"), registration, staticDirectory: resolve("apps/web/dist"),
  publicBaseUrl: origin, allowedOrigins: [origin], hostedAgent: {
    personalApiEncryptionKey: randomBytes(32).toString("base64"), endpoints: [{ id: "fixture", profileId: "fixture-service",
      label: "Service fixture", provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1",
      apiToken: "fixture-k", quotaGroup: "fixture", dailyRuns: 4, maxConcurrent: 1 }],
    image: `fixture/cloud@sha256:${"a".repeat(64)}`, userMinIntervalSeconds: 1,
    userDailyRuns: 4, globalDailyRuns: 20, maxConcurrent: 1,
    fetch: async () => { throw Error("Live providers are forbidden in this fixture"); },
    runContainer: async () => {
      if (failNextCloudRun) { failNextCloudRun = false; throw Error("fixture_run_failed"); }
      return JSON.stringify({ answer: "Selected personal model answered.", files: [] });
    },
  } }, port);
async function seed(context, locale) {
  const marker = randomUUID();
  const sent = await server.database.registration.send({ email: `${randomUUID()}@example.invalid`, locale: "en",
    challenge_token: randomUUID(), idempotency_key: randomUUID() }, marker, randomUUID(), registration);
  const identity = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id, code: mails.at(-1).code,
    display_name: "API tester", device_name: "Browser fixture", remember_device: false,
    password: randomBytes(24).toString("hex"), privacy_acknowledged: true }, marker, randomUUID(), registration);
  const actor = identity.actor, project = server.service.createProject(actor, { title: "API fixture", idempotency_key: randomUUID() });
  const session = server.service.createSession(actor, { project_id: project.id, title: "Personal model", mode: "multi", idempotency_key: randomUUID() }).session;
  const cookie = server.database.createBrowserSession(actor);
  await context.addCookies([{ name: "gatherthread_session", value: cookie.token, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await context.addInitScript(locale => {
    localStorage.setItem("gt-lang", locale === "zh" ? "zh" : "en");
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) { return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : read.call(this, key); };
  }, locale);
  return { actor, project, session };
}
try {
  for (const [name, engine, locale, viewport, mobile] of [
    ["chrome-desktop", chromium, "zh", { width: 1440, height: 800 }, false],
    ["webkit-phone", webkit, "en", { width: 390, height: 844 }, true],
    ["chrome-tablet", chromium, "en", { width: 1024, height: 768 }, true],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce",
      ...(mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
    const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    await context.route(/^https?:/, route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const f = await seed(context, locale);
    const openSettings = async () => { if (mobile) await page.locator("#mobile-tools-button").click(); await page.locator("#settings-button").click(); };
    try {
      await page.goto(`${origin}/app/#project=${f.project.id}&session=${f.session.id}`);
      await page.locator("#code-notice-dialog[open]").waitFor(); await page.locator("#code-notice-continue").click();
      await page.locator("#session-view:not([hidden])").waitFor(); await openSettings();
      await page.locator('.settings-navigation a[href="#settings-personal-api"]').click();
      await page.locator("#cloud-api-new").click();
      await page.locator("#cloud-api-provider").selectOption("deepseek");
      await page.locator("#cloud-api-label").fill("Fixture personal model");
      await page.locator("#cloud-api-model").fill("deepseek-chat");
      await page.locator("#cloud-api-key").fill("fixture-k");
      const saved = page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("/v1/cloud-api/"));
      await page.locator("#cloud-api-save").click(); assert.equal((await saved).status(), 200);
      await page.locator("#cloud-api-editor").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#cloud-api-key").inputValue(), "");
      assert.doesNotMatch(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })), /fixture-k/);
      const stored = await context.request.get(`${origin}/v1/cloud-api`), metadata = (await stored.json()).data;
      assert.doesNotMatch(JSON.stringify(metadata), /fixture-k|api_key|ciphertext/);
      const config = metadata.configurations[0]; assert.equal(config.label, "Fixture personal model");
      await page.locator("#cloud-api-list button").click(); assert.equal(await page.locator("#cloud-api-key").inputValue(), "");
      await page.locator("#cloud-api-provider").selectOption("openai"); await page.locator("#cloud-api-save").click();
      assert.match(await page.locator("#cloud-api-status").textContent(), /新密钥|new API key/);
      await page.locator("#cloud-api-provider").selectOption("deepseek"); await page.locator("#cloud-api-cancel").click();
      await page.locator('.settings-navigation a[href="#settings-agents"]').click();
      await page.locator("#settings-enabled-cloud").check(); await page.locator("#settings-form button[type=submit]").click();
      await page.locator("#settings-dialog").waitFor({ state: "hidden" });
      await page.locator("#mobile-agent-button").click(); await page.locator("#agent-harness-select").selectOption("cloud");
      await page.locator("#agent-cloud-model-select").selectOption(config.profile_id);
      await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
      await page.locator("#message-input").fill("Answer this small question.");
      const requested = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
      await page.locator("#send-agent-button").click(); const accepted = await requested;
      assert.equal(accepted.status(), 202); assert.equal(accepted.request().postDataJSON().api_config_revision, config.revision);
      await page.getByText("Selected personal model answered.", { exact: true }).waitFor();
      // Sensors wrap the real HTTP methods, not UI handlers or network results.
      await page.evaluate(async () => {
        const bootstrapUrl = document.querySelector('script[type="module"]').src;
        const bootstrap = await (await fetch(bootstrapUrl)).text();
        const mainUrl = new URL(bootstrap.match(/import\("([^\"]*main\.js[^\"]*)"\)/)[1], bootstrapUrl).href;
        const main = await (await fetch(mainUrl)).text();
        const apiUrl = new URL(main.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)[1], mainUrl).href;
        const { HttpCollaborationApi } = await import(apiUrl);
        const selection = HttpCollaborationApi.prototype.getHostedAgentSelection;
        const append = HttpCollaborationApi.prototype.appendHostedAgentRequest;
        window.fixtureSelectionSettled = 0; window.fixtureHostedWrites = [];
        HttpCollaborationApi.prototype.getHostedAgentSelection = async function (...args) {
          try { return await selection.apply(this, args); }
          finally { window.fixtureSelectionSettled++; }
        };
        HttpCollaborationApi.prototype.appendHostedAgentRequest = function (...args) {
          window.fixtureHostedWrites.push(structuredClone(args[1]));
          return append.apply(this, args);
        };
      });
      const cloudReady = async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const response = await context.request.get(`${origin}/v1/hosted-agent`, { headers: { "Cache-Control": "no-store" } });
          assert.equal(response.status(), 200);
          const status = (await response.json()).data;
          if (status.profiles?.find(profile => profile.id === config.profile_id)?.available) return;
          if (status.rate_limits.retry_after_seconds > 0) {
            // Honor the real server's rate-limit deadline, not an arbitrary UI delay.
            await new Promise(done => setTimeout(done, status.rate_limits.retry_after_seconds * 1000));
          } else await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        throw Error("Actual Cloud Agent availability did not settle within 10 seconds");
      };
      const failedCloudRequest = async content => {
        await cloudReady();
        failNextCloudRun = true;
        await page.locator("#message-input").fill(content);
        const reply = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
        await page.locator("#send-agent-button").click();
        const response = await reply; assert.equal(response.status(), 202);
        const request = (await response.json()).data.request_event;
        await page.locator(`.agent-retry-button[data-request-id="${request.id}"]`).waitFor();
        return request;
      };
      const erased = await failedCloudRequest("ERASED_RETRY_INSTRUCTIONS fixture");
      const selectionUrl = `${origin}/v1/sessions/${f.session.id}/hosted-agent-requests/${erased.id}/selection`;
      let release, entered;
      const held = new Promise(done => { release = done; }), captured = new Promise(done => { entered = done; });
      await page.route(selectionUrl, async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200);
        entered(); await held; await route.fulfill({ response });
      });
      await page.locator("#message-input").fill("Keep this unfinished retry draft");
      await page.evaluate(() => { window.fixtureHostedWrites = []; });
      await cloudReady();
      await page.locator(`.agent-retry-button[data-request-id="${erased.id}"]`).click();
      await captured;
      await page.locator(`#message-${erased.id} .message-delete-action`).click();
      await page.locator(`#message-${erased.id} .event-content`).getByText(/消息已删除|Message deleted/, { exact: true }).waitFor();
      release();
      await page.waitForFunction(() => window.fixtureSelectionSettled === 1);
      assert.deepEqual(await page.evaluate(() => window.fixtureHostedWrites), [], "a held selection cannot resubmit erased instructions");
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this unfinished retry draft");
      await page.unroute(selectionUrl);

      // A fresh retry after deletion remains usable and pins the current history.
      const valid = await failedCloudRequest("A fresh, independent retry after deletion");
      await page.locator("#message-input").fill("Keep this new retry draft");
      await page.evaluate(() => { window.fixtureHostedWrites = []; });
      await cloudReady();
      assert.equal(server.database.hostedAgentRateUsage(f.actor, 1).retry_after_seconds, 0, "actual ledger is ready before the retry click");
      const retried = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
      await page.locator(`.agent-retry-button[data-request-id="${valid.id}"]`).click();
      const retryResponse = await retried; assert.equal(retryResponse.status(), 202,
        retryResponse.ok() ? "Accepted retry" : JSON.stringify({ response: await retryResponse.json(),
          writes: await page.evaluate(() => window.fixtureHostedWrites.map(input => ({ idempotencyKey: input.idempotencyKey, contentRevision: input.contentRevision }))),
          ledger: server.database.hostedAgentRateUsage(f.actor, 1) }));
      assert.equal(retryResponse.request().postDataJSON().content_revision, 1);
      assert.equal(retryResponse.request().postDataJSON().api_config_revision, config.revision);
      await page.getByText("Selected personal model answered.", { exact: true }).last().waitFor();
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this new retry draft");
      await openSettings(); await page.locator('.settings-navigation a[href="#settings-personal-api"]').click();
      await page.locator("#cloud-api-list button").click(); await page.locator("#cloud-api-enabled").uncheck();
      const paused = page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("/v1/cloud-api/"));
      await page.locator("#cloud-api-save").click(); assert.equal((await paused).status(), 200);
      await page.locator("#cloud-api-editor").waitFor({ state: "hidden" }); await page.locator("#cloud-api-list button").click();
      const deleted = page.waitForResponse(r => r.request().method() === "DELETE" && r.url().includes("/v1/cloud-api/"));
      await page.locator("#cloud-api-delete").click(); assert.equal((await deleted).status(), 204);
      await page.locator("#cloud-api-editor").waitFor({ state: "hidden" }); assert.equal(await page.locator("#cloud-api-list li").count(), 0);
      assert.equal(await page.locator("#settings-dialog").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      assert.deepEqual(errors, []); console.log(`${name}: private API, exact cloud model, held-selection deletion fence, normal revision-pinned retry and drafts, pause/delete; ordinary clicks passed`);
    } finally { await context.close(); await browser.close(); }
  }
} finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
