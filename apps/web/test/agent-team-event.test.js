import assert from "node:assert/strict";
import test from "node:test";
import { teamEventPresentation } from "../src/agent-team-event.js";

const marker = { run_id: "run-a", step_id: "step-a", node_id: "node-a", node_label: "Planner", task_content: "Review the fixture" };
const request = (overrides = {}) => ({ id: "request-a", type: "agent_request", payload: { content: "Internal execution prompt", agent_team: marker }, ...overrides });
const response = (content, overrides = {}) => ({ id: "response-a", type: "agent_response", replyTo: "request-a", payload: { content }, ...overrides });
const block = decision => `\`\`\`gatherthread-team\n${JSON.stringify(decision)}\n\`\`\``;
const complete = { version: 1, step_id: "step-a", action: "complete" };
const zh = text => ({ Team: "团队", "Team test": "团队测试", "Checking this module's connection.": "正在检查模块连接。",
  "Module connection succeeded.": "模块连接成功。", "Module finished.": "模块已完成。", "Awaiting clarification": "等待澄清" })[text] ?? text;

test("only Team-marked requests and their linked replies receive a Team display transformation", () => {
  const original = request(), ordinary = request({ id: "ordinary", payload: { content: "Regular request" } });
  assert.deepEqual(teamEventPresentation(original, [original], zh), { label: "团队 · Planner", content: "Review the fixture" });
  assert.deepEqual(teamEventPresentation(response("Ordinary answer"), [original], zh), { label: "团队 · Planner" });
  assert.equal(teamEventPresentation(ordinary, [ordinary]), null);
  assert.equal(teamEventPresentation(response("Regular answer", { replyTo: "ordinary" }), [ordinary]), null);
  assert.equal(teamEventPresentation(response("Unlinked answer", { replyTo: "missing", payload: { content: "Unlinked answer", agent_team: marker } }), [original]), null,
    "a reply cannot manufacture Team attribution with its own payload marker");
  assert.equal(teamEventPresentation({ id: "chat-a", type: "human_chat", payload: { content: "Human text", agent_team: marker } }, [original]), null);
  assert.equal(teamEventPresentation({ id: "progress-a", type: "agent_progress", replyTo: original.id, payload: { content: "Progress", agent_team: marker } }, [original]), null);
});

test("deleted or unavailable requests and replies never reintroduce hidden task text through presentation", () => {
  for (const flag of [{ deleted: { reason: "author" } }, { contentUnavailable: true }]) {
    const hiddenRequest = request(flag), normalRequest = request();
    assert.equal(teamEventPresentation(hiddenRequest, [hiddenRequest]), null);
    assert.equal(teamEventPresentation(response("GT_TEAM_OK:node-a:step-a"), [hiddenRequest]), null);
    assert.equal(teamEventPresentation(response("Result", flag), [normalRequest]), null);
  }
});

test("connectivity probes show readable Chinese text only for the exact node and step nonce", () => {
  const probe = request({ payload: { content: "Internal probe prompt", agent_team: { ...marker, purpose: "test" } } });
  assert.deepEqual(teamEventPresentation(probe, [probe], zh), { label: "团队测试 · Planner", content: "正在检查模块连接。" });
  assert.deepEqual(teamEventPresentation(response(" \nGT_TEAM_OK:node-a:step-a\n "), [probe], zh), { label: "团队测试 · Planner", content: "模块连接成功。" });
  for (const text of ["GT_TEAM_OK:node-b:step-a", "GT_TEAM_OK:node-a:step-b", "GT_TEAM_OK:node-a:step-a:extra", "Prefix GT_TEAM_OK:node-a:step-a", "GT_TEAM_OK:node-a:step-a\nExtra answer"]) {
    assert.deepEqual(teamEventPresentation(response(text), [probe], zh), { label: "团队测试 · Planner" }, "invalid nonce text must remain available to the normal renderer");
  }
  assert.deepEqual(teamEventPresentation(response("GT_TEAM_OK:node-a:step-a"), [request()], zh), { label: "团队 · Planner" }, "normal task text resembling a probe is not relabeled as a connectivity success");
});

