import assert from "node:assert/strict";
import test from "node:test";
import { describeTeamActionError, formatTeamRunIssue, isTeamActionUncertain, teamTimeoutContinuationAvailable } from "../src/agent-team-diagnostics.js";
import { TEAM_ZH_CN } from "../src/agent-team-i18n.js";

const zh = text => TEAM_ZH_CN[text] ?? text;
const issueRun = (code, status = "failed") => ({ status, error_code: code,
  issue: { code, node_id: "node-a", node_label: "研究模块", target_kind: "shared", retry_at: null } });

for (const code of [
  "agent_share_daily_limit", "agent_share_offline", "agent_share_revoked", "agent_share_lease_expired", "agent_share_profile_changed",
  "agent_share_request_cancelled", "agent_share_busy", "agent_share_source_capacity", "agent_share_execution_failed", "agent_share_locked",
  "agent_share_context_too_large", "agent_share_output_too_large", "agent_share_progress_limit", "agent_share_storage_full",
  "agent_team_deadline", "agent_team_call_limit", "agent_team_authorization_lost", "agent_team_target_unavailable", "agent_team_model_unavailable",
  "agent_team_runtime_offline", "agent_team_runtime_revoked", "agent_team_native_exit_pending", "agent_team_native_hold_capacity", "agent_team_storage_full", "agent_team_prompt_too_large", "agent_team_plan_too_large",
  "agent_team_sensitive_input", "agent_share_sensitive_input", "agent_team_probe_failed", "agent_team_agent_failed", "agent_team_execution_failed",
  "runtime_offline", "runtime_revoked", "model_unavailable", "agent_share_unsupported", "access_changed", "context_changed",
  "team_directive_invalid", "team_directive_mismatch", "team_delegation_forbidden", "team_response_route_mismatch", "team_clarification_missing",
  "provider_auth_failed", "cloud_api_unavailable", "cloud_api_changed", "cloud_api_invalid", "hosted_profile_changed", "hosted_profile_unavailable",
  "provider_rate_limited", "cloud_api_limit", "hosted_daily_limit", "hosted_user_quota", "hosted_global_budget", "provider_unavailable", "provider_request_failed",
  "hosted_runner_unavailable", "hosted_context_too_large", "hosted_code_too_large", "hosted_access_changed", "storage_quota_exceeded",
  "codex_turn_cancelled", "codex_turn_missing", "codex_turn_failed", "harness_execution_failed", "agent_request_abandoned", "container_failed",
  "container_interrupted", "agent_startup_failed", "agent_session_failed", "agent_answer_failed", "agent_idle_failed", "agent_shutdown_failed",
  "empty_agent_result", "container_output_too_large", "test_replaced",
]) test(`run diagnostic safely explains ${code} in Chinese and English`, () => {
  const run = issueRun(code), english = formatTeamRunIssue(run), chinese = formatTeamRunIssue(run, zh);
  assert.equal(english.code, code); assert.equal(chinese.code, code);
  assert.equal(chinese.moduleLabel, "研究模块"); assert.match(chinese.reason, /[\u4e00-\u9fff]/u);
  assert.match(chinese.advice, /[\u4e00-\u9fff]/u); assert.notEqual(english.reason, chinese.reason);
  assert.notEqual(english.advice, chinese.advice);
});

test("native execution failure does not speculate about an expired claim", () => {
  for (const code of ["codex_turn_failed", "harness_execution_failed"]) {
    const diagnostic = formatTeamRunIssue(issueRun(code), zh);
    assert.match(diagnostic.reason, /未能完成本次执行/u);
    assert.doesNotMatch(diagnostic.reason, /租约|认领/u);
  }
  const abandoned = formatTeamRunIssue(issueRun("agent_request_abandoned"), zh);
  assert.match(abandoned.reason, /执行认领已失效.*未收到最终结果/u);
});

test("native exit waits and retained-record capacity tell users how to recover without unsafe duplicate execution", () => {
  const waiting = formatTeamRunIssue(issueRun("agent_team_native_exit_pending", "running"), zh);
  assert.match(waiting.reason, /旧的本地执行尚未确认退出.*尚未开始/u);
  assert.match(waiting.advice, /原设备的连接程序.*旧任务已真正停止.*请勿重复提交.*退出确认/u);
  const ended = formatTeamRunIssue(issueRun("agent_team_native_exit_pending", "stopped"), zh);
  assert.doesNotMatch(ended.advice, /本次调用会.*等待/u);
  const full = formatTeamRunIssue(issueRun("agent_team_native_hold_capacity", "running"), zh);
  assert.match(full.reason, /退出确认记录.*容量上限/u);
  assert.match(full.advice, /确认进程退出前不要清除安全记录.*清理 Team 运行记录不会释放/u);
});

