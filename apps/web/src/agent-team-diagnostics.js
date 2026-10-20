// Only fixed public copy and explicitly allowlisted run metadata reach the UI.
// Provider exception messages, response bodies and arbitrary error details do not.
const copy = new Map();
const translated = (en, zh) => { copy.set(en, zh); return en; };
const help = {
  newTask: translated("Resolve the issue, review any work already done, then start a new Team task.", "解决问题并检查已经完成的工作后，重新发起团队任务。"),
  sharedQuota: translated("Wait for the daily reset at 00:00 UTC (08:00 Beijing time), or ask the owner to change the allowance. After a sharing configuration change, select its current connection again, save, retest and enable the Team before starting a new task. Retesting uses sharing allowance.", "请等待每天 UTC 00:00（北京时间 08:00）额度重置，或请共享者调整额度。共享配置变化后，需重新选择当前连接、保存、测试并启用 Team，再发起任务；重测也会使用共享额度。"),
  sharedAccess: translated("Ask the owner to reconnect and enable sharing for you again. Update and retest the module if its saved sharing configuration changed, then start a new task.", "请共享者重新连接，并为你开启共享；若共享配置已变化，请重新选择该模块的连接并测试，再发起任务。"),
  sharedSource: translated("Ask the owner to reconnect a fresh Agent source and share it with you. Select that current sharing connection in the module, save, retest and enable the Team before starting a new task. Waiting or clearing Team run records cannot restore the old source.", "请共享者重新连接新的 Agent 来源并为你开启共享；再在模块中重新选择当前共享连接，保存、测试并启用 Team 后发起新任务。等待或清理 Team 运行记录不能恢复原来源。"),
  sharedBusy: translated("Wait for the shared Agent to have a free execution slot, review any work already done, then start a new Team task. This failed task cannot continue automatically.", "请等待共享 Agent 出现空闲执行名额，检查已经完成的工作后，再发起新的团队任务；本次失败任务不会自动继续。"),
  sharedStorage: translated("Wait for the sharing queue to free capacity and confirm old executions have actually exited. If capacity remains full, ask the sharing owner or administrator to check retained sharing records and limits. Review existing work before starting a new task; clearing Team run records does not free sharing capacity.", "请等待共享队列释放容量，并确认旧执行已真正退出；若仍满，请共享者或管理员检查共享保留记录和容量限制。检查已有工作后再发起新任务；清理 Team 运行记录不会释放共享容量。"),
  runtimeBusy: translated("Check the existing execution on the selected Agent and wait for it to finish. Review any work already done before starting a new Team task to avoid duplicate execution.", "请检查所选 Agent 上的已有执行，并等待其结束；检查已完成的工作后再发起新的团队任务，避免重复执行。"),
  nativeExit: translated("Keep the original device's connector running and check that its earlier task has actually stopped. This call will wait within its original time limit; do not submit a duplicate. If it remains blocked, ask the owner or administrator to check the exit confirmation.", "请保持原设备的连接程序运行，并确认旧任务已真正停止。本次调用会在原时限内等待，请勿重复提交；若持续等待，请设备持有者或管理员检查退出确认。"),
  nativeCapacity: translated("Ask the device owner or administrator to check earlier executions and their exit confirmations. Reconnect the original devices if available; do not clear safety records before confirming those processes have exited. Clearing Team run records does not free this capacity.", "请设备持有者或管理员检查旧执行及退出确认；原设备可用时请重新连接。确认进程退出前不要清除安全记录；清理 Team 运行记录不会释放此容量。"),
  connection: translated("Reconnect the selected Agent. If its connection or model changed, update and retest the module before starting a new task.", "请重新连接所选 Agent；若连接或模型已变化，请修改模块并重新测试，再发起任务。"),
  timeout: translated("If calls and the original time allowance remain, choose Continue to start a new counted call with saved context. Otherwise start a new task.", "若剩余调用次数和原任务时限允许，点击“继续”将带上已保存的上下文开始新一轮调用；否则需重新发起任务。"),
  resume: translated("Review the task, then choose Resume while the original call and time limits allow. Resuming may require another Agent call.", "检查任务后，可在原次数和时限允许时点击“恢复”；恢复执行可能需要另一次 Agent 调用。"),
  clarification: translated("Send a chat message in this session explaining how to proceed, then select Continue after clarification. To change identities, prompts or data flows, stop this task, edit and retest the Team, then start a new task.", "请先在当前会话发送 chat 说明如何处理，再点击“澄清后继续”。如需修改身份、提示词或连线，请停止后修改、重测并启动新任务。"),
  configuration: translated("Review this module's identity, prompt and allowed-call connections, then save, retest and start a new task.", "请检查该模块的身份、提示词和允许调用的连线，保存并重新测试后，再发起任务。"),
  budget: translated("Review the work already done and adjust the Team's limits if needed. Save and retest changed configuration, then start a new task.", "请检查已经完成的工作，按需调整 Team 上限；修改后需保存并重测，再发起任务。"),
  context: translated("Refresh the conversation and review its current history, then start a new task. The interrupted task cannot continue with deleted context.", "请刷新并检查当前会话记录后重新发起任务；已中断任务不能继续使用删除前的上下文。"),
  waiting: translated("The Team will retry automatically within its original time limit. Do not submit the same task again; you can still pause or stop it.", "团队会在原任务时限内自动重试，请勿重复提交；仍可暂停或停止。"),
  executor: translated("Check the selected Agent connection and do not submit the same task again. Pausing and resuming retries execution in a new counted call within the original time limit. You can also stop and review existing work first.", "请检查所选 Agent 的连接，请勿重复提交同一任务。暂停后恢复将开始新一轮调用并消耗次数，仍受原时限约束；也可停止任务，先检查已有工作。"),
  queued: translated("Wait for the shared Agent to become available, or pause or stop this Team. Do not submit the same task again.", "请等待共享 Agent 执行，或暂停、停止此团队；请勿重复提交同一任务。"),
  storage: translated("Clear ended private run records or ask the project owner to free storage, then try again. Clearing a private record keeps conversation messages.", "请清理已结束的私有运行记录，或联系项目负责人释放存储后再试；清理私有记录不会删除聊天消息。"),
  cloudAuth: translated("Ask the cloud configuration owner or administrator to repair the model connection. Select and retest another model if needed, then start a new task.", "请云端配置持有者或管理员检查模型连接；也可重新选择其他模型并测试后发起任务。"),
  unknown: translated("The task did not complete. Review the run record and existing conversation before retrying; an unknown error does not confirm that no work was done.", "任务尚未完成。请先检查运行记录和已有聊天结果再重试；未知错误不代表此前没有执行工作。"),
};
const definitions = [
  [["agent_share_daily_limit"], "The shared Agent's calling or time allowance is exhausted.", "共享 Agent 的调用次数或时长额度已用尽。", "sharedQuota"],
  [["agent_share_offline"], "The shared Agent is offline.", "共享 Agent 已掉线。", "sharedAccess"],
  [["agent_share_revoked"], "The owner stopped sharing or withdrew your access.", "共享者已关闭共享，或取消了你的使用权限。", "sharedAccess"],
  [["agent_share_lease_expired"], "The shared Agent stopped reporting progress and its execution lease expired.", "共享 Agent 长时间未报告进展，执行租约已过期。", "sharedAccess"],
  [["agent_share_profile_changed"], "The shared Agent's saved connection or model configuration changed.", "共享 Agent 的连接或模型配置已变化。", "sharedAccess"],
  [["agent_share_request_cancelled"], "This shared Agent call was cancelled.", "这次共享 Agent 调用已取消。", "newTask"],
  [["agent_share_busy"], "The shared Agent has no free execution slot.", "共享 Agent 暂无可用的执行名额。", "sharedBusy"],
  [["agent_share_source_capacity"], "The shared Agent source's availability-control storage capacity is exhausted.", "共享 Agent 来源的可用性控制记录容量已满。", "sharedSource"],
  [["agent_share_execution_failed"], "The shared Agent failed to execute this module.", "共享 Agent 未能完成此模块的执行。", "newTask"],
  [["agent_share_context_too_large", "agent_share_output_too_large", "agent_share_progress_limit"], "The shared Agent's context or output exceeded its size limit.", "共享 Agent 的上下文或输出超过大小限制。", "configuration"],
  [["agent_team_deadline"], "The Team's total time limit was reached before the task completed.", "团队任务尚未完成，已达到总时长上限。", "budget"],
  [["agent_team_call_limit"], "The Team's call limit was reached before the task completed.", "团队任务尚未完成，已达到总调用次数上限。", "budget"],
  [["agent_timeout", "provider_timeout", "container_timeout", "agent_share_timeout"], "This Agent call timed out; the Team is paused.", "这次 Agent 调用已超时，团队已暂停。", "timeout"],
  [["server_restart"], "The server restarted and paused the unfinished Team task.", "服务器已重启，未完成的团队任务已暂停。", "resume"],
  [["user_paused"], "You or another device on your account paused this Team task.", "你或同账号的其他设备暂停了团队任务。", "resume"],
  [["user_stopped", "agent_team_stopped"], "You or another device on your account stopped this Team task before completion.", "你或同账号的其他设备在完成前停止了团队任务。", "newTask"],
  [["agent_team_instruction_conflict", "agent_team_clarification_required"], "The module reported conflicting instructions and needs your clarification.", "模块报告指令冲突，需要你澄清。", "clarification"],
  [["runtime_offline", "runtime_unavailable"], "The selected local Agent is offline or no longer connected to this session.", "所选本地 Agent 已掉线，或已不再连接此会话。", "connection"],
  [["runtime_busy"], "The selected execution Agent is busy with an existing call and could not start this module.", "所选执行端正忙于已有调用，未能启动此模块。", "runtimeBusy"],
  [["agent_team_runtime_offline", "agent_share_locked"], "The selected Agent connection became unavailable before this module could run.", "所选 Agent 连接在模块执行前已不可用。", "connection"],
  [["runtime_revoked", "agent_team_runtime_revoked", "agent_team_authorization_lost", "access_changed", "hosted_access_changed"], "The task's device or session authorization is no longer valid.", "任务所用设备或会话的授权已失效。", "newTask"],
  [["agent_team_target_unavailable", "agent_team_model_unavailable", "model_unavailable", "agent_share_unsupported"], "The exact saved Agent, model or reasoning effort is unavailable.", "保存的指定 Agent、模型或推理强度当前不可用。", "connection"],
  [["agent_team_waiting_executor"], "Waiting for the selected local Agent to claim this call; the task is not complete.", "正在等待所选本地 Agent 认领调用，任务尚未完成。", "executor"],
  [["agent_team_native_exit_pending"], "An earlier local execution has no confirmed exit; this call has not started.", "旧的本地执行尚未确认退出，本次调用尚未开始。", "nativeExit"],
  [["agent_team_native_hold_capacity"], "The native execution exit-confirmation record limit has been reached.", "本地执行的退出确认记录已达到容量上限。", "nativeCapacity"],
  [["agent_team_claim_expired"], "The local Agent's execution lease expired without a final result; the task is not complete.", "本地 Agent 的执行租约已过期且没有最终结果，任务尚未完成。", "executor"],
  [["agent_share_queued"], "This call is queued for the shared Agent; the task is not complete.", "调用正在等待共享 Agent 执行，任务尚未完成。", "queued"],
  [["context_changed"], "Conversation context changed or was deleted, so this task was interrupted.", "会话上下文发生变化或被删除，任务已中断。", "context"],
  [["team_directive_invalid"], "The module did not return a valid Team control instruction.", "模块未返回有效的团队控制指令。", "configuration"],
  [["team_directive_mismatch"], "The module returned a control instruction for a different step.", "模块返回的控制指令不属于当前步骤。", "configuration"],
  [["team_delegation_forbidden"], "The module tried to call another module without an allowed connection.", "模块尝试调用未通过连线允许调用的模块。", "configuration"],
  [["team_response_route_mismatch"], "The response did not match the selected Agent, model or execution route.", "返回结果与指定 Agent、模型或执行线路不匹配。", "connection"],
  [["team_clarification_missing"], "The module requested clarification without explaining the conflict.", "模块请求澄清，但没有说明冲突内容。", "configuration"],
  [["agent_team_probe_failed"], "The connectivity test received an incorrect module or data-flow response.", "连通性测试收到的模块或数据流验证结果不正确。", "configuration"],
  [["provider_auth_failed", "cloud_api_unavailable", "cloud_api_changed", "cloud_api_invalid", "hosted_profile_changed", "hosted_profile_unavailable"], "The cloud model connection is unauthorized, disabled or changed.", "云端模型连接授权无效、已停用或已变化。", "cloudAuth"],
  [["provider_rate_limited", "cloud_api_limit", "hosted_daily_limit", "hosted_user_quota", "hosted_global_budget"], "The cloud provider's rate or usage allowance was exceeded.", "云端服务的速率或用量额度已用尽。", "newTask"],
  [["provider_unavailable", "provider_request_failed", "hosted_runner_unavailable"], "The cloud model provider or execution service could not complete this call.", "云端模型或执行服务未能完成本次调用。", "newTask"],
  [["hosted_request_unavailable"], "The original cloud request is unavailable or you no longer have access to it.", "原云端请求已不可用，或你已无权访问。", "newTask"],
  [["hosted_context_too_large", "hosted_code_too_large"], "The cloud task's conversation or code exceeds the model's input limit.", "云端任务的会话或代码内容超过模型输入限制。", "configuration"],
  [["hosted_agent_busy", "hosted_user_busy", "hosted_profile_busy", "hosted_user_rate_limit"], "Waiting for cloud execution capacity or a rate-limit retry.", "正在等待云端执行名额或限流后的重试。", "waiting"],
  [["codex_turn_cancelled"], "The Codex turn was cancelled before completion.", "Codex 执行轮次在完成前被取消。", "newTask"],
  [["codex_turn_missing"], "The expected Codex turn could not be found.", "未找到预期的 Codex 执行轮次。", "connection"],
  [["codex_turn_failed", "harness_execution_failed"], "The local Agent failed to execute this call.", "本地 Agent 未能完成本次执行。", "connection"],
  [["agent_request_abandoned"], "The local Agent's execution claim is no longer valid and no final result was received.", "本地 Agent 的执行认领已失效，未收到最终结果。", "connection"],
  [["container_failed", "container_interrupted", "agent_startup_failed", "agent_session_failed", "agent_answer_failed", "agent_idle_failed", "agent_shutdown_failed"], "The cloud Agent's execution environment failed or was interrupted.", "云端 Agent 的执行环境发生故障或被中断。", "newTask"],
  [["empty_agent_result"], "The Agent finished without a usable final answer.", "Agent 结束时未提供可用的最终回复。", "newTask"],
  [["container_output_too_large"], "The cloud Agent's output exceeded its size limit.", "云端 Agent 输出超过大小限制。", "configuration"],
  [["agent_team_storage_full", "storage_quota_exceeded"], "Team or project storage is full.", "团队或项目存储空间已满。", "storage"],
  [["agent_share_storage_full"], "Sharing execution, queue or retained-record capacity is full.", "共享执行、队列或保留记录容量已满。", "sharedStorage"],
  [["agent_team_prompt_too_large", "agent_team_plan_too_large"], "The combined Team configuration and task are too large to execute safely.", "Team 配置与任务组合后过大，无法安全执行。", "configuration"],
  [["agent_team_sensitive_input", "agent_share_sensitive_input"], "The task or Team configuration contains information that cannot be shared safely.", "任务或 Team 配置包含不能安全共享的信息。", "configuration"],
  [["test_replaced"], "This connectivity test was stopped because its saved Team was changed or deleted.", "保存的 Team 已被修改或删除，本次连通性测试已停止。", "configuration"],
  [["agent_team_agent_failed", "agent_team_execution_failed"], "The Agent could not complete this module; no more specific safe cause was reported.", "Agent 未能完成此模块，未提供更具体的安全错误原因。", "unknown"],
];
const diagnostics = new Map();
for (const [codes, en, zh, advice] of definitions) {
  translated(en, zh);
  for (const code of codes) diagnostics.set(code, { reason: en, advice: help[advice] });
}
const unknownReason = translated("The Team task stopped before completion for an unrecognized reason.", "团队任务因未识别的原因在完成前停止。"),
  unknownWaiting = translated("The Team task is still pending without a recognized status explanation.", "团队任务仍在等待，尚无可识别的执行状态说明。"),
  lostHeartbeat = translated("The selected Agent stopped reporting its connection heartbeat. Its accepted call has no final result yet.", "所选 Agent 的连接心跳已中断，已接受的调用尚无最终结果。"),
  uncertain = translated("The last action is unconfirmed. Check the previous action before repeating it; a lost connection does not mean the Team task failed.", "上次操作结果尚未确认，请先“确认上次操作”再重试；连接中断不代表团队任务执行失败。"),
  staleState = translated("The task state changed on another device or no longer allows this action. Refresh the run records before choosing an available control.", "其他设备已更改任务状态，或当前状态不允许此操作。请刷新运行记录，再选择可用操作。"),
  staleConfig = translated("The configuration changed elsewhere. Your unsaved edits are kept. Reopen the Team to load the latest version.", "配置已在其他页面修改，你的未保存内容仍保留。请重新打开此 Team 以加载最新版本。");
