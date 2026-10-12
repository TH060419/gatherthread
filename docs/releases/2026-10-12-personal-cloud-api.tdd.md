# Account-owned cloud API implementation evidence

2026-10-12. Integrated implementation head: `20f352acaf2c6fa571d678f289c5ba1bbae53308`, including main `29321a01ebebe5cc50ef8e75b63ea6acd7813cf6` (storage-first GitHub setup). This is an evidence-only follow-up, not a release/deployment statement.

## Scope

Personal API is an account-level Settings entry immediately after General. Six fixed official providers, exact model IDs and write-only keys supply the existing Cloud Agent, selected-history summary and eligible authorized GitHub task routes. Local Codex/DSH and service-funded models retain their behavior. Private metadata and runtime configuration revisions never become another member's credentials. Keys are encrypted under an independent stable operator key; no custom URL/header or silent payer/model fallback is supported.

## RED/GREEN evidence

- Backend store: `602f410` RED → `8959a18` encrypted metadata, owner/CAS and key handling.
- Backend routing/native HTTP: `5845953` RED → `7cb5fa0` / `b93541d`; `3f3e1c4` closes provider-change, continuation and checkpoint fences.
- Web metadata lifecycle: `d616a36` RED → `31a9616` GREEN. Shell/HTTP RED `4c7b6e6` / `729c560`; retry revision RED `c4470df`, provider change RED `182697b` → Web GREEN `d8220f9`.
- Browser, privacy and user instructions: `ff4a146`; integration `20f352a` preserves both GitHub and personal API behavior.

## Verification

- TypeScript build and 521 server/protocol tests pass after installing the unchanged checked-in lockfile. The initial local checkout had stale KaTeX 0.16.47 although the lock requires 0.18.2; normal `npm ci` corrected the environment, without changing dependencies or weakening security tests.
- Complete `npm run verify` passes: unit/script/Web/integration/E2E, references, licenses, branding, secret checks and npm audit (zero vulnerabilities). Expected pre-existing platform skips remain separate from success.
- Personal API focused tests cover write-only keys, clear-before-await, same-account/generation fencing, uncertain create IDs, provider-change fresh-key requirement, exact delete revision, requester-private retry/resume pin and summary/trial serialization.
- `tests/browser/personal-cloud-api.mjs` passes ordinary pointer flows on Chrome desktop, WebKit phone and Chrome tablet with real HTTP, HttpOnly Cookie authentication and database writes. It adds/edits a private connection, checks no key in response/browser storage, chooses the exact model/revision, reads a controlled answer, pauses and deletes. Separate isolated accounts and controlled executors forbid live provider traffic.
- The integrated `tests/browser/github-storage-setup.mjs` desktop/phone/tablet matrix also passes, preserving original OAuth return and unsaved computer repository drafts.
- `git diff --check` passes. Standalone runtime release checks and the final fresh archive remain coordinator release gates.

## Unclaimed evidence and operational requirements

This Mac has no Docker. The existing Linux smoke now covers the bundled native Anthropic Messages SDK, streaming, actual isolated bash/tool-result loop and checkpoint; current-head CI must pass before merge. Safe fixture-only failure categories were added after an unrelated same-source smoke flake; no resource limit or assertion was removed. These fixtures are not real-provider billing/availability evidence.

The operator must privately provision `GATHERTHREAD_CLOUD_API_ENCRYPTION_KEY` as a canonical 32-byte base64 value, distinct from GitHub/identity keys, and retain it across restarts. Missing configuration disables only Personal API. Provider keys stay outside containers and public logs; already dispatched provider work cannot be recalled or refunded. Main-server concurrency/resource/runtime controls remain, and personal usage has separate 100/account/day and 1,000/host/day acceptance caps.

No real keys, providers, private browser tabs, GitHub repository tasks, npm versions, tags, existing installers or server state were changed for these checks. Independent Standards/Spec reviews and latest-head CI are still required before merge; the final goal uses one combined server delivery.
