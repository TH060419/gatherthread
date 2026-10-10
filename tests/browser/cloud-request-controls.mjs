// Real HTTP, Cookie auth, WebSocket replay and ordinary pointer clicks.
// Containers/providers are controlled fixtures; no live API or GitHub calls.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const directory = mkdtempSync(join(tmpdir(), "gt-browser-cloud-"));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const mails = [], jobs = [];
const endpoint = { id: "fixture", profileId: "sf-qwen35-4b", label: "Qwen3.5-4B", provider: "openai-compatible",
  model: "Qwen/Qwen3.5-4B", baseUrl: "https://api.siliconflow.cn/v1", apiToken: "not-a-real-key",
  quotaGroup: "fixture", dailyRuns: null, maxConcurrent: 1 };
const registration = { enabled: true, origin, siteKey: "fixture",
  challenge: { async verify() { return true; } }, mailer: { async send(mail) { mails.push(mail); } } };
const server = await startCollaborationServer({ databasePath: ":memory:", codeRepositoryDirectory: join(directory, "code"),
  authTokenPepper: randomBytes(32).toString("hex"), registration, staticDirectory: resolve("apps/web/dist"), publicBaseUrl: origin, allowedOrigins: [origin],
  hostedAgent: { endpoints: [endpoint], image: `fixture@sha256:${"a".repeat(64)}`,
    userDailyRuns: null, globalDailyRuns: null, maxConcurrent: 1, userMinIntervalSeconds: 1,
    fetch: async () => { throw new Error("Live model calls are forbidden in this fixture"); },
    runContainer: async (args, _timeout, signal) => {
      const control = args.find(value => value.endsWith("dst=/run/gatherthread,readonly")).split("src=")[1].split(",dst=")[0];
      const config = JSON.parse(readFileSync(join(control, "opencode.json"), "utf8"));
      if (config.permission.bash === "deny") return JSON.stringify({ answer: "Fixture shared cloud summary.", files: [] });
      return new Promise((resolveJob, reject) => {
        jobs.push({ resolve: resolveJob, signal });
        signal.addEventListener("abort", () => reject(new Error("container_interrupted")), { once: true });
      });
    } },
}, port);
let scenarios = 0;

