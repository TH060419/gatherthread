# Local source audit — 2026-09-22

Status: local automated and isolated-runtime verification completed on 2026-09-22; explicit platform/provider limits remain below. This dated audit covers the `0.1.0-alpha.6` checkout and its then-unreleased Git code-collaboration changes, not the shared-history-summary work added afterward. Its verification counts describe that audited snapshot, not the later predeployment source preview. It does not authorize a commit, release, or deployment.

## Scope and ownership

| Area | Owner | Gate |
|---|---|---|
| Server, protocol, authorization, Git storage | server audit | Reproductions, negative authorization/data-integrity tests, scoped typecheck |
| Bridge, Codex, local files and transcript adapters | bridge audit | Reproductions, filesystem/retry/privacy regression tests |
| Web and product home | Web audit | State/routing/rendering tests and isolated browser checks |
| DSH, MCP, operations, integration | primary audit | Lifecycle/privacy tests, full release gate and real DSH integration |

Existing uncommitted work is preserved. Corrections must retain the existing product and interface invariants in [AGENTS.md](../../AGENTS.md); changes to canonical behavior are documented in their owning documents rather than duplicated here.

## Assessment method

- Trace trusted and untrusted inputs at authentication, native RPC, filesystem and Git boundaries.
- Exercise concurrent operations, revoked authorization, interrupted transfers, retries and malformed input, in addition to normal operation.
- Add a regression before fixing a confirmed defect where practical.
- Re-run existing compatibility suites and packaging checks after integration.
- Separate automated evidence, real-runtime checks, documented preview limits and unverified platforms. A passing test suite is not a claim that no vulnerabilities remain.

## Findings

Priority indicates risk within this private-preview threat model, not a CVSS score. These are local reproductions and source findings, not evidence of exploitation or leaked user data.

| Area | Finding | Correction and regression evidence |
|---|---|---|
| P1 · code privacy | Local and server source-file secret checks disagreed and omitted credential families, including the pairing-poll prefix. | One shared predicate runs before local transfer and Git persistence; protocol/server tests cover credential families, encrypted private keys and merge inputs. Arbitrary secrets still require human review. |
| P1 · portable private paths | Windows reserved/short-name-shaped paths, HFS-ignored characters and malformed UTF-16 could bypass privacy/collision assumptions or fail on another OS. | Validate portable aliases and Unicode before writes; keep valid Unicode/emoji. Platform-specific exploit behavior was not exercised on physical Windows/HFS volumes. |
| P1 · Web scope races | Old login/project/session responses could repopulate stale workspace state or reveal an invitation created for an earlier selection. | Authentication/selection generations fence responses, errors and invitation results; delayed-promise tests reproduce stale responses and revocation. |
| P1 · DSH lifecycle | Late credential restoration/configuration could complete after disconnect, or multiple pairing operations could overlap. Cached role capabilities could outlive a role change. | Reserve single-flight work before awaiting, abort/drain configuration before credential clearing, and recreate affected native owners on role changes. Lifecycle regressions fail before the fix. |
| P1 · automatic source upload | The final inventory could differ from the one that passed stability and large-deletion checks. Incomplete native work could be mistaken for idle. | Require matching final inventory and treat unfinished/unknown turns, Hook drafts and execution journals as busy. Preserve independent conversation processing. |
| P2 · local data/retries | A failed initialization stayed cached; long inventories/filenames exceeded private-state/temp-name bounds; a lost server acknowledgement could mark an already completed local operation failed. | Retry transient initialization, bound and support valid maximum inventories, shorten temporary names, and keep the same receipt identity when acknowledgement is lost. Corrupt bindings remain fail-closed. |
| P2 · transcript capture | A hard link inside an allowed root could refer to outside data; a replaced path could change during capture. | Accept single-link regular files only; recheck canonical path, file descriptor identity and authorized root around reads. |
| P2 · MCP resource/mutation boundaries | HTTP input, JSON structure and batch execution lacked consistent bounds; invalid JSON-RPC IDs could reach tool dispatch. | Enforce 1 MiB/default frame, 128-member batches, depth/node limits, sequential batch dispatch and ID validation before mutation. Preserve notifications and valid batches. Host authentication/deadlines remain separate requirements. |
| P2 · Web action races | Repeated sends could duplicate writes or clear a newer draft; an offline selected upload device could silently change; an old confirmation could approve a newly loaded review. | Send lock and draft/scope checks, explicit exact-device selection, and confirmation bound to the exact preview instance. |
| P2 · browser credential target | A browser API override could route credentials to another origin. | Reject cross-origin and embedded-credential URLs before fetch. Keep same-origin development proxy and explicit Node connector selection. |
| P1/P2 · Codex context | A fixed 4K replay budget and cumulative token spending caused unnecessary compactions; stale usage could erase estimates; visible imports removed older text under a false compact label. Unknown post-compact usage could trigger repeated paid compaction/rebuild; known oversized candidates could switch the binding. | Native-first accounting, full-body snapshots, durable recovery guards and candidate budget validation. The 77-test Codex suite passes; a 262k-window/70KB replay reproduction drops from 11 compactions to zero. Failed/oversized candidates preserve the old binding; unresolved recovery preserves journals. See [ADR-0026](../adr/0026-native-first-context-management.md) for explicit limits. |
| P2 · DSH context | Incoming cloud messages used the outgoing 64 KiB truncation helper. | Separate incoming complete redacted projection from bounded outgoing capture; long-message start/tail, cursor/flush, deduplication and native-settings tests pass. |
| P3 · mobile | A tooltip enlarged a 390px viewport to 430px; the context numeric control's minimum columns exceeded its container. | Keep the tooltip and numeric controls inside their containers; add static regressions and recheck isolated Chromium at desktop/mobile widths. |

