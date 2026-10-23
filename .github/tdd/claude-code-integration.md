# Claude Code connector, plugin and Launcher integration

## Scope and authority

This is a source implementation submitted for review, not an npm/installer release
or server rollout. The primary checkout's unrelated changes were preserved in a
separate managed feature worktree. The user authorized updating the local Claude
installation; the official user-npm installation is now 2.1.306. No model request,
global plugin/Hook installation or server change was made. The user subsequently
authorized a feature-branch commit, PR submission and review only; merge,
publication and deployment remain separate decisions.

## Acceptance criteria

- An independently enabled Claude connection uses its exact device/model and
  never falls back to Codex, DSH or a model alias.
- Windows/macOS Launcher v3 carries public account/project/harness metadata, not
  a password or device token; old Codex v1/v2 behavior remains unchanged.
- A standalone package contains the matching native plugin, commands and
  user-only MCP tools, with no monorepo runtime dependency after installation.
- Web requests stream public answers, selected tools and real plans. Pause
  terminates the owned process before settlement; uncertain replay never starts
  the same local operation again.
- Native shared context, publication and file synchronization retain separate
  consent, ACL, revision, busy-state and idempotency boundaries.

## RED → GREEN evidence

- New Web tests initially failed for missing Claude profile/link exports and
  controls. The implementation now preserves independent native profiles,
  rejects ambiguous/wrong targets and passes the shared v1/v2/v3 vectors.
- The server initially refused Claude local controls. Its bounded allowlist now
  admits implemented exact-runtime local/file controls while refusing Codex-only
  history import and revoked/foreign devices.
- Fake-CLI tests cover metadata-only preflight, strict isolated arguments,
  streamed answer/tool/plan interleaving, split-secret redaction, wrong native
  session/model, missing/malformed/oversized output, confirmed cancellation and
  durable execution replay. A malformed process that ignores SIGTERM was a
  review finding; abort now escalates to SIGKILL and waits for process close.
- Launcher consent/model cases failed before implementation. Both native UIs
  now start file synchronization unchecked, reset it on a new handoff and reject
  aliases. Candidate discovery selects a compatible existing Claude installation
  without rewriting PATH or overriding a manually edited executable field.
- Independent review found multi-turn manual-upload proof could block its own
  queue. Tests now cover two completed turns, lost commit acknowledgement,
  switched native models and later transcript growth exceeding 2 MiB. Stat-only
  Stop anchors keep the later consented read near the captured turn. Private
  state has a bounded write/read budget and fails without losing prior outbox.
- Independent review also found a newly discovered native Solo was absent from
  file-sync busy checks. Workspace-level activity begins before the first ACL
  await; source operations and remote execution reserve a common local guard.
  A trusted active file-operation refusal reaches the actual UserPromptSubmit
  Hook as a block. Barrier tests reproduced both reservation races before the
  synchronous post-await recheck; both orderings now admit at most one operation.

No development checkpoint commits were created before the user's later PR
authorization. The recorded failures are local test observations, not an
invented RED commit history.

## Verification

| Check | Observed result |
| --- | --- |
| Forced TypeScript build and both standalone connector builds | Pass |
| Claude runtime plus shared bridge/loop/relay/server-control focused regression | 101 pass |
| Web check, including built output | 746 source tests and 3 output checks pass |
| Script regression with two concurrent workers | 153 pass |
| Existing integration / end-to-end scenarios | 5 / 9 pass |
| Dedicated Claude real-HTTP → fake CLI → streamed canonical reply integration | 1 pass; no provider calls |
| New package Git-less pack/install, embedded plugin and synthetic preflight | Pass |
| Installed Claude 2.1.306 strict plugin validation and real metadata-only executor preflight | Pass; zero model calls |
| Windows Launcher Python contracts on macOS | 52 cases run, including 6 Windows-native cases skipped |
| macOS packaging unit tests | 40 pass |
| Fresh Swift compilation, actual AppKit URI/account/icon/form/cancellation/discovery checks | Pass |
| Reference/license/branding/secret audits and dependency vulnerability lookup | Pass; zero npm vulnerabilities |

The initial default-concurrency run encountered password/socket and Python
fixture timeout/busy conditions; a four-worker run still encountered HTTP
timeout/busy conditions. Those runs are not reported as successful. Isolated
HTTP/multi-device rechecks passed 23 tests, file HTTP rechecks passed 5 tests,
and the Python fixture passed independently.

The final serial full-suite attempt reported 1,283 tests: 1,274 passed, 3 failed
and 6 skipped. The failures represent two timing cases: the existing delayed
password-reset notification/socket case and the new process-close timing case
(whose failed nested case also fails its parent). The latter incorrectly began
its seven-second cancellation clock before the child had started. Its clock now
begins after the fixture proves startup, retaining the same seven-second bound
and the assertion that the process is dead. The corrected executor file passed
all 24 tests; the unchanged password-reset file passed all 5 in an isolated run.
No assertion, product limit or test was removed. A fresh single-run full-suite
pass is still required before treating the canonical release gate as green;
targeted reruns are not presented as that evidence. A subsequent PR-preparation
serial run completed with 1,283 tests: 1,277 passed, zero failed and six skipped.
This clean run predates the additional independent-review fixes below; its
counts are not attributed to the later revision.