const genericAction = translated("Unable to complete this Team action. Refresh the run records and review the configuration before retrying.", "未能完成团队操作。请刷新运行记录并检查配置后重试。");
const priorTimeout = translated("A prior Agent call reported a timeout.", "此前的 Agent 调用报告了超时。");
const timeoutCodes = new Set(["agent_timeout", "provider_timeout", "container_timeout", "agent_share_timeout"]);
const testRecovery = translated("Resolve the reported issue, asking the connection owner or administrator if needed, then select Test. An unfinished previous test will be stopped. Tests use provider and sharing allowances, not the later task's Team call allowance.", "请修复以上问题，必要时联系连接持有者或管理员，再点击“测试”；原来未完成的测试会先停止。测试会使用模型和共享额度，不占后续正式任务的 Team 调用次数。"),
  testQuotaRecovery = translated("Wait for the daily reset at 00:00 UTC (08:00 Beijing time), or ask the owner to adjust the allowance. Reselect changed sharing configuration and save it before testing again. Tests also use sharing allowance.", "请等待每天 UTC 00:00（北京时间 08:00）额度重置，或请共享者调整额度；共享配置变化后需重新选择并保存，再次测试。测试也会使用共享额度。"),
  testWaiting = translated("This connectivity test is still waiting. Do not start a duplicate test. To cancel it, save a configuration change or delete the Team; the previous test will be stopped.", "本次连通性测试仍在等待，请勿重复发起。若需取消，可保存配置修改或删除 Team，原测试会停止。");

