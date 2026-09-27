import test from "node:test";
import assert from "node:assert/strict";
import { eligibleHistorySources, historySummaryTimeline, historySelectionError, selectedHistorySourceIds, historySummaryExecutionWire, historyWireEvents } from "../src/history-summaries.js";
import { DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS, isHistorySummarySource, activeHistorySummaries } from "../src/history-summary-policy.js";
import { normalizeSettings } from "../src/settings.js";
import { HttpCollaborationApi } from "../src/api.js";

const event = (id, sequence, type = "human_chat", extra = {}) => ({ id, sequence, type, sessionId: "s1",
  actor: { id: "u1", username: "Fixture" }, visibility: "session", payload: { content: id }, ...extra });
const request = (id, sequence, ids) => event(id, sequence, "agent_request", {
  payload: { content: "Generated summary prompt", history_summary: { version: 1, source_event_ids: ids, source_digest: "a".repeat(64) } },
});
const response = (id, sequence, replyTo, extra = {}) => event(id, sequence, "agent_response", { replyTo, ...extra });

test("only public completed messages and summaries are selectable, never generated prompts or progress", () => {
  const events = [event("a", 1), event("r", 2, "agent_request"), response("answer", 3, "r"),
    event("pending", 4, "agent_request"), event("failed-request", 5, "agent_request"),
    response("failure", 6, "failed-request", { payload: { content: "Failed", status: "failed" } }),
    event("private", 7, "human_chat", { visibility: "owner_only" }), event("tool", 8, "tool_result"),
    request("summary", 9, ["a"]), response("summary-answer", 10, "summary"),
    event("progress", 11, "agent_progress"), event("empty", 12, "human_chat", { payload: { content: " " } })];
  assert.deepEqual(eligibleHistorySources(events).map((item) => item.id), ["a", "r", "answer", "summary-answer"]);
  assert.deepEqual(selectedHistorySourceIds(events, new Set(["answer", "a", "private"])), ["a", "answer"]);
});

test("indexed eligibility is equivalent to shared policy across malformed, private, failed and nested records", () => {
  const events = [event("human", 1), event("request", 2, "agent_request"), response("answer", 3, "request"),
    event("pending", 4, "agent_request"), request("summary", 5, ["human", "request"]), response("summary-answer", 6, "summary"),
    request("nested", 7, ["summary-answer", "human"]), response("nested-answer", 8, "nested"),
    request("forged", 9, ["human"]), response("forged-answer", 10, "forged", { actor: { id: "other" } }),
    event("malformed", 11, "agent_request", { payload: { content: "reserved", history_summary: "invalid" } }),
    response("malformed-answer", 12, "malformed"), event("reply-chat", 13, "human_chat", { replyTo: "summary" }),
    response("payload-forged", 14, undefined, { payload: { content: "ordinary response", reply_to_event_id: "summary" } }),
    event("array-payload", 15, "human_chat", { payload: Object.assign([], { content: "not a record" }) })];
  for (const visibility of ["session", "owner_only", undefined]) {
    for (const status of [undefined, "completed", "succeeded", "failed", "cancelled", "running", ""]) {
      for (const error of [undefined, null, false, "failure"]) {
        const id = `case-${events.length}`;
        events.push(event(id, events.length + 1, "agent_request", { visibility }));
        events.push(response(`${id}-reply`, events.length + 1, id, { visibility,
          payload: { text: "Fixture result", ...(status === undefined ? {} : { status }), ...(error === undefined ? {} : { error }) } }));
      }
    }
  }
  const wire = historyWireEvents(events);
  const expected = wire.filter((item) => item.visibility === "session" && isHistorySummarySource(item, wire)).map((item) => item.id);
  assert.deepEqual(eligibleHistorySources(events).map((item) => item.id), expected);
  assert.deepEqual(historySummaryTimeline(events).active.map((item) => item.id), activeHistorySummaries(wire).map((item) => item.request.id));
});

