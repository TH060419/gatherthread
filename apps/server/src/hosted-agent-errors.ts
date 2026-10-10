// Public failures contain allowlisted codes only, never exception/provider text.
const FAILURE_CODES = new Set(["container_timeout", "container_failed", "container_output_too_large",
  "container_interrupted", "empty_agent_result", "provider_auth_failed", "provider_rate_limited",
  "provider_unavailable", "provider_request_failed", "provider_timeout",
  "agent_startup_failed", "agent_session_failed", "agent_answer_failed", "agent_idle_failed", "agent_shutdown_failed"]);
export function hostedFailureCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  return FAILURE_CODES.has(value) ? value : "model_unavailable";
}
export function hostedFailureContent(code: string): string {
  if (code === "container_timeout" || code === "provider_timeout") return "Cloud Agent timed out. Please try a shorter request or another cloud model.";
  if (code === "provider_rate_limited") return "The cloud model is busy. Please wait and try again.";
  if (code === "provider_auth_failed") return "The cloud model connection needs administrator attention. Please try another model.";
  return "Cloud Agent is unavailable. Please try a new request later.";
}