test("a shared quota failure identifies the module, quota, reset and exact configuration recovery", () => {
  const diagnostic = formatTeamRunIssue(issueRun("agent_share_daily_limit"), zh);
  assert.match(diagnostic.text, /研究模块.*调用次数或时长额度已用尽/u);
  assert.match(diagnostic.advice, /UTC 00:00.*08:00/u);
  assert.match(diagnostic.advice, /重新选择当前连接、保存、测试并启用/u);
});

test("exhausted shared-source control capacity requires a fresh source rather than waiting for concurrency or clearing Team records", () => {
  const capacity = formatTeamRunIssue(issueRun("agent_share_source_capacity"), zh);
  assert.match(capacity.reason, /可用性控制记录容量已满/u); assert.doesNotMatch(capacity.reason, /执行名额/u);
  assert.match(capacity.advice, /共享者重新连接新的 Agent 来源/u);
  assert.match(capacity.advice, /重新选择当前共享连接，保存、测试并启用/u);
  assert.match(capacity.advice, /等待或清理 Team 运行记录不能恢复/u);
  assert.match(formatTeamRunIssue({ ...issueRun("agent_share_source_capacity"), purpose: "test" }, zh).advice, /重新连接新的 Agent 来源/u);
  const busy = formatTeamRunIssue(issueRun("agent_share_busy"), zh);
  assert.match(busy.advice, /等待.*空闲执行名额.*新的团队任务/u);
  assert.match(busy.advice, /不会自动继续/u);
});

test("sharing storage exhaustion directs queue and retained-record recovery rather than clearing Team private runs", () => {
  const sharing = formatTeamRunIssue(issueRun("agent_share_storage_full"), zh);
  assert.match(sharing.reason, /共享执行、队列或保留记录容量已满/u);
  assert.match(sharing.advice, /等待共享队列释放容量.*旧执行已真正退出/u);
  assert.match(sharing.advice, /共享者或管理员.*保留记录/u);
  assert.match(sharing.advice, /再发起新任务.*清理 Team 运行记录不会释放共享容量/u);
  const teamStorage = formatTeamRunIssue(issueRun("agent_team_storage_full"), zh);
  assert.match(teamStorage.advice, /清理已结束的私有运行记录/u);
  assert.doesNotMatch(sharing.advice, /请清理已结束的私有运行记录/u);
});

test("unavailable cloud requests and busy native runtimes have distinct actionable explanations", () => {
  const unavailable = formatTeamRunIssue(issueRun("hosted_request_unavailable"), zh);
  assert.equal(unavailable.code, "hosted_request_unavailable"); assert.match(unavailable.reason, /原云端请求已不可用/u);
  assert.match(unavailable.advice, /检查已经完成的工作后，重新发起/u);
  const busy = formatTeamRunIssue(issueRun("runtime_busy"), zh);
  assert.equal(busy.code, "runtime_busy"); assert.match(busy.reason, /执行端正忙于已有调用/u);
  assert.match(busy.advice, /检查所选 Agent 上的已有执行.*等待其结束.*新的团队任务/u);
  assert.doesNotMatch(busy.advice, /自动重试|自动继续|点击“继续”/u);
});

test("a legacy generic failure code cannot falsely mark a still-running task as failed", () => {
  for (const code of ["agent_team_execution_failed", "agent_team_agent_failed"]) {
    const waiting = formatTeamRunIssue(issueRun(code, "running"), zh);
    assert.match(waiting.reason, /仍在等待/u); assert.doesNotMatch(waiting.reason, /失败|未能完成/u);
    assert.match(waiting.advice, /请勿重复提交.*暂停后恢复.*消耗次数/u);
    const failed = formatTeamRunIssue(issueRun(code, "failed"), zh);
    assert.match(failed.reason, /未能完成此模块/u); assert.doesNotMatch(failed.reason, /仍在等待/u);
  }
});

for (const code of ["agent_timeout", "provider_timeout", "container_timeout", "agent_share_timeout"])
  test(`a paused ${code} offers continuation only within original limits`, () => {
    const diagnostic = formatTeamRunIssue({ ...issueRun(code, "paused"), error_code: "agent_timeout" }, zh);
    assert.match(diagnostic.reason, /超时.*暂停/u); assert.match(diagnostic.advice, /剩余调用次数和原任务时限/u);
    assert.match(diagnostic.advice, /开始新一轮调用/u);
  });