test("10k-event history uses bounded full-history scans for eligibility and version response lookup", (t) => {
  const events = [];
  for (let index = 0; index < 5000; index += 1) {
    const id = `request-${index}`;
    events.push(event(id, events.length + 1, "agent_request"));
    events.push(response(`answer-${index}`, events.length + 1, id));
  }
  for (let index = 0; index < 500; index += 1) {
    events.push(request(`summary-${index}`, events.length + 1, [`request-${index}`]));
    events.push(response(`summary-answer-${index}`, events.length + 1, `summary-${index}`));
  }
  const nativeSome = Array.prototype.some, nativeFind = Array.prototype.find;
  let largeSome = 0, largeFind = 0;
  const start = performance.now();
  try {
    // Count algorithmic work, not a machine-dependent timing threshold. A full
    // history scan per ordinary response or summary version is a regression.
    Array.prototype.some = function (...args) { if (this.length >= 10000) largeSome += 1; return nativeSome.apply(this, args); };
    Array.prototype.find = function (...args) { if (this.length >= 10000) largeFind += 1; return nativeFind.apply(this, args); };
    assert.equal(eligibleHistorySources(events).length, 10500);
    const plan = historySummaryTimeline(events);
    assert.equal(plan.versions.length, 500);
    assert.equal(plan.active.length, 500);
    assert.equal(plan.hidden.has("answer-4999"), false);
  } finally {
    Array.prototype.some = nativeSome;
    Array.prototype.find = nativeFind;
  }
  t.diagnostic(`${events.length} records: ${Math.round(performance.now() - start)} ms; full-history some=${largeSome}, find=${largeFind}`);
  assert.ok(largeSome <= 4, "Source eligibility must not scan the complete event list for each source.");
  assert.equal(largeFind, 0, "Version responses must use a prebuilt reply index.");
});

test("a long summary ancestry chain shares one resolver rather than rebuilding it per version", (t) => {
  const events = [event("root", 1)];
  for (let index = 0; index < 1000; index += 1) {
    events.push(request(`chain-${index}`, events.length + 1, [index ? `chain-answer-${index - 1}` : "root"]));
    events.push(response(`chain-answer-${index}`, events.length + 1, `chain-${index}`));
  }
  const nativeMap = Array.prototype.map;
  let versionMapBuilds = 0;
  const start = performance.now();
  try {
    Array.prototype.map = function (...args) {
      if (this.length === 1000 && this[0]?.sourceEventIds) versionMapBuilds += 1;
      return nativeMap.apply(this, args);
    };
    const plan = historySummaryTimeline(events);
    assert.equal(plan.versions.length, 1000);
    assert.deepEqual(plan.active.map((version) => version.id), ["chain-999"]);
    assert.deepEqual(plan.active[0].coverage.map((source) => source.id), ["root"]);
  } finally { Array.prototype.map = nativeMap; }
  t.diagnostic(`1000 nested summaries: ${Math.round(performance.now() - start)} ms; version-wide map builds=${versionMapBuilds}`);
  assert.ok(versionMapBuilds <= 10, "Reuse ancestry indexes and memoized expansions for every version.");
});

test("newest whole non-overlapping summaries fold at their first source, preserving every unselected original", () => {
  const events = [event("a", 1), event("middle", 2), event("b", 3), event("c", 4),
    request("old", 5, ["a", "b"]), response("old-answer", 6, "old"),
    request("new", 7, ["b", "c"]), response("new-answer", 8, "new")];
  const plan = historySummaryTimeline(events);
  assert.deepEqual(plan.active.map((item) => item.id), ["new"]);
  assert.equal(plan.versions.length, 2);
  assert.equal(plan.before.get("b")[0].id, "new");
  assert.equal(plan.hidden.has("a"), false);
  assert.equal(plan.hidden.has("middle"), false);
  assert.equal(plan.hidden.has("b"), true);
  assert.equal(plan.hidden.has("c"), true);
  assert.equal(plan.hidden.has("old-answer"), true);
  assert.deepEqual(eligibleHistorySources(events).map((item) => item.id), ["a", "middle", "b", "c", "old-answer", "new-answer"]);
  for (const options of [{ selecting: true }, { original: true }, { expanded: new Set(["new"]) }]) {
    const expanded = historySummaryTimeline(events, options);
    assert.equal(expanded.hidden.has("b"), false);
    assert.equal(expanded.hidden.has("c"), false);
  }
});

test("selecting a summary and overlapping originals deduplicates ancestry and keeps old versions selectable", () => {
  const events = [event("a", 1), event("b", 2), event("c", 3), event("untouched", 4),
    request("old", 5, ["a", "b"]), response("old-answer", 6, "old"),
    request("nested", 7, ["old-answer", "b", "c"]), response("nested-answer", 8, "nested")];
  const plan = historySummaryTimeline(events);
  assert.deepEqual(plan.active.map((version) => version.id), ["nested"]);
  assert.deepEqual(plan.active[0].coverage.map((source) => source.id), ["a", "b", "c"]);
  assert.equal(plan.before.get("a")[0].id, "nested");
  assert.equal(plan.hidden.has("untouched"), false);
  const selection = historySummaryTimeline(events, { selecting: true });
  assert.equal(selection.hidden.has("a"), false);
  assert.equal(selection.before.get("old")[0].response.id, "old-answer");
  assert.equal(selection.before.get("nested")[0].response.id, "nested-answer");
  assert.equal(historySelectionError(events, ["old-answer", "c"]), "");
});

