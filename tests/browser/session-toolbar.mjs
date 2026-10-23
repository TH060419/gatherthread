// Actual loopback HTTP/Cookie/SQLite/WebSocket and browser pointer/keyboard paths.
// Accounts and runtime answers are disposable fixtures; no model, signup or GitHub call executes.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import { browserSessionFixture } from "../../apps/server/dist/test/auth-fixtures.js";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
const reserve = createServer();
await new Promise(done => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port;
await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`;
const running = await startCollaborationServer({ databasePath: ":memory:", staticDirectory: resolve("apps/web/dist"),
  authTokenPepper: randomBytes(32).toString("hex"), publicBaseUrl: origin, allowedOrigins: [origin],
  actorRateLimit: { windowMs: 60_000, limit: 6000 }, actorWriteRateLimit: { windowMs: 60_000, limit: 600 } }, port);
const output = mkdtempSync(join(tmpdir(), "gatherthread-session-toolbar-"));
const cases = [
  ["chromium-desktop", chromium, "en", 1440, 900, false],
  ["webkit-desktop", webkit, "zh-CN", 1440, 900, false],
  ["chromium-phone", chromium, "zh-CN", 390, 844, true],
  ["webkit-phone", webkit, "en", 390, 844, true],
  ["chromium-tablet", chromium, "en", 1024, 900, true],
  ["webkit-tablet", webkit, "zh-CN", 820, 1180, true],
];
const key = () => randomUUID();
const runtimes = [];
const heartbeats = setInterval(() => { for (const { actor, runtime } of runtimes) running.service.heartbeatRuntime(actor, runtime.id); }, 1000);
let passed = 0;

function seed() {
  const owner = running.database.createIdentity({ display_name: "Toolbar owner", device_name: "Toolbar browser", can_create_projects: true });
  const peer = running.database.createIdentity({ display_name: "Toolbar teammate", device_name: "Toolbar peer" });
  const project = running.service.createProject(owner.actor, { title: "Toolbar project", idempotency_key: key() });
  const create = title => running.service.createSession(owner.actor,
    { project_id: project.id, title, mode: "multi", idempotency_key: key() }).session;
  const session = create("Toolbar conversation");
  running.service.setMembership(owner.actor, session.id, peer.actor.user_id, "participant", key());
  const other = create("Another conversation");
  const last = create("Final conversation");
  const chat = (target, content, mention = false) => running.service.appendEvent(peer.actor, target.id, {
    type: "human_chat", visibility: "session", idempotency_key: key(), payload: { content,
      ...(mention ? { mentions: [{ user_id: owner.actor.user_id, start: 0, end: "@Toolbar owner".length }] } : {}) } });
  const runtime = running.service.registerRuntime(owner.actor, { session_id: session.id, device_id: owner.actor.device_id,
    harness: "codex", provider: "openai", model: "gpt-6-sol", local_session_id: key(), capture_fidelity: "harness_transcript",
    execution_profiles: [{ provider: "openai", model: "gpt-6-sol", reasoning_efforts: ["low", "high"] }] });
  runtimes.push({ actor: owner.actor, runtime });
  const profile = { harness: "codex", provider: "openai", model: "gpt-6-sol", runtime_id: runtime.id, reasoning_effort: "high" };
  const answer = (request, content) => {
    const claim = running.service.claimAgentRequest(owner.actor, session.id, request.id, runtime.id);
    return running.service.completeAgentRequest(owner.actor, session.id, request.id, runtime.id, key(),
      { content }, "gpt-6-sol", "high", claim.attempt_count);
  };
  const mention = chat(session, "@Toolbar owner Please review this folded decision.", true);
  const existingRequest = running.service.createHistorySummary(owner.actor, session.id,
    { source_event_ids: [mention.id], execution_profile: profile, idempotency_key: key() });
  answer(existingRequest, "Earlier summarized decision.");
  for (let index = 0; index < 25; index++) chat(session, `Discussion ${index}: ${"Readable project discussion. ".repeat(18)}`);
  const source = chat(session, "Summarize this next development decision.");
  const otherMention = chat(other, "@Toolbar owner Check the second conversation.", true);
  const otherRuntime = running.service.registerRuntime(owner.actor, { session_id: other.id, device_id: owner.actor.device_id,
    harness: "codex", provider: "openai", model: "gpt-6-sol", local_session_id: key(), capture_fidelity: "harness_transcript" });
  runtimes.push({ actor: owner.actor, runtime: otherRuntime });
  const otherRequest = running.service.createHistorySummary(owner.actor, other.id,
    { source_event_ids: [otherMention.id], execution_profile: { ...profile, runtime_id: otherRuntime.id }, idempotency_key: key() });
  const otherClaim = running.service.claimAgentRequest(owner.actor, other.id, otherRequest.id, otherRuntime.id);
  running.service.completeAgentRequest(owner.actor, other.id, otherRequest.id, otherRuntime.id, key(),
    { content: "Second conversation folded summary." }, "gpt-6-sol", "high", otherClaim.attempt_count);
  const lastMention = chat(last, "@Toolbar owner Check the final conversation.", true);
  return { owner, peer, project, session, other, last, mention, otherMention, lastMention, source, runtime, answer, chat };
}

async function openPage(browser, f, locale, width, height, mobile, errors) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile,
    reducedMotion: "reduce", locale, ...(mobile ? { userAgent: width < 760
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
  const cookie = browserSessionFixture(running, { token: f.owner.token, origin }).headers.get("set-cookie").split(";")[0];
  await context.addCookies([{ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1),
    url: origin, httpOnly: true, sameSite: "Strict" }]);
  await context.addInitScript(({ locale, mobile }) => {
    localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
    localStorage.setItem("gatherthread.interface-mode.v1", mobile ? "mobile" : "desktop");
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      return name.startsWith("gatherthread.onboarding.v1:") ? "skipped" : read.call(this, name);
    };
  }, { locale, mobile });
  await context.route(/^https?:/, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/app/#project=${f.project.id}&session=${f.session.id}`);
  await page.locator("#session-view:not([hidden])").waitFor();
  if (await page.locator("#code-notice-dialog[open]").isVisible()) await page.locator("#code-notice-continue").click();
  await page.locator(`#message-${f.source.id}`).waitFor();
  await page.waitForFunction(mobile => document.querySelector("#workspace").dataset.mobileUi === String(mobile), mobile);
  return { context, page };
}

