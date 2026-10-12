// Real loopback HTTP, HttpOnly Cookie, SQLite and WebSocket integration.
// Every identity and body is a disposable public fixture; no provider is called.
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
const running = await startCollaborationServer({ databasePath: ":memory:",
  authTokenPepper: randomBytes(32).toString("hex"), staticDirectory: resolve("apps/web/dist"),
  allowedOrigins: [origin], publicBaseUrl: origin, heartbeatIntervalMs: 100,
  actorRateLimit: { windowMs: 60_000, limit: 6000 }, actorWriteRateLimit: { windowMs: 60_000, limit: 600 } }, port);
const artifacts = mkdtempSync(join(tmpdir(), "gatherthread-deletion-ui-"));
const cases = [
  ["chromium-desktop", chromium, "en", 1440, 900, false],
  ["webkit-desktop", webkit, "zh-CN", 1440, 900, false],
  ["chromium-phone", chromium, "zh-CN", 390, 844, true],
  ["webkit-phone", webkit, "en", 390, 844, true],
  ["chromium-tablet", chromium, "en", 1024, 900, true],
  ["webkit-tablet", webkit, "zh-CN", 820, 1180, true],
];
const key = () => randomUUID();
const eventNode = (page, event) => page.locator(`#message-${event.id}`);
const deletedText = locale => locale === "zh-CN" ? "消息已删除" : "Message deleted";
const click = (locator, mobile) => mobile ? locator.tap() : locator.click();
async function bounded(work, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded 10 seconds`)), 10_000);
  })]); } finally { clearTimeout(timer); }
}
let passed = 0;

function makeFixture() {
  const owner = running.database.createIdentity({ display_name: "Deletion owner", device_name: "Fixture browser", can_create_projects: true });
  const member = running.database.createIdentity({ display_name: "Deletion member", device_name: "Fixture member" });
  const viewer = running.database.createIdentity({ display_name: "Deletion viewer", device_name: "Fixture viewer" });
  const project = running.service.createProject(owner.actor, { title: "Disposable deletion project", idempotency_key: key() });
  const { session } = running.service.createSession(owner.actor, { project_id: project.id, title: "Deletion conversation", mode: "multi", idempotency_key: key() });
  running.service.setMembership(owner.actor, session.id, member.actor.user_id, "participant", key());
  running.service.setMembership(owner.actor, session.id, viewer.actor.user_id, "participant", key());
  const chat = (content, identity = owner, extras = {}) => running.service.appendEvent(identity.actor, session.id,
    { type: "human_chat", payload: { content, ...extras.payload }, visibility: "session", idempotency_key: key(),
      ...(extras.replyTo ? { reply_to_event_id: extras.replyTo } : {}) });
  const ownViewer = chat("Viewer authored this before becoming read-only", viewer);
  running.service.setMembership(owner.actor, session.id, viewer.actor.user_id, "viewer", key());
  const own = chat(`@Deletion owner REMOVE_SOURCE_${key()}`, owner, { payload: { mentions: [
    { user_id: owner.actor.user_id, start: 0, end: "@Deletion owner".length },
  ] } });
  const peer = chat("A member's independent message", member);
  const quote = chat("An independently authored quote remains", member, { replyTo: own.id });
  const runtime = running.service.registerRuntime(owner.actor, { session_id: session.id, device_id: owner.actor.device_id,
    harness: "codex", provider: "fixture", model: "fixture", local_session_id: `fixture-${key()}`,
    capture_fidelity: "harness_transcript", context_deletion_version: 1 });
  const profile = { harness: "codex", provider: "fixture", model: "fixture", runtime_id: runtime.id };
  const answer = (request, content) => {
    running.service.claimAgentRequest(owner.actor, session.id, request.id, runtime.id);
    return running.service.completeAgentRequest(owner.actor, session.id, request.id, runtime.id, key(), { content }, undefined, undefined, 1);
  };
  const summaryRequest = running.service.createHistorySummary(owner.actor, session.id, {
    idempotency_key: key(), source_event_ids: [own.id, peer.id], execution_profile: profile });
  const firstSummary = answer(summaryRequest, "FIRST_DERIVED_REMOVE fixture summary");
  const nestedRequest = running.service.createHistorySummary(owner.actor, session.id, {
    idempotency_key: key(), source_event_ids: [firstSummary.id], execution_profile: profile });
  const nestedSummary = answer(nestedRequest, "NESTED_DERIVED_REMOVE fixture summary");
  for (let index = 0; index < 24; index++) chat(`Readable older message ${index}. ${"Shared discussion. ".repeat(16)}`, member);
  const request = content => running.service.appendEvent(owner.actor, session.id, { type: "agent_request", visibility: "session",
    content_revision: running.database.requireSession(session.id).content_revision,
    idempotency_key: key(), payload: { content, execution_profile: profile } });
  const active = request("ACTIVE_REQUEST fixture");
  running.service.claimAgentRequest(owner.actor, session.id, active.id, runtime.id);
  const work = running.service.appendAgentProgress(owner.actor, session.id, active.id, runtime.id, key(), {
    phase: "stream", stream_id: key(), stream_kind: "answer", stream_mode: "snapshot",
    stream_revision: 1, stream_state: "running", content: "OLD_GENERATED_REMOVE work" }, undefined, undefined, 1);
  running.service.appendAgentProgress(owner.actor, session.id, active.id, runtime.id, key(), {
    phase: "stream", stream_id: key(), stream_kind: "plan", stream_mode: "snapshot",
    stream_revision: 1, stream_state: "running", content: "", plan: [{ step: "OLD_PLAN_REMOVE", status: "in_progress" }] }, undefined, undefined, 1);
  const soloResult = running.service.createSession(member.actor, { project_id: project.id, mode: "solo", title: "Member Solo", idempotency_key: key() });
  const solo = soloResult.session;
  running.service.appendEvent(member.actor, solo.id, { type: "human_chat", visibility: "session",
    idempotency_key: key(), payload: { content: "Member Solo read-only fixture" } });
  return { owner, member, viewer, project, session, own, peer, quote, ownViewer, active, work,
    firstSummary, nestedSummary, solo, request, answer, runtime };
}

async function pageFor(browser, f, identity, locale, width, height, mobile, errors) {
  const context = await browser.newContext({ viewport: { width, height }, locale, isMobile: mobile, hasTouch: mobile,
    reducedMotion: "reduce", ...(mobile ? { userAgent: width < 760
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
  const cookie = browserSessionFixture(running, { token: identity.token, origin }).headers.get("set-cookie").split(";")[0];
  await context.addCookies([{ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1),
    url: origin, httpOnly: true, sameSite: "Strict" }]);
  await context.addInitScript(locale => {
    localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) { return name.startsWith("gatherthread.onboarding.v1:") ? "skipped" : read.call(this, name); };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.fixtureCopied = text; } } });
    window.fixtureSockets = [];
    window.fixtureReceivedSequences = [];
    const Socket = WebSocket;
    window.WebSocket = class extends Socket { constructor(...args) {
      super(...args); window.fixtureSockets.push(this);
      this.addEventListener("message", message => {
        const frame = JSON.parse(message.data);
        if (frame.type === "event" && Number.isSafeInteger(frame.event?.sequence)) window.fixtureReceivedSequences.push(frame.event.sequence);
      });
    } };
  }, locale);
  await context.route(/^https?:/, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/app/#project=${f.project.id}&session=${f.session.id}`);
  await page.locator("#session-view:not([hidden])").waitFor();
  if (await page.locator("#code-notice-dialog[open]").isVisible()) await click(page.locator("#code-notice-continue"), mobile);
  await page.locator("#event-timeline .event-card").first().waitFor();
  await page.waitForFunction(() => window.fixtureSockets.some(socket => socket.readyState === 1));
  assert.equal((await context.request.get(origin + "/v1/me")).status(), 200);
  return { context, page };
}