test("pending, failed, private, forged and incomplete summaries never hide originals", () => {
  const events = [event("a", 1), request("pending", 2, ["a"]), request("failed", 3, ["a"]),
    response("failure", 4, "failed", { payload: { content: "failed", status: "failed" } }),
    request("missing", 5, ["not-loaded"]), response("missing-answer", 6, "missing"),
    request("forged", 7, ["a"]), response("forged-answer", 8, "forged", { actor: { id: "other" } })];
  const plan = historySummaryTimeline(events);
  assert.equal(plan.active.length, 0);
  assert.equal(plan.hidden.has("a"), false);
  assert.equal(plan.before.get("pending")[0].status, "pending");
  assert.equal(plan.before.get("failed")[0].status, "failed");
  assert.equal(historySummaryTimeline([event("a", 1), { ...request("private", 2, ["a"]), visibility: "owner_only" }]).versions.length, 0);
});

test("selection caps reject duplicate IDs, unavailable originals and UTF-8 serialized sources without truncation", () => {
  assert.match(historySelectionError([event("a", 1)], []), /1 and 100/);
  assert.match(historySelectionError([event("a", 1)], ["a", "a"]), /1 and 100/);
  assert.match(historySelectionError([event("a", 1)], ["missing"]), /no longer available/);
  const large = event("large", 1, "human_chat", { payload: { content: "中".repeat(6900) } });
  assert.match(historySelectionError([large], ["large"]), /20 KiB/);
  assert.equal(large.payload.content.length, 6900);
});

test("summary instructions migrate additively, preserve edits and reset invalid values to the shared default", () => {
  assert.equal(normalizeSettings({ version: 11 }).historySummaries.instructions, DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS);
  assert.equal(normalizeSettings({ historySummaries: { instructions: "Keep exact units.\n保留单位。" } }).historySummaries.instructions, "Keep exact units.\n保留单位。");
  for (const instructions of ["", " ", "x".repeat(4001), { token: "fixture" }]) {
    assert.equal(normalizeSettings({ historySummaries: { instructions } }).historySummaries.instructions, DEFAULT_HISTORY_SUMMARY_INSTRUCTIONS);
  }
});

test("summary HTTP mapping freezes exact runtime, source IDs, instructions and idempotency; context policy is server-backed", async () => {
  const calls = [];
  const api = new HttpCollaborationApi();
  api.request = async (path, options) => {
    calls.push({ path, ...options, body: options?.body && JSON.parse(options.body) });
    if (path.endsWith("history-summaries")) return { event: { id: "sum1", sequence: 3, session_id: "s1", actor_user_id: "u1",
      visibility: "session", type: "agent_request", idempotency_key: "same-key", payload: request("sum1", 3, ["a"]).payload } };
    return { mode: "original" };
  };
  const receipt = await api.createHistorySummary("s1", { sourceEventIds: ["a"], instructions: "Preserve units.", idempotencyKey: "same-key",
    executionProfile: { harness: "deepseek-harness", provider: "local", model: "model-X", runtimeId: "runtime-exact", reasoningEffort: "high" } });
  assert.equal(receipt.visibility, "session");
  assert.equal(receipt.idempotencyKey, "same-key");
  assert.deepEqual(calls[0], { path: "/v1/sessions/s1/history-summaries", method: "POST", body: {
    idempotency_key: "same-key", source_event_ids: ["a"], instructions: "Preserve units.",
    execution_profile: { harness: "deepseek-harness", provider: "local", model: "model-X", runtime_id: "runtime-exact", reasoning_effort: "high" },
  } });
  assert.throws(() => historySummaryExecutionWire({ harness: "codex", model: "m" }), /exact online/);
  await api.getProjectContextPolicy("p1");
  await api.setProjectContextPolicy("p1", "original");
  assert.equal(calls[1].path, "/v1/projects/p1/context-policy");
  assert.deepEqual(calls[2].body, { mode: "original" });
});
