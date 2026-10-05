// Real loopback HTTP/WebSocket + in-memory identities/runtimes. No model executes.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const reserve = createServer();
await new Promise(done => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port;
await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`;
const mails = [];
const registration = { enabled: true, origin, siteKey: "fixture",
  challenge: { async verify() { return true; } }, mailer: { async send(mail) { mails.push(mail); } } };
const server = await startCollaborationServer({ databasePath: ":memory:",
  authTokenPepper: randomBytes(32).toString("hex"), registration, staticDirectory: resolve("apps/web/dist"),
  publicBaseUrl: origin, allowedOrigins: [origin] }, port);
const output = resolve(process.env.BROWSER_OUTPUT_DIRECTORY ?? "output/playwright/mobile-workspace");
mkdirSync(output, { recursive: true });
const mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
let scenarios = 0;
const runtimes = [];
const heartbeat = setInterval(() => {
  for (const { actor, runtime } of runtimes) server.service.heartbeatRuntime(actor, runtime.id);
}, 1000);

async function seed(locale) {
  const email = `${randomUUID()}@example.invalid`, password = "isolated mobile browser password";
  const marker = randomUUID();
  const sent = await server.database.registration.send({ email, locale: "en", challenge_token: randomUUID(),
    idempotency_key: randomUUID() }, marker, randomUUID(), registration);
  const identity = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id,
    code: mails.at(-1).code, display_name: "Mobile tester", device_name: "Computer fixture",
    remember_device: false, password, privacy_acknowledged: true }, marker, randomUUID(), registration);
  const project = server.service.createProject(identity.actor, { title: "Mobile project", idempotency_key: randomUUID() });
  const { session } = server.service.createSession(identity.actor, { project_id: project.id, title: "A shared conversation",
    mode: "multi", idempotency_key: randomUUID() });
  const teammate = server.database.createIdentity({ display_name: "Teammate", device_name: "Other computer" });
  server.service.setMembership(identity.actor, session.id, teammate.actor.user_id, "participant", randomUUID());
  const source = server.service.appendEvent(teammate.actor, session.id, { type: "human_chat", visibility: "session",
    idempotency_key: randomUUID(), payload: { content: "A source message for quoting and summarizing." } });
  const register = (actor, harness, profiles) => {
    const runtime = server.service.registerRuntime(actor, { session_id: session.id, device_id: actor.device_id, harness,
      provider: profiles[0].provider, model: profiles[0].model, local_session_id: randomUUID(),
      capture_fidelity: "harness_transcript", execution_profiles: profiles });
    runtimes.push({ actor, runtime }); return runtime;
  };
  const codex = register(identity.actor, "codex", [{ provider: "openai", model: "gpt-6-sol", reasoning_efforts: ["low", "high"] }]);
  const dsh = register(identity.actor, "deepseek-harness", [
    { provider: "deepseek-official", model: "deepseek-v4-flash", reasoning_efforts: ["low", "high", "max"] },
    { provider: "deepseek-official", model: "deepseek-v4-pro", reasoning_efforts: ["low", "high"] },
  ]);
  const foreign = register(teammate.actor, "deepseek-harness", [{ provider: "foreign", model: "not-mine" }]);
  return { email, password, identity, project, session, source, codex, dsh, foreign, locale };
}

async function login(page, f) {
  await page.goto(`${origin}/app/#project=${f.project.id}&session=${f.session.id}`);
  await page.locator("#auth-select-email-login").click();
  await page.locator("#email-login-email").fill(f.email);
  await page.locator("#email-login-password").fill(f.password);
  await page.locator("#email-login-form button[type=submit]").click();
  await page.locator("#auth-view").waitFor({ state: "hidden" });
  await page.locator("#code-notice-dialog[open]").waitFor();
  await page.locator("#code-notice-continue").click();
  await page.locator("#session-view:not([hidden])").waitFor();
  await page.getByText(f.source.payload.content, { exact: true }).waitFor();
}

async function tools(page, id) {
  await page.locator("#mobile-tools-button").click();
  await page.locator("#mobile-tools-dialog[open]").waitFor();
  if (id) await page.locator(`#${id}`).click();
}

async function chooseAgent(page, harness, model) {
  await page.locator("#mobile-agent-button").click();
  await page.locator("#mobile-agent-dialog[open]").waitFor();
  await page.locator("#agent-harness-select").selectOption(harness);
  if (harness === "codex") {
    await page.locator("#agent-model-select").selectOption(model);
    await page.locator("#agent-effort-select").selectOption("high");
  } else {
    assert.equal(await page.locator('#agent-dsh-runtime-select option').filter({ hasText: "not-mine" }).count(), 0);
    await page.locator("#agent-dsh-model-select").selectOption(JSON.stringify(["deepseek-official", model]));
    await page.locator("#agent-dsh-effort-select").selectOption("high");
  }
  await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
  await page.waitForFunction(() => document.activeElement?.id === "mobile-agent-button");
}

