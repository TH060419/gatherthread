import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { TEAM_ZH_CN } from "../src/agent-team-i18n.js";
import { describeTeamActionError } from "../src/agent-team-diagnostics.js";

const source = (await readFile(new URL("../src/main.js", import.meta.url), "utf8")).replace(/\r\n?/gu, "\n");
const functionSource = name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m")); assert.notEqual(start, -1, name);
  const tail = source.slice(start), end = tail.indexOf("\n}\n") + 2; assert.ok(end > 1, name); return tail.slice(0, end);
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const noop = () => {};
const plain = value => JSON.parse(JSON.stringify(value));
const node = () => ({ value: "", textContent: "", disabled: false, childNodes: [], focus: noop,
  replaceChildren(...children) { this.childNodes = children; } });

function fixture(start) {
  const raw = " \t😀 检查 @林 小明\r\n ", label = "@林 小明", at = raw.indexOf(label);
  let metadata = { replyTo: "quoted-source", mentions: [{ user_id: "member-a", start: at, end: at + label.length }] }, sent = 0;
  const calls = [], nodes = new Map(), app = vm.createContext({
    authenticationGeneration: 1, selectedSessionGeneration: 1,
    state: { currentUser: { id: "alice" }, project: { id: "project-a" }, session: { id: "session-a", mode: "multi" },
      settings: { composer: { confirmAgentRequest: false } }, sync: { contentRevision: 3 } },
    messageInput: { ...node(), value: raw }, sendAgentButton: node(), sendChatButton: node(), sendError: node(),
    pendingMessageSend: null, currentProjectHarness: () => "team", agentRequestControl: { action: () => "request" },
    createIdempotencyKey: kind => `fixture-${kind}`, renderComposerPermissions: noop,
    localizer: { t: text => text }, window: { confirm: () => true },
    api: { appendHumanChat() { throw new Error("A Team request must not become human chat"); },
      appendAgentRequest() { throw new Error("A Team request must not bypass the Team service"); } },
    element: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    messageActions: { metadata: () => structuredClone(metadata), sent: () => { sent++; metadata = { replyTo: null, mentions: [] }; } },
    teamsUi: { t: text => text, describeError: (error, action) => describeTeamActionError(error, action), startTask: async (content, options) => {
      calls.push({ content, options }); return start ? start(content, options) : { run: { id: "run-a" }, replayed: false };
    } },
  });
  vm.runInContext(["captureWorkspaceScope", "sendMessage"].map(functionSource).join("\n"), app);
  return { app, raw, label, calls, metadata: () => structuredClone(metadata), setMetadata: value => { metadata = structuredClone(value); }, sent: () => sent };
}

test("the real composer routes Team requests with the quote and UTF-16 mention offsets adjusted for trimmed leading whitespace", async () => {
  const f = fixture(); await f.app.sendMessage("agent_request");
  assert.equal(f.calls.length, 1); const { content, options } = f.calls[0];
  assert.equal(content, f.raw.trim()); assert.equal(options.replyTo, "quoted-source");
  assert.deepEqual(plain(options.mentions), [{ user_id: "member-a", start: content.indexOf(f.label), end: content.indexOf(f.label) + f.label.length }]);
  assert.equal(content.slice(options.mentions[0].start, options.mentions[0].end), f.label);
  assert.equal(f.app.messageInput.value, ""); assert.equal(f.sent(), 1);
});

test("an accepted Team request clears its unchanged draft and composer metadata once", async () => {
  const receipt = { run: { id: "run-a" }, replayed: false };
  const f = fixture(async (_content, options) => { options.onAccepted(receipt); return receipt; });
  await f.app.sendMessage("agent_request");
  assert.equal(f.app.messageInput.value, ""); assert.deepEqual(f.metadata(), { replyTo: null, mentions: [] });
  assert.equal(f.sent(), 1, "the callback and resolved HTTP response must not clear the composer twice");
});

for (const change of ["quote", "mentions", "draft"]) {
  test(`an accepted Team request preserves a newer ${change} selected while the response is pending`, async () => {
    const pending = deferred(), f = fixture(() => pending.promise), originalMetadata = f.metadata();
    const sending = f.app.sendMessage("agent_request"); assert.equal(f.calls.length, 1);
    if (change === "quote") f.setMetadata({ ...originalMetadata, replyTo: "new-quote" });
    if (change === "mentions") f.setMetadata({ ...originalMetadata, mentions: [{ ...originalMetadata.mentions[0], user_id: "new-member" }] });
    if (change === "draft") f.app.messageInput.value = "A new draft typed while waiting";
    const currentDraft = f.app.messageInput.value, currentMetadata = f.metadata(), receipt = { run: { id: "run-a" }, replayed: false };
    f.calls[0].options.onAccepted(receipt); pending.resolve(receipt); await sending;
    assert.equal(f.app.messageInput.value, currentDraft); assert.deepEqual(f.metadata(), currentMetadata); assert.equal(f.sent(), 0);
    assert.equal(f.calls[0].options.replyTo, originalMetadata.replyTo);
    assert.equal(f.calls[0].options.mentions[0].user_id, "member-a", "the submitted options must retain the original mention selection");
  });
}