test("valid terminal complete and delegate controls are hidden only in the derived display", () => {
  const source = request();
  for (const decision of [complete, { version: 1, step_id: "step-a", action: "delegate", target_node_id: "node-b", task: "Check fixture" }]) {
    const text = `Public result\n\n${block(decision)}\n`, event = response(text), before = structuredClone(event);
    Object.freeze(event.payload); Object.freeze(event);
    assert.deepEqual(teamEventPresentation(event, [source], zh), { label: "团队 · Planner", content: "Public result" });
    assert.deepEqual(event, before, "canonical content must retain its exact routing receipt");
    assert.equal(event.payload.content, text);
  }
  assert.deepEqual(teamEventPresentation(response(block(complete)), [source], zh), { label: "团队 · Planner", content: "模块已完成。" });
});

test("bad JSON, wrong step, wrong version/action and nonterminal fences remain in ordinary content", () => {
  const source = request();
  for (const text of [
    "Public\n```gatherthread-team\n{broken\n```",
    `Public\n${block({ ...complete, step_id: "step-b" })}`,
    `Public\n${block({ ...complete, version: 2 })}`,
    `Public\n${block({ ...complete, action: "pause" })}`,
    `Public\n${block(complete)}\nAdditional public text`,
    "Public\n```json\n{}\n```",
    `Public\n${block(complete)}\n${block(complete)}`,
  ]) {
    const event = response(text);
    assert.deepEqual(teamEventPresentation(event, [source], zh), { label: "团队 · Planner" });
    assert.equal(event.payload.content, text);
  }
});

test("content aliases are supported without changing the original message and node labels remain literal strings", () => {
  const literal = "<img src=x onerror='fixture()'>", source = request({ payload: { agent_team: { ...marker, node_label: literal } } });
  assert.equal(teamEventPresentation(source, [source], zh).label, `团队 · ${literal}`);
  for (const event of [response("unused", { payload: { text: `Alias answer\n${block(complete)}` } }),
    response("unused", { payload: {}, content: `Alias answer\n${block(complete)}` })]) {
    const before = structuredClone(event);
    assert.deepEqual(teamEventPresentation(event, [source], zh), { label: `团队 · ${literal}`, content: "Alias answer" });
    assert.deepEqual(event, before);
  }
  assert.deepEqual(teamEventPresentation(response("unused", { payload: {} }), [source], zh), { label: `团队 · ${literal}` });
});

test("a verified terminal clarify directive preserves the public question while leaving canonical content untouched", () => {
  const source = request(), decision = { version: 1, step_id: "step-a", action: "clarify" };
  const event = response(`Which requirement takes priority?\n${block(decision)}`), original = structuredClone(event);
  Object.freeze(event.payload); Object.freeze(event);
  assert.deepEqual(teamEventPresentation(event, [source], zh), { label: "团队 · Planner", content: "Which requirement takes priority?" });
  assert.deepEqual(event, original);
  assert.deepEqual(teamEventPresentation(response(block(decision)), [source], zh), { label: "团队 · Planner", content: "等待澄清" },
    "a clarification without public text must not be displayed as a completed module");
});

test("clarify display accepts only the current step's exact fields and does not relax delegate validation", () => {
  const source = request();
  for (const decision of [
    { version: 1, step_id: "step-b", action: "clarify" },
    { version: 1, step_id: "step-a", action: "clarify", task: "Unexpected field" },
    { version: 1, step_id: "step-a", action: "clarify", target_node_id: "node-b" },
    { version: 1, action: "clarify" },
    { version: 1, step_id: "step-a", action: "delegate" },
    { version: 1, step_id: "step-a", action: "delegate", target_node_id: "node-b", task: "" },
    { version: 1, step_id: "step-a", action: "delegate", target_node_id: "bad node", task: "Do a check" },
    { version: 1, step_id: "step-a", action: "delegate", target_node_id: "node-b", task: "Do a check", extra: true },
  ]) {
    const event = response(`Public details\n${block(decision)}`);
    assert.deepEqual(teamEventPresentation(event, [source], zh), { label: "团队 · Planner" });
    assert.equal(event.payload.content, `Public details\n${block(decision)}`);
  }
});