test("cloud and shared timeout details with exhausted continuation budget give a concrete new-task recovery", () => {
  for (const code of ["provider_timeout", "container_timeout", "agent_share_timeout"]) {
    const run = { ...issueRun(code, "paused"), error_code: "agent_timeout", calls_used: 1, max_calls: 1,
      deadline_at: new Date(Date.now() + 60_000).toISOString() };
    const diagnostic = formatTeamRunIssue(run, zh);
    assert.match(diagnostic.reason, /超时.*暂停/u);
    assert.match(diagnostic.advice, /修改后需保存并重测，再发起任务/u);
    assert.doesNotMatch(diagnostic.advice, /开始新一轮调用/u);
  }
});

for (const code of ["hosted_agent_busy", "hosted_user_busy", "hosted_profile_busy", "hosted_user_rate_limit",
  "agent_team_waiting_executor", "agent_team_claim_expired", "agent_share_queued"])
  test(`running ${code} is explained as waiting, never falsely described as terminal failure`, () => {
    const diagnostic = formatTeamRunIssue(issueRun(code, "running"), zh);
    assert.doesNotMatch(diagnostic.reason, /已失败|已停止|任务失败/u); assert.ok(diagnostic.advice);
    if (code.startsWith("hosted_")) assert.match(diagnostic.advice, /自动重试/u);
    if (code === "agent_team_claim_expired") assert.match(diagnostic.advice, /新一轮调用并消耗次数/u);
  });

test("unknown future run codes never leak payloads and healthy/completed runs produce no notice", () => {
  const run = issueRun("provider_private_fixture_secret", "failed"); run.issue.message = "private prompt fixture";
  run.issue.details = { credential: "private key fixture" };
  const diagnostic = formatTeamRunIssue(run, zh);
  assert.equal(diagnostic.code, "unknown"); assert.doesNotMatch(JSON.stringify(diagnostic), /fixture|provider_private/u);
  assert.equal(formatTeamRunIssue({ status: "running", error_code: null }), null);
  assert.equal(formatTeamRunIssue({ ...run, status: "completed" }), null);
  assert.doesNotMatch(formatTeamRunIssue({ ...run, status: "running" }, zh).reason, /停止|失败/u);
});

test("old paused/stopped/deadline/call-limit summaries still have useful instructions without issue metadata", () => {
  for (const status of ["paused", "stopped", "timed_out", "call_limit"]) {
    const diagnostic = formatTeamRunIssue({ status, error_code: null }, zh);
    assert.ok(diagnostic.reason); assert.ok(diagnostic.advice); assert.notEqual(diagnostic.code, "unknown");
  }
  assert.match(formatTeamRunIssue({ status: "paused", error_code: "server_restart" }, zh).reason, /服务器已重启/u);
});

test("run-state conflicts and configuration conflicts give different recovery instructions", () => {
  const problem = { status: 409, code: "conflict", message: "private backend detail" };
  assert.match(describeTeamActionError(problem, "run", zh), /任务状态.*刷新运行记录/u);
  assert.match(describeTeamActionError(problem, "save", zh), /配置已在其他页面修改.*未保存内容仍保留/u);
  assert.doesNotMatch(describeTeamActionError(problem, "run", zh), /配置已/u);
});

test("unconfirmed network or invalid responses never claim execution failed or expose raw exception text", () => {
  for (const problem of [new Error("provider private fixture"), { status: 0, code: "request_timeout" },
    { status: 502, code: "invalid_team_response" }, { status: 503, code: "unknown", message: "raw provider fixture" }]) {
    assert.equal(isTeamActionUncertain(problem), true);
    const text = describeTeamActionError(problem, "start", zh);
    assert.match(text, /操作结果尚未确认/u); assert.match(text, /不代表.*执行失败/u); assert.doesNotMatch(text, /fixture/u);
  }
});

test("explicitly disabled services are definite rejections instead of uncertain transport", () => {
  for (const code of ["agent_sharing_disabled", "hosted_agent_disabled"]) {
    const problem = { status: 503, code };
    assert.equal(isTeamActionUncertain(problem), false);
    assert.match(describeTeamActionError(problem, "start", zh), /未被接受/u);
  }
});

