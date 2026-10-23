# ADR-0061: Account-private saved Agent Teams and independent modules

- Status: proposed / local implementation preview
- Date: 2026-10-16

## Context

The earlier unreleased Team prototype coupled one session plan, graph editing
and execution. Users need a small reusable library, modules whose execution
Agent can be configured independently, and a test gate before enabling a Team.
Native Agent sharing now supplies an explicit grant boundary under ADR-0056;
Team composition must reuse it rather than treating a borrowed runtime as owned.

## Decision

Separate account-private saved definitions and favorite module snapshots from
immutable, requester-private session executions. The library is account-wide;
its storage limits and graph/editor behavior are specified by
[Product specification](../PRODUCT_SPEC.md#my-agent-teams-local-implementation-preview).
A favorite is copied into a new module, never a live reference. A module can be
saved before its exact Agent/model/effort is bound, without gaining execution
authority.

Permit a new task only through an explicitly human-started, saved, tested and
enabled definition revision. A two-phase minimal test first probes every module's
exact route, then transfers its verified public response token over each allowed
graph direction to the destination and checks an exact echo. Each destination
receives all of its incoming probe tokens in one call, so both directions of a
bidirectional edge are exercised within bounded calls. Success is not substantive
task validation. Configuration edits invalidate the test and block new starts.
Existing accepted task snapshots retain their original graph and limits until
their own controls or authority end them. New raw-plan HTTP starts are excluded.

The orchestrator serializes calls and accepts only canonical, provenance-bound
results and step-specific allowed delegation decisions. Own native, cloud and
shared-native execution retain their existing authorization, quota, context and
cleanup owners. Original authorizing-device revocation fences work even when
the executor uses a separately valid device. Testing has a separate Team-run
budget, while ordinary provider and shared-grant consumption remains real.

Treat graph connections as allowed-call relationships, not a fixed execution
sequence. Give each module a complete allowlisted public Team overview on its
first invocation per run and refresh that same frozen public manifest on later
calls, because fresh execution contexts may not remember previous ones. A
per-node first-contact marker and current caller/return/phase/budget brief make
the distinction explicit on every invocation. Do not include other modules'
private prompts or native routing
credentials in the overview. Identity defines responsibilities; a module prompt
refines methods within them, and direct conflicts require human clarification
instead of autonomous reinterpretation. A verified Clarify report pauses the run;
explicit Resume freezes a later original-requester human message and report as
erasure-aware dependencies and makes a new counted call to the same module.
The original configuration and execution limits remain fixed. This is a
behavioral conflict-reporting protocol, not semantic contradiction detection.
Detailed behavior and disclosure limits
remain owned by Product specification and Security.

Stable exact-input receipts recover unknown acceptance; definition revision CAS
prevents stale enable/save from undoing a newer disable. An account-wide monotonic
revision clock preserves this fence even when a deleted Team ID is recreated;
its revisions are opaque and its single metadata row is deleted with the account.
The new namespace begins at `2^40` to separate newly allocated revisions from
the earlier preview's per-Team counters, including deleted legacy configurations.
Successful test stamps are committed by the server and do not depend on browser
polling or retention of the private test run. Replacing a configuration fences
its old test in the library transaction; physical cleanup remains recoverable.
Emergency controls have
independent admission capacity and transport recovery. Native
turn cancellation must reach the actual native executor, and its execution
capacity stays reserved until that exact native attempt confirms exit. The
connector durably retries content-free exit acknowledgments after reconnect;
neither lease expiry nor removal of private run pointers proves physical exit.
The same rule applies when sessions, projects, runtimes or claims are deleted:
deletion atomically retains content-free exact-attempt holds outside history
foreign keys. Exact original-device exit receipts can retire them after deletion,
while absent or foreign acknowledgments are indistinguishable no-ops. New Team
hold admission has account/global bounds and cannot evict unconfirmed old work.
Native claim compatibility and the metadata-only control transport are defined
in Interface contracts. Capability is executor-specific: process-backed entries
must durably prove physical group settlement before exporting cleanup receipts;
unsupported platforms refuse Team claims. Cleanup scope is immutable and old
settled receipts drain before runtime registration. Ambiguous legacy origin or
native ownership remains held, never guessed from current routing or PID reuse.
A failed native
cancellation remains repairable after the run ends or resumes onto a new step:
startup and bounded coordinator retries inspect fenced outstanding claims,
without dispatching another call or changing the run's outcome. A nullable
per-step retry timestamp is added to preview databases without rewriting saved
plans or canonical events. Revoked original authority cannot publish a new
result; trusted cleanup may only retire the already fenced exact claim.
Private run deletion atomically retires its residual native claims before
dropping the step pointers, including Forget, expiry and storage reclamation;
the cleanup rolls back together with a rejected deletion transaction.
Storage-pressure admission
may reclaim only the account's obsolete terminal connectivity caches, atomically
with the new start and without discarding current test stamps, ordinary task
history or consumed-key fences. Ended task records have an explicit Web cleanup
path through the existing private Forget contract. Private run erasure never
turns a canonical Team-owned request into an ordinary executable request or
makes its accepted start key reusable. Keep a separate content-free consumed-key
receipt after private Forget or expiry, including runs stopped before their first
canonical step; receipt capacity fails closed instead of evicting that fence.
Detailed routes and compatibility belong to
[Interface contracts](../INTERFACE_CONTRACTS.md#saved-agent-team-preview-contract),
data flow to [Architecture](../ARCHITECTURE.md#saved-agent-teams-local-implementation-preview),
and trust/retention to [Security](../SECURITY.md#agent-team-preview-boundary).

## Consequences and verification

The additive library stores reusable private configuration without changing
canonical history or creating additional project membership. Account-wide
reuse does not make a session-bound runtime portable: unavailable exact targets
must be explicitly rebound and retested. Favorites cannot silently update other
Teams. Cycles and parent returns remain bounded by the immutable run limits.

Verification must cover atomic library caps and ownership, immutable copies,
test/edit/enable revisions, exact target/provenance failures, shared quota and
Solo acknowledgment, revoked original authorizers, lost receipts, emergency
controls, retention, consumed-key fencing and canonical ownership after Forget.
Instruction coverage includes first-contact/refresh manifests, actual caller/return
attribution, conflict reports, qualifying human clarification, same-key Resume and erasure
of clarification dependencies after Forget. Graph/editor behavior
also requires real Safari and Chromium checks. This record specifies the local
implementation contract, not completed browser/provider acceptance or released
availability. It changes no package version, tag, publication or deployment.