async function tools(page, mobile) {
  if (mobile && !await page.locator("#history-summary-select-button").isVisible()) await click(page.locator("#mobile-tools-button"), mobile);
}
async function closeTools(page, mobile) {
  if (mobile && await page.locator("#mobile-tools-dialog[open]").isVisible()) await click(page.locator("#mobile-tools-dialog [data-mobile-close]"), mobile);
}
async function remove(page, event, mobile, accept = true, settled = true) {
  let warning = "";
  const dialogHandled = new Promise(resolve => page.once("dialog", async dialog => {
    warning = dialog.message(); await (accept ? dialog.accept() : dialog.dismiss()); resolve();
  }));
  await click(eventNode(page, event).locator(".message-delete-action"), mobile);
  await bounded(dialogHandled, "Deletion confirmation");
  if (accept && settled) await eventNode(page, event).locator(".event-content").getByText(/Message deleted|消息已删除/, { exact: true }).waitFor();
  return warning;
}

try {
  for (const [name, engine, locale, width, height, mobile] of cases) {
    if (process.env.DELETION_BROWSER_CASE && process.env.DELETION_BROWSER_CASE !== name) continue;
    const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const errors = [], f = makeFixture(), opened = [];
    let page;
    try {
      const owner = await pageFor(browser, f, f.owner, locale, width, height, mobile, errors);
      opened.push(owner.context); page = owner.page;
      await tools(page, mobile);
      await click(page.locator("#history-summary-versions-button"), mobile);
      await page.locator("#history-summary-versions").getByText("NESTED_DERIVED_REMOVE fixture summary", { exact: true }).waitFor();
      await click(page.locator("#history-summary-versions-close"), mobile);
      await tools(page, mobile);
      await click(page.locator("#history-summary-view-button"), mobile);
      await closeTools(page, mobile);
      await eventNode(page, f.own).waitFor();
      assert.equal(await eventNode(page, f.peer).locator(".message-delete-action").count(), 0, "owner cannot delete another writer's message");
      await click(eventNode(page, f.own).locator(".message-action").nth(0), mobile);
      assert.equal(await page.evaluate(() => window.fixtureCopied), f.own.payload.content, "copy excludes name/time");
      await click(eventNode(page, f.own).locator(".message-action").nth(1), mobile);
      await page.locator("#message-input").fill("Keep this unfinished draft");
      const canceled = await remove(page, f.own, mobile, false);
      assert.match(canceled, locale === "zh-CN" ? /不会被抹除/ : /not erased/);
      assert.equal(running.database.getEvent(f.session.id, f.own.id).deleted, undefined);
      assert.equal(await eventNode(page, f.own).locator(".message-delete-action").count(), 1);
      const deleteUrl = `${origin}/v1/sessions/${f.session.id}/events/${f.own.id}/delete`, deleteKeys = [];
      const uncertain = async route => {
        deleteKeys.push(route.request().postDataJSON().idempotency_key);
        return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ error: { code: "fixture_uncertain", message: "Isolated acknowledgement failure" } }) });
      };
      await page.route(deleteUrl, uncertain);
      const firstUncertain = page.waitForResponse(response => response.url() === deleteUrl && response.status() === 503);
      await remove(page, f.own, mobile, true, false); await firstUncertain;
      await page.waitForFunction(id => !document.querySelector(`[data-message-delete-id="${id}"]`).disabled, f.own.id);
      await page.unroute(deleteUrl, uncertain);
      assert.equal(running.database.getEvent(f.session.id, f.own.id).deleted, undefined);
      await tools(page, mobile);
      await click(page.locator("#mentions-button"), mobile);
      await page.locator(`#mentions-list [data-mention-event-id="${f.own.id}"]`).waitFor();
      await click(page.locator("#mentions-close"), mobile);
      await closeTools(page, mobile);

      // A held old HTTP page and a delayed real WebSocket-format event simulate
      // network reordering at the actual browser transport boundary.
      let releaseOld, enterOld;
      const oldEntered = new Promise(resolve => { enterOld = resolve; });
      let held = false;
      const oldHead = running.database.requireSession(f.session.id).next_sequence;
      const stale = { ...f.own, id: "delayed-old-copy", sequence: oldHead + 1, content_revision: 0 };
      await page.route(`${origin}/v1/sessions/${f.session.id}/events?*`, async route => {
        const after = Number(new URL(route.request().url()).searchParams.get("after_sequence"));
        if (held || after === 0) return route.continue();
        held = true;
        await new Promise(resolve => { releaseOld = resolve; enterOld(); });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
          events: [stale], cursor: stale.sequence, has_more: false, content_revision: 0,
        } }) });
      });
      let releaseFresh, enterFresh;
      const freshEntered = new Promise(resolve => { enterFresh = resolve; });
      let freshHeld = false, capturedFreshCursor;
      await page.route(`${origin}/v1/sessions/${f.session.id}/events?*`, async route => {
        const after = Number(new URL(route.request().url()).searchParams.get("after_sequence"));
        if (freshHeld || after !== 0) return route.fallback();
        freshHeld = true;
        const response = await route.fetch();
        capturedFreshCursor = (await response.json()).data.cursor;
        await new Promise(resolve => { releaseFresh = resolve; enterFresh(); });
        return route.fulfill({ response });
      });
      let releaseDelete, enterDelete;
      const deleteEntered = new Promise(resolve => { enterDelete = resolve; });
      await page.route(deleteUrl, async route => {
        deleteKeys.push(route.request().postDataJSON().idempotency_key);
        await new Promise(resolve => { releaseDelete = resolve; enterDelete(); });
        return route.continue();
      });
      await eventNode(page, f.own).scrollIntoViewIfNeeded();
      const before = await eventNode(page, f.own).evaluate(node => node.getBoundingClientRect().top);
      // Begin the genuine user click while history is live. An unrelated gap
      // then starts an older replay before the deletion acknowledgement arrives.
      const deleting = remove(page, f.own, mobile);
      await bounded(deleteEntered, "Deletion transport fixture");
      await page.evaluate(event => window.fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "event", event }) })), { ...stale, sequence: oldHead + 2 });
      await bounded(oldEntered, "Old replay fixture");
      releaseDelete();
      await bounded(freshEntered, "Authoritative deletion snapshot");
      const peerCookie = browserSessionFixture(running, { token: f.member.token, origin }).headers.get("set-cookie").split(";")[0];
      const peerResponse = await fetch(`${origin}/v1/sessions/${f.session.id}/events`, { method: "POST",
        headers: { Cookie: peerCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({
          type: "human_chat", visibility: "session", idempotency_key: key(),
          payload: { content: "NEW_WHILE_DELETION_REFRESH fixture" },
        }) });
      assert.equal(peerResponse.status, 201);
      const peerDuringRefresh = (await peerResponse.json()).data.event;
      assert.ok(peerDuringRefresh.sequence > capturedFreshCursor, "new message was written after the held snapshot");
      await page.waitForFunction(sequence => window.fixtureReceivedSequences.includes(sequence), peerDuringRefresh.sequence);
      assert.doesNotMatch(await page.locator("#event-timeline").textContent(), /NEW_WHILE_DELETION_REFRESH/,
        "no unverified body is retained while the deletion snapshot is pending");
      releaseFresh();
      const warning = await deleting;
      await page.getByText("NEW_WHILE_DELETION_REFRESH fixture", { exact: true }).waitFor();
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this unfinished draft");
      const oldFinished = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === `/v1/sessions/${f.session.id}/events`
          && Number(url.searchParams.get("after_sequence")) === oldHead && response.status() === 200;
      });
      releaseOld();
      await oldFinished;
      assert.equal(deleteKeys.length, 2); assert.equal(new Set(deleteKeys).size, 1, "uncertain deletion retry reuses the one key");
      assert.equal(running.database.sqlite.prepare("SELECT COUNT(*) AS count FROM message_deletions WHERE session_id=? AND target_event_id=?")
        .get(f.session.id, f.own.id).count, 1);
      assert.match(warning, locale === "zh-CN" ? /GatherThread|之后/ : /future GatherThread/);
      await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "request");
      await page.evaluate(event => window.fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "event", event }) })), { ...stale, sequence: oldHead + 100 });
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this unfinished draft");
      assert.equal(await page.locator("#composer-quote").isVisible(), false, "only the deleted draft quote is cleared");
      assert.ok(Math.abs(await eventNode(page, f.own).evaluate(node => node.getBoundingClientRect().top) - before) < 10,
        "deletion keeps the reading anchor instead of scrolling to the bottom");
      assert.equal(await eventNode(page, f.own).locator(".message-action, .history-source-checkbox").count(), 0);
      assert.equal(await eventNode(page, f.quote).locator(".quoted-message").isDisabled(), true);
      assert.match(await eventNode(page, f.quote).locator(".quoted-message").textContent(), locale === "zh-CN" ? /已删除/ : /deleted/);
      assert.equal(await eventNode(page, f.own).evaluate(node => node === document.activeElement), true, "focus follows the retained tombstone");
      const text = await page.locator("#event-timeline").textContent();
      assert.doesNotMatch(text, /REMOVE_SOURCE_|FIRST_DERIVED_REMOVE|NESTED_DERIVED_REMOVE|OLD_GENERATED_REMOVE|OLD_PLAN_REMOVE/);
      assert.match(text, /A member's independent message/);
      assert.match(text, /An independently authored quote remains/);
      assert.match(text, locale === "zh-CN" ? /因来源已删除而失效/ : /Unavailable because its source was deleted/);
      assert.equal(await page.locator("#history-summary-versions-dialog[open]").count(), 0);
      assert.equal(await page.locator("#history-summary-versions li").count(), 0);
      assert.equal(await page.locator("#history-summary-versions-button").isVisible(), false);
      const replay = await owner.context.request.get(`${origin}/v1/sessions/${f.session.id}/events?limit=500`);
      assert.equal(replay.status(), 200);
      assert.doesNotMatch(await replay.text(), /REMOVE_SOURCE_|FIRST_DERIVED_REMOVE|NESTED_DERIVED_REMOVE|OLD_GENERATED_REMOVE|OLD_PLAN_REMOVE/);
      for (const view of ["summary", "original"]) {
        const response = await owner.context.request.get(`${origin}/v1/sessions/${f.session.id}/context?view=${view}`);
        assert.equal(response.status(), 200); assert.doesNotMatch(await response.text(), /REMOVE_SOURCE_|DERIVED_REMOVE|OLD_GENERATED_REMOVE|OLD_PLAN_REMOVE/);
      }
      await tools(page, mobile); await click(page.locator("#mentions-button"), mobile);
      await page.locator("#mentions-empty:not([hidden])").waitFor();
      assert.equal(await page.locator(`#mentions-list [data-mention-event-id="${f.own.id}"]`).count(), 0);
      await click(page.locator("#mentions-close"), mobile); await closeTools(page, mobile);
      await tools(page, mobile); await click(page.locator("#history-summary-select-button"), mobile); await closeTools(page, mobile);
      assert.equal(await eventNode(page, f.own).locator(".history-source-checkbox").count(), 0);
      await closeTools(page, mobile); await click(page.locator("#history-summary-cancel-button"), mobile);

      const active = f.request("A new deletable active request");
      running.service.claimAgentRequest(f.owner.actor, f.session.id, active.id, f.runtime.id);
      running.service.appendAgentProgress(f.owner.actor, f.session.id, active.id, f.runtime.id, key(),
        { content: "ACTIVE_LINKED_REMOVE", phase: "lifecycle", status: "started" }, undefined, undefined, 1);
      await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "pause");
      const requestWarning = await remove(page, active, mobile);
      assert.match(requestWarning, locale === "zh-CN" ? /相关回复、工作过程/ : /linked replies and work/);
      await page.waitForFunction(() => document.querySelector("#send-agent-button").dataset.agentAction === "request");
      assert.doesNotMatch(await page.locator("#event-timeline").textContent(), /ACTIVE_LINKED_REMOVE/);
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this unfinished draft");
      const keptRequest = f.request("Keep this request when only its reply is deleted");
      running.service.claimAgentRequest(f.owner.actor, f.session.id, keptRequest.id, f.runtime.id);
      const streamedReply = running.service.appendAgentProgress(f.owner.actor, f.session.id, keptRequest.id, f.runtime.id, key(), {
        phase: "stream", stream_id: key(), stream_kind: "answer", stream_mode: "snapshot",
        stream_revision: 1, stream_state: "running", content: "DELETE_REPLY_ONLY fixture" }, undefined, undefined, 1);
      await page.waitForFunction(() => document.getElementById("event-timeline").textContent.includes("DELETE_REPLY_ONLY fixture"));
      const reply = running.service.completeAgentRequest(f.owner.actor, f.session.id, keptRequest.id, f.runtime.id, key(),
        { content: "DELETE_REPLY_ONLY fixture" }, undefined, undefined, 1);
      await eventNode(page, reply).waitFor();
      await remove(page, reply, mobile);
      assert.equal(running.database.getEvent(f.session.id, keptRequest.id).deleted, undefined);
      assert.ok(running.database.getEvent(f.session.id, streamedReply.id).deleted,
        "deleting the final answer also scrubs its previously streamed copy");
      assert.doesNotMatch(JSON.stringify(running.database.getEvent(f.session.id, streamedReply.id)), /DELETE_REPLY_ONLY/);
      assert.doesNotMatch(await page.locator("#event-timeline").textContent(), /DELETE_REPLY_ONLY/);
      assert.equal(await eventNode(page, keptRequest).locator(".event-content").textContent(), keptRequest.payload.content);
      assert.equal(await eventNode(page, reply).locator(".event-content").textContent(), deletedText(locale));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
      await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });

      const reader = await pageFor(browser, f, f.viewer, locale, width, height, mobile, errors); opened.push(reader.context);
      assert.equal(await eventNode(reader.page, f.ownViewer).locator(".message-delete-action").count(), 0, "viewer cannot delete even an earlier own message");
      assert.equal(await reader.page.locator(".message-delete-action").count(), 0);
      if (mobile) await click(page.locator("#toggle-session-rail-button"), mobile);
      await click(page.locator("#session-list button").filter({ hasText: "Member Solo" }), mobile);
      await page.getByText("Member Solo read-only fixture", { exact: true }).waitFor();
      assert.equal(await page.locator(".message-delete-action").count(), 0, "project owner has no other-Solo override");
      assert.equal(await page.locator("#message-input").isDisabled(), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: author deletion, Cookie/DB/WS, stale delivery, no-loss refresh, summaries, quotes, mentions, draft/scroll/focus, viewer and Solo`);
      passed++;
    } catch (error) {
      if (page) await page.screenshot({ path: join(artifacts, `${name}-failure.png`), fullPage: true }).catch(() => {});
      console.error(`${name}:`, errors);
      throw error;
    } finally { for (const context of opened) await context.close(); await browser.close(); }
  }
  console.log(`Deletion pointer scenarios passed: ${passed}. Artifacts: ${artifacts}`);
} finally { await running.close(); }