async function tools(page, mobile) {
  if (mobile && !await page.locator("#mobile-tools-dialog[open]").isVisible()) await page.locator("#mobile-tools-button").click();
}
async function closeTools(page, mobile) {
  if (mobile && await page.locator("#mobile-tools-dialog[open]").isVisible()) await page.locator("#mobile-tools-dialog [data-mobile-close]").click();
}
async function menu(page, mobile, kind) {
  await tools(page, mobile);
  const summary = kind === "summary", panel = summary ? "history-summary-menu-panel" : "session-options-panel";
  if (!await page.locator(`#${panel}`).isVisible()) await page.locator(summary ? "#history-summary-menu-button" : "#session-options-button").click();
  await page.locator(`#${panel}:not([hidden])`).waitFor();
}
async function summaryAction(page, mobile, id) {
  await menu(page, mobile, "summary"); await page.locator(`#${id}`).click();
}

async function exercise(page, f, mobile, locale, name) {
  assert.equal(await page.locator(".session-header #mentions-button").count(), 0);
  assert.equal(await page.locator("#mobile-tools-dialog #mentions-button").count(), 0);
  if (!mobile) {
    assert.equal(await page.locator(".session-header-actions > .session-toolbar-menu").count(), 2);
    assert.equal(await page.locator(".session-header-actions > .session-toolbar-menu > button:visible").count(), 2,
      "desktop title has exactly summary and session-options entries");
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await menu(page, mobile, "summary");
    assert.equal(await page.locator("#session-options-panel").isVisible(), false);
    await page.locator("#session-options-button").click();
    assert.equal(await page.locator("#history-summary-menu-panel").isVisible(), false, "only one menu opens at a time");
    await page.locator("#session-options-button").press("ArrowDown");
    await page.waitForFunction(() => document.activeElement.id === "rename-session-button");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement.id === "session-options-button");
    assert.equal(await page.locator("#session-options-panel").isVisible(), false);
    await menu(page, mobile, "summary");
    await page.locator(mobile ? "#mobile-tools-title" : "#message-input").click();
    assert.equal(await page.locator("#history-summary-menu-panel").isVisible(), false, "outside pointer dismisses menu");
    await menu(page, mobile, "options");
    await page.locator("#session-context-details > summary").click();
    await page.locator("#session-context-panel").waitFor();
    await page.waitForFunction(mobile => document.querySelector("#session-context-panel").parentElement.tagName
      === (mobile ? "DETAILS" : "BODY"), mobile);
    assert.equal(await page.locator("#session-context-panel").evaluate(node => node.parentElement.tagName), mobile ? "DETAILS" : "BODY");
    const statusControls = await page.locator("#session-context-panel").evaluate(node => [...node.querySelectorAll("button, input, select, a[href]")]
      .filter(control => !control.disabled && !control.closest("[hidden]") && control.getClientRects().length).map(control => control.id));
    await page.locator("#session-context-details > summary").focus();
    await page.keyboard.press("Tab");
    if (statusControls.length) {
      assert.equal(await page.locator("#session-context-panel").evaluate(node => node.contains(document.activeElement)), true,
        "status disclosure enters its own visible controls even when portalled");
    } else {
      assert.equal(mobile, true, "desktop fixture must retain actionable status controls");
      assert.equal(await page.locator("#session-context-details > summary").evaluate(node => node === document.activeElement), false,
        "mobile informational status must release Tab when it has no controls");
      assert.equal(await page.evaluate(() => document.activeElement === document.body
        || (document.activeElement.getClientRects().length > 0 && !document.activeElement.closest("[hidden]"))), true,
      "native WebKit may move focus to browser chrome; any retained DOM focus must remain visible");
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#session-context-details").open);
    assert.equal(await page.locator("#session-context-details").evaluate(node => node.open), false);
    await page.keyboard.press("Escape");
    await closeTools(page, mobile);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${theme}: no horizontal overflow`);
    await page.screenshot({ path: join(output, `${name}-${theme}.png`) });
  }
  // Existing versions and view actions are still available through the one entry.
  await summaryAction(page, mobile, "history-summary-versions-button");
  await page.locator("#history-summary-versions-dialog[open]").waitFor();
  await page.locator("#history-summary-versions").getByText("Earlier summarized decision.", { exact: true }).waitFor();
  await page.locator("#history-summary-versions-close").click();
  // Generation invokes the real summary endpoint; only runtime execution is synthetic.
  await page.locator("#mobile-agent-button").click();
  await page.locator("#agent-harness-select").selectOption("codex");
  await page.locator("#agent-model-select").selectOption("gpt-6-sol");
  await page.locator("#agent-effort-select").selectOption("high");
  await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
  await summaryAction(page, mobile, "history-summary-select-button");
  await page.locator(`.history-source-checkbox[data-source-event-id="${f.source.id}"]`).check();
  await page.locator("#history-summary-generate-button").click();
  const posted = page.waitForResponse(response => response.request().method() === "POST"
    && response.url() === `${origin}/v1/sessions/${f.session.id}/history-summaries`);
  await page.locator("#history-summary-confirm-button").click();
  const response = await posted; assert.equal(response.status(), 201);
  const request = (await response.json()).data.event; f.answer(request, "New toolbar-generated summary.");
  await page.getByText("New toolbar-generated summary.", { exact: true }).waitFor();
  // Read the current conversation intentionally, leaving two unread mentions in
  // unvisited conversations. Summary selection is allowed to reveal originals.
  await summaryAction(page, mobile, "history-summary-view-button");
  await page.locator(`#message-${f.mention.id}`).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("#mentions-count").textContent === "2");
  await summaryAction(page, mobile, "history-summary-view-button");
  await page.locator("#mentions-button:not([hidden])").waitFor();
  await page.locator("#mentions-button").click();
  await page.waitForFunction(id => location.hash.includes(`session=${id}`), f.other.id);
  await page.locator(`#message-${f.otherMention.id}`).waitFor();
  await page.waitForFunction(id => document.activeElement.id === `message-${id}`, f.otherMention.id);
  assert.equal(await page.locator("#mentions-count").innerText(), "1", "only final-session unread remains");
  // Check the original/summary switch after reading the oldest mention; opening
  // original view earlier could legitimately acknowledge it before the jump test.
  await summaryAction(page, mobile, "history-summary-view-button");
  await page.locator(`#message-${f.otherMention.id}`).waitFor({ state: "detached" });
  await summaryAction(page, mobile, "history-summary-view-button");
  await page.locator(`#message-${f.otherMention.id}`).waitFor();
  await page.locator("#mentions-button").click();
  await page.waitForFunction(id => location.hash.includes(`session=${id}`), f.last.id);
  await page.locator(`#message-${f.lastMention.id}`).waitFor();
  await page.locator("#mentions-button").waitFor({ state: "hidden" });
  const visible = f.chat(f.last, "@Toolbar owner This arriving message is already visible.", true);
  await page.locator(`#message-${visible.id}`).waitFor();
  await page.waitForFunction(id => {
    const card = document.getElementById(`message-${id}`), area = document.getElementById("timeline-region");
    return card && card.getBoundingClientRect().top >= area.getBoundingClientRect().top
      && card.getBoundingClientRect().bottom <= area.getBoundingClientRect().bottom;
  }, visible.id);
  await page.locator("#mentions-button").waitFor({ state: "hidden" });
  // A new poll must not resurrect the mention that was read without pressing @.
  const before = await page.locator("#mentions-count").innerText();
  await page.locator("#timeline-region").evaluate(node => node.dispatchEvent(new Event("scroll")));
  assert.equal(await page.locator("#mentions-count").innerText(), before);
  await menu(page, mobile, "options"); await page.locator("#rename-session-button").click();
  await page.locator("#rename-session-dialog[open]").waitFor();
  await page.locator("#rename-session-name").fill("Renamed toolbar conversation");
  await page.locator("#rename-session-form button[type=submit]").click();
  await page.locator("#rename-session-dialog").waitFor({ state: "hidden" });
  assert.equal(running.database.requireSession(f.last.id).title, "Renamed toolbar conversation");
  await menu(page, mobile, "options"); await page.locator("#delete-session-button").click();
  await page.locator("#delete-cloud-dialog[open]").waitFor();
  await page.locator("#cancel-delete-cloud-button").click();
  assert.equal(running.database.requireSession(f.last.id).title, "Renamed toolbar conversation", "cancelled deletion preserves session");
  assert.equal(await page.locator("#mentions-dialog[open]").count(), 0, "unread jumps never open the old inbox");
  assert.ok(["en", "zh-CN"].includes(locale));
}

try {
  for (const [name, engine, locale, width, height, mobile] of cases) {
    if (process.env.TOOLBAR_BROWSER_CASE && !process.env.TOOLBAR_BROWSER_CASE.split(",").includes(name)) continue;
    const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const errors = [], f = seed(); let context, page;
    try {
      ({ context, page } = await openPage(browser, f, locale, width, height, mobile, errors));
      await exercise(page, f, mobile, locale, name); assert.deepEqual(errors, []); passed++;
      console.log(`PASS ${name}: two entries, themes, summaries, exclusivity, status keyboard, mentions/read, cross-session, rename/delete`);
    } catch (error) {
      if (page) await page.screenshot({ path: join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
      console.error(`${name}:`, errors, `Artifacts: ${output}`);
      if (page) console.error(await page.evaluate(() => ({ hash: location.hash, active: document.activeElement?.id,
        mentionCount: document.querySelector("#mentions-count")?.textContent,
        announcement: document.querySelector("#live-announcer")?.textContent,
        openDialogs: [...document.querySelectorAll("dialog[open]")].map(node => node.id) })));
      throw error;
    } finally { await context?.close(); await browser.close(); }
  }
  console.log(`Session toolbar browser scenarios passed: ${passed}. Artifacts: ${output}`);
} finally { clearInterval(heartbeats); await running.close(); }
