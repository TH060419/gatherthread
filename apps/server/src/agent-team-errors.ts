/** Public Team diagnostics never reuse exception/provider messages. */
const NATIVE_FAILURES = new Set(["agent_request_abandoned", "harness_execution_failed",
  "codex_turn_cancelled", "codex_turn_missing", "codex_turn_failed", "context_changed"]);
const SHARED_FAILURES = new Set(["agent_share_timeout", "agent_share_execution_failed", "agent_share_request_cancelled",
  "agent_share_offline", "agent_share_locked", "agent_share_unsupported", "agent_share_revoked", "agent_share_lease_expired", "agent_share_profile_changed",
  "agent_share_daily_limit", "agent_share_storage_full", "agent_share_context_too_large", "access_changed", "context_changed"]);
const CLOUD_FAILURES = new Set(["container_timeout", "container_failed", "container_output_too_large", "container_interrupted",
  "agent_timeout", "empty_agent_result", "provider_auth_failed", "provider_rate_limited", "provider_unavailable",
  "provider_request_failed", "provider_timeout", "agent_startup_failed", "agent_session_failed", "agent_answer_failed",
  "agent_idle_failed", "agent_shutdown_failed", "model_unavailable", "storage_quota_exceeded", "access_changed", "context_changed"]);
export function teamAgentFailureCode(value: unknown, kind: "local" | "shared" | "cloud"): string {
  const allowed = kind === "local" ? NATIVE_FAILURES : kind === "shared" ? SHARED_FAILURES : CLOUD_FAILURES;
  return typeof value === "string" && allowed.has(value) ? value : "agent_team_agent_failed";
}
export const TEAM_GLOBAL_ISSUES = new Set(["agent_team_authorization_lost", "context_changed", "access_changed", "hosted_access_changed",
  "agent_team_deadline", "agent_team_call_limit", "agent_team_storage_full", "agent_team_native_hold_capacity", "user_paused", "server_restart", "test_replaced"]);
const PUBLIC_CODES = new Set([...NATIVE_FAILURES, ...SHARED_FAILURES, ...CLOUD_FAILURES, ...TEAM_GLOBAL_ISSUES,
  "agent_team_agent_failed", "agent_team_execution_failed", "agent_team_target_unavailable", "agent_team_model_unavailable",
  "agent_team_runtime_offline", "agent_team_runtime_revoked", "agent_team_waiting_executor", "agent_team_claim_expired", "agent_team_native_exit_pending",
  "agent_team_probe_failed", "agent_team_prompt_too_large", "agent_team_sensitive_input", "agent_team_instruction_conflict",
  "agent_team_plan_too_large", "agent_team_busy", "agent_team_incomplete", "agent_team_disconnected", "agent_team_stopped",
  "agent_team_limit", "agent_team_favorite_limit", "agent_team_clarification_required", "shared_agent_solo_disclosure_required",
  "team_response_route_mismatch", "team_directive_invalid", "team_directive_mismatch", "team_clarification_missing", "team_delegation_forbidden",
  "agent_sharing_disabled", "agent_share_queued", "agent_share_busy", "agent_share_source_capacity", "agent_share_progress_limit",
  "agent_share_sensitive_input", "agent_share_solo_disclosure_required", "agent_share_output_too_large",
  "hosted_agent_busy", "hosted_user_busy", "hosted_profile_busy", "hosted_user_rate_limit", "hosted_user_quota", "hosted_global_budget",
  "hosted_profile_unavailable", "hosted_profile_changed", "hosted_runner_unavailable", "hosted_context_too_large", "hosted_code_too_large",
  "hosted_request_unavailable", "cloud_api_changed", "cloud_api_invalid", "cloud_api_unavailable", "cloud_api_limit",
  "forbidden", "not_found", "conflict", "idempotency_conflict", "message_deleted", "runtime_busy"]);
/** Old/private diagnostic values remain durable but never become public text. */
export function teamPublicIssueCode(value: unknown): string {
  return typeof value === "string" && PUBLIC_CODES.has(value) ? value : "agent_team_execution_failed";
}