test("preflight errors include only the bounded module diagnostic, never arbitrary error details", () => {
  const problem = { status: 409, code: "agent_team_model_unavailable", details: {
    node_label: "<img src=x onerror=alert(1)>", credential: "private credential fixture", raw: "private provider fixture",
  } };
  const text = describeTeamActionError(problem, "test", zh);
  assert.match(text, /<img src=x onerror=alert\(1\)>/u); assert.doesNotMatch(text, /fixture/u);
  for (const label of ["x".repeat(121), "bad\nmodule", null]) {
    assert.ok(!describeTeamActionError({ ...problem, details: { node_label: label } }, "test", zh).startsWith("模块:"));
  }
});

test("quoted message deletion and authorization changes provide next steps without echoing server messages", () => {
  for (const [code, expected] of [["message_deleted", /草稿仍保留.*重新选择引用/u], ["unauthorized", /重新登录/u],
    ["forbidden", /权限/u], ["not_found", /刷新并确认权限/u]]) {
    const text = describeTeamActionError({ status: 409, code, message: "private provider fixture" }, "start", zh);
    assert.match(text, expected); assert.doesNotMatch(text, /fixture/u);
  }
});

test("safe recovery conflict details distinguish consumed receipts, terminal runs and invalid recovery actions", () => {
  for (const [issue_code, expected] of [["agent_team_receipt_cleared", /曾被接受.*私有记录已清理/u],
    ["agent_team_run_ended", /任务已结束，无法恢复/u], ["agent_team_deadline", /总时长上限/u],
    ["agent_team_call_limit", /总调用次数上限/u], ["agent_team_continue_required", /点击“继续”/u],
    ["agent_team_not_timed_out", /普通暂停.*恢复/u], ["agent_team_clarification_unavailable", /原澄清报告已不可用/u]]) {
    const text = describeTeamActionError({ status: 409, code: "conflict", details: { issue_code } }, "run", zh);
    assert.match(text, expected); assert.doesNotMatch(text, /配置已在其他页面修改/u);
  }
  assert.doesNotMatch(describeTeamActionError({ status: 409, code: "conflict", details: { issue_code: "private_fixture_code" } }, "run", zh), /fixture/u);
});

test("an atomically rejected storage quota error is actionable rather than an unknown server result", () => {
  const problem = { status: 507, code: "storage_quota_exceeded" };
  assert.equal(isTeamActionUncertain(problem), false);
  assert.match(describeTeamActionError(problem, "start", zh), /存储空间已满.*清理/u);
});

test("test timeouts and restarts point to the available Test control instead of nonexistent Continue or Resume controls", () => {
  for (const code of ["agent_timeout", "provider_timeout", "server_restart", "agent_team_probe_failed"]) {
    const diagnostic = formatTeamRunIssue({ ...issueRun(code, "paused"), purpose: "test" }, zh);
    assert.match(diagnostic.advice, /点击“测试”/u); assert.match(diagnostic.advice, /原来未完成的测试会先停止/u);
    assert.doesNotMatch(diagnostic.advice, /点击“继续”|点击“恢复”/u);
  }
  assert.match(formatTeamRunIssue({ ...issueRun("agent_share_daily_limit"), purpose: "test" }, zh).advice, /UTC 00:00.*再次测试/u);
});

test("timeout continuation guidance agrees with the run's authoritative state rather than its diagnostic cause alone", () => {
  for (const status of ["failed", "stopped", "timed_out", "call_limit", "running"]) {
    const run = { ...issueRun("provider_timeout", status), error_code: "agent_timeout", calls_used: 1, max_calls: 3,
      deadline_at: new Date(Date.now() + 60_000).toISOString() };
    assert.equal(teamTimeoutContinuationAvailable(run), false, `${status} has no Continue control`);
    const diagnostic = formatTeamRunIssue(run, zh);
    assert.doesNotMatch(diagnostic.advice, /点击“继续”/u);
    if (status !== "running") assert.doesNotMatch(diagnostic.advice, /开始新一轮调用/u);
    assert.doesNotMatch(diagnostic.reason, /任务已暂停/u);
  }
  const ordinaryPause = { ...issueRun("provider_timeout", "paused"), error_code: "user_paused", calls_used: 1, max_calls: 3,
    deadline_at: new Date(Date.now() + 60_000).toISOString() };
  assert.equal(teamTimeoutContinuationAvailable(ordinaryPause), false);
  assert.match(formatTeamRunIssue(ordinaryPause, zh).advice, /点击“恢复”/u);
});