async function exerciseAgent(page, f, harness, model, runtime) {
  await chooseAgent(page, harness, model);
  const prompt = `Request ${harness}`, draft = `Unsent ${harness}`;
  await page.locator("#message-input").fill(prompt);
  page.once("dialog", dialog => dialog.accept());
  const posted = page.waitForResponse(response => response.request().method() === "POST"
    && response.url() === `${origin}/v1/sessions/${f.session.id}/events`);
  await page.locator("#send-agent-button").click();
  assert.equal((await posted).status(), 201);
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "wait");
  const request = server.service.replay(f.identity.actor, f.session.id, 0, 200).events.filter(event => event.type === "agent_request").at(-1);
  assert.equal(request.payload.execution_profile.runtime_id, runtime.id);
  assert.equal(request.payload.execution_profile.model, model);
  assert.equal(request.payload.execution_profile.reasoning_effort, "high");
  const claim = server.service.claimAgentRequest(f.identity.actor, f.session.id, request.id, runtime.id);
  server.service.appendAgentProgress(f.identity.actor, f.session.id, request.id, runtime.id, randomUUID(),
    { content: "Fixture started", status: "running" }, model, "high", claim.attempt_count);
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "pause");
  await page.locator("#message-input").fill(draft);
  await page.locator("#send-agent-button").click();
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "resume");
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  await chooseAgent(page, harness === "codex" ? "deepseek-harness" : "codex", harness === "codex" ? "deepseek-v4-pro" : "gpt-6-sol");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#send-agent-button").click();
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "wait");
  const resumed = server.service.replay(f.identity.actor, f.session.id, 0, 200).events.filter(event => event.type === "agent_request").at(-1);
  assert.notEqual(resumed.id, request.id);
  assert.deepEqual(resumed.payload.execution_profile, request.payload.execution_profile);
  assert.equal(resumed.payload.content, request.payload.content);
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  const second = server.service.claimAgentRequest(f.identity.actor, f.session.id, resumed.id, runtime.id);
  server.service.completeAgentRequest(f.identity.actor, f.session.id, resumed.id, runtime.id, randomUUID(),
    { text: `Fixture reply ${harness}` }, model, "high", second.attempt_count);
  await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "request");
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  await page.locator("#send-chat-button").click();
  await page.getByText(draft, { exact: true }).waitFor();
}