Changes are intentionally local patches. Existing uncommitted code-collaboration implementation, authorization rules, model selection, session IDs, upload consent, snapshots and original local Git state are preserved.

## Functional and regression scope

- Server/protocol: authenticated ACL, revoked devices, owner-only code enable/merge, member branches, viewer rejection, stale heads, conflicts, retry receipts and quotas.
- Local code: opt-in authorization, manual/stable automatic uploads, dirty-download refusal, recovery into a new directory, long paths, private files and failed acknowledgements.
- Codex: distinct Desktop/background purposes, active/incomplete writer protection, local-only retained tasks, Hook/manual upload independence, replay journals and native-context accounting.
- DSH: real profile installation, pairing/configuration/disconnect, native session discovery/adoption, exact advertised model selection, progress/final upload, code consent/upload/auto-upload/recovery, reconnection and removal. The real-runtime script uses a temporary profile and mock model, not the user's DSH home or provider key.
- Web: authentication and selection races, consent/device selection, precise review approval, Markdown/KaTeX, mobile dimensions and bilingual settings.
- MCP/packaging: malformed and oversized requests, valid notifications/batches, Git-less tarball installation, exported entry points, package metadata, references, licenses and known dependency advisories.

## Verification record

After all code/context fixes, `npm run release:verify` exited successfully on macOS with Node `v24.16.0`. The unit suite was repeated to retain the result counts after the full gate's verbose output was truncated:

| Gate | Result |
|---|---|
| Typecheck, DSH/Web/connector builds | Passed |
| Unit regressions | 501 passed; one Windows-only PowerShell execution fixture skipped; zero failures |
| Web | 176/176 passed, plus build-output check 1/1 |
| HTTP integration | 4/4 passed, including two-user Git sync and lost-workspace recovery |
| Collaboration/redaction contract E2E | 9/9 passed |
| Scripts | Passed in the full gate |
| Reference/license checks | 14 reference projects / 47 installed packages; zero review items |
| Branding, secret scan, release metadata | Passed |
| Dependency advisories | `npm audit --audit-level=moderate`: zero known vulnerabilities at this run |
| Git-less packages | Codex tarball install/help/MCP/preflight and DSH install/import/manifest checks passed |

The 77 Codex-specific tests are a subset of the unit count, not additional independent tests. Test results cover this source checkout; previously published npm packages were not replaced.

The real npm-plugin integration passed again after the context changes using pinned `@deepseek-ai/dsh@0.1.2-rc.1`, with `realDshHome: false`, no package downloads, an official local credential store at mode `0600`, and credentials cleared before plugin removal. It covered the added Git workflows as well as existing conversation workflows. A public message larger than 64 KiB retained both start/tail markers in DSH's actual outgoing model request; pairing and passive history projection triggered zero model requests. The model endpoint was a local mock, so this does not establish provider-window behavior or semantic summary quality. Command: `npm run build:dsh-plugin && node scripts/test-dsh-npm-plugin-real.mjs` after the TypeScript/Web build.

The Web audit used isolated Chromium `153.0.8010.50`: the original 20 interaction checks passed again, plus 16 context-settings combinations (English/Chinese, Codex/DSH/both orders, 1440px/390px). Both runs had zero page errors and zero external requests. Test scripts/screenshots were left in a private temporary directory, not added to release assets. Safari and Edge were not run in this audit.

Initial sandbox-only loopback-listener `EPERM` failures were environment restrictions, not passing tests; the affected suites and final gate were rerun successfully with approved loopback access. The final source diff passed `git diff --check`. The final documentation pass also synchronized the English/Chinese connection guides and corrected the Chinese empty-session troubleshooting entry; no application code changed after the passing release gate.

## Remaining limits and release disposition

1. **Context is not unlimited or lossless.** Native compaction can use quota and summarize away details. DSH `0.1.2-rc.1` cannot guarantee automatic rescue of a first backlog already larger than the model window. Codex background recovery pauses when no safe fresh usage is available; it has no reset UI/CLI in this preview, and reconnecting with the same report or requesting a larger model does not bypass that guard. A lost native task with no future report needs a follow-up authorized recovery design, not state deletion. The separate Desktop realtime path remains independent. Unknown/custom capacity metadata and disabled native compaction remain user/provider configuration issues. Real-model summary quality and provider-limit behavior were not tested with paid requests.
2. **Privacy is deployment-scoped, not end-to-end encryption.** The trusted server stores canonical plaintext and uploaded code. Every project reader can inspect code branches; Solo is not a code-privacy boundary. Secret detectors recognize known patterns, not every possible private file or key.
3. **Code checkpoints are a bounded preview, not full Git hosting.** There is no smart-HTTP clone/push endpoint, automatic task worktree isolation or cross-harness tool/file lock. Concurrent local Agents require separate working copies. Recoverability covers only eligible files actually uploaded. See [CODE_SYNC.md](../CODE_SYNC.md).
4. **Native platforms and operations remain release gates.** Windows/Linux CI, real Safari/Edge UI checks, the Windows two-account local-relay boundary, physical filesystem behavior, multi-device fault tests and operator backup/restore must be checked before a broader release. Small mocked/local tests do not establish Internet-facing load resilience.
5. **Embedding boundaries remain explicit.** MCP HTTP requires its host's authentication, request deadline and rate limits. Git storage/object retention and matched SQLite/Git backups need operator policies. No production server was changed or assessed as deployed.

No commit, push, merge, npm publication, tag or deployment was performed by this audit. The tested source is a candidate for project-lead review, not an assertion that all vulnerabilities or regressions are impossible.
