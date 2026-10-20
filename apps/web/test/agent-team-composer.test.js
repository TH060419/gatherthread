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
const node = () => ({ value: "", textContent: "", disabled: false, childNodes: [], focus: noop, handlers: new Map(),
  addEventListener(type, handler) { this.handlers.set(type, handler); },
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

test("exact Team recovery clears its old composer error without changing a newer draft", async () => {
  const f = fixture(async () => { throw Object.assign(Error("lost ACK"), { status: 0 }); });
  await f.app.sendMessage("agent_request"); assert.match(f.app.sendError.textContent, /unconfirmed/u);
  f.app.messageInput.value = "A newer draft";
  f.calls[0].options.onAccepted({ run: { id: "recovered" } });
  assert.equal(f.app.sendError.textContent, ""); assert.equal(f.app.messageInput.value, "A newer draft");
});

test("exact Team recovery cannot erase a newer composer validation error or an error in another scope", async () => {
  const f = fixture(async () => { throw Object.assign(Error("lost ACK"), { status: 0 }); });
  await f.app.sendMessage("agent_request");
  f.app.messageInput.value = ""; await f.app.sendMessage("agent_request");
  assert.equal(f.app.sendError.textContent, "Write a message first.");
  f.calls[0].options.onAccepted({ run: { id: "recovered" } });
  assert.equal(f.app.sendError.textContent, "Write a message first.");
  f.app.selectedSessionGeneration++; f.app.sendError.textContent = "A new session problem";
  f.calls[0].options.onAccepted({ run: { id: "recovered" } }); assert.equal(f.app.sendError.textContent, "A new session problem");
});

test("both production Team controls derive emergency permission independently of realtime append readiness", async () => {
  const { canAppend } = await import("../src/domain.js");
  const start = source.indexOf("const teamsUi = mountAgentTeams("), end = source.indexOf("\n});", start) + 4;
  const app = vm.createContext({
    mountAgentTeams: options => options,
    document: {}, api: {}, element: () => ({}), createIdempotencyKey: () => "unused", window: {},
    refreshDshRuntimes: noop, refreshHostedAgentStatus: noop, renderComposerPermissions: noop,
    authenticationGeneration: 1, selectedSessionGeneration: 1, canAppend,
    sharedAgentsUi: { agents: () => [], refresh: noop }, hostedAgentStatus: { profiles: [] },
    state: { currentUser: { id: "alice" }, project: { id: "project-a" },
      session: { id: "session-a", mode: "multi", members: [{ userId: "alice", role: "owner" }] },
      sync: { phase: "replaying", events: [], contentRevision: 0 }, executionRuntimes: [], devices: [] },
  });
  vm.runInContext(source.slice(start, end).replace("const teamsUi =", "globalThis.teamOptions ="), app);
  for (const phase of ["connecting", "replaying", "offline", "live"]) {
    app.state.sync.phase = phase; const context = app.teamOptions.getContext();
    assert.equal(context.writable, phase === "live"); assert.equal(context.controlWritable, true);
  }
  app.state.session.members[0].role = "viewer"; assert.equal(app.teamOptions.getContext().controlWritable, false);
  const composerStart = source.indexOf("const agentRequestControl = mountAgentRequestControl("), composerEnd = source.indexOf("\n});", composerStart) + 4;
  app.mountAgentRequestControl = options => options; app.teamsUi = { activeRun: () => ({ id: "team-a", status: "running" }) };
  app.localizer = { t: value => value }; app.document.documentElement = { dataset: {} }; app.mobileControlLabel = value => value;
  app.currentProjectHarness = () => "team"; app.pendingMessageSend = null; app.sendAgentButton = {}; app.sendError = {};
  vm.runInContext(source.slice(composerStart, composerEnd).replace("const agentRequestControl =", "globalThis.composerOptions ="), app);
  app.state.session.members[0].role = "owner"; app.state.sync.phase = "replaying";
  assert.equal(app.composerOptions.getContext().writable, false); assert.equal(app.composerOptions.getContext().controlWritable, true);
  app.state.session.members[0].role = "viewer"; assert.equal(app.composerOptions.getContext().controlWritable, false);
});

test("an old acceptance cannot clear a newer Team error with identical public wording", async () => {
  const f = fixture(async () => { throw Object.assign(Error("lost ACK"), { status: 0 }); });
  await f.app.sendMessage("agent_request"); const original = f.calls[0].options;
  f.app.messageInput.value = "Another task"; await f.app.sendMessage("agent_request");
  const newerText = f.app.sendError.textContent; assert.match(newerText, /unconfirmed/u);
  original.onAccepted({ run: { id: "older-accepted" } }); assert.equal(f.app.sendError.textContent, newerText);
  f.calls[1].options.onAccepted({ run: { id: "newer-accepted" } }); assert.equal(f.app.sendError.textContent, "");
});

for (const invalidation of ["history", "obsolete", "validation", "newer_problem"]) {
  test(`late Team start failure preserves the composer after ${invalidation}`, async () => {
    const pending = deferred(), f = fixture(() => pending.promise), before = f.metadata();
    const sending = f.app.sendMessage("agent_request");
    let expected = "";
    if (invalidation === "history") f.app.state.sync.contentRevision++;
    if (invalidation === "obsolete") f.app.teamsUi.isObsoleteError = () => true;
    if (invalidation === "validation") {
      f.app.messageInput.value = ""; await f.app.sendMessage("agent_request");
      expected = "Write a message first.";
    }
    if (invalidation === "newer_problem") {
      f.app.sendError.textContent = expected = "A more recent problem";
    }
    pending.reject(Object.assign(Error("synthetic delayed failure"), { status: 409, code: "agent_team_model_unavailable",
      details: { node_label: "OBSOLETE_PRIVATE_MODULE" } }));
    await sending;
    assert.equal(f.app.sendError.textContent, expected);
    assert.doesNotMatch(f.app.sendError.textContent, /OBSOLETE_PRIVATE_MODULE/u);
    assert.deepEqual(f.metadata(), before); assert.equal(f.sent(), 0); assert.equal(f.app.pendingMessageSend, null);
  });
}

for (const invalidation of ["history", "obsolete", "validation"]) {
  test(`late Team recovery failure preserves the composer after ${invalidation}`, async () => {
    const f = fixture(), pending = deferred();
    f.app.teamsUi.recover = () => pending.promise;
    const start = source.indexOf('element("team-agent-recover").addEventListener(');
    const end = source.indexOf('\nelement("shared-agent-recover")', start);
    assert.ok(start > 0 && end > start); vm.runInContext(source.slice(start, end), f.app);
    const old = { text: "Earlier unknown result" };
    f.app.sendError.textContent = old.text; f.app.sendError.teamProblemIntent = old;
    const recovering = f.app.element("team-agent-recover").handlers.get("click")();
    let expected = old.text;
    if (invalidation === "history") f.app.state.sync.contentRevision++;
    if (invalidation === "obsolete") f.app.teamsUi.isObsoleteError = () => true;
    if (invalidation === "validation") {
      f.app.messageInput.value = ""; await f.app.sendMessage("agent_request"); expected = "Write a message first.";
    }
    pending.reject(Object.assign(Error("synthetic delayed recovery"), { status: 409, code: "agent_team_model_unavailable",
      details: { node_label: "OBSOLETE_PRIVATE_MODULE" } }));
    await recovering;
    assert.equal(f.app.sendError.textContent, expected);
    assert.doesNotMatch(f.app.sendError.textContent, /OBSOLETE_PRIVATE_MODULE/u);
    assert.equal(f.sent(), 0);
  });
}

for (const newer of [false, true]) {
  test(`a previously displayed Team diagnostic is removed on invalidation without clearing a newer problem (${newer})`, async () => {
    const problem = Object.assign(Error("synthetic module unavailable"), { status: 409, code: "agent_team_model_unavailable",
      details: { node_label: "EXPIRED_MODULE_LABEL" } });
    const f = fixture(async () => { throw problem; }); let obsolete = false;
    f.app.teamsUi.isObsoleteError = value => value === problem && obsolete;
    await f.app.sendMessage("agent_request"); assert.match(f.app.sendError.textContent, /EXPIRED_MODULE_LABEL/u);
    if (newer) f.app.sendError.textContent = "Keep this newer problem";
    obsolete = true;
    vm.runInContext(functionSource("clearStaleTeamComposerProblem"), f.app);
    f.app.clearStaleTeamComposerProblem();
    assert.equal(f.app.sendError.textContent, newer ? "Keep this newer problem" : "");
    assert.equal(f.app.sendError.teamProblemIntent, undefined);
    assert.equal(f.app.messageInput.value, f.raw); assert.equal(f.sent(), 0);
  });
}
