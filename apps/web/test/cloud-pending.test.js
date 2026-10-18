import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { composerAgentAction } from "../src/agent-request-control.js";

const cloudRequest = { id: "cloud-request", type: "agent_request", actor: { id: "me" },
  payload: { profile_id: "free", execution_profile: { harness: "opencode", model: "free-model" } } };
test("cloud pending messages never wait for a local connector", () => {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const body = source.match(/function renderAgentPendingStatus\(request, progressEvents = \[\]\) \{[\s\S]*?\n\}/)[0];
  const createElement = () => ({ children: [], dataset: {}, setAttribute() {}, append(...nodes) { this.children.push(...nodes); } });
  const sandbox = { document: { createElement }, state: { session: { members: [] } },
    isExecutionRuntime: () => false, localizer: { t: text => text },
    latestStreamedText: (events) => events?.length ? "Reading the parser" : "" };
  vm.createContext(sandbox); vm.runInContext(body, sandbox);
  const pending = sandbox.renderAgentPendingStatus(cloudRequest);
  assert.equal(pending.dataset.state, "answering");
  assert.match(pending.children[1].textContent, /Cloud Agent/);
  assert.doesNotMatch(pending.children[1].textContent, /local runtime/);

  const streamed = sandbox.renderAgentPendingStatus(cloudRequest, [{ payload: { content: "x" } }]);
  assert.equal(streamed.dataset.streamed, "true");
  assert.equal(streamed.children[1].textContent, "Agent: Working");
  assert.doesNotMatch(streamed.children[1].textContent, /Reading the parser/,
    "the full answer is displayed in its section, not repeated in the compact status");
});

test("cloud progress uses cloud controls without exposing the local claim route", () => {
  const progress = { type: "agent_progress", replyTo: cloudRequest.id, payload: { status: "working" } };
  assert.equal(composerAgentAction([cloudRequest, progress], "me").action, "pause");
  assert.equal(composerAgentAction([cloudRequest, progress], "me").cloud, true);
  assert.equal(composerAgentAction([{ ...cloudRequest, payload: { ...cloudRequest.payload, github_task_id: "fixture" } }, progress], "me").action, "wait");
  assert.equal(composerAgentAction([cloudRequest, { type: "agent_response", replyTo: cloudRequest.id }], "me").action, "request");
});

test("Team pending status follows its exact module route instead of another connection belonging to that member", () => {
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const body = source.match(/function renderAgentPendingStatus\(request, progressEvents = \[\]\) \{[\s\S]*?\n\}/)[0];
  const createElement = () => ({ children: [], dataset: {}, setAttribute() {}, append(...nodes) { this.children.push(...nodes); } });
  const exact = { id: "codex-route", harness: "codex", status: "online" };
  const sandbox = { document: { createElement }, state: { session: { members: [
    { userId: "me", runtime: { id: "unrelated-dsh", harness: "deepseek-harness", status: "online" } },
  ] }, executionRuntimes: [exact] }, isExecutionRuntime: runtime => runtime?.status === "online",
    localizer: { t: text => ({ Working: "正在工作", "Waiting for Agent…": "等待 Agent…" })[text] ?? text },
    teamsUi: { t: text => ({ Team: "团队", "Team test": "团队测试" })[text] ?? text }, latestStreamedText: () => "" };
  vm.createContext(sandbox); vm.runInContext(body, sandbox);
  const request = { id: "module-request", type: "agent_request", actor: { id: "me" }, payload: {
    agent_team: { node_label: "审阅模块" }, execution_profile: { runtime_id: exact.id, harness: "codex", model: "fixture" } } };
  const running = sandbox.renderAgentPendingStatus(request);
  assert.equal(running.dataset.state, "answering");
  assert.equal(running.children[1].textContent, "团队 · 审阅模块: 正在工作");
  exact.status = "offline";
  const waiting = sandbox.renderAgentPendingStatus(request);
  assert.equal(waiting.dataset.state, "queued", "another online DSH must not stand in for this module's offline Codex");
  assert.equal(waiting.children[1].textContent, "团队 · 审阅模块: 等待 Agent…");
  sandbox.state.executionRuntimes = [];
  assert.equal(sandbox.renderAgentPendingStatus(request, [{ type: "agent_progress" }]).dataset.state, "answering",
    "other viewers can recognize canonical progress even when they cannot list this user's exact runtime");
  const cloud = { ...request, payload: { ...request.payload, execution_profile: { harness: "opencode" } } };
  assert.equal(sandbox.renderAgentPendingStatus(cloud).dataset.state, "answering");
  assert.equal(sandbox.renderAgentPendingStatus({ ...cloud, actor: { id: "no-longer-member" } }).dataset.state, "answering",
    "retained Team history must render after its original actor leaves the project");
  const shared = { ...request, sharedExecution: { job_id: "shared-module-job" } };
  assert.equal(sandbox.renderAgentPendingStatus(shared).dataset.state, "queued");
  assert.equal(sandbox.renderAgentPendingStatus(shared, [{ sharedExecution: shared.sharedExecution }]).dataset.state, "answering");
});