const actionMessages = new Map([
  ["agent_team_incomplete", translated("Choose an Agent, model and reasoning effort for every module.", "请为每个模块选择 Agent、模型及可用的推理强度。")],
  ["agent_team_disconnected", translated("Connect every module to the start module.", "请从起点连接到每个模块，并确认连线方向。")],
  ["agent_team_limit", translated("Team limit reached (5). Delete one to add another.", "已保存 5 个 Team，删除一个后可继续添加。")],
  ["agent_team_favorite_limit", translated("Favorite limit reached (5). Remove one to add another.", "已收藏 5 个模块，取消一个收藏后可继续添加。")],
  ["agent_team_busy", translated("A Team task is already active. Stop or finish it before starting another.", "已有团队任务正在执行，请先停止或等待结束。")],
  ["agent_team_not_enabled", translated("The Team is no longer enabled. Your selection is kept; choose or enable it again.", "当前 Team 已停用，选择仍保留；请重新启用或选择其他 Agent。")],
  ["agent_team_clarification_required", help.clarification],
  ["validation_error", translated("Review the Team configuration and try again.", "请检查团队名称、模块和调用上限后重试。")],
  ["unauthorized", translated("Your login or device authorization expired. Sign in again before continuing.", "登录或设备授权已失效，请重新登录后继续。")],
  ["forbidden", translated("Your current project or session permissions do not allow this action. Ask the owner to check your access.", "当前项目或会话权限不允许此操作，请负责人检查你的权限。")],
  ["not_found", translated("This Team, run or session is unavailable, or you no longer have access. Refresh and check your access before retrying.", "此 Team、运行记录或会话已不可用，或你已无权访问。请刷新并确认权限后再试。")],
  ["shared_agent_solo_disclosure_required", translated("Confirm that this Solo task and its context will be processed on the sharing owner's device.", "请确认本次 Solo 任务及上下文将交给共享者的设备处理。")],
  ["agent_share_solo_disclosure_required", translated("Confirm that this Solo task and its context will be processed on the sharing owner's device.", "请确认本次 Solo 任务及上下文将交给共享者的设备处理。")],
  ["message_deleted", translated("The quoted message was deleted. Your draft is kept; choose another quote or remove the quote before retrying.", "引用的消息已删除，你的草稿仍保留；请重新选择引用或取消引用后再试。")],
  ["agent_sharing_disabled", translated("Agent sharing is currently disabled on this server. This action was not accepted; ask the administrator to enable it before retrying.", "此服务器当前未启用 Agent 共享，本次操作未被接受；请管理员启用后再试。")],
  ["hosted_agent_disabled", translated("Cloud Agent execution is currently disabled on this server. This action was not accepted; choose another Agent or ask the administrator to enable it.", "此服务器当前未启用云端 Agent，本次操作未被接受；请选择其他 Agent，或请管理员启用。")],
  ["agent_team_receipt_cleared", translated("This task was already accepted, but its private record was cleared. Review the existing conversation and work before explicitly starting a new task; retrying cannot restart the old one.", "此任务曾被接受，但私有记录已清理。请先检查已有聊天和工作，再明确发起新任务；重试不能重启原任务。")],
  ["agent_team_run_ended", translated("This Team task has ended and cannot be resumed. Review its result before starting another task if needed.", "此团队任务已结束，无法恢复。请先检查结果，确有需要时再发起新任务。")],
  ["agent_team_continue_required", translated("This step timed out. Use Continue, rather than Resume, while the original call and time limits allow.", "当前步骤已超时，请在原次数和时限允许时点击“继续”，不要使用“恢复”。")],
  ["agent_team_not_timed_out", translated("Continue is available only after an Agent timeout. Refresh the run records; use Resume for an ordinary paused task.", "仅 Agent 超时后可以“继续”。请刷新运行记录；普通暂停的任务应点击“恢复”。")],
  ["agent_team_clarification_unavailable", translated("The original clarification report is no longer available. Review the current conversation and start a new task.", "原澄清报告已不可用。请检查当前会话内容后重新发起任务。")],
]);