## PR review follow-up

Independent Standards and Spec reviews identified native manual-command
ordering, exact saved-profile drift, terminal cleanup, failed-turn context
cursor recovery, and overly broad/generated work telemetry. New synthetic
regressions reproduced the failures before correction. Explicit manual upload
now flushes only completed outbox entries even during its own native command;
active drafts remain private. Claude profiles refuse passive model/effort
replacement without changing existing DSH behavior. Terminal Hook metadata
releases draft/activity state even when the answer cannot be captured, and
failed turns preserve the previously committed context cursor. Tool results
share fixed completion status rather than raw bodies; silent processes generate
no fabricated work progress. Claude requests also retain their explicit public
quote independently of a summary, without restoring erased content.

Follow-up verification and review are recorded against the new PR revision;
neither the original review nor earlier green counts certify a changed tree.
The first fix revision passed a fresh full serial unit run (1,287 passed, six
skipped, zero failed), 747 Web tests plus three output checks, 154 script tests
and the Git-less package check. A second review then exercised stale open
Settings forms and Hook frames larger than 1 MiB. The final follow-up preserves
profile pins on unrelated saves, adopts a profile only on explicit device
selection, and reads selected Hook fields incrementally so an oversized answer
cannot discard terminal metadata. Windows CI identified a path-separator-only
test assertion; the test now normalizes host separators while retaining exact
namespace/hash and named-pipe checks. No test was removed or skipped for it.

The browser check uses only the local MockCollaborationApi with synthetic data.
It covers desktop enablement and connection dialog, the missing-Claude refusal
despite an online DSH runtime, Chinese copy, and the compact mobile selector with
desktop connection controls hidden. It is not a real account or native-phone test.
The final browser pass exposed a blank disabled device selector. A focused test
first failed for the missing option; the selector now visibly says there is no
connected device, and the focused 55-test plus full 746-test Web reruns pass.

## Deliberate limits

Initial review baseline (superseded by the owner-requested native-permission update below): unattended Web execution exposed file/plan tools, not Bash, network tools or
Agent spawning. Native Claude sessions keep their own interactive permissions.
Only public output is captured; hidden reasoning is excluded. Native upload
proof reads at most a bounded 1.25 MiB region of the exact authorized transcript;
a single oversized turn that cannot be proved safely remains private instead of
being guessed or attributed to the configured default model.

The file guard coordinates this connector and reviewed installed Hooks, not
unrelated processes editing the same directory. Use separate working copies for
independent simultaneous writers. Windows/Intel native execution, full clean
installer publication and real provider execution still need their own evidence.
Existing published packages/installers and live server state are unchanged.

## Owner-requested own-Agent permission parity (2026-10-22)

The owner explicitly requested that own-Claude Web execution use normal local
tools and permissions, like the existing own-Codex/DSH routes. The earlier
file/plan-only policy above is superseded, not a cross-member sharing expansion.
The default is now `native`: no tool whitelist, restricted/safe-mode, empty MCP
configuration or permission-mode override. Explicit manual/plan remain valid.
No new permission prompts are automatically approved and no bypass flag is added.
Native permission denial has a fixed actionable failure without raw inputs.

Owned Web UUID registration prevents the restored local GatherThread Hooks from
blocking their own process, injecting duplicate context or creating a Solo echo.
Unrelated native/file work retains the busy fence. Command/network/subagent/MCP
activity can publish start/completion states without raw arguments/results.
Cancellation targets the owned process tree, including terminal descendants.

Native acceptance command:
`node scripts/verify-claude-native-permissions.mjs /absolute/path/to/claude`.
Installed Claude Code 2.1.306 actually executed offline npm installation for a
locally allowed command; the same command under a native deny rule created no
dependency files. Local Hooks ran and settings stayed byte-identical in both
cases. The provider was a loopback fixture; real provider/model calls were zero.
No user configuration, private session or live service was used. Automated tests
also cover exact Hook ownership, native tool disclosure, explicit mode overrides,
permission failure, process-tree cancellation and changed-journal refusal.
Real provider billing and Windows native acceptance remain separate evidence.

Final production-source re-review at `d2549211b946256dabf9eeffcf3665fca497bc9c`:
Standards and Spec independently cleared all remaining findings. Follow-up fixes
exclude private/outside/linked file arguments, preserve native permission-denial
guidance even on exit 1, and freeze/resample the owned POSIX process tree before
forced termination so shutdown handlers cannot detach new work. An uncertain
cleanup retains the workspace busy barrier. The native plugin's instruction
file is updated to the same permission policy rather than retaining the earlier
file-only guidance.

Final local regression: 1,303 unit cases (1,297 pass, six existing platform skips,
zero failures), 154 script tests, six integration tests, nine E2E tests and all
Web source/built checks pass. Git-less Claude tarball installation, embedded
user-only MCP/preflight, reference/license/secret/branding audits and diff checks
pass. Installed-CLI fake-provider permission acceptance remains separate from
real model/provider validation. Production-source Linux, macOS, Windows and
hosted-container CI all passed at `d254921`; instruction/report-only follow-up
must still retain its own matching package verification and CI record.