try {
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch({ headless: true, ...(name === "chromium"
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? engine.executablePath() } : {}) });
    try {
      for (const locale of ["en", "zh-CN"]) {
        const f = await seed(locale), errors = [];
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
          hasTouch: true, userAgent: mobileUA, locale, reducedMotion: "reduce" });
        await context.route(/^https?:/, route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
        await context.addInitScript(locale => {
          localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
          const read = Storage.prototype.getItem;
          Storage.prototype.getItem = function(key) {
            return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : read.call(this, key);
          };
        }, locale);
        const page = await context.newPage();
        page.on("pageerror", error => errors.push(error.message));
        try {
          await login(page, f);
          const me = (await (await context.request.get(origin + "/v1/me")).json()).data;
          assert.equal(me.id, f.identity.actor.user_id);
          assert.notEqual(me.device_id, f.identity.actor.device_id, "computer runtime belongs to another device of the same account");
          assert.equal(await page.locator("#connect-codex-button").isVisible(), false);
          assert.equal(await page.locator("#session-header").count(), 0); // The semantic header is retained, just folded.
          assert.equal(await page.locator(".session-header").isVisible(), false);
          await page.locator("#toggle-session-rail-button").click();
          await page.locator("#mobile-sessions-dialog[open]").waitFor();
          const createProject = await page.locator("#new-project-button").boundingBox();
          const projectSelect = await page.locator("#project-select").boundingBox();
          assert.ok(createProject.y + createProject.height <= projectSelect.y || createProject.x >= projectSelect.x + projectSelect.width,
            `create project does not overlap the project selector: ${JSON.stringify({ createProject, projectSelect })}`);
          assert.equal(await page.locator("#add-agent-button").isVisible(), false);
          assert.equal(await page.locator("#connect-dsh-button").isVisible(), false);
          assert.equal(await page.locator(".mobile-device-note").first().isVisible(), true);
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => document.activeElement?.id === "toggle-session-rail-button");
          await tools(page, "settings-button");
          await page.locator("#settings-dialog[open]").waitFor();
          await page.locator("#settings-enabled-dsh").check();
          await page.locator("#settings-confirm-agent").check();
          await page.locator("#settings-form button[type=submit]").click();
          await exerciseAgent(page, f, "codex", "gpt-6-sol", f.codex);
          await exerciseAgent(page, f, "deepseek-harness", "deepseek-v4-pro", f.dsh);
          // Quotes and @ still use the canonical metadata, not a second mobile implementation.
          const sourceCard = page.locator(".event-card").filter({ hasText: f.source.payload.content });
          await sourceCard.getByRole("button", { name: /Quote message|引用消息/ }).click();
          await page.locator("#message-input").fill("@");
          await page.locator("#mention-picker button").filter({ hasText: "Teammate" }).click();
          await page.locator("#message-input").press("End");
          await page.locator("#message-input").pressSequentially(" quoted response");
          await page.locator("#send-chat-button").click();
          await page.locator("#composer-quote").waitFor({ state: "hidden" });
          const quoted = server.service.replay(f.identity.actor, f.session.id, 0, 200).events.filter(event => event.type === "human_chat").at(-1);
          assert.equal(quoted.reply_to_event_id, f.source.id);
          assert.ok(quoted.payload.mentions.length === 1);
          await tools(page, "mobile-members-button");
          await page.locator("#mobile-members-dialog[open]").waitFor();
          await page.locator("#member-list").getByText("Teammate", { exact: true }).waitFor();
          await page.keyboard.press("Escape");
          await tools(page);
          await page.screenshot({ path: join(output, `${name}-${locale}-tools.png`) });
          await page.locator("#session-context-details > summary").click();
          await page.keyboard.press("Tab");
          assert.equal(await page.locator("#session-context-panel").evaluate(node => node.closest("dialog")?.id), "mobile-tools-dialog");
          assert.equal(await page.locator("#session-context-panel").isVisible(), true);
          await page.locator("#mobile-tools-dialog [data-mobile-close]").click();
          await tools(page, "mentions-button");
          await page.locator("#mentions-dialog[open]").waitFor();
          await page.keyboard.press("Escape");
          // Generation is a normal exact-runtime request; the fixture, not a model, supplies its result.
          await chooseAgent(page, "codex", "gpt-6-sol");
          await tools(page, "history-summary-select-button");
          await page.locator(`.history-source-checkbox[data-source-event-id="${f.source.id}"]`).check();
          await page.locator("#history-summary-generate-button").click();
          const summaryPosted = page.waitForResponse(response => response.request().method() === "POST"
            && response.url() === `${origin}/v1/sessions/${f.session.id}/history-summaries`);
          await page.locator("#history-summary-confirm-button").click();
          const summaryResponse = await summaryPosted;
          assert.equal(summaryResponse.status(), 201);
          const summaryRequest = (await summaryResponse.json()).data.event;
          const summaryClaim = server.service.claimAgentRequest(f.identity.actor, f.session.id, summaryRequest.id, f.codex.id);
          server.service.completeAgentRequest(f.identity.actor, f.session.id, summaryRequest.id, f.codex.id, randomUUID(),
            { text: "Fixture shared summary" }, "gpt-6-sol", "high", summaryClaim.attempt_count);
          await page.getByText("Fixture shared summary", { exact: true }).waitFor();
          await page.locator(".history-summary-card [data-summary-view-toggle]").click();
          await page.getByText(f.source.payload.content, { exact: true }).waitFor();
          await page.locator(".history-summary-card [data-summary-view-toggle]").click();
          await tools(page, "history-summary-view-button");
          await page.getByText(f.source.payload.content, { exact: true }).waitFor();
          await tools(page, "history-summary-view-button");
          await tools(page, "history-summary-versions-button");
          await page.locator("#history-summary-versions-dialog[open]").waitFor();
          await page.keyboard.press("Escape");
          // Draft and native control identity survive mobile/desktop reparenting.
          await page.locator("#message-input").fill("Resize draft");
          await page.evaluate(() => { window.originalProfile = document.querySelector("#agent-request-profile"); });
          for (const [width, height] of [[320, 720], [390, 460], [844, 390], [1440, 900], [390, 844]]) {
            await page.setViewportSize({ width, height });
            await page.waitForFunction(width => document.querySelector("#workspace").dataset.mobileUi === String(width <= 760), width);
            assert.equal(await page.locator("#message-input").inputValue(), "Resize draft");
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${width}: no horizontal overflow`);
            assert.equal(await page.evaluate(() => window.originalProfile === document.querySelector("#agent-request-profile")), true);
            if (width <= 760) {
              await page.waitForFunction(() => Math.abs(document.querySelector('#workspace').getBoundingClientRect().height - visualViewport.height) < 2);
              const bounds = await page.locator("#composer").boundingBox();
              assert.ok(bounds.y + bounds.height <= height + 1, `composer fits ${width}x${height}: ${JSON.stringify(bounds)}`);
              for (const id of ["mobile-compose-tools-button", "mobile-agent-button", "send-chat-button", "send-agent-button"]) {
                const button = await page.locator(`#${id}`).boundingBox();
                assert.ok(button.x >= bounds.x && button.x + button.width <= bounds.x + bounds.width, `${id} stays inside composer at ${width}`);
              }
              assert.ok((await page.locator("#timeline-region").boundingBox()).height > 100);
              assert.ok((await page.locator("#mobile-agent-button").boundingBox()).height >= 44);
            } else {
              assert.equal(await page.locator("#agent-request-profile").evaluate(node => node.parentElement.id), "composer");
              assert.equal(await page.locator("#settings-button").evaluate(node => node.parentElement.className), "account-cluster");
              assert.match(await page.locator("#send-agent-button").innerText(), locale === "en" ? /Request my agent/ : /请求我的 Agent/);
              assert.equal(await page.locator("#toggle-session-rail-button").getAttribute("aria-expanded"), "true");
              assert.match(await page.locator("#toggle-session-rail-button").getAttribute("aria-label"), locale === "en" ? /Collapse session sidebar/ : /收起会话侧栏/);
              assert.match(await page.locator("#mobile-members-button").getAttribute("aria-label"), locale === "en" ? /Expand member sidebar|Collapse member sidebar/ : /展开成员侧栏|收起成员侧栏/);
            }
          }
          // Closing a modal on resize must not overwrite the restored desktop disclosure state.
          await page.locator("#toggle-session-rail-button").click();
          await page.locator("#mobile-sessions-dialog[open]").waitFor();
          await page.setViewportSize({ width: 844, height: 390 });
          await page.waitForFunction(() => document.querySelector("#workspace").dataset.mobileUi === "false");
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await page.locator("#mobile-sessions-dialog").evaluate(node => node.open), false);
          assert.equal(await page.locator("#toggle-session-rail-button").getAttribute("aria-expanded"), "true");
          assert.match(await page.locator("#toggle-session-rail-button").getAttribute("aria-label"), locale === "en" ? /Collapse session sidebar/ : /收起会话侧栏/);
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForFunction(() => document.querySelector("#workspace").dataset.mobileUi === "true");
          await page.screenshot({ path: join(output, `${name}-${locale}-workspace.png`) });
          await page.evaluate(() => document.documentElement.dataset.theme = "dark");
          await page.screenshot({ path: join(output, `${name}-${locale}-dark.png`) });
          await chooseAgent(page, "codex", "gpt-6-sol");
          await page.locator("#mobile-agent-button").click();
          await page.screenshot({ path: join(output, `${name}-${locale}-options.png`) });
          await page.keyboard.press("Escape");
          // Empty project: close the drawer and give the full remaining height to the start screen.
          const empty = server.service.createProject(f.identity.actor, { title: "Empty project", idempotency_key: randomUUID() });
          await page.goto(`${origin}/app/#project=${empty.id}`);
          await page.reload();
          await page.locator("#empty-state:not([hidden])").waitFor();
          const grid = await page.locator(".workspace-grid").boundingBox();
          const conversation = await page.locator(".conversation").boundingBox();
          assert.ok(Math.abs(conversation.height - grid.height) < 2, "empty-project conversation fills its grid");
          await tools(page, "settings-button");
          await page.locator("#settings-locale").selectOption(locale === "en" ? "zh-CN" : "en");
          await page.locator("#settings-form button[type=submit]").click();
          await tools(page);
          assert.match(await page.locator("#mobile-tools-title").innerText(), locale === "en" ? /会话工具/ : /Conversation tools/);
          await page.keyboard.press("Escape");
          assert.deepEqual(errors, []);
          scenarios++;
          console.log(`PASS ${name} ${locale}: mobile sheets, remote Codex/DSH, exact routing, pause/resume, draft, quote/@, empty project, resize, locale`);
        } catch (error) {
          if (errors.length) console.error("Browser page errors:", errors);
          await page.screenshot({ path: join(output, `${name}-${locale}-failure.png`) }).catch(() => {});
          throw error;
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  console.log(`${scenarios} isolated bilingual Chromium/WebKit mobile scenarios passed.`);
} finally { clearInterval(heartbeat); await server.close(); }