export const TEAM_DIAGNOSTIC_ZH_CN = Object.fromEntries(copy);

export function teamTimeoutContinuationAvailable(run, now = Date.now()) {
  const deadline = Date.parse(run?.deadline_at);
  return run?.status === "paused" && run.error_code === "agent_timeout" && run.purpose !== "test"
    && !(Number.isFinite(run?.calls_used) && Number.isFinite(run?.max_calls) && run.calls_used >= run.max_calls)
    && !(Number.isFinite(deadline) && deadline <= now);
}

export function formatTeamRunIssue(run, t = value => value) {
  if (!run || run.status === "completed") return null;
  const code = run.issue?.code ?? run.error_code ?? (run.status === "paused" ? "user_paused" : run.status === "stopped" ? "user_stopped"
    : run.status === "call_limit" ? "agent_team_call_limit" : run.status === "timed_out" ? "agent_team_deadline" : null);
  if (run.status === "running" && !code) return null;
  const diagnostic = diagnostics.get(code), runningOffline = run.status === "running" && ["agent_team_runtime_offline", "runtime_offline"].includes(code);
  const runningUnknown = run.status === "running" && (!diagnostic || ["agent_team_agent_failed", "agent_team_execution_failed"].includes(code));
  const timeout = timeoutCodes.has(code);
  const reason = t(timeout && run.status !== "paused" ? priorTimeout : runningOffline ? lostHeartbeat : runningUnknown ? unknownWaiting : diagnostic?.reason ?? unknownReason);
  let advice = runningOffline || runningUnknown ? help.executor : diagnostic?.advice ?? help.unknown;
  if (timeout) advice = run.status === "paused" ? run.error_code === "agent_timeout"
    ? teamTimeoutContinuationAvailable(run) ? help.timeout : help.budget : help.resume
    : run.status === "running" ? help.executor : ["timed_out", "call_limit"].includes(run.status) ? help.budget : help.newTask;
  if (["failed", "stopped", "timed_out", "call_limit"].includes(run.status)
    && [help.timeout, help.resume, help.clarification, help.executor, help.waiting, help.queued, help.nativeExit].includes(advice)) advice = help.newTask;
  const moduleLabel = typeof run.issue?.node_label === "string" ? run.issue.node_label : null;
  return { reason, text: moduleLabel ? `${t("Module")}: ${moduleLabel} · ${reason}` : reason,
    advice: t(run.purpose === "test" ? run.status === "running" ? testWaiting : code === "agent_share_daily_limit" ? testQuotaRecovery
      : code === "agent_share_source_capacity" ? help.sharedSource : testRecovery
      : advice),
    code: diagnostics.has(code) ? code : "unknown", moduleLabel };
}