test("a deleted quote rejected by the Team service preserves the typed draft and selection for correction", async () => {
  const f = fixture(async () => { throw Object.assign(new Error("The quoted message was deleted; select another message"), { status: 409, code: "message_deleted" }); });
  const before = f.metadata(); await f.app.sendMessage("agent_request");
  assert.equal(f.app.messageInput.value, f.raw); assert.deepEqual(f.metadata(), before); assert.equal(f.sent(), 0);
  assert.match(f.app.sendError.textContent, /quoted message was deleted/u); assert.equal(f.app.pendingMessageSend, null);
});

test("an unknown Team acknowledgement preserves the draft, quote and mentions for stable recovery", async () => {
  const f = fixture(async () => { throw Object.assign(new Error("Team acknowledgement timed out. Check the previous action."), { code: "request_timeout" }); });
  const before = f.metadata(); await f.app.sendMessage("agent_request");
  assert.equal(f.app.messageInput.value, f.raw); assert.deepEqual(f.metadata(), before); assert.equal(f.sent(), 0);
  assert.equal(f.calls[0].options.replyTo, before.replyTo); assert.equal(f.calls[0].options.mentions[0].user_id, "member-a");
  assert.match(f.app.sendError.textContent, /Check the previous action/u);
});

test("Team composer errors show fixed safe guidance rather than a private exception message", async () => {
  const f = fixture(async () => { throw Object.assign(new Error("SYNTHETIC_PRIVATE_PROVIDER_BODY_MUST_NOT_APPEAR"), {
    status: 429, code: "agent_share_daily_limit" }); });
  await f.app.sendMessage("agent_request");
  assert.match(f.app.sendError.textContent, /allowance/u);
  assert.doesNotMatch(f.app.sendError.textContent, /SYNTHETIC_PRIVATE/u);
  assert.equal(f.app.messageInput.value, f.raw);
});

test("an old-session Team acknowledgement cannot clear an identical draft and quote in the new session", async () => {
  const pending = deferred(), f = fixture(() => pending.promise), before = f.metadata();
  const sending = f.app.sendMessage("agent_request"); f.app.selectedSessionGeneration++; f.app.state.session = { id: "session-b", mode: "multi" };
  const receipt = { run: { id: "run-a" }, replayed: false }; f.calls[0].options.onAccepted(receipt); pending.resolve(receipt); await sending;
  assert.equal(f.app.messageInput.value, f.raw); assert.deepEqual(f.metadata(), before); assert.equal(f.sent(), 0);
});


test("the Team composer localizes both disabled accessible names across English and Chinese switches", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  let locale = "en";
  const selects = new Map([
    ["team-agent-model-select", { label: "Model", accessible: "Team model", chinese: "团队模型" }],
    ["team-agent-effort-select", { label: "Reasoning effort", accessible: "Team reasoning effort", chinese: "团队推理强度" }],
  ].map(([id, expected]) => {
    assert.match(html, new RegExp(`<select id="${id}"[^>]*disabled[^>]*aria-label="${expected.accessible}"`), "stable IDs must identify the real disabled Team controls");
    return [id, { ...expected, disabled: true, attributes: { "aria-label": expected.accessible }, parentElement: { firstChild: { nodeType: 3, textContent: expected.label } },
      setAttribute(name, value) { this.attributes[name] = value; } }];
  }));
  const hint = { textContent: "" }, app = vm.createContext({
    element: id => id === "team-agent-profile-fields" ? { querySelector: () => hint } : selects.get(id),
    teamsUi: { t: text => locale === "zh-CN" ? TEAM_ZH_CN[text] ?? text : text },
  });
  vm.runInContext(functionSource("renderTeamProfileLabels"), app);
  for (const next of ["en", "zh-CN", "en"]) {
    locale = next; app.renderTeamProfileLabels();
    for (const select of selects.values()) {
      assert.equal(select.attributes["aria-label"], locale === "zh-CN" ? select.chinese : select.accessible);
      assert.equal(select.parentElement.firstChild.textContent, locale === "zh-CN" ? TEAM_ZH_CN[select.label] : select.label);
      assert.equal(select.disabled, true, "localization must retain module-owned model and effort configuration");
    }
  }
});
