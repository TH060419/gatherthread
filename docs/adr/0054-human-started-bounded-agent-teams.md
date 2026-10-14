# ADR-0054: Human-started bounded Agent teams

- Status: proposed / implementation review
- Date: 2026-10-13

## Context

A session member may have several already-authorized exact Codex, DSH and Cloud
Agent targets. Collaboration needs explicit delegation without turning a public
message or arbitrary model output into ambient execution authority.

## Decision

Use a requester-private plan and a human-started, immutable run snapshot.
The server coordinates sequential assignments over configured directed edges;
bidirectional edges allow both directions. A subordinate's completion returns to
its requesting parent without requiring a reverse edge. That return is another
accepted Agent call. Independent team runs retain existing runtime/provider
concurrency limits; this is not parallel execution within one team.

The run freezes its authorizing device, original task, plan, history revision,
exact runtime/provider/model/reasoning and personal API configuration revision.
Automatic dispatch rechecks current authority and target capabilities. There is
no fallback, new credential grant, billing substitution or automatic publication
of a GitHub PR. Local tool approvals remain with the native harness.

Only an exact canonical final response may contain one terminal, strict
`gatherthread-team` decision bound to the current step nonce. A node with no
outgoing grants may instead complete with its nonempty plain final answer; the
coordinator can only return along its existing parent stack or finish the run.
Explicit control markers remain strict even at leaves, and a delegating node
cannot silently complete with missing control. A decision may
complete the assignment or request a task at an allowed adjacent node. Human
chat, live progress, unrelated responses, malformed/duplicate blocks and stale
nonces cannot drive the graph. Public answers are untrusted collaboration data.
Native-visible output retains [ADR-0045](0045-streamed-public-agent-output.md)'s
allowlist; hidden reasoning and private native instructions stay excluded.

Every accepted request is charged transactionally. Limits and public interface
shapes are owned by [Interface contracts](../INTERFACE_CONTRACTS.md); user-visible
behavior is owned by [Product specification](../PRODUCT_SPEC.md). Native claim
reclamation cannot cause uncounted executions of a team step. Restart pauses
unfinished runs; explicit resumption can create a fresh counted call. Cloud
execution timeout pauses for explicit Continue, which keeps the original task and
recoverable public results while creating a fresh bounded execution round. It
cannot restore terminated internal thought or unsaved work.

Pause/Stop fence further calls and late publication. Lost HTTP acknowledgments
retain the same intent and key; a successful no-op also has a durable receipt.
Quota exhaustion cannot remove the independent reserved Stop capacity. Bounded
Pause receipts cannot borrow it, including when resuming between full-quota
pauses. The existing fixed run allowance prepays the separately bounded receipts.
Browser reads are cancellable and bounded independently of control mutations;
loaded tasks remain pausable/stoppable while a refresh is stalled. Browser
configuration editing never dispatches an Agent; the accepted run graph is
read-only and separately displayed from the user's editable draft.

Private control records are bounded and pruned after terminal retention. Their
removal does not turn existing canonical team requests into ordinary requests,
including ordinary Cloud continuation: server-owned team metadata remains a
permanent execution fence. Expiry is enforced by background maintenance and
authorized private reads, independently of saving or creating new plans. Author erasure
under [ADR-0050](0050-author-message-erasure-and-context-revisions.md) clears derived
team runs/steps/receipts for the affected session atomically and advances the
ordinary content revision fence. Canonical same-run request/answer dependencies also erase later generated prompts containing copied tasks/results, including after private record cleanup; independent human inputs remain subject to ADR-0050's existing scope. Saved draft rules are independent human input.
Recognized credentials in submitted plans/tasks are rejected before storage.

## Compatibility and verification

Additive SQLite tables and explicit column upgrades preserve existing drafts.
Server and Web need to upgrade together for team controls. Rollback must retain
team request fencing; an older executor that ignores team metadata is unsupported.
Local workspace files and native task history are never deleted by private run
cleanup or canonical cloud erasure.

Tests cover directed return, bounded cycles, exact target and nonce refusal,
private ownership, controls/idempotency, interruption/restart, deadlines,
timeout continuation, history deletion, personal API revision/payer, storage
bounds, HTTP/CSRF, migration and stale browser reads. A loopback browser fixture
uses simulated executors and proves control flow only. Real native/provider
acceptance, Safari and Windows/Linux execution checks remain separate gates;
local passing mocks do not claim deployed or production team support.

The optional `npm run test:agent-team:codex-real` gate uses an explicitly selected
installed executable (`GATHERTHREAD_CODEX_COMMAND`, absolute path), its reported
default model and three read-only ephemeral arithmetic turns. It consumes the
configured Codex account's allowance, so it is not part of automatic CI. The
synthetic in-memory GT run verifies director delegation, subordinate completion,
parent return, exact claims and three-call accounting without publishing to an
existing project. Only public assistant text is consumed; tools are rejected by
the acceptance assertion. It does not replace full connector/Desktop projection,
DSH, Cloud provider or cross-platform acceptance.

Additional local acceptance has exercised the HTTP server, LocalBridge and
Codex App Server executor through three exact director/worker/return calls. The
installed DSH 0.2.0-rc.2 SDK path also completes that sequence with ordinary and
summary contexts using a loopback Messages-compatible fixture. This verifies
the native DSH bridge, not real DeepSeek inference or its Web UI. Session-format
compatibility is recorded separately in [ADR-0055](0055-dsh-session-format-owned-context.md).

A five-call HTTP run also completes Codex -> DSH -> Cloud -> DSH -> Codex
with ordinary counted parent returns. Codex uses its real installed executor;
DSH uses its real SDK with a loopback provider; Cloud uses the production
HostedAgent reservation/context/completion path with a test runner substitute.
This revealed and corrected shared native replay's assumption that every
provenance has a local runtime ID. The server-contained Cloud reply has none,
as already allowed by the protocol, and never becomes a local execution grant.
Actual Docker/provider and deployment acceptance remain distinct gates.

Separate arithmetic acceptance also completes the five-call sequence using a
fresh real Qwen3.5-4B reply from the operator's test service, explicitly copied
through Safari into a bounded manual response broker. DSH still uses its SDK
with a loopback model fixture. This proves that the actual public Qwen answer
returns through the coordinator to DSH and Codex; it does not verify automatic
provider transport, local Docker, a deployed Team API or real DeepSeek inference.