async function seed(context, locale) {
  const marker = randomUUID();
  const sent = await server.database.registration.send({ email: `${randomUUID()}@example.invalid`, locale: "en",
    challenge_token: randomUUID(), idempotency_key: randomUUID() }, marker, randomUUID(), registration);
  const identity = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id, code: mails.at(-1).code,
    display_name: "Cloud tester", device_name: "Browser fixture", remember_device: false,
    password: randomBytes(24).toString("hex"), privacy_acknowledged: true }, marker, randomUUID(), registration);
  const actor = identity.actor;
  const project = server.service.createProject(actor, { title: "Cloud fixture", idempotency_key: randomUUID() });
  const session = server.service.createSession(actor, { project_id: project.id, title: "Without a local Agent",
    mode: "multi", idempotency_key: randomUUID() }).session;
  const source = server.service.appendEvent(actor, session.id, { type: "human_chat", visibility: "session",
    idempotency_key: randomUUID(), payload: { content: "A public source message for the shared summary." } });
  const reservation = server.service.reserveHostedAgentRequest(actor, session.id, { profile_id: endpoint.profileId,
    content: "Who are you?", include_code: false, idempotency_key: randomUUID() }, [endpoint],
    { userDailyRuns: null, globalDailyRuns: null, maxConcurrent: 1 });
  server.service.finishHostedAgentRequest(reservation.event.id, { errorCode: "container_failed", providerAttempts: 0 });
  // Fixture time does not gate the first retry; later starts use the actual interval.
  server.database.sqlite.prepare("DELETE FROM hosted_agent_user_activity WHERE user_id=?").run(actor.user_id);
  const cookie = server.database.createBrowserSession(actor);
  await context.addCookies([{ name: "gatherthread_session", value: cookie.token, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await context.addInitScript(locale => {
    localStorage.setItem("gt-lang", locale === "zh" ? "zh" : "en");
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : getItem.call(this, key);
    };
  }, locale);
  return { actor, project, session, source, request: reservation.event };
}

try {
  for (const [name, engine, locale, viewport, mobile] of [
    ["chromium", chromium, "en", { width: 1440, height: 760 }, false],
    ["webkit", webkit, "zh", { width: 1440, height: 760 }, false],
    ["webkit-phone", webkit, "zh", { width: 390, height: 844 }, true],
  ]) {
    const browser = await engine.launch({ headless: true, ...(name === "chromium" && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile,
      ...(mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } : {}), reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route(/^https?:/, route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const f = await seed(context, locale);
    const actionState = action => page.waitForFunction(action => document.querySelector("#send-agent-button").dataset.agentAction === action, action);
    try {
      await page.goto(`${origin}/app/#project=${f.project.id}&session=${f.session.id}`);
      await page.locator("#code-notice-dialog[open]").waitFor(); await page.locator("#code-notice-continue").click();
      await page.locator("#session-view:not([hidden])").waitFor();
      if (mobile) { await page.locator("#mobile-tools-button").click(); }
      await page.locator("#settings-button").click();
      await page.locator("#settings-enabled-dsh").check();
      await page.locator("#settings-enabled-cloud").check();
      await page.locator("#settings-agent-harness").selectOption("deepseek-harness");
      await page.locator("#settings-form button[type=submit]").click();
      await page.locator("#settings-dialog").waitFor({ state: "hidden" });
      // Saving settings must not depend on a connected runtime.
      assert.equal(server.database.listSessionRuntimesForUser(f.session.id, f.actor.user_id).length, 0);
      await page.locator("#mobile-agent-button").click();
      await page.locator("#agent-harness-select").selectOption("cloud");
      await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
      await page.locator("#message-input").fill("An unsent draft stays here.");
      const accepted = page.waitForResponse(response => response.request().method() === "POST"
        && response.url().endsWith("/hosted-agent-requests"));
      await page.locator(`[data-action=retry-agent-request][data-request-id="${f.request.id}"]`).click();
      assert.equal((await accepted).status(), 202);
      await actionState("pause");
      await page.locator("#send-agent-button").click();
      await actionState("resume");
      assert.equal(await page.locator("#message-input").inputValue(), "An unsent draft stays here.");
      await page.waitForFunction(() => document.querySelector("#send-agent-button").disabled === false);
      // The short operator interval is an actual constraint, not a model/UI delay.
      await new Promise(resolve => setTimeout(resolve, 1100));
      const resumed = page.waitForResponse(response => response.request().method() === "POST"
        && response.url().endsWith("/hosted-agent-requests"));
      const previousJobCount = jobs.length;
      await page.locator("#send-agent-button").click(); assert.equal((await resumed).status(), 202);
      await actionState("pause");
      for (let count = 0; jobs.length === previousJobCount && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(jobs.length > previousJobCount);
      jobs.at(-1).resolve(JSON.stringify({ answer: "Fixture completed public answer.", files: [] }));
      await page.getByText("Fixture completed public answer.", { exact: true }).waitFor();
      await actionState("request");
      assert.equal(await page.locator("#message-input").inputValue(), "An unsent draft stays here.");
      const requests = server.service.replay(f.actor, f.session.id, 0, 100).events.filter(event => event.type === "agent_request");
      assert.deepEqual(requests.at(-1).payload.execution_profile, f.request.payload.execution_profile);
      if (mobile) await page.locator("#mobile-tools-button").click();
      await page.locator("#history-summary-select-button").click();
      await page.locator(`.history-source-checkbox[data-source-event-id="${f.source.id}"]`).check();
      await page.locator("#history-summary-generate-button").click();
      assert.match(await page.locator("#history-summary-confirm-warning").textContent(), /cloud model|云端模型/);
      await new Promise(resolve => setTimeout(resolve, 1100));
      const summarized = page.waitForResponse(response => response.request().method() === "POST"
        && response.url().endsWith("/hosted-history-summaries"));
      await page.locator("#history-summary-confirm-button").click(); assert.equal((await summarized).status(), 202);
      await page.getByText("Fixture shared cloud summary.", { exact: true }).waitFor();
      await page.locator(".history-summary-card [data-summary-view-toggle]").click();
      await page.getByText(f.source.payload.content, { exact: true }).waitFor();
      assert.deepEqual(errors, []); scenarios++; console.log(`${name}: retry → pause → resume → reply → cloud summary passed`);
    } finally {
      jobs.forEach(job => job.resolve(JSON.stringify({ answer: "Fixture cleanup", files: [] })));
      await context.close(); await browser.close();
    }
  }
  console.log(`${scenarios} real-pointer cloud-control scenarios passed; no live provider used.`);
} finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