export function isTeamActionUncertain(problem) {
  return !problem?.status || problem.status >= 500 && !["agent_sharing_disabled", "hosted_agent_disabled", "storage_quota_exceeded"].includes(problem.code);
}

function actionErrorText(problem, action, t) {
  const detailCode = problem?.details?.issue_code;
  const code = problem?.code === "conflict" && (diagnostics.has(detailCode) || actionMessages.has(detailCode)) ? detailCode : problem?.code;
  // HTTP acceptance may have succeeded even when the browser did not receive a
  // usable reply. Never label uncertain transport as an execution failure.
  if (isTeamActionUncertain(problem)) return t(uncertain);
  if (code === "conflict" || code === "idempotency_conflict") return t(["run", "forget"].includes(action) ? staleState : staleConfig);
  if (actionMessages.has(code)) return t(actionMessages.get(code));
  if (diagnostics.has(code)) {
    const entry = diagnostics.get(code);
    return `${t(entry.reason)} ${t(entry.advice)}`;
  }
  if (problem.status === 401) return t(actionMessages.get("unauthorized"));
  if (problem.status === 403) return t(actionMessages.get("forbidden"));
  if (problem.status === 404) return t(actionMessages.get("not_found"));
  return t(genericAction);
}

export function describeTeamActionError(problem, action, t = value => value) {
  const text = actionErrorText(problem, action, t), label = problem?.details?.node_label;
  // The API keeps only the schema-validated node diagnostic fields. Maintain
  // the bound here too for standalone/mock clients, and never echo other data.
  return typeof label === "string" && label.length > 0 && label.length <= 120 && !/[\u0000-\u001f\u007f-\u009f]/u.test(label)
    ? `${t("Module")}: ${label} · ${text}` : text;
}
