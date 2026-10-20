import test from "node:test";
import assert from "node:assert/strict";
import { TEAM_GLOBAL_ISSUES, teamAgentFailureCode, teamPublicIssueCode } from "../src/agent-team-errors.js";

test("Team execution diagnostics accept known failures only for their actual execution kind", () => {
  assert.equal(teamAgentFailureCode("codex_turn_cancelled", "local"), "codex_turn_cancelled");
  assert.equal(teamAgentFailureCode("agent_request_abandoned", "local"), "agent_request_abandoned");
  assert.equal(teamAgentFailureCode("agent_share_lease_expired", "shared"), "agent_share_lease_expired");
  assert.equal(teamAgentFailureCode("agent_share_daily_limit", "shared"), "agent_share_daily_limit");
  assert.equal(teamAgentFailureCode("provider_auth_failed", "cloud"), "provider_auth_failed");
  assert.equal(teamAgentFailureCode("provider_timeout", "cloud"), "provider_timeout");
  for (const [code, kind] of [["provider_auth_failed", "local"], ["codex_turn_cancelled", "shared"],
    ["agent_share_revoked", "cloud"]] as const) assert.equal(teamAgentFailureCode(code, kind), "agent_team_agent_failed");
});

test("native safety holds expose fixed categories without misattributing account capacity to one module", () => {
  assert.equal(teamPublicIssueCode("agent_team_native_exit_pending"), "agent_team_native_exit_pending");
  assert.equal(teamPublicIssueCode("agent_team_native_hold_capacity"), "agent_team_native_hold_capacity");
  assert.equal(TEAM_GLOBAL_ISSUES.has("agent_team_native_exit_pending"), false);
  assert.equal(TEAM_GLOBAL_ISSUES.has("agent_team_native_hold_capacity"), true);
});

test("Team execution diagnostics reject arbitrary regex-valid codes, exception messages and nonstrings", () => {
  for (const kind of ["local", "shared", "cloud"] as const) {
    for (const value of ["unrecognized_private_payload_123456", "provider_auth_failed\nprivate detail", "CODEX_TURN_FAILED",
      "", null, undefined, { code: "provider_auth_failed" }, new Error("PRIVATE_PROVIDER_DIAGNOSTIC"), 403]) {
      assert.equal(teamAgentFailureCode(value, kind), "agent_team_agent_failed");
    }
  }
});
