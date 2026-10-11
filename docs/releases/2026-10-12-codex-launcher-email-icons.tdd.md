# Codex Launcher email-account and icon repair

Date: 2026-10-12. Base: `148d75e93cbba1ef55d17b753267a244c177e37b`.
Status: local implementation and review complete. The maintainer authorized PR submission, conditional merge and test-server deployment on 2026-10-12; publication and deployment evidence will be recorded separately.

## Approved behavior

Desktop connection prioritizes the Launcher and folds terminal fallback. The Web prepares the current email, project and exact production/test environment; the native form asks only for the account password. Successful authorization creates an independent native device, without replacing browser/phone sessions. Existing CLI, DSH and mobile selection of an online computer Agent remain supported. Both platforms receive the existing approved brand icon, not a new logo.

## RED to GREEN evidence

| Change | Observed RED | GREEN evidence |
| --- | --- | --- |
| Native password authorization | Missing protocol exports/database methods prevented new tests compiling | Strict schemas, project/account/password/device checks, replay/race/budget/admission regressions pass |
| Web v2 handoff | v1 generated instead of v2; incomplete account inputs accepted | Shared formal/test vectors and domain tests pass |
| Launcher-first entry | Primary download flow and folded fallback absent | Static UI checks and built Web real-pointer flows pass |
| Brand icons | ICO missing and macOS bundle icon undeclared | Multi-resolution ICO, PNG, ICNS, plist/resource and native image decode pass |
| macOS compatibility floor | A local build declared 13.0 but contained a Launcher targeting 26.0 and Node targeting 13.5 | Explicit 13.5 compiler target, matching bundle metadata and both executable minimum checks |
| Pending confirmation | Close/reopen left Confirm disabled | Delayed callback unit test and actual close/reopen clicks pass |
| Same-project reopen | Reopening revoked an already-launched native password request | Distinct-grant unit and built-app pointer regressions preserve launched grants; project/account clearing still revokes them |
| Rejected URL | Issued but untracked grant not revoked | Invalid-origin handoff cleanup test passes |
| macOS Stop | Cancellation/generation fence absent | Delayed fake claim cancellation and stale-result/AppKit form self-tests pass |
| Windows Stop | Stop before dispatch still sent a claim; pending reads/opens held the worker | Shared cancellation, prompt local wait release, best-effort transport close and no delayed connector launch pass |
| Windows claim response | 25 incomplete/revoked/invalid metadata variants accepted | Complete record validation rejects all variants |
| Project scope | Switching projects retained unconsumed handoff | Actual source-function regression verifies clear before loading |
| Email hint lifetime/correction | Tab hint lasted 30 days; corrected email kept the old prefill | One-day tab/30-day explicit Remember validity, expiry removal and correction tests pass |
| Download layout | Anchor overlapped its instructions in real browser geometry | Scoped inline-flex button with bounding-box regression passes |
| Linux/self-hosted copy | Launcher-only description shown despite unavailable native entry | Matching terminal description and auto-expanded fallback, no Launcher grant issued |

No checkpoint commit was made before the maintainer granted Gate 2 approval. Test inputs use `.invalid` mailboxes and synthetic credentials only. A long synthetic wrong-password literal was shortened to another policy-valid wrong value after the secret-pattern audit flagged it; the scanner itself was not relaxed.

## Verification

- Browser: Chrome and WebKit each exercise four real built-app desktop pointer flows (both supported platform identities, both exact official origins), two Linux/self-hosted terminal fallback flows, plus phone and tablet existing-computer-Agent selection. All Web requests are intercepted to local build/fake API. Only the native-navigation sink is replaced with a gesture record; no force clicks, real credentials or OS app opening.
- Web Launcher unit coverage: 10 tests; 96.97% lines, 88.73% branches, 81.82% functions.
- Python: Windows helper/icon suite 32 tests, 26 pass and 6 pre-existing Windows-native skips on Mac; macOS packaging suite 7/7.
- macOS arm64: native Swift compilation, shared URI vectors 4 accepted/18 rejected, separate account vectors 2 accepted/5 rejected, bounded fake-network claims and cancellation, AppKit form, high-resolution ICNS decode, plist and ad-hoc signature verification. Full ZIP built successfully.
- TypeScript, connector/DSH/Web builds, scripts, Web/output, integration and E2E checks completed; reference/license/branding/secret audits pass, npm audit reports zero vulnerabilities.
- Full unit regression rerun with `--test-concurrency=1`: 951 tests, 946 pass, zero failures, 5 platform-dependent skips. A default parallel rerun under local contention produced hash-capacity/socket timing failures in unrelated existing suites. No test cases, security limits or production password work were reduced; the complete serial rerun and the remaining verification stages passed.
- `git diff --check` passes; independent review confirmed the corrected authorization, cancellation, lifecycle and privacy boundaries.

Built macOS archive: `prototypes/codex-launcher/dist/GatherThreadLauncher-macOS-arm64.zip`.
Local 13.5-target rebuild SHA-256: `ada29e55b8f0dfbb658a365498b3d9c6ac5b77a289580c8174419d7c06b5df59`. Published CI archives will have their own recorded hashes.

## Remaining publication gates

Windows registry/shortcut appearance and actual Windows packaging require Windows CI/native evidence. Intel macOS was not built. The Mac bundle is ad-hoc signed, not Developer ID notarized; no system installation, Launch Services registration or real account/Codex run was performed. Already downloaded or published ZIPs are unchanged. A source merge alone cannot update the Launcher downloads: rebuild and separately authorize versioned publication plus matching server deployment. No npm version, Git tag, GitHub Release, protection rule or server was changed in this repair.
