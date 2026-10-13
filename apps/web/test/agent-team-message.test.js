import test from "node:test";
import assert from "node:assert/strict";
import { teamMessagePresentation } from "../src/agent-team-message.js";
const request = { id: "request-fixture", type: "agent_request", actor: { id: "owner-fixture" }, payload: { agent_team: { run_id: "run-fixture", step_id: "step-fixture", node_id: "lead", node_label: "Director", task_content: "Human task" } } };
const response = { id: "response-fixture", replyTo: request.id, actor: request.actor, type: "agent_response", payload: {} };
const block = step => `\n\n\`\`\`gatherthread-team\n${JSON.stringify({ version: 1, step_id: step, action: "complete" })}\n\`\`\``;
test("team rendering keeps canonical instructions and routing recoverable without changing copy source", () => {
  const source = "Canonical team instructions";
  assert.deepEqual(teamMessagePresentation(request, [request], source), { ...request.payload.agent_team, ownerId: request.actor.id, content: "Human task", details: source, kind: "instructions" });
  const answer = "Observed result" + block("step-fixture");
  const shown = teamMessagePresentation(response, [request], answer);
  assert.equal(shown.content, "Observed result"); assert.equal(shown.kind, "routing");
  assert.equal(shown.content + "\n\n" + shown.details, answer); assert.equal(request.payload.agent_team.task_content, "Human task");
});
test("unverified, duplicate, nonterminal and erased team controls stay visible or lose derived presentation", () => {
  for (const content of ["Answer" + block("other-step"), block("step-fixture") + block("step-fixture"), block("step-fixture") + "\nMore text", "```gatherthread-team\nnot json\n```", "Inline " + block("step-fixture").trimStart()])
    assert.equal(teamMessagePresentation(response, [request], content).content, content);
  assert.equal(teamMessagePresentation({ ...response, actor: { id: "foreign" } }, [request], "Answer"), null);
  assert.equal(teamMessagePresentation(response, [{ ...request, deleted: { reason: "author" } }], "Answer"), null);
  assert.equal(teamMessagePresentation({ ...response, contentUnavailable: true }, [request], "Answer"), null);
});
